"""Durable, host-configured limits for new billable music-provider attempts.

Counts are attempts, not estimated currency. Reserve before *each* provider
POST (including network fallbacks); never refund an ambiguous or failed call.
Polling and downloads must not use this guard. No keys or prompts are stored.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import time
import uuid

import psutil


class PaidUsageError(RuntimeError):
    def __init__(self, message, *, status=429, code='PAID_USAGE_LIMIT', retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after
        self.attempt_started = False


def setting(name, default):
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
        if str(value) != raw.strip() or not 0 <= value <= 1_000_000:
            raise ValueError()
        return value
    except (TypeError, ValueError):
        raise PaidUsageError(f'{name} 配置无效；请在服务器配置非负整数后重试',
                             status=503, code='PAID_USAGE_CONFIG') from None


class PaidUsage:
    def __init__(self, filename, *, daily=None, total=300, per_minute=12, concurrent=2, clock=time.time):
        self.filename = Path(filename)
        self.daily = daily or {'text': 60, 'song': 6, 'artwork': 6}
        self.total, self.per_minute, self.concurrent = total, per_minute, concurrent
        self.clock = clock

    @classmethod
    def configured(cls):
        default = Path(__file__).resolve().parents[2] / '.local' / 'paid-usage.sqlite3'
        return cls(os.environ.get('MUSIC_PAID_USAGE_DB', str(default)),
                   daily={kind: setting(f'MUSIC_{kind.upper()}_DAILY_LIMIT', maximum)
                          for kind, maximum in [('text', 60), ('song', 6), ('artwork', 6)]},
                   total=setting('MUSIC_PAID_TOTAL_LIMIT', 300),
                   per_minute=setting('MUSIC_PAID_RATE_PER_MINUTE', 12),
                   concurrent=setting('MUSIC_PAID_MAX_CONCURRENT', 2))

    @contextmanager
    def connection(self):
        db = None
        try:
            self.filename.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(self.filename, timeout=5, isolation_level=None)
            if os.name != 'nt':
                os.chmod(self.filename, 0o600)
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise sqlite3.DatabaseError('Unsupported ledger schema')
            db.execute('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, category TEXT NOT NULL, started REAL NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS attempts_time ON attempts(started)')
            db.execute('CREATE TABLE IF NOT EXISTS active (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, process_started REAL NOT NULL)')
            db.execute('PRAGMA user_version=1')
            yield db
            db.execute('COMMIT')
        except (sqlite3.Error, OSError):
            raise PaidUsageError('调用额度账本暂时无法安全读写，已停止新付费请求；请检查磁盘空间、目录权限和日志，勿删除账本后重试',
                                 status=503, code='PAID_USAGE_UNAVAILABLE') from None
        finally:
            if db is not None:
                db.close()  # Rolls back an uncommitted reservation on limit errors.

    def reserve(self, category):
        if category not in self.daily:
            raise PaidUsageError('付费调用类别未登记，已停止请求', status=503, code='PAID_USAGE_CATEGORY')
        for name, maximum in ((f'MUSIC_{category.upper()}_DAILY_LIMIT', self.daily[category]),
                              ('MUSIC_PAID_TOTAL_LIMIT', self.total),
                              ('MUSIC_PAID_RATE_PER_MINUTE', self.per_minute),
                              ('MUSIC_PAID_MAX_CONCURRENT', self.concurrent)):
            if maximum == 0:
                raise PaidUsageError(f'服务器已暂停此类新付费请求；请由管理员调整 {name} 后重试',
                                     code='PAID_USAGE_DISABLED')
        now = self.clock()
        day = datetime.fromtimestamp(now, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        with self.connection() as db:
            for identifier, pid, started in db.execute('SELECT id,pid,process_started FROM active').fetchall():
                try:
                    process = psutil.Process(pid)
                    dead = abs(process.create_time() - started) > .01 or process.status() == psutil.STATUS_ZOMBIE
                except psutil.NoSuchProcess:
                    dead = True
                except psutil.AccessDenied:
                    dead = False  # Cannot establish death: fail closed rather than exceed concurrency.
                if dead:
                    db.execute('DELETE FROM active WHERE id=?', (identifier,))
            count = db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]
            if count >= self.total:
                raise PaidUsageError('本机音乐生成的累计调用额度已用完；请由管理员核对使用记录后调整 MUSIC_PAID_TOTAL_LIMIT，勿重复提交')
            count = db.execute('SELECT COUNT(*) FROM attempts WHERE category=? AND started>=?', (category, day)).fetchone()[0]
            if count >= self.daily[category]:
                label = {'text': '写词、灵感与对话', 'song': '歌曲', 'artwork': '封面'}[category]
                raise PaidUsageError(f'今日{label}调用额度已用完；请在 UTC 次日或由管理员调整 MUSIC_{category.upper()}_DAILY_LIMIT 后重试',
                                     retry_after=max(1, int(day + 86400 - now)))
            recent = db.execute('SELECT COUNT(*),MIN(started) FROM attempts WHERE started>?', (now - 60,)).fetchone()
            if recent[0] >= self.per_minute:
                raise PaidUsageError('提交过于频繁，暂未调用模型；请稍后重试', retry_after=max(1, int((recent[1] or now) + 61 - now)))
            if db.execute('SELECT COUNT(*) FROM active').fetchone()[0] >= self.concurrent:
                raise PaidUsageError('已有模型请求正在处理，暂未新增付费调用；请等待当前请求完成后重试', retry_after=5)
            identifier = uuid.uuid4().hex
            db.execute('INSERT INTO attempts VALUES (?,?,?)', (identifier, category, now))
            db.execute('INSERT INTO active VALUES (?,?,?)', (identifier, os.getpid(), psutil.Process().create_time()))
        return identifier

    def release(self, identifier):
        with self.connection() as db:
            db.execute('DELETE FROM active WHERE id=?', (identifier,))

    @contextmanager
    def call(self, category):
        identifier = self.reserve(category)
        try:
            yield identifier
        finally:
            # A failure releases concurrency only; its durable attempt remains.
            try:
                self.release(identifier)
            except PaidUsageError as error:
                error.attempt_started = True
                raise


@contextmanager
def paid_call(category):
    with PaidUsage.configured().call(category) as identifier:
        yield identifier
