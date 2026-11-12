import tempfile,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import lyrics as m
class GeneratedLyricsTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.audio=self.root/'song.mp3';self.audio.write_bytes(b'identity-only fixture, not musical evidence');self.job={'id':str(uuid.uuid4()),'lyrics':'[Verse]\n走过雨后的清晨'}
 def test_mix_source_fingerprint_does_not_claim_to_be_a_vocal_stem(self):
  context,_=m.generated_context(self.job,self.audio);self.assertIsNone(context['vocal_sha256']);self.assertEqual(context['basis'],'generated_song_mix')
  before=context['source_sha256'];self.audio.write_bytes(b'changed audio');self.assertNotEqual(m.generated_context(self.job,self.audio)[0]['source_sha256'],before)
 def test_pure_music_cannot_start_alignment(self):
  with self.assertRaises(ValueError):m.generated_context({**self.job,'instrumental':True},self.audio)
 def test_repeated_request_reuses_one_alignment_job(self):
  with patch.object(m,'JOBS',self.root/'jobs'),patch.object(m.subprocess,'Popen',return_value=SimpleNamespace(poll=lambda:None)) as spawn:
   service=m.Lyrics();first=service.start_generated(self.job,self.audio);again=service.start_generated(self.job,self.audio)
   self.assertEqual(first['id'],again['id']);self.assertEqual(spawn.call_count,1)
   self.assertEqual(spawn.call_args.kwargs['env']['PYTHONUTF8'],'1');self.assertIn('-X',spawn.call_args.args[0]);self.assertIn('utf8',spawn.call_args.args[0])
 def test_retry_after_failure_starts_one_new_job(self):
  import json
  with patch.object(m,'JOBS',self.root/'jobs'),patch.object(m.subprocess,'Popen',return_value=SimpleNamespace(poll=lambda:None)) as spawn:
   service=m.Lyrics();first=service.start_generated(self.job,self.audio)
   file=m.JOBS/first['id']/'state.json';state=json.loads(file.read_text());state.update(stage='error',error='对齐未完成',created_at=state['created_at']-1);m.save_json(file,state)
   second=service.start_generated(self.job,self.audio);again=service.start_generated(self.job,self.audio)
   self.assertNotEqual(first['id'],second['id']);self.assertEqual(second['id'],again['id']);self.assertEqual(spawn.call_count,2)
if __name__=='__main__':unittest.main()
