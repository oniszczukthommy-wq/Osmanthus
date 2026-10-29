"""Actual audio replacement invariants; never mutate the user's live state."""
from copy import deepcopy
from pathlib import Path
import hashlib,json,tempfile,uuid
import numpy as np
from project import Project,ROOT,save_json
from arrangements import Arrangements
from reorchestration import source_job,voicing

def main():
 source=ROOT/'projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data'
 original=Project(source);live_state=deepcopy(original.state);state=deepcopy(live_state);checks={};out=ROOT/'reorchestration-acceptance'
 job=json.loads((out/'job.json').read_text());full=json.loads((ROOT/'arrangement-jobs'/job['id']/'state.json').read_text())
 candidate=full['result']['track'];track_id=candidate['id'];piano=candidate['replaces_track_id']
 # The user may already have applied this candidate. Reconstruct its recorded
 # starting state only inside the temporary fixture, keeping live edits intact.
 state['tracks'].pop(track_id,None);state['tracks'][piano]=deepcopy(candidate['source_track_state'])
 state.update(history=[],cursor=0,revision=0)
 audit=json.loads((ROOT/'arrangement-jobs'/job['id']/'audit.json').read_text());checks.update(audit['compliance_checks'])
 for pc in range(12):
  for third in (3,4):voicing({'root':pc,'pitch_classes':[pc,(pc+third)%12,(pc+7)%12]})
 checks['all_24_triad_shapes_available']=True
 with tempfile.TemporaryDirectory() as tmp:
  directory=Path(tmp)
  for file in source.iterdir():
   if file.is_file() and file.suffix in ('.wav','.json') and file.name not in ('project.json','additional-tracks.json'):(directory/file.name).symlink_to(file)
  save_json(directory/'project.json',state);save_json(directory/'additional-tracks.json',json.loads((source/'additional-tracks.json').read_text()))
  p=Project(directory);base=p.mix();before=deepcopy(p.state['tracks']);fp=p.fingerprint();oldkeys={k:p.track_digest(k) for k in before}
  a,b=[round(t*p.sr) for t in candidate['range_seconds']]
  p.apply({'type':'replace_part','track_id':track_id},'manual',p.state['revision']);mixed=p.mix()
  checks['only_source_track_settings_changed']=all(p.state['tracks'][k]==v for k,v in before.items() if k!=piano)
  checks['original_audio_arrays_unchanged']=all(np.array_equal(v,original.audio[k]) for k,v in p.audio.items())
  checks['outside_interval_sample_identical']=np.array_equal(base[:a],mixed[:a]) and np.array_equal(base[b:],mixed[b:])
  checks['selected_interval_changed']=not np.array_equal(base[a:b],mixed[a:b])
  checks['old_piano_center_silent']=not np.any(p.render_track(piano)[a+1000:b-1000])
  checks['guitar_inherits_source_mix_and_edits']=p.state['tracks'][track_id]==before[piano]
  checks['other_cache_keys_unchanged']=all(p.track_digest(k)==v for k,v in oldkeys.items() if k!=piano)
  checks['reload_preserves_samples']=np.array_equal(Project(directory).mix(),mixed)
  p.move_history('undo',p.state['revision']);checks['one_undo_restores_samples_and_fingerprint']=np.array_equal(p.mix(),base) and p.fingerprint()==fp
  p.move_history('redo',p.state['revision']);checks['one_redo_restores_samples']=np.array_equal(p.mix(),mixed)
  p.apply({'type':'track_enabled','track_id':track_id,'enabled':False},'manual',p.state['revision'],compact=True)
  checks['new_guitar_independent_gate']=not np.array_equal(p.mix()[a:b],mixed[a:b]) and all(p.state['tracks'][k]==v for k,v in before.items() if k!=piano)
  p.move_history('undo',p.state['revision']);p.move_history('undo',p.state['revision'])
  p.apply({'type':'segment_gain','track_id':piano,'mode':'gain','gain_db':-3,'start_seconds':9,'end_seconds':11},'manual',p.state['revision'])
  changed=p.fingerprint()
  try:p.apply({'type':'replace_part','track_id':track_id},'manual',p.state['revision'])
  except ValueError:checks['changed_source_rejected_without_overwrite']=p.fingerprint()==changed
  try:p.apply({'type':'add_part','track_id':track_id},'manual',p.state['revision'])
  except ValueError:checks['cannot_accidentally_layer_replacement']=p.fingerprint()==changed
  try:source_job(p,'piano')
  except ValueError:checks['audio_only_source_honestly_rejected']=True
 checks['live_project_unchanged']=json.loads((source/'project.json').read_text())==live_state
 report={'status':'passed' if all(checks.values()) else 'failed','job_id':job['id'],'checks':{k:bool(v) for k,v in checks.items()},'listening_accepted':False}
 save_json(out/'sample-acceptance.json',report);print(json.dumps(report,ensure_ascii=False,indent=2));assert all(checks.values())
if __name__=='__main__':main()
