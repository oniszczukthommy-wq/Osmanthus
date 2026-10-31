"""Download route regression tests, isolated from app startup and model calls."""
import ast
import http.client
import io
import json
import mimetypes
import os
from pathlib import Path, PureWindowsPath
import re
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlparse
import wave
import zipfile

CODE=Path(__file__).resolve().parent
IDENTIFIER='11111111-1111-4111-8111-111111111111'


def handler_class(root, *, windows=False):
    """Use actual route/serve methods without importing startup/private data."""
    tree=ast.parse((CODE/'server.py').read_text(encoding='utf-8'))
    owner=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
    methods=[n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name in ('json','serve','do_GET')]
    cls=ast.ClassDef(name='DownloadHandler',bases=[ast.Name(id='BaseHTTPRequestHandler',ctx=ast.Load())],keywords=[],body=methods,decorator_list=[])
    scope=dict(BaseHTTPRequestHandler=BaseHTTPRequestHandler,re=re,json=json,os=os,mimetypes=mimetypes,
        Path=PureWindowsPath if windows else Path,unquote=unquote,urlparse=urlparse,ROOT=root,
        LEGACY_DATA=root/'legacy',project_directory=lambda _:root/'project',export_directory=lambda _:root/'exports',
        send_file_chunk=lambda conn,data:(conn.sendall(data) is None))
    from media_paths import media_file
    from preview_cache import open_media
    scope['media_file']=media_file
    scope['open_media']=open_media
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),str(CODE/'server.py'),'exec'),scope)
    scope['DownloadHandler'].log_message=lambda *args:None
    return scope['DownloadHandler']


class DownloadPathTests(unittest.TestCase):
    def dispatch(self,route,root,*,windows=False):
        handler=handler_class(root,windows=windows)
        request=types.SimpleNamespace(path=route,json=lambda status,body:(status,body),serve=lambda file:(200,file))
        return handler.do_GET(request)

    def test_windows_drive_prefix_is_rejected_in_project_route(self):
        result=self.dispatch('/exports/'+IDENTIFIER+'/C:%5Cprivate%5Crecord.zip',PureWindowsPath('C:/Osmanthus'),windows=True)
        self.assertEqual(result[0],404,result)

    def test_windows_paths_and_encoded_traversals_are_rejected_in_both_routes(self):
        attacks=[r'C:\private\record.wav',r'C:record.wav',r'\private\record.wav',r'\\server\share\record.wav',
                 r'\\?\C:\private\record.wav',r'..\record.wav','../record.wav','/private/record.wav',
                 'record.wav:stream.wav','record.wav ','.hidden.wav','CON.wav','nul.mp3','COM1.wav','LPT9.wav',
                 'bad\x00.wav','bad\n.wav','%2e%2e%5crecord.wav','C%3a%5cprivate%5crecord.wav']
        for prefix in ['/audio/','/exports/','/audio/'+IDENTIFIER+'/','/exports/'+IDENTIFIER+'/']:
            for name in attacks:
                with self.subTest(prefix=prefix,name=name):
                    self.assertEqual(self.dispatch(prefix+quote(name,safe=''),PureWindowsPath('C:/Osmanthus'),windows=True)[0],404)

    def test_symlink_outside_requested_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='osmanthus-download-audit-') as temp:
            root=Path(temp);outside=root/'exports-outside';outside.mkdir()
            secret=outside/'private.wav';secret.write_bytes(b'not public')
            for name in ['legacy','project','exports']:
                directory=root/name;directory.mkdir()
                try:(directory/'escape.wav').symlink_to(secret)
                except OSError as error:self.skipTest('Symlink creation unavailable: '+str(error))
            for prefix in ['/audio/','/exports/','/audio/'+IDENTIFIER+'/','/exports/'+IDENTIFIER+'/']:
                with self.subTest(prefix=prefix):self.assertEqual(self.dispatch(prefix+'escape.wav',root)[0],404)

    def test_real_downloads_and_ranges_preserve_wav_mp3_and_zip(self):
        with tempfile.TemporaryDirectory(prefix='Osmanthus 中文 download ') as temp:
            root=Path(temp);payloads={'sample.mp3':b'ID3'+bytes(range(64))};buffer=io.BytesIO()
            with wave.open(buffer,'wb') as output:
                output.setnchannels(1);output.setsampwidth(2);output.setframerate(8000);output.writeframes(bytes(160))
            payloads['sample.wav']=buffer.getvalue();buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w') as archive:archive.writestr('manifest.json','{"test":true}')
            payloads['stems-r1-abc.zip']=buffer.getvalue()
            for name in ['legacy','project','exports']:
                directory=root/name;directory.mkdir()
                for filename,payload in payloads.items():(directory/filename).write_bytes(payload)
            with ThreadingHTTPServer(('127.0.0.1',0),handler_class(root)) as server:
                thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                try:
                    for prefix in ['/audio/','/exports/','/audio/'+IDENTIFIER+'/','/exports/'+IDENTIFIER+'/']:
                        for filename,payload in payloads.items():
                            if filename.endswith('.zip') and prefix!='/exports/'+IDENTIFIER+'/':continue
                            for header,status,expected in [(None,200,payload),('bytes=3-12',206,payload[3:13]),('bytes=-7',206,payload[-7:])]:
                                with self.subTest(prefix=prefix,filename=filename,range=header):
                                    client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                                    try:
                                        client.request('GET',prefix+filename,headers={'Range':header} if header else {})
                                        response=client.getresponse();self.assertEqual(response.status,status)
                                        self.assertEqual(response.read(),expected);self.assertEqual(int(response.getheader('Content-Length')),len(expected))
                                        self.assertEqual(response.getheader('Accept-Ranges'),'bytes')
                                        if prefix.startswith('/exports/'):self.assertIn('attachment;',response.getheader('Content-Disposition'))
                                    finally:client.close()
                    client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                    try:
                        client.request('GET','/audio/'+IDENTIFIER+'/sample.wav',headers={'Range':'bytes=99999-'})
                        response=client.getresponse();self.assertEqual(response.status,416);response.read()
                    finally:client.close()
                    # On Windows this is a real drive-qualified existing file,
                    # not merely a lexical PureWindowsPath reproduction.
                    private=root/'private.wav';private.write_bytes(b'outside download directories')
                    for name in [str(private.resolve()),'missing.wav']:
                        for prefix in ['/audio/','/exports/','/audio/'+IDENTIFIER+'/','/exports/'+IDENTIFIER+'/']:
                            with self.subTest(prefix=prefix,rejected=name):
                                client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                                try:
                                    client.request('GET',prefix+quote(name,safe=''))
                                    response=client.getresponse();self.assertEqual(response.status,404)
                                    self.assertNotIn(b'outside download directories',response.read())
                                finally:client.close()
                finally:server.shutdown();thread.join(timeout=3)


if __name__=='__main__':unittest.main(verbosity=2)
