"""Isolated correction/version contracts. No model, service or user-project writes."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import hashlib,json,tempfile,threading,time,unittest,uuid,wave
import scores
import score_review as review

def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False))

class ScoreReviewTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='score-review-contract-');self.root=Path(self.temp.name)
  self.jobs=self.root/'score-jobs';self.jobs.mkdir();self.data=self.root/'project/data';self.data.mkdir(parents=True)
  self.patches=[patch.object(scores,'ROOT',self.root),patch.object(scores,'JOBS',self.jobs),patch.object(review.subprocess,'Popen')]
  for p in self.patches:p.start()
  self.addCleanup(lambda:[p.stop() for p in reversed(self.patches)]);self.addCleanup(self.temp.cleanup)
  self.identifier=str(uuid.uuid4());self.base=str(uuid.uuid4());self.audio=self.data/'vocals.wav'
  with wave.open(str(self.audio),'wb') as f:f.setparams((1,2,8000,0,'NONE','not compressed'));f.writeframes(b'\0\0'*32000)
  self.lyrics='[VERSE]\n晨光好'
  write(self.root/'workflow/runs'/self.identifier/'state.json',{'lyrics':self.lyrics})
  write(self.data/'preparation.json',{'generation_job_id':self.identifier,'project_id':self.identifier,'source_sha256':'a'*64,
    'duration_seconds':4.,'tracks':[{'id':'vocals','file':'vocals.wav','sha256':review.digest(self.audio)}]})
  write(self.data/'project.json',{'id':self.identifier,'revision':7,'tracks':{'vocals':{'voice_variant':'original','muted':False}}})
  self.project=SimpleNamespace(directory=self.data,state={'id':self.identifier,'revision':7})
  self.context=scores.source_context(self.data)[0]
  chars=[{'index':i,'char':char,'line_index':0,'start':start,'end':end,'anchor':start} for i,(char,start,end) in enumerate([('晨',.25,.75),('光',1.,1.5),('好',1.75,2.5)])]
  notes=[]
  for i,(a,b,pitch,index) in enumerate([(.25,.75,60,0),(1.,1.5,62,1),(1.75,2.5,64,None)]):
   notes.append({'id':'n'+str(i+1),'start_seconds':a,'end_seconds':b,'start_beats':a*2,'end_beats':b*2,
    'quantized_start_seconds':a,'quantized_end_seconds':b,'midi':pitch,'midi_float':float(pitch),
    'lyric_index':index,'lyric':chars[index]['char'] if index is not None else '',
    'line_index':0 if index is not None else None,'review_reasons':['test diagnostic'],'pitch_listening_accepted':False})
  self.score={**self.context,'schema_version':1,'title':'测试','duration_seconds':4.,'bpm':120.,'meter':'4/4',
    'key':'C major','key_tonic':'C','key_mode':'major','numbered_tonic_pc':0,'numbered_tonic_name':'C',
    'notation_origin_seconds':0.,'quarter_grid':.25,'measure_count':2,'notes':notes,'lyrics_lines':['晨光好'],
    'lyrics_characters':chars,'unmapped_lyrics':[chars[2]],'review_points':[],
    'summary':{'note_count':3,'lyric_characters':3,'mapped_characters':2,'unmapped_characters':1,'flagged_notes':3}}
  write(self.jobs/self.base/'score.json',self.score)
  self.sha=review.digest(self.jobs/self.base/'score.json')
  state={**self.context,'id':self.base,'stage':'ready','created_at':1.,'finished_at':2.,'summary':self.score['summary'],
    'files':{'score.json':self.sha},'reused_analysis':False}
  write(self.jobs/self.base/'state.json',state)
  self.manager=review.ScoreReviews(scores.Scores());self.original_project=(self.data/'project.json').read_bytes()
  self.original_vocal=self.audio.read_bytes();self.original_score=(self.jobs/self.base/'score.json').read_bytes()
 def request(self,operations=None):
  state=self.manager.get(self.data)
  return {'request_id':str(uuid.uuid4()),'project_id':self.identifier,'revision':7,'review_revision':state['review_revision'],
    'score_job_id':state['active_score_job_id'],'score_sha256':state['active_score_sha256'],
    **({'operations':operations} if operations is not None else {})}
 def create(self,operations=None):
  body=self.request(operations or [{'type':'update_note','note_id':'n1','midi':61}]);job=self.manager.start_candidate(self.project,body)
  return body,job
 def fake_renderer(self,score,folder,data):
  for name in review.FILES-{'score.json'}:(folder/name).write_bytes(('artifact '+name+' '+str(score['notes'][0]['midi'])).encode())
  (folder/'staff-page-1.png').write_bytes(b'fake-page')
 def render(self,job):review.render_job(job['id'],renderer=self.fake_renderer)
 def save_body(self,job=None,confirm=(),unconfirm=()):
  body=self.request();body.update(confirm_note_ids=list(confirm),unconfirm_note_ids=list(unconfirm))
  if job:body.update(score_job_id=job['id'],score_sha256=review.digest(self.jobs/job['id']/'score.json'))
  return body
 def assert_originals(self):
  self.assertEqual((self.data/'project.json').read_bytes(),self.original_project)
  self.assertEqual(self.audio.read_bytes(),self.original_vocal)
  self.assertEqual((self.jobs/self.base/'score.json').read_bytes(),self.original_score)

 def test_baseline_get_is_readonly_and_excludes_mixer_revision(self):
  state=self.manager.get(self.data);self.assertEqual(state['review_revision'],0);self.assertEqual(state['active_score_job_id'],self.base)
  self.assertFalse((self.root/'score-reviews').exists());self.assertNotIn('revision',state['source']);self.assert_originals()

 def test_preview_is_immutable_unapplied_and_render_requires_no_analysis(self):
  _,job=self.create();self.assertEqual(job['stage'],'queued');self.assertEqual(self.manager.get(self.data)['active_score_job_id'],self.base)
  self.assertEqual(scores.Scores().latest(self.data)['id'],self.base)
  self.render(job);state=scores.Scores().read(job['id']);self.assertEqual(state['stage'],'ready')
  candidate=json.loads((self.jobs/job['id']/'score.json').read_text());self.assertEqual(candidate['notes'][0]['midi'],61)
  self.assertEqual(candidate['notes'][1],self.score['notes'][1]);self.assertEqual(scores.Scores().latest(self.data)['id'],self.base)
  self.assert_originals()

 def test_save_reload_protects_confirmed_and_preserves_default_score_recheck(self):
  _,job=self.create();self.render(job);result=self.manager.save(self.project,self.save_body(job,confirm=['n1']))
  self.assertEqual(result['review']['review_revision'],1);self.assertIn('n1',result['review']['confirmed_note_ids'])
  loaded=review.ScoreReviews().get(self.data);self.assertEqual(loaded['active_score_job_id'],job['id'])
  self.assertEqual(scores.Scores().latest(self.data)['id'],job['id'])
  with patch.object(scores.subprocess,'Popen') as spawn:
   preserved=scores.Scores().start(self.project,{'project_id':self.identifier,'request_id':str(uuid.uuid4()),'force_recompute':True})
  self.assertEqual(preserved['id'],job['id']);self.assertTrue(preserved['review_preserved']);spawn.assert_not_called()
  with self.assertRaisesRegex(RuntimeError,'解除确认'):self.create([{'type':'update_note','note_id':'n1','midi':63}])
  self.assert_originals()

 def test_explicit_unlock_is_durable_before_reedit(self):
  self.manager.save(self.project,self.save_body(confirm=['n1']))
  self.manager.save(self.project,self.save_body(unconfirm=['n1']))
  self.assertNotIn('n1',review.ScoreReviews().get(self.data)['confirmed_note_ids'])
  _,job=self.create();self.render(job);self.manager.save(self.project,self.save_body(job,confirm=['n1']))
  self.assertEqual(self.manager.get(self.data)['review_revision'],3);self.assert_originals()

 def test_preview_request_idempotency_and_changed_payload_rejected(self):
  body,job=self.create();self.assertEqual(self.manager.start_candidate(self.project,body)['id'],job['id'])
  bad=deepcopy(body);bad['operations'][0]['midi']=66
  with self.assertRaises(ValueError):self.manager.start_candidate(self.project,bad)
  self.assert_originals()

 def test_save_replay_is_idempotent(self):
  body=self.save_body(confirm=['n1']);first=self.manager.save(self.project,body);again=self.manager.save(self.project,body)
  self.assertEqual(first['review']['review_revision'],again['review']['review_revision']);self.assertTrue(again['replayed'])

 def test_two_views_cannot_silently_overwrite(self):
  a=self.save_body(confirm=['n1']);b=self.save_body(confirm=['n2']);self.manager.save(self.project,a)
  with self.assertRaisesRegex(RuntimeError,'版本已变化'):review.ScoreReviews().save(self.project,b)
  self.assertEqual(self.manager.get(self.data)['confirmed_note_ids'],['n1'])

 def test_simultaneous_saves_use_file_lock(self):
  bodies=[self.save_body(confirm=[key]) for key in ['n1','n2']];barrier=threading.Barrier(2);outcomes=[]
  def save(body):
   barrier.wait()
   try:review.ScoreReviews().save(self.project,body);outcomes.append('saved')
   except RuntimeError:outcomes.append('conflict')
  threads=[threading.Thread(target=save,args=(body,)) for body in bodies]
  for t in threads:t.start()
  for t in threads:t.join(5);self.assertFalse(t.is_alive())
  self.assertCountEqual(outcomes,['saved','conflict']);self.assertEqual(self.manager.get(self.data)['review_revision'],1)

 def test_stale_candidate_cannot_replace_new_confirmation(self):
  _,job=self.create();self.render(job);old_body=self.save_body(job)
  self.manager.save(self.project,self.save_body(confirm=['n2']))
  with self.assertRaises(RuntimeError):self.manager.save(self.project,old_body)
  self.assertEqual(self.manager.get(self.data)['active_score_job_id'],self.base)

 def test_wrong_project_score_and_hash_rejected(self):
  for change in [{'project_id':str(uuid.uuid4())},{'score_job_id':str(uuid.uuid4())},{'score_sha256':'b'*64},{'review_revision':True}]:
   body=self.request([{'type':'update_note','note_id':'n1','midi':61}]);body.update(change)
   with self.subTest(change=change),self.assertRaises((RuntimeError,ValueError)):self.manager.start_candidate(self.project,body)

 def test_actual_vocal_file_integrity_checked(self):
  self.audio.write_bytes(b'changed vocal')
  with self.assertRaisesRegex(RuntimeError,'原唱文件'):self.create()

 def test_source_change_during_render_does_not_publish(self):
  _,job=self.create()
  def renderer(score,folder,data):self.fake_renderer(score,folder,data);self.audio.write_bytes(b'changed vocal')
  with self.assertRaises(RuntimeError):review.render_job(job['id'],renderer=renderer)
  self.assertEqual(scores.Scores().read(job['id'])['stage'],'error')
  self.assertEqual((self.jobs/self.base/'score.json').read_bytes(),self.original_score)

 def test_missing_render_artifact_never_becomes_ready(self):
  _,job=self.create()
  with self.assertRaises(ValueError):review.render_job(job['id'],renderer=lambda *args:None)
  self.assertEqual(scores.Scores().read(job['id'])['stage'],'error');self.assert_originals()

 def test_lyric_link_can_resolve_missing_character_without_changing_text(self):
  _,job=self.create([{'type':'update_note','note_id':'n3','lyric_index':2}]);self.render(job)
  candidate=json.loads((self.jobs/job['id']/'score.json').read_text());self.assertEqual(candidate['notes'][2]['lyric'],'好')
  self.assertEqual(candidate['unmapped_lyrics'],[]);self.assertEqual(candidate['lyrics_characters'],self.score['lyrics_characters'])

 def test_split_note_supports_same_pitch_repeated_word(self):
  _,job=self.create([{'type':'split_note','note_id':'n3','at_seconds':2.,'lyric_index':2}]);self.render(job)
  candidate=json.loads((self.jobs/job['id']/'score.json').read_text());self.assertEqual(len(candidate['notes']),4)
  self.assertEqual(candidate['notes'][-1]['midi'],64);self.assertEqual(candidate['notes'][-1]['lyric'],'好')

 def test_invalid_notes_times_duplicate_lyrics_and_unknown_fields_rejected(self):
  cases=[{'type':'update_note','note_id':'n1','midi':128},
   {'type':'update_note','note_id':'n1','midi':True},
   {'type':'update_note','note_id':'n1','end_seconds':1.3},
   {'type':'update_note','note_id':'n1','start_seconds':float('nan')},
   {'type':'update_note','note_id':'n3','lyric_index':0},
   {'type':'update_note','note_id':'n3','lyric':'new forbidden word'},
   {'type':'add_note','start_seconds':5,'end_seconds':6,'midi':60}]
  for operation in cases:
   with self.subTest(operation=operation),self.assertRaises((ValueError,RuntimeError)):self.create([operation])
  self.assert_originals()

 def test_lyric_order_cannot_be_reversed(self):
  with self.assertRaisesRegex(ValueError,'先后顺序'):
   self.create([{'type':'update_note','note_id':'n1','lyric_index':2}])
  self.assert_originals()

 def test_missing_staff_preview_never_becomes_ready(self):
  _,job=self.create()
  def renderer(score,folder,data):
   self.fake_renderer(score,folder,data);(folder/'staff-page-1.png').unlink()
  with self.assertRaisesRegex(ValueError,'预览文件缺失'):review.render_job(job['id'],renderer=renderer)
  self.assertEqual(scores.Scores().read(job['id'])['stage'],'error');self.assert_originals()

 def test_pitch_only_review_does_not_requantize_or_move_other_notes(self):
  self.score['notes'][0].update(start_seconds=.2501234,end_seconds=.7501234)
  changed,identifiers=review.apply_operations(self.score,[{'type':'update_note','note_id':'n1','midi':61}],{},str(uuid.uuid4()))
  self.assertEqual(changed['notes'][0]['start_seconds'],.2501234)
  self.assertEqual(changed['notes'][0]['start_beats'],self.score['notes'][0]['start_beats'])
  self.assertEqual(changed['notes'][1:],self.score['notes'][1:])

 def test_mixer_change_keeps_score_review_source(self):
  self.manager.save(self.project,self.save_body(confirm=['n1']));prior=self.manager.get(self.data)
  write(self.data/'project.json',{'id':self.identifier,'revision':8,'tracks':{'vocals':{'voice_variant':'original','muted':True,'gain_db':-9}}})
  after=self.manager.get(self.data);self.assertEqual(prior,after)

 def test_legacy_pitch_confirmation_is_scoped_and_protected(self):
  self.score['notes'][0]['pitch_listening_accepted']=True;write(self.jobs/self.base/'score.json',self.score)
  state=scores.Scores().read(self.base);state['files']['score.json']=review.digest(self.jobs/self.base/'score.json');write(self.jobs/self.base/'state.json',state)
  loaded=self.manager.get(self.data);self.assertEqual(loaded['confirmed_notes']['n1']['fields'],['midi'])
  with self.assertRaises(RuntimeError):self.create()

 def test_legacy_pitch_confirmation_blocks_default_automatic_reanalysis(self):
  self.score['notes'][0]['pitch_listening_accepted']=True;write(self.jobs/self.base/'score.json',self.score)
  state=scores.Scores().read(self.base);state['files']['score.json']=review.digest(self.jobs/self.base/'score.json');write(self.jobs/self.base/'state.json',state)
  with patch.object(scores.subprocess,'Popen') as spawn:
   result=scores.Scores().start(self.project,{'project_id':self.identifier,'request_id':str(uuid.uuid4()),'force_recompute':True})
  self.assertEqual(result['id'],self.base);self.assertTrue(result['review_preserved']);spawn.assert_not_called()
  self.assertFalse((self.root/'score-reviews').exists())

 def test_unsaved_candidate_snapshot_does_not_pin_obsolete_automatic_base(self):
  _,candidate=self.create();new=str(uuid.uuid4());write(self.jobs/new/'score.json',self.score)
  state=scores.Scores().read(self.base);state.update(id=new,created_at=100.);write(self.jobs/new/'state.json',state)
  self.assertEqual(self.manager.get(self.data)['active_score_job_id'],new)
  self.assertEqual(scores.Scores().latest(self.data)['id'],new)
  self.render(candidate)
  with self.assertRaises(RuntimeError):self.manager.save(self.project,self.save_body(candidate))

 def test_corrupt_saved_state_does_not_fall_back_to_automatic_score(self):
  self.manager.save(self.project,self.save_body(confirm=['n1']));folder=self.manager._folder(self.context)
  (folder/'state.json').write_text('{broken')
  with self.assertRaises((ValueError,RuntimeError)):scores.Scores().latest(self.data)

 def test_saved_candidate_does_not_claim_whole_score_accuracy(self):
  _,job=self.create();self.render(job);result=self.manager.save(self.project,self.save_body(job,confirm=['n1','n2','n3']))
  self.assertFalse(result['review']['whole_score_accuracy_accepted']);self.assertFalse(result['job']['accuracy_accepted'])

if __name__=='__main__':unittest.main()
