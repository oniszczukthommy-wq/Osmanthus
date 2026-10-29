"""Offline safeguards: duplicate requests, ambiguous submission, and retry scope."""
import json, tempfile, uuid
from pathlib import Path
from unittest.mock import patch
import workflow as w

def main():
    checks={}
    with tempfile.TemporaryDirectory() as temp:
        base=Path(temp);runs=base/'runs';runs.mkdir();projects=base/'projects';projects.mkdir()
        with patch.object(w,'RUNS',runs),patch.object(w,'PROJECTS',projects),patch.object(w.STREAM,'ROOT',base),patch.object(w.STREAM,'JOBS',{}):
            service=w.Workflow();identifier=str(uuid.uuid4())
            body={'request_id':identifier,'brief':'雨后归途的中文流行歌曲','style':'中文流行','voice':'温暖女声'}
            with patch.object(service,'launch') as launch:
                first=service.start(body);second=service.start(body)
                checks['same_request_id_returns_same_song']=first['id']==second['id'] and len(service.jobs)==1
                checks['duplicate_does_not_launch_paid_work_again']=launch.call_count==1
            service.running.add(identifier)
            try:service.start({**body,'request_id':str(uuid.uuid4())})
            except ValueError:checks['concurrent_second_generation_rejected']=len(service.jobs)==1
            service.running.clear();job=service.jobs[identifier]
            job.update(stage='generating',submission_started=True,task_id=None)
            with patch.object(service,'launch') as launch:
                service.recover()
                checks['ambiguous_submission_not_reposted_on_restart']=job['stage']=='error' and launch.call_count==0
                try:service.resume(identifier)
                except ValueError:checks['ambiguous_submission_retry_rejected']=launch.call_count==0
            job['task_id']='known-provider-task'
            with patch.object(service,'launch') as launch:
                result=service.resume(identifier)
                checks['known_task_resume_keeps_same_job']=result['id']==identifier and job['task_id']=='known-provider-task' and launch.call_count==1
            job.update(download_ready=True,stage='separating',origin='new_generation')
            (runs/identifier/'complete.mp3').write_bytes(b'unit fixture, not musical evidence')
            with patch.object(w.STREAM,'worker') as generate,patch.object(w.subprocess,'run') as prepare:
                prepare.return_value.returncode=1
                service.run(job)
                checks['separation_failure_does_not_generate_another_song']=generate.call_count==0 and job['stage']=='error' and job['download_ready']
    result={'status':'passed' if all(checks.values()) else 'failed','checks':checks,
            'scope':'Offline mocked safety checks only; actual API/browser song proof is separate.'}
    (w.ROOT/'workflow-recovery-checks.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2));assert all(checks.values())

if __name__=='__main__':main()
