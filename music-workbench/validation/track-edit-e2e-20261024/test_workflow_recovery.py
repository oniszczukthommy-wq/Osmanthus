"""Recovery must never interpret lost submission evidence as a new paid task."""
import json, tempfile, time, unittest, uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
import workflow as w


class WorkflowRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.runs=self.root/'runs';self.runs.mkdir()
        for obj,name,value in [(w,'RUNS',self.runs),(w.STREAM,'ROOT',self.root),(w.STREAM,'JOBS',{})]:
            self.stack.enter_context(patch.object(obj,name,value))
        self.stack.enter_context(patch.dict(w.os.environ,{'YINCHAO_API_KEY':'offline-only','DEEPSEEK_API_KEY':'offline-only'}))

    def save(self,**changes):
        job={'id':str(uuid.uuid4()),'created_at':time.time(),'title':'恢复测试','status':'pending',
             'stage':'generating','events':[],'download_ready':False,'lyrics':'离线测试歌词',
             'prompt':'中文流行测试','model':'v4.5','buffering_events':0,**changes}
        w.STREAM.persist(job)
        return job

    def assert_blocked_without_submit(self,job):
        file=self.runs/job['id']/'state.json';original=file.read_bytes()
        work=w.Workflow()
        # Drive the real worker for any incorrectly admitted task. The provider
        # transport is intercepted so this regression can never spend money.
        with patch.object(work,'launch',side_effect=work.run),patch.object(w.STREAM,'request_json',side_effect=RuntimeError('offline intercepted')) as request:
            work.recover()
            self.assertEqual(request.call_count,0,'Recovery must not POST a replacement paid task')
        self.assertNotIn(job['id'],work.jobs)
        self.assertIn(job['id'],work.recovery_issues)
        self.assertEqual(file.read_bytes(),original)

    def test_complete_schema_without_submission_evidence_never_reposts(self):
        self.assert_blocked_without_submit(self.save())

    def test_missing_submission_fields_with_provider_events_never_reposts(self):
        self.assert_blocked_without_submit(self.save(events=[{'type':'submitted','at':1}]))

    def test_false_submission_flag_cannot_override_provider_events(self):
        self.assert_blocked_without_submit(self.save(submission_started=False,events=[{'type':'submitted','at':1}]))

    def test_false_submission_flag_cannot_override_completed_status(self):
        self.assert_blocked_without_submit(self.save(submission_started=False,status='complete'))

    def test_same_request_cannot_overwrite_quarantined_task(self):
        job=self.save();file=self.runs/job['id']/'state.json';original=file.read_bytes()
        work=w.Workflow()
        with patch.object(work,'launch') as launch:
            with self.assertRaises(ValueError):
                work.start({'request_id':job['id'],'brief':'制作一首中文流行歌曲'})
            launch.assert_not_called()
        self.assertEqual(file.read_bytes(),original)

    def test_non_string_or_empty_task_id_is_not_submission_proof(self):
        for task_id in ('',None,True,123,{},'   '):
            with self.subTest(task_id=task_id):
                self.assert_blocked_without_submit(self.save(task_id=task_id))

    def test_download_flag_without_local_audio_is_not_submission_proof(self):
        self.assert_blocked_without_submit(self.save(download_ready=True,stage='awaiting_selection',status='done'))

    def test_uncertain_submission_cannot_treat_truthy_non_string_task_id_as_known(self):
        self.assert_blocked_without_submit(self.save(submission_started=True,task_id=True))

    def test_complete_legacy_task_and_true_fresh_task_still_recover(self):
        known=self.save(task_id='provider-existing-task')
        fresh=self.save(submission_started=False)
        audio=self.save(status='done',stage='ready',download_ready=True)
        (self.runs/audio['id']/'complete.mp3').write_bytes(b'existing complete audio fixture')
        work=w.Workflow()
        with patch.object(work,'launch') as launch:
            work.recover()
            self.assertEqual({c.args[0]['id'] for c in launch.call_args_list},{known['id'],fresh['id']})
        self.assertIn(audio['id'],work.jobs)
        self.assertFalse(work.recovery_issues)

    def test_new_single_task_persists_explicit_unsubmitted_flag(self):
        work=w.Workflow();identifier=str(uuid.uuid4())
        with patch.object(work,'launch'):
            work.start({'request_id':identifier,'brief':'制作一首中文流行歌曲'})
        saved=json.loads((self.runs/identifier/'state.json').read_text())
        self.assertIs(saved.get('submission_started'),False)


if __name__=='__main__':unittest.main()
