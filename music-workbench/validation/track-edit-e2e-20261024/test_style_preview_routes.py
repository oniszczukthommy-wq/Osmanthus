import http.client
from contextlib import closing
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from test_media_paths import handler_class
from style_previews import available_style_previews


class StylePreviewRouteTests(unittest.TestCase):
    def test_missing_or_unreadable_previews_are_not_listed(self):
        with tempfile.TemporaryDirectory(prefix='style-preview-empty-') as temp:
            self.assertEqual(available_style_previews(temp), [])
            class Unreadable:
                def open(self, mode):
                    raise PermissionError('not readable')
            with patch('style_previews.style_preview_file', return_value=Unreadable()):
                self.assertEqual(available_style_previews(temp), [])

    def test_whitelisted_file_and_range_and_rejected_paths(self):
        with tempfile.TemporaryDirectory(prefix='style-preview-route-') as temp:
            root = Path(temp)
            directory = root / 'assets' / 'style-previews'
            directory.mkdir(parents=True)
            payload = b'ID3' + bytes(range(64))
            (directory / 'lofi.mp3').write_bytes(payload)
            (directory / 'other.mp3').write_bytes(b'not public')
            (directory / 'gentle-piano.mp3').write_bytes(b'')
            with ThreadingHTTPServer(('127.0.0.1', 0), handler_class(root)) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with closing(http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)) as client:
                        client.request('GET', '/api/style-previews')
                        response = client.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(json.loads(response.read()), {'ids': ['lofi']})
                    for route, headers, status, expected in [
                        ('/style-previews/lofi.mp3', {}, 200, payload),
                        ('/style-previews/lofi.mp3', {'Range': 'bytes=3-12'}, 206, payload[3:13]),
                        ('/style-previews/other.mp3', {}, 404, None),
                        ('/style-previews/%2e%2e/other.mp3', {}, 404, None),
                        ('/style-previews/lofi.mp3%2f..%2fother.mp3', {}, 404, None),
                        ('/style-previews/chinese-pop.mp3', {}, 404, None),
                    ]:
                        with self.subTest(route=route), closing(http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)) as client:
                            client.request('GET', route, headers=headers)
                            response = client.getresponse()
                            self.assertEqual(response.status, status)
                            data = response.read()
                            if expected is not None:
                                self.assertEqual(data, expected)
                                self.assertEqual(response.getheader('Accept-Ranges'), 'bytes')
                finally:
                    server.shutdown()
                    thread.join(timeout=3)


if __name__ == '__main__': unittest.main()
