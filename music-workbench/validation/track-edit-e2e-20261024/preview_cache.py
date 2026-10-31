"""Bounded, rebuildable preview files; never sweep source media or exports.

The byte target is per project. Current tracks and open readers are pinned, so
their necessary working set may exceed the target. There are no worker threads.
All deletion/open decisions share a short process-local lock; transfers do not.
"""
from collections import Counter
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import threading
import time
from weakref import WeakValueDictionary

DEFAULT_MAX_BYTES = 512 * 1024 * 1024
_lock = threading.RLock()
_readers = Counter()
_managers = WeakValueDictionary()
_name = re.compile(r'(vocals|drums|bass|other|piano|guitar|piano_add_[a-f0-9]{10}|guitar_arr_[a-f0-9]{10})-([a-f0-9]{16})\.wav')


def canonical(path):
    return Path(path).resolve()


@contextmanager
def lease(path):
    """Pin a path for a render/read, including the interval before open()."""
    path = canonical(path)
    with _lock:
        _readers[path] += 1
    try:
        yield
    finally:
        with _lock:
            _readers[path] -= 1
            if not _readers[path]:
                del _readers[path]
            manager = _managers.get(path.parent)
            if manager is not None:
                manager.prune()


@contextmanager
def open_media(path):
    """Keep served audio alive through the last byte (also works for non-cache files)."""
    with lease(path):
        try:
            handle = Path(path).open('rb')
        except (FileNotFoundError, IsADirectoryError):
            yield None
            return
        with handle:
            with _lock:
                manager = _managers.get(canonical(path).parent)
                if manager is not None:
                    manager.touch(path)
            yield handle


def for_project(directory, track_ids, source_names):
    directory = canonical(directory)
    with _lock:
        manager = _managers.get(directory)
        if manager is None:
            manager = PreviewCache(directory)
            _managers[directory] = manager
        manager.track_ids.update(track_ids)
        manager.source_names.update(source_names)
        return manager


class PreviewCache:
    def __init__(self, directory):
        self.directory = directory
        self.track_ids = set()
        self.source_names = {'original.wav', 'original.mp3'}
        self.current = set()
        self.last_status = {}

    def protect_current(self, names):
        with _lock:
            self.current = {self.directory / name for name in names}
            return self.prune()

    def touch(self, path):
        # Sidecar mtime is persistent LRU metadata; do not touch the audio stat
        # used to validate its waveform. A missing cache is simply regenerated.
        path = Path(path)
        if path.parent.resolve() != self.directory or not _name.fullmatch(path.name):
            return
        sidecar = path.with_suffix('.peaks.json')
        try:
            if not sidecar.is_symlink():
                stamp = time.time_ns()
                os.utime(sidecar, ns=(stamp, stamp))
        except OSError:
            pass

    def entries(self):
        result = []
        for file in self.directory.glob('*.wav'):
            match = _name.fullmatch(file.name)
            if not match or match[1] not in self.track_ids or file.name in self.source_names:
                continue
            sidecar = file.with_suffix('.peaks.json')
            try:
                if file.is_symlink() or sidecar.is_symlink() or not file.is_file() or not sidecar.is_file():
                    continue
                if file.resolve().parent != self.directory or sidecar.resolve().parent != self.directory:
                    continue
                audio_stat, peaks_stat = file.stat(), sidecar.stat()
                if peaks_stat.st_size > 256 * 1024:
                    continue
                saved = json.loads(sidecar.read_text(encoding='utf-8'))
                if (not isinstance(saved, dict) or saved.get('schema_version') != 1 or
                        saved.get('audio_key') != match[2] or
                        saved.get('audio_stat') != [audio_stat.st_size, audio_stat.st_mtime_ns] or
                        not isinstance(saved.get('peaks'), list) or len(saved['peaks']) != 1000):
                    continue
                result.append((peaks_stat.st_mtime_ns, file, sidecar, audio_stat.st_size + peaks_stat.st_size))
            except (OSError, ValueError, TypeError):
                continue  # Unknown/corrupt artifacts are NOT authorized deletion candidates.
        return result

    def prune(self):
        """Best-effort housekeeping must never turn a committed edit into a failure."""
        with _lock:
            try:
                limit = int(os.environ.get('MUSIC_PREVIEW_CACHE_MAX_BYTES', DEFAULT_MAX_BYTES))
                if limit < 0:
                    raise ValueError('MUSIC_PREVIEW_CACHE_MAX_BYTES must be nonnegative')
                entries = self.entries()
                total = sum(item[3] for item in entries)
                protected = self.current | set(_readers)
                pinned = sum(item[3] for item in entries if item[1] in protected)
                deleted = 0
                for _, file, sidecar, size in sorted(entries):
                    if total <= limit:
                        break
                    if file in protected:
                        continue
                    try:
                        # These paths were proven regular, generated cache files
                        # above and no application reader can acquire them here.
                        file.unlink()
                        total -= size
                        deleted += 1
                        try:
                            sidecar.unlink()
                        except OSError:
                            # Report a leftover sidecar honestly; it is tiny and
                            # cannot be mistaken for source audio on the next run.
                            total += sidecar.stat().st_size if sidecar.exists() else 0
                    except OSError:
                        continue
                self.last_status = {'target_bytes': limit, 'bytes': total, 'protected_bytes': pinned,
                                    'over_target': total > limit, 'removed_files': deleted}
            except (OSError, ValueError, TypeError) as error:
                self.last_status = {**self.last_status, 'cleanup_error': str(error)}
            return dict(self.last_status)
