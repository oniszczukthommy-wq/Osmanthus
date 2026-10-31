import io,unittest,time,tempfile,threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,Mock
import workflow as w
class StreamTransportTests(unittest.TestCase):
 def args(self,url):
  with patch.dict(w.os.environ,{'YINCHAO_API_KEY':'test-only'}),patch.object(w.STREAM.subprocess,'Popen',return_value=SimpleNamespace(stdin=io.BytesIO())) as call:
   w.STREAM.media_curl(url)
  return call.call_args.args[0]
 def test_generation_pause_is_not_aborted_by_file_download_low_speed_watchdog(self):
  args=self.args('https://open.yinchaoyongxian.com/api/v1/song/stream/example')
  self.assertNotIn('--speed-time',args);self.assertNotIn('--speed-limit',args);self.assertIn('--connect-timeout',args)
  self.assertNotIn('test-only',' '.join(args))
 def test_completed_download_retains_slow_connection_guard(self):
  self.assertIn('--speed-time',self.args('https://api-cdn.yinchaoyongxian.com/song.mp3'))
 def test_connection_setup_is_bounded_and_does_not_disable_tls_verification(self):
  args=self.args('https://api-cdn.yinchaoyongxian.com/song.mp3')
  self.assertIn('--http1.1',args);self.assertEqual(args[args.index('--connect-timeout')+1],'5');self.assertNotIn('--insecure',args)
 def relay(self,code,kind='stream'):
  output=io.BytesIO();handler=SimpleNamespace(wfile=output,send_response=Mock(),send_header=Mock(),end_headers=Mock(),json=Mock(),close_connection=False)
  reads=iter([b'abc',b'']);process=SimpleNamespace(stdout=SimpleNamespace(read1=lambda _:next(reads)),stderr=io.BytesIO(b'connection dropped'),wait=lambda **_:code,poll=lambda:code)
  job={'id':'test','created_at':time.time(),'status':'stream','events':[],'pipe_url':'https://example.test/stream','audio_url':'https://example.test/final'}
  with patch.object(w.STREAM,'media_curl',return_value=process) as fetch,patch.object(w.STREAM,'event'):
   w.STREAM.Handler.send_stream(handler,job,kind)
  return handler,output.getvalue(),fetch
 def test_broken_upstream_is_not_reported_as_a_clean_audio_end(self):
  handler,data,_=self.relay(28);self.assertNotIn(b'0\r\n\r\n',data);self.assertTrue(handler.close_connection);handler.json.assert_not_called()
 def test_complete_preview_uses_shared_cache_instead_of_a_second_remote_transfer(self):
  with patch.object(w.STREAM.Handler,'send_cached_preview') as cached:
   job={'id':'test'};handler=object();w.STREAM.Handler.send_stream(handler,job,'preview_complete')
  cached.assert_called_once_with(handler,job)

class CompletedDownloadTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.root_patch=patch.object(w.STREAM,'ROOT',self.root);self.root_patch.start()
  self.event_patch=patch.object(w.STREAM,'event');self.events=self.event_patch.start()
  self.data=b'ID3'+b'a'*25000+b'b'*30000
  self.job={'id':'test','created_at':time.time(),'status':'done','events':[],'audio_url':'https://example.test/song.mp3'}
 def tearDown(self):
  self.root_patch.stop();self.event_patch.stop();self.tmp.cleanup()
 def process(self,parts,code=0):
  chunks=iter(parts+[b''])
  return SimpleNamespace(stdout=SimpleNamespace(read1=lambda _:next(chunks)),stderr=io.BytesIO(b'interrupted' if code else b''),wait=lambda **_:code,poll=lambda:code)
 def headers(self,path,status=200,offset=0,total=None,etag='v1'):
  total=total or len(self.data);extra=f'Content-Range: bytes {offset}-{total-1}/{total}\r\n' if status==206 else ''
  # curl writes HTTP wire bytes. Text mode on Windows would turn CRLF into
  # CRCRLF, manufacturing blank header blocks that real curl does not produce.
  path.write_bytes(f'HTTP/1.1 {status} OK\r\nContent-Length: {total-offset}\r\nETag: {etag}\r\n{extra}\r\n'.encode('ascii'))
 def test_header_fixture_preserves_curl_wire_bytes_on_windows(self):
  # Reproduce Windows text-mode newline translation even on POSIX runners.
  original=Path.write_text
  def windows_text(path,value,**kw):
   kw.setdefault('newline','\r\n');return original(path,value,**kw)
  file=self.root/'response.headers'
  with patch.object(Path,'write_text',windows_text):self.headers(file,206,12000)
  self.assertNotIn(b'\r\r\n',file.read_bytes())
  self.assertEqual(w.STREAM.response_headers(file),(206,{'content-length':str(len(self.data)-12000),
   'etag':'v1','content-range':f'bytes 12000-{len(self.data)-1}/{len(self.data)}'}))
 def test_partial_disconnect_resumes_exact_bytes_without_duplication(self):
  offsets=[]
  def fetch(url,**kw):
   offsets.append(kw['offset']);self.headers(kw['headers_path'],206 if kw['offset'] else 200,kw['offset'])
   return self.process([self.data[:12000]],18) if not kw['offset'] else self.process([self.data[kw['offset']:]])
  with patch.object(w.STREAM,'media_curl',side_effect=fetch):w.STREAM.finish_download(self.job)
  self.assertEqual(offsets,[0,12000]);self.assertTrue(self.job['download_ready']);self.assertEqual((self.root/'runs/test/complete.mp3').read_bytes(),self.data)
 def test_preview_and_saver_share_transfer_and_play_before_download_finishes(self):
  first=threading.Event();release=threading.Event();calls=[]
  def fetch(url,**kw):
   calls.append(url);self.headers(kw['headers_path']);parts=iter([self.data[:12000],self.data[12000:],b''])
   def read(_):
    chunk=next(parts)
    if chunk==self.data[12000:]:first.set();release.wait(3)
    return chunk
   return SimpleNamespace(stdout=SimpleNamespace(read1=read),stderr=io.BytesIO(),wait=lambda **_:0,poll=lambda:0)
  with patch.object(w.STREAM,'media_curl',side_effect=fetch):
   saver=threading.Thread(target=w.STREAM.finish_download,args=(self.job,));saver.start()
   self.assertTrue(first.wait(2));state=w.STREAM.completed_download(self.job)
   self.assertEqual(state.read(0),self.data[:12000]);self.assertFalse(self.job.get('download_ready',False));self.assertFalse(state.file.exists())
   release.set();saver.join(3);self.assertFalse(saver.is_alive());self.assertEqual(state.read(12000),self.data[12000:]);self.assertEqual(state.read(len(self.data)),b'')
  self.assertEqual(len(calls),1);self.assertEqual(state.file.read_bytes(),self.data)
 def test_ignored_resume_range_does_not_append_duplicate_audio_or_mark_complete(self):
  calls=[]
  def fetch(url,**kw):
   calls.append(kw['offset']);self.headers(kw['headers_path'])
   return self.process([self.data[:12000]],18) if not kw['offset'] else self.process([self.data])
  with patch.object(w.STREAM,'media_curl',side_effect=fetch):w.STREAM.finish_download(self.job)
  state=w.STREAM.completed_download(self.job)
  self.assertEqual(state.size,12000);self.assertFalse(self.job.get('download_ready',False));self.assertFalse(state.file.exists())
  with self.assertRaisesRegex(RuntimeError,'range'):state.read(12000)
  self.assertEqual(calls,[0,12000,12000,12000,12000])
 def test_changed_etag_rejects_resume_without_mixing_two_files(self):
  def fetch(url,**kw):
   offset=kw['offset'];self.headers(kw['headers_path'],206 if offset else 200,offset,etag='v2' if offset else 'v1')
   return self.process([self.data[:12000]],18) if not offset else self.process([self.data[offset:]])
  with patch.object(w.STREAM,'media_curl',side_effect=fetch):w.STREAM.finish_download(self.job)
  state=w.STREAM.completed_download(self.job);self.assertEqual(state.size,12000);self.assertIn('content changed',state.error)
 def test_incomplete_file_is_never_published_and_explicit_recovery_can_retry(self):
  def broken(url,**kw):self.headers(kw['headers_path'],206 if kw['offset'] else 200,kw['offset']);return self.process([self.data[:2000]],18)
  with patch.object(w.STREAM,'media_curl',side_effect=broken):w.STREAM.finish_download(self.job)
  self.assertFalse((self.root/'runs/test/complete.mp3').exists())
  def good(url,**kw):self.headers(kw['headers_path']);return self.process([self.data])
  with patch.object(w.STREAM,'media_curl',side_effect=good):w.STREAM.finish_download(self.job)
  self.assertEqual((self.root/'runs/test/complete.mp3').read_bytes(),self.data);self.assertTrue(self.job['download_ready'])
if __name__=='__main__':unittest.main()
