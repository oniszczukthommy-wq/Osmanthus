from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,MagicMock
import tempfile,sys,json,uuid,time,hashlib
ROOT=Path(__file__).resolve().parent;sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
import scores
from project import save_json
source=scores.ROOT/'projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data';project=SimpleNamespace(directory=source,state={'id':'c6f722c8-c2da-4fad-879f-e0bde53d80ca'})
checks={};before=hashlib.sha256((source/'project.json').read_bytes()).hexdigest()
with tempfile.TemporaryDirectory() as temp,patch.object(scores,'JOBS',Path(temp)),patch.object(scores.subprocess,'Popen') as popen:
 popen.return_value.poll.return_value=None;manager=scores.Scores();body={'project_id':project.state['id'],'request_id':str(uuid.uuid4())}
 first=manager.start(project,body);manager.start(project,body);checks['same_request_starts_one_worker']=popen.call_count==1
 second=manager.start(project,{**body,'request_id':str(uuid.uuid4())});checks['same_source_reuses_pending_job']=second['id']==first['id'] and popen.call_count==1
 try:manager.start(project,{**body,'project_id':str(uuid.uuid4())})
 except ValueError:checks['cannot_replay_for_different_song']=True
 try:manager.start(project,{**body,'request_id':'../other'})
 except ValueError:checks['invalid_request_id_rejected']=True
 state=manager.read(first['id']);state.update(stage='ready',summary={'note_count':2},files={'score.json':'fake'});save_json(Path(temp)/first['id']/'state.json',state)
 checks['new_manager_recovers_durable_ready_job']=scores.Scores().latest(source)['stage']=='ready'
 try:manager.asset(first['id'],'state.json')
 except ValueError:checks['private_state_not_served']=True
 try:manager.asset(first['id'],'score.json')
 except ValueError:checks['missing_public_asset_is_explicit_error']=True
 f=Path(temp)/first['id']/'score.json';f.write_text('{}')
 try:manager.asset(first['id'],'score.json')
 except ValueError:checks['corrupt_asset_rejected']=True
 state['files']['score.json']=hashlib.sha256(f.read_bytes()).hexdigest();save_json(Path(temp)/first['id']/'state.json',state)
 checks['verified_asset_accessible']=manager.asset(first['id'],'score.json')==f
 context,_=scores.source_context(source);checks['source_signature_excludes_mixer_controls']=all(k not in context for k in ('revision','gain_db','muted','tracks','fingerprint')) and context['basis']=='original_complete_lead_vocal'
 state.update(stage='transcribing',pid=999999999);checks['lost_worker_reports_interrupted']=manager.public(state)['stage']=='interrupted'
checks['tests_do_not_change_song_project']=hashlib.sha256((source/'project.json').read_bytes()).hexdigest()==before
result={'status':'passed' if all(checks.values()) else 'failed','checks':checks,'scope':'Job API contracts and file validation in temporary directory; process spawning mocked. Full real pipeline has separate evidence.'};save_json(ROOT/'score-job-contract-acceptance.json',result);print(result);assert all(checks.values())
