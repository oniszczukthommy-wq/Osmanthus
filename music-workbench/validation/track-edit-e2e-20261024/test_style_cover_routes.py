"""Exercise style cover routing without starting the application or model jobs."""
from contextlib import closing
import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest

from style_previews import STYLE_PREVIEW_IDS
from test_media_paths import handler_class


class StyleCoverRouteTests(unittest.TestCase):
    def test_webp_whitelist_range_and_rejected_paths(self):
        with tempfile.TemporaryDirectory(prefix='style-cover-route-') as temp:
            root = Path(temp)
            directory = root / 'assets' / 'style-covers'
            directory.mkdir(parents=True)
            payload = b'RIFF\x48\x00\x00\x00WEBP' + bytes(range(64))
            (directory / 'lofi.webp').write_bytes(payload)
            (directory / 'unknown.webp').write_bytes(b'must not be exposed')
            (root / 'outside.webp').write_bytes(b'outside the cover directory')
            handler = handler_class(root)
            # The shared handler fixture compiles only server methods; expose the
            # same whitelist imported by the real server module.
            handler.do_GET.__globals__['STYLE_PREVIEW_IDS'] = STYLE_PREVIEW_IDS
            with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    cases = [
                        ('/assets/style-covers/lofi.webp', {}, 200, payload),
                        ('/assets/style-covers/lofi.webp', {'Range': 'bytes=1-4'}, 206, payload[1:5]),
                        ('/assets/style-covers/chinese-pop.webp', {}, 404, None),
                        ('/assets/style-covers/unknown.webp', {}, 404, None),
                        ('/assets/style-covers/%2e%2e/outside.webp', {}, 404, None),
                        ('/assets/style-covers/lofi.webp%2f..%2foutside.webp', {}, 404, None),
                        ('/assets/style-covers/%2e%2e%5coutside.webp', {}, 404, None),
                        ('/assets/style-covers/lofi.jpg', {}, 404, None),
                        ('/assets/style-covers/LOFI.webp', {}, 404, None),
                    ]
                    for route, headers, status, expected in cases:
                        with self.subTest(route=route, headers=headers), closing(
                            http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                        ) as client:
                            client.request('GET', route, headers=headers)
                            response = client.getresponse()
                            self.assertEqual(response.status, status)
                            body = response.read()
                            if expected is not None:
                                self.assertEqual(body, expected)
                                self.assertEqual(response.getheader('Content-Type'), 'image/webp')
                                self.assertEqual(response.getheader('Accept-Ranges'), 'bytes')
                            else:
                                self.assertNotIn(b'must not be exposed', body)
                                self.assertNotIn(b'outside the cover directory', body)
                finally:
                    server.shutdown()
                    thread.join(timeout=3)

    def test_cover_symlink_cannot_escape_directory(self):
        with tempfile.TemporaryDirectory(prefix='style-cover-symlink-') as temp:
            root = Path(temp)
            directory = root / 'assets' / 'style-covers'
            directory.mkdir(parents=True)
            outside = root / 'outside.webp'
            outside.write_bytes(b'outside')
            try:
                (directory / 'lofi.webp').symlink_to(outside)
            except OSError as error:
                self.skipTest('Symlink creation unavailable: ' + str(error))
            handler = handler_class(root)
            handler.do_GET.__globals__['STYLE_PREVIEW_IDS'] = STYLE_PREVIEW_IDS
            with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with closing(http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)) as client:
                        client.request('GET', '/assets/style-covers/lofi.webp')
                        response = client.getresponse()
                        self.assertEqual(response.status, 404)
                        self.assertNotIn(b'outside', response.read())
                finally:
                    server.shutdown()
                    thread.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
