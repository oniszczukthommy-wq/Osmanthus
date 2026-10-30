import io,unittest,time
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
 def relay(self,code,kind='stream'):
  output=io.BytesIO();handler=SimpleNamespace(wfile=output,send_response=Mock(),send_header=Mock(),end_headers=Mock(),json=Mock(),close_connection=False)
  reads=iter([b'abc',b'']);process=SimpleNamespace(stdout=SimpleNamespace(read1=lambda _:next(reads)),stderr=io.BytesIO(b'connection dropped'),wait=lambda **_:code,poll=lambda:code)
  job={'id':'test','created_at':time.time(),'status':'stream','events':[],'pipe_url':'https://example.test/stream','audio_url':'https://example.test/final'}
  with patch.object(w.STREAM,'media_curl',return_value=process) as fetch,patch.object(w.STREAM,'event'):
   w.STREAM.Handler.send_stream(handler,job,kind)
  return handler,output.getvalue(),fetch
 def test_broken_upstream_is_not_reported_as_a_clean_audio_end(self):
  handler,data,_=self.relay(28);self.assertNotIn(b'0\r\n\r\n',data);self.assertTrue(handler.close_connection);handler.json.assert_not_called()
 def test_complete_preview_uses_final_remote_address_without_local_download(self):
  handler,data,fetch=self.relay(0,'preview_complete');self.assertEqual(fetch.call_args.args[0],'https://example.test/final');self.assertTrue(data.endswith(b'0\r\n\r\n'))
if __name__=='__main__':unittest.main()
