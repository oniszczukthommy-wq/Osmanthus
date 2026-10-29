"""Actual-song invariants in a disposable project; never edits the user's song."""
from pathlib import Path
from copy import deepcopy
import hashlib,json,sys,tempfile
import numpy as np
ROOT=Path(__file__).resolve().parent;APP=ROOT.parent/'track-edit-e2e-20261024';sys.path.insert(0,str(APP))
from project import Project
from scores import Scores,source_context
from vocals import Vocals,reference
DATA=APP/'projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data'

def main():
 checks={};original_sha=hashlib.sha256((DATA/'project.json').read_bytes()).hexdigest();manager=Vocals();job=manager.read('5a07a5ca-b01c-4fcd-8c9a-240ae6519761');variant=job['candidate']['id']
 with tempfile.TemporaryDirectory() as tmp:
  directory=Path(tmp)
  for f in DATA.iterdir():
   if not f.is_file() or f.name.startswith('.'):continue
   if f.name in ('project.json','vocal-variants.json'):directory.joinpath(f.name).write_bytes(f.read_bytes())
   else:directory.joinpath(f.name).symlink_to(f.resolve())
  p=Project(directory);snapshot=p.file.read_bytes()
  try:p.apply({'type':'vocal_variant','track_id':'vocals','variant_id':variant},'manual',p.state['revision'])
  except ValueError:checks['rejected_candidate_cannot_apply']=p.file.read_bytes()==snapshot
  manifest_file=directory/'vocal-variants.json';manifest=json.loads(manifest_file.read_text())
  for candidate in manifest['variants']:candidate.pop('rejected_by_user',None)
  manifest_file.write_text(json.dumps(manifest));p=Project(directory)
  before=p.mix();fingerprint=p.fingerprint();tracks=deepcopy(p.state['tracks']);keys={name:p.track_digest(name) for name in tracks};oldcontext,_=source_context(directory)
  checks['original_score_accepted']=Scores().latest(directory)['accuracy_accepted']
  revision=p.state['revision'];p.apply({'type':'vocal_variant','track_id':'vocals','variant_id':variant},'manual',revision)
  after=p.mix();checks['only_vocal_state_changes']=all(v==p.state['tracks'][name] for name,v in tracks.items() if name!='vocals')
  checks['vocal_mix_and_segment_edits_kept']=all(v==p.state['tracks']['vocals'][key] for key,v in tracks['vocals'].items())
  checks['vocal_buffer_changes']=p.track_digest('vocals')!=keys['vocals'];checks['other_buffer_keys_unchanged']=all(p.track_digest(name)==key for name,key in keys.items() if name!='vocals')
  new_source=p.vocal_source(variant);original=p.audio['vocals'];env=p.envelope('vocals')[:,None];settings=p.state['tracks']['vocals']
  expected=(new_source-original)*env*(10**(settings['gain_db']/20))*p.meta['master_gain']
  if settings['muted']:expected[:]=0
  error=float(np.max(np.abs((after-before)-expected)));checks['mix_difference_only_new_vocal']=error<5e-7
  newcontext,_=source_context(directory);checks['resinging_changes_score_source']=newcontext['vocal_sha256']!=oldcontext['vocal_sha256'] and newcontext['basis']=='resynthesized_complete_lead_vocal'
  checks['old_score_not_reused_for_new_performance']=Scores().latest(directory) is None
  checks['old_human_correction_not_transferred']=newcontext['corrections_sha256']==hashlib.sha256(b'[]').hexdigest()
  checks['same_song_length_and_shape']=new_source.shape==original.shape
  checks['new_performance_non_silent_finite']=bool(np.isfinite(new_source).all() and np.sqrt(np.mean(new_source**2))>.001)
  checks['new_performance_no_clipping']=float(np.max(np.abs(new_source)))<1
  checks['reference_for_new_take_stays_pinned']=reference(p)['score_job_id']==job['candidate']['source_score_job_id']
  p.move_history('undo',p.state['revision']);checks['undo_exact_original_mix']=np.array_equal(before,p.mix()) and p.fingerprint()==fingerprint
  checks['undo_restores_accepted_original_score']=Scores().latest(directory)['accuracy_accepted']
  p.move_history('redo',p.state['revision']);checks['redo_exact_new_mix']=np.array_equal(after,p.mix())
  reloaded=Project(directory);checks['restart_keeps_selected_voice']=np.array_equal(after,reloaded.mix())
  reloaded.apply({'type':'vocal_variant','track_id':'vocals','variant_id':'original'},'manual',reloaded.state['revision']);checks['restore_original_exact_mix']=np.array_equal(before,reloaded.mix()) and reloaded.fingerprint()==fingerprint
  before_file=(directory/'project.json').read_bytes()
  try:reloaded.apply({'type':'vocal_variant','track_id':'vocals','variant_id':'missing'},'manual',reloaded.state['revision'])
  except ValueError:checks['invalid_voice_does_not_write']=(directory/'project.json').read_bytes()==before_file
  try:reloaded.apply({'type':'vocal_variant','track_id':'drums','variant_id':variant},'manual',reloaded.state['revision'])
  except ValueError:checks['wrong_track_does_not_write']=(directory/'project.json').read_bytes()==before_file
 checks['real_user_project_untouched']=hashlib.sha256((DATA/'project.json').read_bytes()).hexdigest()==original_sha
 result={'status':'passed' if all(checks.values()) else 'failed','checks':checks,'max_mix_invariant_error':error,'scope':'Real 94.77-second song in temporary copy; rejection removed ONLY in disposable fixture to test generic mechanics. Live candidate remains rejected.'}
 (ROOT/'variant-invariants.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2));assert all(checks.values())
if __name__=='__main__':main()
