"""Offline lifecycle tests. Mocked audio is not musical evidence."""
import copy, json, tempfile, time, unittest, uuid
from pathlib import Path
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
import workflow as w
import generation_pairs as gp

class PairTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.runs=self.root/'runs';self.runs.mkdir()
        self.projects=self.root/'projects';self.projects.mkdir()
        for obj,name,value in [(w,'RUNS',self.runs),(w,'PROJECTS',self.projects),(w.STREAM,'ROOT',self.root),(w.STREAM,'JOBS',{})]:
            self.stack.enter_context(patch.object(obj,name,value))
        self.stack.enter_context(patch.dict(w.os.environ,{'YINCHAO_API_KEY':'test-only','DEEPSEEK_API_KEY':'test-only'}))
        self.work=w.Workflow();self.service=gp.GenerationPairs(self.work,self.root/'batches')
        self.body={'request_id':str(uuid.uuid4()),'brief':'周末向海边出发的轻松歌曲','style':'R&B','voice':'成熟自然男声'}
        self.launch=self.stack.enter_context(patch.object(self.work,'launch'))

    def batch(self):
        with patch.object(self.service,'launch_draft'):
            self.service.start(self.body)
        batch=self.service.read(self.body['request_id'])
        def lyrics(job,**kwargs):
            self.assertFalse(kwargs['persist_result'])
            job.update(title='测试歌曲',lyrics='[VERSE]\n测试歌词\n[CHORUS]\n相同歌词',prompt='unused detailed planner result')
        with patch.object(self.work,'lyrics',side_effect=lyrics) as call:
            self.service.draft(batch)
            self.assertEqual(call.call_count,1)
        self.launch.reset_mock()
        return batch

    def ready(self,batch,slot):
        j=self.work.jobs[batch['candidate_ids'][slot]]
        j.update(stage='awaiting_selection',status='done',download_ready=True,task_id='provider-'+slot)
        (self.runs/j['id']/'complete.mp3').write_bytes(b'unit fixture; not a real song')
        w.STREAM.persist(j)
        return j

    def test_shared_lyrics_and_two_distinct_prompts_and_ids(self):
        b=self.batch();a,c=[self.work.jobs[x] for x in b['candidate_ids'].values()]
        self.assertNotEqual(a['id'],c['id']);self.assertEqual(a['lyrics'],c['lyrics'])
        self.assertNotEqual(a['prompt'],c['prompt'])
        self.assertIn(a['prompt'],c['prompt']);self.assertIn(self.body['voice'],a['prompt'])
        self.assertNotIn('unused detailed planner result',a['prompt'])
        self.assertFalse(a['selected_for_preparation']);self.assertFalse(c['selected_for_preparation'])

    def test_same_request_replays_and_changed_body_rejected(self):
        with patch.object(self.service,'launch_draft') as call:
            first=self.service.start(self.body);again=self.service.start(self.body)
            self.assertEqual(first['id'],again['id']);self.assertEqual(call.call_count,1)
            with self.assertRaises(RuntimeError):self.service.start({**self.body,'brief':'different words'})

    def test_provided_lyrics_are_shared_verbatim_without_ai_rewrite(self):
        body={**self.body,'lyrics':'[VERSE]\n我写下自己的歌词\n[CHORUS]\n留住这段旋律'}
        with patch.object(self.service,'launch_draft'):
            self.service.start(body)
        batch=self.service.read(body['request_id'])
        with patch.object(self.work,'lyrics') as writer:
            self.service.draft(batch);writer.assert_not_called()
        self.assertTrue(all(self.work.jobs[i]['lyrics']==body['lyrics'] for i in batch['candidate_ids'].values()))
        with self.assertRaises(RuntimeError):self.service.start({**body,'lyrics':'不能用相同ID偷偷换词'})

    def test_generation_does_not_prepare_until_selected(self):
        b=self.batch();j=self.work.jobs[b['candidate_ids']['A']]
        def worker(job):
            job.update(status='done',download_ready=True)
            (self.runs/job['id']/'complete.mp3').write_bytes(b'fixture')
        with patch.object(w.STREAM,'worker',side_effect=worker) as provider,patch.object(w.subprocess,'run') as prepare:
            self.work.run(j)
            self.assertEqual(provider.call_count,1);prepare.assert_not_called()
        self.assertEqual(j['stage'],'awaiting_selection')

    def test_selection_scopes_exact_candidate_and_repeat_is_safe(self):
        b=self.batch();a=self.ready(b,'A');c=self.ready(b,'B')
        result=self.service.select(b['id'],c['id'])
        self.assertEqual(result['selected_candidate_id'],c['id'])
        self.assertFalse(a['selected_for_preparation']);self.assertTrue(c['selected_for_preparation'])
        self.launch.assert_called_once_with(c)
        self.work.running.add(c['id'])
        # Real launch, not the spy, performs the idempotency check.
        with patch.object(self.work,'launch',wraps=w.Workflow.launch.__get__(self.work)):
            with patch.object(w.threading,'Thread') as thread:
                self.service.select(b['id'],c['id']);thread.assert_not_called()
        with self.assertRaises(RuntimeError):self.service.select(b['id'],a['id'])
        self.work.running.clear()

    def test_cross_batch_and_unready_selection_rejected(self):
        b=self.batch()
        with self.assertRaises(ValueError):self.service.select(b['id'],str(uuid.uuid4()))
        with self.assertRaises(RuntimeError):self.service.select(b['id'],b['candidate_ids']['A'])
        self.launch.assert_not_called()

    def test_one_failed_other_still_selectable(self):
        b=self.batch();a=self.ready(b,'A');c=self.work.jobs[b['candidate_ids']['B']]
        c.update(stage='error',status='error',error='provider failed')
        c['events'].append({'type':'provider_status','status':'fail'})
        public=self.service.public(b)
        self.assertEqual(public['stage'],'awaiting_selection')
        self.assertTrue(public['candidates'][0]['can_select'])
        self.assertTrue(public['candidates'][1]['can_retry_generation'])
        self.service.select(b['id'],a['id']);self.launch.assert_called_once_with(a)

    def test_confirmed_failure_retry_new_attempt_only_once(self):
        b=self.batch();a=self.ready(b,'A');old=self.work.jobs[b['candidate_ids']['B']]
        old.update(stage='error',status='error',task_id='failed-task')
        old['events'].append({'type':'provider_status','status':'fail'})
        request=str(uuid.uuid4());first=self.service.retry(b['id'],old['id'],request)
        new=b['candidate_ids']['B'];self.assertNotEqual(new,old['id'])
        self.assertEqual(b['candidate_ids']['A'],a['id'])
        self.service.retry(b['id'],old['id'],request)
        self.assertEqual(self.launch.call_count,1)
        self.assertEqual(self.work.jobs[new]['lyrics'],a['lyrics'])
        self.assertIn(old['id'],self.work.jobs)

    def test_unknown_submission_never_reposts_or_retries(self):
        b=self.batch();j=self.work.jobs[b['candidate_ids']['A']]
        j.update(submission_started=True,task_id=None,stage='error')
        self.service.launch_candidate(j);self.launch.assert_not_called()
        with self.assertRaises(RuntimeError):self.service.retry(b['id'],j['id'],str(uuid.uuid4()))

    def test_restart_recovers_known_task_not_selected_stems(self):
        b=self.batch();a=self.ready(b,'A');c=self.work.jobs[b['candidate_ids']['B']]
        c.update(submission_started=True,task_id='running-task',stage='generating');w.STREAM.persist(c)
        work=w.Workflow();service=gp.GenerationPairs(work,self.root/'batches')
        with patch.object(work,'launch') as launch:
            work.recover();launch.assert_not_called()
            service.recover()
            self.assertEqual([x.args[0]['id'] for x in launch.call_args_list],[c['id']])
        self.assertEqual(work.jobs[a['id']]['stage'],'awaiting_selection')

    def test_restart_selected_candidate_prepares_only_it(self):
        b=self.batch();a=self.ready(b,'A');c=self.ready(b,'B')
        b['selected_candidate_id']=c['id'];self.service.save(b)
        # Simulate crash after durable selection, before setting job flag.
        work=w.Workflow();service=gp.GenerationPairs(work,self.root/'batches')
        with patch.object(work,'launch') as launch:
            service.recover();self.assertEqual([x.args[0]['id'] for x in launch.call_args_list],[c['id']])
        self.assertTrue(work.jobs[c['id']]['selected_for_preparation'])
        self.assertFalse(work.jobs[a['id']]['selected_for_preparation'])

    def test_legacy_resume_cannot_bypass_selection(self):
        b=self.batch();j=self.ready(b,'A')
        with self.assertRaises(ValueError):self.work.resume(j['id'])

    def test_selected_prepare_failure_keeps_audio_and_does_not_generate(self):
        b=self.batch();j=self.ready(b,'B');self.service.select(b['id'],j['id'])
        with patch.object(w.STREAM,'worker') as provider,patch.object(w.subprocess,'run',return_value=SimpleNamespace(returncode=1)) as prepare:
            self.work.run(j)
            provider.assert_not_called();self.assertEqual(prepare.call_count,1)
            self.assertIn(str(self.runs/j['id']/'complete.mp3'),prepare.call_args.args[0])
            self.assertIn(str(self.projects/j['id']/'data'),prepare.call_args.args[0])
        self.assertTrue(j['download_ready']);self.assertEqual(j['stage'],'error')
        self.assertEqual(self.service.public(b)['stage'],'preparation_error')

    def test_selection_arriving_at_generation_finish_is_not_lost(self):
        b=self.batch();j=self.work.jobs[b['candidate_ids']['A']]
        original=self.work.stage
        def stage(job,value,**kw):
            original(job,value,**kw)
            if value=='awaiting_selection':job['selected_for_preparation']=True
        with patch.object(self.work,'stage',side_effect=stage),patch.object(w.STREAM,'worker',side_effect=lambda job:job.update(download_ready=True)):
            self.work.run(j)
        self.launch.assert_called_once_with(j)

    def test_constraint_preservation_and_prompt_limit(self):
        fields={**self.body,'brief':'只用木吉他，不要钢琴，保持平直节奏'}
        p=gp.prompts(fields)
        self.assertIn(fields['brief'],p['B']['prompt'])
        self.assertNotIn('电钢琴',p['B']['prompt']);self.assertNotIn('切分',p['B']['prompt'])
        self.assertLessEqual(len(gp.prompts({**fields,'brief':'歌'*2000,'voice':'声'*240})['B']['prompt']),3000)

    def test_another_project_queued_for_separation_blocks_new_selection(self):
        b=self.batch();j=self.ready(b,'A')
        other=str(uuid.uuid4())
        self.work.jobs[other]={'selected_for_preparation':True,'download_ready':True,'stage':'awaiting_selection'}
        self.work.running.add(other)
        with self.assertRaises(RuntimeError):self.service.select(b['id'],j['id'])
        self.launch.assert_not_called()

if __name__=='__main__':unittest.main()
