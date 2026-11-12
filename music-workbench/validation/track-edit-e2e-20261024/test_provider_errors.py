"""Offline tests for safe, actionable provider failures; no external requests."""
from contextlib import nullcontext
import io
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

import provider_errors
import provider_http
import workflow


class ProviderErrorTests(unittest.TestCase):
    def test_curl_status_marker_is_removed_before_json_parsing(self):
        body, status = provider_errors.split_curl_response(b'{"choices":[]}\n__OSMANTHUS_HTTP_STATUS__:200')
        self.assertEqual(body, b'{"choices":[]}')
        self.assertEqual(status, 200)

    def test_statuses_distinguish_balance_auth_limit_and_rejection(self):
        for status, fragment in ((402, '额度'), (401, '身份验证'), (403, '权限'),
                                 (429, '限流'), (422, '未接受')):
            with self.subTest(status=status):
                self.assertIn(fragment, provider_errors.http_failure(status, 'lyrics'))
                self.assertIn('原输入已保留', provider_errors.http_failure(status, 'lyrics'))

    def test_http_body_is_never_revealed_for_music(self):
        sentinel = 'secret-provider-body-with-another-key'
        error = urllib.error.HTTPError('https://example.invalid', 402, 'failed', {},
                                       io.BytesIO(sentinel.encode()))
        with patch('provider_http.urllib.request.build_opener') as opener, \
             patch('provider_http.paid_call', return_value=nullcontext()):
            opener.return_value.open.side_effect = error
            with self.assertRaises(RuntimeError) as caught:
                provider_http.request_json('https://example.invalid', 'fake-key', {'test': True})
        message = str(caught.exception)
        self.assertIn('额度', message)
        self.assertNotIn(sentinel, message)
        self.assertNotIn('fake-key', message)

    def test_music_submission_network_failure_is_not_retried(self):
        with patch('provider_http.urllib.request.build_opener') as opener, \
             patch('provider_http.paid_call', return_value=nullcontext()):
            opener.return_value.open.side_effect = urllib.error.URLError('internal network detail')
            with self.assertRaisesRegex(RuntimeError, '结果尚未确认'):
                provider_http.request_json('https://example.invalid', 'fake-key', {'test': True})
            self.assertEqual(opener.return_value.open.call_count, 1)
            with self.assertRaises(urllib.error.URLError):
                provider_http.request_json('https://example.invalid', 'fake-key')

    def test_conflicting_submission_is_treated_as_uncertain(self):
        message = provider_errors.http_failure(409, 'music', submission=True)
        self.assertIn('结果尚未确认', message)
        self.assertNotIn('未接受请求', message)

    def test_lyrics_status_and_timeout_do_not_echo_provider_output(self):
        samples = [(SimpleNamespace(returncode=22, stdout=b'private detail\n__OSMANTHUS_HTTP_STATUS__:402'), '额度'),
                   (SimpleNamespace(returncode=22, stdout=b'private detail\n__OSMANTHUS_HTTP_STATUS__:401'), '身份验证'),
                   (SimpleNamespace(returncode=28, stdout=b'private detail\n__OSMANTHUS_HTTP_STATUS__:000'), '超时'),
                   (subprocess.TimeoutExpired('curl', 80), '超时')]
        for result, expected in samples:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as folder, \
                 patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fake-secret'}), \
                 patch('paid_usage.paid_call', return_value=nullcontext()), \
                 patch('workflow.subprocess.run') as run:
                if isinstance(result, Exception):
                    run.side_effect = result
                else:
                    run.return_value = result
                job = {'id': 'test', 'brief': '测试', 'style': '民谣', 'voice': '自然'}
                with self.assertRaises(RuntimeError) as caught:
                    workflow.Workflow.lyrics(None, job, folder=Path(folder), persist_result=False)
                message = str(caught.exception)
                self.assertIn(expected, message)
                self.assertNotIn('fake-secret', message)
                self.assertNotIn('private detail', message)
                self.assertEqual(run.call_count, 1)

    def test_provider_task_failure_does_not_echo_provider_error(self):
        stream = workflow.STREAM
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(stream, 'ROOT', Path(directory)), \
             patch.object(stream, 'persist'), patch.object(stream, 'event'), \
             patch.object(stream, 'request_json', return_value={
                 'choices': [{'status': 'fail', 'error': 'private provider detail'}]}):
            (Path(directory) / 'runs' / 'safe-test').mkdir(parents=True)
            job = {'id': 'safe-test', 'task_id': 'existing-test-task',
                   'status': 'pending', 'created_at': 0, 'events': []}
            stream.worker(job)
            self.assertEqual(job['status'], 'error')
            self.assertIn('失败或取消', job['error'])
            self.assertNotIn('private provider detail', job['error'])

    def test_legacy_workflow_restart_never_launches_paid_or_artwork_work(self):
        manager = workflow.Workflow.__new__(workflow.Workflow)
        known = {'id': 'known', 'created_at': 1, 'stage': 'generating',
                 'task_id': 'provider-task', 'submission_started': True}
        unsent = {'id': 'unsent', 'created_at': 2, 'stage': 'lyrics'}
        complete = {'id': 'complete', 'created_at': 3, 'stage': 'ready'}
        manager.jobs = {j['id']: j for j in (known, unsent, complete)}
        with patch.object(manager, 'launch') as launch, patch.object(manager, 'stage') as stage:
            manager.recover();manager.recover()
            launch.assert_not_called();stage.assert_not_called()
        self.assertEqual(known['stage'], 'error')
        self.assertIn('手动恢复', known['error'])
        self.assertEqual(unsent['stage'], 'error')
        self.assertEqual(complete['stage'], 'ready')


if __name__ == '__main__':
    unittest.main()
