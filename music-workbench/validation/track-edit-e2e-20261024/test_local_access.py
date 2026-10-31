"""Real HTTP parser regression, with no app startup, user files or paid APIs."""
import ast
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest
from local_access import local_request_allowed

def guarded_handler():
    tree=ast.parse(Path(__file__).with_name('server.py').read_text(encoding='utf-8'))
    owner=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
    guard=next(n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name=='parse_request')
    scope={'BaseHTTPRequestHandler':BaseHTTPRequestHandler,'local_request_allowed':local_request_allowed}
    cls=ast.ClassDef(name='Guarded',bases=[ast.Name(id='BaseHTTPRequestHandler',ctx=ast.Load())],keywords=[],body=[guard],decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),'actual-http-guard','exec'),scope)
    cls=scope['Guarded'];cls.accepted=0
    def accepted(self):
        type(self).accepted+=1;self.send_response(200);self.send_header('Content-Length','0');self.end_headers()
    for method in ['GET','HEAD','POST','PUT','DELETE','OPTIONS']:setattr(cls,'do_'+method,accepted)
    cls.log_message=lambda *args:None
    return cls

class LocalAccessTests(unittest.TestCase):
    def test_actual_parser_rejects_rebinding_for_every_method_and_keeps_loopback(self):
        handler=guarded_handler()
        with ThreadingHTTPServer(('127.0.0.1',0),handler) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            local=f'127.0.0.1:{server.server_port}'
            def request(method,headers,target='/api/project'):
                connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                try:
                    connection.putrequest(method,target,skip_host=True)
                    for k,v in headers:connection.putheader(k,v)
                    connection.endheaders();r=connection.getresponse();r.read();return r.status
                finally:connection.close()
            try:
                attacks=[[],[('Host','evil.example')],[('Host','evil.example'),('Origin','http://evil.example')],
                    [('Host',local),('Host','evil.example')],[('Host',local),('Origin','null')],
                    [('Host',local),('Origin','http://evil.example')],[('Host',local),('Origin','http://'+local),('Origin','http://'+local)],
                    [('Host',local),('Sec-Fetch-Site','cross-site')],[('Host','evil.example'),('X-Forwarded-Host',local)]]
                for method in ['GET','HEAD','POST','PUT','DELETE','OPTIONS']:
                    for headers in attacks:
                        with self.subTest(method=method,headers=headers):self.assertEqual(request(method,headers),403)
                self.assertEqual(handler.accepted,0)
                for host in (local,f'localhost:{server.server_port}'):
                    for method in ('GET','POST','HEAD'):
                        self.assertEqual(request(method,[('Host',host),('Origin','http://'+host)]),200)
                for target in ('http://evil.example/api/project','//evil.example/api/project'):
                    self.assertEqual(request('GET',[('Host',local)],target),403)
            finally:server.shutdown();thread.join(3)

if __name__=='__main__':unittest.main()
