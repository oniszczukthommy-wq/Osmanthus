"""Offline limits regression: isolated ledgers, child processes and fake providers."""
import concurrent.futures
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from paid_usage import PaidUsage, PaidUsageError


class PaidUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / 'usage.sqlite3'
        self.environment = patch.dict(os.environ, {'MUSIC_PAID_USAGE_DB': str(self.file),
            'MUSIC_TEXT_DAILY_LIMIT': '60', 'MUSIC_SONG_DAILY_LIMIT': '6',
            'MUSIC_ARTWORK_DAILY_LIMIT': '6', 'MUSIC_PAID_RATE_PER_MINUTE': '100',
            'MUSIC_PAID_MAX_CONCURRENT': '2', 'MUSIC_PAID_TOTAL_LIMIT': '300'})
        self.environment.start(); self.addCleanup(self.environment.stop)

    def count(self):
        with closing(sqlite3.connect(self.file)) as db:
            return db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]

    def test_failed_attempt_is_retained_and_daily_limit_survives_recreation(self):
        clock = lambda: 1761955201
        ledger = PaidUsage(self.file, daily={'text': 2}, clock=clock)
        with self.assertRaises(TimeoutError), ledger.call('text'):
            raise TimeoutError('provider response unknown')
        with PaidUsage(self.file, daily={'text': 2}, clock=clock).call('text'):
            pass
        with self.assertRaisesRegex(PaidUsageError, '今日'):
            with PaidUsage(self.file, daily={'text': 2}, clock=clock).call('text'): pass
        self.assertEqual(self.count(), 2)
        with PaidUsage(self.file, daily={'text': 2}, clock=lambda: clock()+86400).call('text'): pass
        with self.assertRaisesRegex(PaidUsageError, '累计'):
            with PaidUsage(self.file, total=3).call('song'): pass

    def test_zero_disabled_rate_and_concurrency_are_enforced(self):
        for parameters in [{'daily': {'text': 0}}, {'total': 0}, {'per_minute': 0}, {'concurrent': 0}]:
            with self.assertRaises(PaidUsageError):
                with PaidUsage(self.file, **parameters).call('text'): self.fail('Must not execute provider')
        ledger = PaidUsage(self.file, per_minute=1)
        with ledger.call('text'): pass
        with self.assertRaisesRegex(PaidUsageError, '频繁'):
            with ledger.call('text'): pass

    def test_competing_threads_cannot_overspend_last_slots(self):
        ledger = PaidUsage(self.file, daily={'song': 2}, concurrent=16, per_minute=100)
        def request(_):
            try:
                with ledger.call('song'): return True
            except PaidUsageError: return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(request, range(12))), 2)
        self.assertEqual(self.count(), 2)

    def test_cross_process_active_limit_then_crash_recovery_preserves_attempt(self):
        program = "from paid_usage import PaidUsage; import sys,os; g=PaidUsage(sys.argv[1],concurrent=1); g.reserve('text'); print('reserved',flush=True); sys.stdin.readline(); os._exit(0)"
        child = subprocess.Popen([sys.executable, '-c', program, str(self.file)],
                                 cwd=Path(__file__).parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'reserved')
            with self.assertRaisesRegex(PaidUsageError, '正在处理'):
                with PaidUsage(self.file, concurrent=1).call('song'): pass
            child.communicate('\n', timeout=10)
            with PaidUsage(self.file, concurrent=1).call('song'): pass
            self.assertEqual(self.count(), 2)
        finally:
            if child.poll() is None: child.kill(); child.communicate()

    def test_corrupt_ledger_stops_new_calls(self):
        self.file.write_text('not a sqlite database')
        with self.assertRaises(PaidUsageError) as error:
            with PaidUsage(self.file).call('song'): self.fail('provider must not run')
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.file.read_text(), 'not a sqlite database')

    def test_ledger_directory_failure_stops_new_calls(self):
        blocked = Path(self.temp.name)/'not-a-directory'
        blocked.write_text('keep this file')
        with self.assertRaises(PaidUsageError) as error:
            with PaidUsage(blocked/'usage.sqlite3').call('text'): self.fail('provider must not run')
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(blocked.read_text(), 'keep this file')

    def test_invalid_host_configuration_fails_closed(self):
        with patch.dict(os.environ, {'MUSIC_TEXT_DAILY_LIMIT': 'unlimited'}), self.assertRaises(PaidUsageError):
            PaidUsage.configured()

    def test_provider_post_is_charged_but_poll_is_not(self):
        import provider_http
        from contextlib import contextmanager
        from io import StringIO
        @contextmanager
        def response(*args, **kwargs): yield StringIO('{}')
        with patch('provider_http.urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect = response
            provider_http.request_json('https://open.yinchaoyongxian.com/api/v1/song/generate', 'test-only', {'n': 1})
            provider_http.request_json('https://open.yinchaoyongxian.com/api/v1/task/query?task_id=test', 'test-only')
        self.assertEqual(self.count(), 1)

    def test_inspiration_network_fallback_is_a_separate_attempt(self):
        import inspiration
        from types import SimpleNamespace
        with patch('inspiration.urllib.request.build_opener') as opener, patch('inspiration.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=b'{}')) as curl:
            opener.return_value.open.side_effect = TimeoutError('uncertain first POST')
            self.assertEqual(inspiration.complete({}, 'test-only'), {})
            curl.assert_called_once()
        self.assertEqual(self.count(), 2)
        with patch.dict(os.environ, {'MUSIC_TEXT_DAILY_LIMIT': '3'}), patch('inspiration.urllib.request.build_opener') as opener, patch('inspiration.subprocess.run') as curl:
            opener.return_value.open.side_effect = TimeoutError('uncertain first POST')
            with self.assertRaises(PaidUsageError): inspiration.complete({}, 'test-only')
            curl.assert_not_called()
        self.assertEqual(self.count(), 3)

    def test_cover_actual_submission_is_counted_and_blocked_before_curl(self):
        import artwork
        from types import SimpleNamespace
        output = Path(self.temp.name) / 'response.json'
        with patch.dict(os.environ, {'ARTWORK_API_KEY': 'test-only'}), patch('artwork.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=b'{}')) as curl:
            artwork.call_image({}, output)
            self.assertEqual(self.count(), 1)
            with patch.dict(os.environ, {'MUSIC_ARTWORK_DAILY_LIMIT': '1'}), self.assertRaises(PaidUsageError):
                artwork.call_image({}, output)
            self.assertEqual(curl.call_count, 1)

    def test_draft_thread_limit_rejects_before_creating_unbounded_work(self):
        import uuid
        from types import SimpleNamespace
        from generation_drafts import GenerationDrafts
        release = threading.Event()
        def write(job, **kwargs):
            release.wait(5)
            job.update(title='test', lyrics='original test lyrics')
        work = SimpleNamespace(lock=threading.RLock(), running=set(), jobs={}, lyrics=write)
        drafts = GenerationDrafts(SimpleNamespace(workflow=work, batches={}), Path(self.temp.name)/'drafts')
        body = {'brief': 'a calm original pop song', 'style': '中文流行', 'voice': '温暖男声'}
        workers, failures = [], []
        real_thread = threading.Thread
        def make_worker(*args, **kwargs):
            target = kwargs.pop('target')
            def checked_target(*target_args, **target_kwargs):
                try: target(*target_args, **target_kwargs)
                except BaseException as error: failures.append(error)
            worker = real_thread(*args, target=checked_target, **kwargs)
            workers.append(worker)
            return worker
        with patch('generation_drafts.threading.Thread', side_effect=make_worker):
            try:
                drafts.start({**body, 'request_id': str(uuid.uuid4())})
                drafts.start({**body, 'request_id': str(uuid.uuid4())})
                with self.assertRaises(PaidUsageError): drafts.start({**body, 'request_id': str(uuid.uuid4())})
                self.assertEqual(len(drafts.drafts), 2)
                self.assertEqual(len(drafts.running), 2)
            finally:
                release.set()
                # run() removes its running marker before its final disk write.
                # Wait for actual thread exit before TemporaryDirectory cleanup,
                # especially on Windows where removing an open file fails.
                for worker in workers: worker.join(timeout=10)
                self.assertFalse(any(worker.is_alive() for worker in workers), 'Draft workers did not exit')
        self.assertEqual(failures, [], 'A draft worker raised after its running marker was removed')
        self.assertEqual(len(drafts.running), 0)
        for identifier in drafts.drafts:
            saved = json.loads((drafts.directory/identifier/'state.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['stage'], 'ready')

    def test_assistant_fallback_counts_each_attempt_and_does_not_retry_quota_error(self):
        # Compile the real handler without importing server.py's live project
        # managers, credentials loader or startup recovery.
        import ast
        import time
        import uuid
        import urllib.error
        import urllib.request
        from types import SimpleNamespace
        from paid_usage import paid_call
        tree = ast.parse(Path(__file__).with_name('server.py').read_text())
        function = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == 'assistant')
        scope = {'os': os, 'json': json, 'time': time, 'uuid': uuid, 'urllib': urllib,
                 'tempfile': tempfile, 'subprocess': subprocess, 'paid_call': paid_call,
                 'LOCK': threading.RLock(), 'AUDITS': Path(self.temp.name), 'PRESETS': [],
                 'check_context': lambda body: None, 'save_json': lambda *args: None,
                 'resolve_reference': lambda *args: {'status': 'none'},
                 'SECTIONS': SimpleNamespace(get=lambda directory: {}),
                 'PROJECT': SimpleNamespace(directory=Path(self.temp.name),
                     meta={'duration_seconds': 30, 'tracks': []},
                     state={'id': 'offline-project', 'tracks': {}, 'revision': 0}, view=lambda: {})}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'server.py', 'exec'), scope)
        body = {'message': '请说明当前选区', 'project_id': 'offline-project', 'revision': 0}
        result = {'choices': [{'message': {'content': '请选择区间'}}]}
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'test-only', 'MUSIC_TEXT_DAILY_LIMIT': '3'}), \
             patch('urllib.request.build_opener') as opener, \
             patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(result).encode())) as curl:
            opener.return_value.open.side_effect = TimeoutError('uncertain first POST')
            self.assertFalse(scope['assistant'](body)['applied'])
            self.assertEqual(self.count(), 2)
            self.assertEqual(curl.call_count, 1)
            with self.assertRaises(PaidUsageError): scope['assistant'](body)
            self.assertEqual(self.count(), 3)
            self.assertEqual(curl.call_count, 1)
            with self.assertRaises(PaidUsageError): scope['assistant'](body)
            self.assertEqual(opener.return_value.open.call_count, 2)
            self.assertEqual(curl.call_count, 1)

    def test_cover_quota_rejection_is_resumable_without_ambiguous_submission(self):
        import artwork
        import uuid
        reference = {'project_id': str(uuid.uuid4()), 'title': '离线封面',
                     'lyrics': '离线测试歌词', 'style': '中文流行', 'source_sha256': ''}
        manager = artwork.Artwork(Path(self.temp.name))
        with patch.object(manager, 'launch_next'), patch.dict(os.environ, {'ARTWORK_API_KEY': 'test-only', 'MUSIC_ARTWORK_DAILY_LIMIT': '0'}), patch('artwork.subprocess.run') as curl:
            created = manager.ensure(reference)
            job = manager.read(created['id'])
            manager.run(job)
            self.assertEqual(job['stage'], 'error')
            self.assertFalse(job['submission_started'])
            self.assertTrue(job['usage_blocked'])
            curl.assert_not_called()
            self.assertEqual(manager.resume(job['id'])['stage'], 'queued')
            self.assertFalse(job['usage_blocked'])

    def test_song_block_has_no_ambiguous_submission_and_existing_task_still_polls(self):
        import time
        import uuid
        import workflow
        from contextlib import contextmanager
        from io import StringIO
        stream = workflow.STREAM
        job = {'id': str(uuid.uuid4()), 'model': 'test-model', 'prompt': 'test',
               'lyrics': 'test', 'status': 'new', 'events': [], 'created_at': time.time()}
        (Path(self.temp.name)/'runs'/job['id']).mkdir(parents=True)
        @contextmanager
        def response(*args, **kwargs):
            yield StringIO(json.dumps({'choices': [{'status': 'done', 'duration': 30,
                                                    'audio_url': 'https://example.test/audio.mp3'}]}))
        with patch.object(stream, 'ROOT', Path(self.temp.name)), patch.object(stream, 'event'), \
             patch.object(stream, 'persist'), patch.object(stream, 'finish_download') as download, \
             patch.dict(os.environ, {'YINCHAO_API_KEY': 'test-only', 'MUSIC_SONG_DAILY_LIMIT': '0'}), \
             patch('provider_http.urllib.request.build_opener') as opener:
            stream.worker(job)
            self.assertEqual(job['status'], 'error')
            self.assertFalse(job['submission_started'])
            opener.return_value.open.assert_not_called()
            job.update(task_id='existing-paid-task', status='pending')
            opener.return_value.open.side_effect = response
            stream.worker(job)
            self.assertEqual(job['status'], 'done')
            self.assertEqual(opener.return_value.open.call_count, 1)
            self.assertEqual(opener.return_value.open.call_args.args[0].get_method(), 'GET')
            download.assert_called_once_with(job)


if __name__ == '__main__': unittest.main()
