"""Offline contracts for media DNS fallback and server-only authentication."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
import urllib.parse
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location(
    "yinchao_media_download_under_test", Path(__file__).with_name("server.py")
)
media = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {"YINCHAO_API_KEY": "unit-test-provider-token"}):
    spec.loader.exec_module(media)


def dns_response(ip: str):
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps(
        {"Answer": [{"type": 28, "data": "2001:db8::1"}, {"type": 1, "data": ip}]}
    ).encode()
    return response


def completed_process(data: bytes, returncode: int = 0):
    process = MagicMock()
    process.stdout.read.return_value = data
    process.stderr.read.return_value = b"test transport failure" if returncode else b""
    process.wait.return_value = returncode
    process.poll.return_value = returncode
    return process


class MediaDownloadTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(media, "ROOT", self.root))
        self.stack.enter_context(
            patch.dict(os.environ, {"YINCHAO_API_KEY": "unit-test-provider-token"})
        )
        self.process = MagicMock()
        self.popen = self.stack.enter_context(
            patch.object(media.subprocess, "Popen", return_value=self.process)
        )
        self.build_opener = self.stack.enter_context(
            patch.object(
                media.urllib.request, "build_opener",
                side_effect=AssertionError("Unexpected network request in offline test"),
            )
        )
        self.stack.enter_context(
            patch.object(
                media.urllib.request, "urlopen",
                side_effect=AssertionError("Unexpected network request in offline test"),
            )
        )

    def argv(self, call=None):
        return (call or self.popen.call_args).args[0]

    def test_default_cdn_uses_system_dns_and_has_low_speed_guard(self):
        url = "https://api-cdn.yinchaoyongxian.com/audio/example.mp3"
        (self.root / "download-network.json").write_text(
            json.dumps({"resolved_ip": "203.0.113.11"})
        )
        with patch.object(Path, "read_text", side_effect=AssertionError("Stale DNS file read")):
            returned = media.media_curl(url)

        self.assertIs(returned, self.process)
        self.build_opener.assert_not_called()
        args = self.argv()
        self.assertNotIn("--resolve", args)
        self.assertIn(url, args)
        self.assertEqual(args[args.index("--speed-time") + 1], "20")
        self.assertEqual(args[args.index("--speed-limit") + 1], "512")
        self.assertIsNone(self.popen.call_args.kwargs["stdin"])
        self.process.stdin.write.assert_not_called()

    def test_explicit_cdn_fallback_resolves_fresh_a_records_on_each_call(self):
        url = "https://api-cdn.yinchaoyongxian.com/audio/example.mp3"
        opener = MagicMock()
        opener.open.side_effect = [dns_response("198.51.100.41"), dns_response("198.51.100.42")]
        with patch.object(media.urllib.request, "build_opener", return_value=opener):
            with patch.object(Path, "read_text", side_effect=AssertionError("Stale DNS file read")):
                media.media_curl(url, resolve_media=True)
                media.media_curl(url, resolve_media=True)

        self.assertEqual(opener.open.call_count, 2)
        for call in opener.open.call_args_list:
            lookup = urllib.parse.urlparse(call.args[0])
            query = urllib.parse.parse_qs(lookup.query)
            self.assertEqual(lookup.scheme, "https")
            self.assertEqual(query["name"], ["api-cdn.yinchaoyongxian.com"])
            self.assertEqual(query["type"], ["A"])
        resolves = [self.argv(call)[self.argv(call).index("--resolve") + 1]
                    for call in self.popen.call_args_list]
        self.assertEqual(resolves, [
            "api-cdn.yinchaoyongxian.com:443:198.51.100.41",
            "api-cdn.yinchaoyongxian.com:443:198.51.100.42",
        ])
        self.process.stdin.write.assert_not_called()

    def test_official_api_bearer_is_sent_only_through_stdin(self):
        media.media_curl("https://open.yinchaoyongxian.com/audio/stream")
        args = self.argv()
        self.assertEqual(args[args.index("--header") + 1], "@-")
        self.assertEqual(self.popen.call_args.kwargs["stdin"], media.subprocess.PIPE)
        self.assertNotIn("unit-test-provider-token", " ".join(args))
        self.assertNotIn("Authorization", " ".join(args))
        self.process.stdin.write.assert_called_once_with(
            b"Authorization: Bearer unit-test-provider-token\n"
        )
        self.process.stdin.close.assert_called_once()
        self.build_opener.assert_not_called()

    def test_cdn_and_other_hosts_do_not_receive_bearer_or_dns_override(self):
        for host in (
            "api-cdn.yinchaoyongxian.com",
            "media.example.test",
            "open.yinchaoyongxian.com.example.test",
        ):
            with self.subTest(host=host):
                self.popen.reset_mock()
                self.process.reset_mock()
                # The fallback flag must not apply CDN lookup to unrelated hosts.
                fallback = host != "api-cdn.yinchaoyongxian.com"
                media.media_curl(f"https://{host}/audio.mp3", resolve_media=fallback)
                args = self.argv()
                self.assertNotIn("--header", args)
                self.assertNotIn("--resolve", args)
                self.assertNotIn("unit-test-provider-token", " ".join(args))
                self.assertIsNone(self.popen.call_args.kwargs["stdin"])
                self.process.stdin.write.assert_not_called()
        self.build_opener.assert_not_called()

    def test_final_download_retries_normal_dns_then_two_fresh_fallbacks(self):
        folder = self.root / "runs" / "test-job"
        folder.mkdir(parents=True)
        payload = b"offline-audio-fixture" * 1000
        job = {"id": "test-job", "audio_url": "https://api-cdn.yinchaoyongxian.com/final.mp3"}
        attempts = [completed_process(b"", 1), completed_process(b"", 1), completed_process(payload)]
        with patch.object(media, "media_curl", side_effect=attempts) as download:
            with patch.object(media, "event"), patch.object(media.time, "sleep"):
                media.finish_download(job)

        self.assertEqual(download.call_count, 3)
        self.assertEqual(
            [call.kwargs["resolve_media"] for call in download.call_args_list],
            [False, True, True],
        )
        self.assertTrue(job["download_ready"])
        self.assertEqual((folder / "complete.mp3").read_bytes(), payload)
        self.assertIsNone(job["download_error"])
        self.popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
