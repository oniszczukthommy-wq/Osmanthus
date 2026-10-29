import hashlib,http.client,threading,tempfile,unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import numpy as np
from mv_bridge import MVHandoffs,proxy_mv

class HandoffsTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.bridge=MVHandoffs(self.root,Path(__file__).parent.parent/'audiocraft/conda-env/bin/ffmpeg')
        self.body={'request_id':'10000000-0000-4000-8000-000000000001','project_id':'20000000-0000-4000-8000-000000000002','source_kind':'current_mix','revision':4,'fingerprint':'f'*64}
    def tearDown(self):self.temp.cleanup()
    def resolve(self,intent):
        class Snapshot:
            sr=8000
            def mix(self):return np.column_stack([np.sin(np.arange(25600)*.3)*.1]*2).astype('float32')
        return {**intent,'title':'测试歌曲','duration':3.2,'lyrics':'这句歌不能丢','timed_lyrics':[],'snapshot':Snapshot()}
    def test_current_mix_and_idempotency(self):
        first=self.bridge.create(self.body,self.resolve);second=self.bridge.create(self.body,lambda _:self.fail('duplicate rendered again'))
        self.assertEqual(first,second);self.assertEqual(first['revision'],4);self.assertEqual(first['lyrics'],'这句歌不能丢');self.assertNotIn('audio_file',first)
        self.assertEqual(hashlib.sha256(self.bridge.audio(first['id']).read_bytes()).hexdigest(),first['audio_sha256'])
    def test_conflicting_request_does_not_replace_audio(self):
        self.bridge.create(self.body,self.resolve)
        with self.assertRaises(RuntimeError):self.bridge.create({**self.body,'revision':5},self.resolve)
    def test_mutated_audio_is_not_reused(self):
        first=self.bridge.create(self.body,self.resolve);self.bridge.audio(first['id']).write_bytes(b'changed')
        with self.assertRaises(RuntimeError):self.bridge.create(self.body,self.resolve)
    def test_invalid_identity_and_external_file(self):
        with self.assertRaises(ValueError):self.bridge.create({**self.body,'request_id':'../../outside'},self.resolve)
        with self.assertRaises(ValueError):self.bridge.create(self.body,lambda i:{**i,'audio_file':'/etc/hosts'})
    def test_original_audio_is_referenced_without_copy(self):
        original=self.root/'song.mp3';original.write_bytes(b'original bytes')
        b={**self.body,'source_kind':'generated_original','revision':None};v=self.bridge.create(b,lambda i:{**i,'title':'原曲','audio_file':original})
        self.assertEqual(self.bridge.audio(v['id']),original.resolve());self.assertEqual(len(list((self.bridge.directory/'audio').iterdir())),0)

class ProxyTest(unittest.TestCase):
    def test_namespaced_html_range_and_put(self):
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                data=b'<html><head></head><body>MV</body></html>' if self.path=='/' else b'0123456789'
                if self.headers.get('Range'):data=data[2:5];self.send_response(206);self.send_header('Content-Range','bytes 2-4/10')
                else:self.send_response(200)
                self.send_header('Content-Type','text/html' if self.path=='/' else 'video/mp4');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def do_PUT(self):
                data=self.rfile.read(int(self.headers['Content-Length']));self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def do_DELETE(self):
                data=b'{"removed":true}';self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        upstream=ThreadingHTTPServer(('127.0.0.1',0),Upstream);threading.Thread(target=upstream.serve_forever,daemon=True).start();port=upstream.server_port
        class Gateway(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def do_GET(self):proxy_mv(self,port)
            def do_PUT(self):proxy_mv(self,port)
            def do_DELETE(self):proxy_mv(self,port)
        gateway=ThreadingHTTPServer(('127.0.0.1',0),Gateway);threading.Thread(target=gateway.serve_forever,daemon=True).start()
        def req(route,method='GET',data=None,headers=None):
            c=http.client.HTTPConnection('127.0.0.1',gateway.server_port);c.request(method,route,data,headers or {});r=c.getresponse();result=(r.status,r.getheaders(),r.read());c.close();return result
        try:
            self.assertIn(b'<base href="/mv/">',req('/mv/')[2]);status,headers,body=req('/mv/file.mp4',headers={'Range':'bytes=2-4'});self.assertEqual(status,206);self.assertEqual(body,b'234');self.assertIn(('Content-Range','bytes 2-4/10'),headers)
            self.assertEqual(req('/mv/api/project','PUT',b'{"saved":true}')[2],b'{"saved":true}')
            self.assertEqual(req('/mv/api/materials/test-id','DELETE')[2],b'{"removed":true}')
        finally:gateway.shutdown();gateway.server_close();upstream.shutdown();upstream.server_close()
if __name__=='__main__':unittest.main()
