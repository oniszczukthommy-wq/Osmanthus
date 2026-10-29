"""Offline creation acceptance: real managers, inert providers and isolated state."""
import copy,json,tempfile,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
import workflow as w
import generation_pairs as gp
import generation_drafts as gd
from create_flow import CreationFlow,AUTO_VOICE,fields

class CreationFlowTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.runs=self.root/'runs';self.runs.mkdir();self.projects=self.root/'projects';self.projects.mkdir()
        for obj,name,value in ((w,'RUNS',self.runs),(w,'PROJECTS',self.projects),(w.STREAM,'ROOT',self.root),(w.STREAM,'JOBS',{})):
            self.stack.enter_context(patch.object(obj,name,value))
        self.stack.enter_context(patch.dict('os.environ',{'DEEPSEEK_API_KEY':'test-only','YINCHAO_API_KEY':'test-only'}))
        self.work=w.Workflow();self.pairs=gp.GenerationPairs(self.work,self.root/'batches')
        self.drafts=gd.GenerationDrafts(self.pairs,self.root/'drafts')
        self.flow=CreationFlow(self.pairs,self.drafts,self.root/'creation')
        self.launch=self.stack.enter_context(patch.object(self.work,'launch'))
        self.pair_launch=self.stack.enter_context(patch.object(self.pairs,'launch_draft'))
        self.lyric_launch=self.stack.enter_context(patch.object(self.drafts,'launch'))
        self.body={'request_id':str(uuid.uuid4()),'mode':'simple','prompt':'雨停以后，第一班车驶向新的清晨，温暖的女声 R&B'}

    def manual(self,**updates):
        return {**self.body,'mode':'advanced','lyrics':'[Verse]\n雨停以后 我走向清晨\n[Chorus]\n请保留我的每一个字。',**updates}

    def complete_planning(self,identifier):
        b=self.pairs.read(identifier)
        def writer(job,**kwargs):job.update(lyrics='[VERSE]\n真实管理器下的离线测试歌词',title='模型取的名字')
        with patch.object(self.work,'lyrics',side_effect=writer) as write:self.pairs.draft(b)
        return b,write

    def restore(self):
        work=w.Workflow();pairs=gp.GenerationPairs(work,self.root/'batches');drafts=gd.GenerationDrafts(pairs,self.root/'drafts')
        flow=CreationFlow(pairs,drafts,self.root/'creation');return work,pairs,drafts,flow

    def test_simple_authorizes_one_click_without_approval_draft(self):
        result=self.flow.start(self.body)
        self.assertEqual(result['mode'],'simple');self.assertEqual(result['batch_id'],self.body['request_id'])
        self.assertEqual(result['batch']['creation_mode'],'simple');self.pair_launch.assert_called_once()
        self.assertEqual(self.drafts.drafts,{});self.lyric_launch.assert_not_called()
        self.assertEqual(self.work.jobs,{})
        saved=json.loads((self.root/'creation'/result['id']/'state.json').read_text())
        self.assertEqual(saved['state'],'accepted');self.assertNotIn('confirmed',json.dumps(saved))
        batch,writer=self.complete_planning(result['id']);self.assertEqual(writer.call_count,1)
        self.assertEqual(len(batch['candidate_ids']),2);self.assertEqual(self.launch.call_count,2)
        self.assertEqual(len({self.work.jobs[x]['lyrics'] for x in batch['candidate_ids'].values()}),1)
        self.assertEqual(result['input']['voice'],AUTO_VOICE);self.assertEqual(result['input']['style'],'中文 R&B')

    def test_advanced_user_lyrics_not_rewritten_and_title_is_optional(self):
        body=self.manual(title='我自己的歌');result=self.flow.start(body);batch,writer=self.complete_planning(result['id'])
        writer.assert_not_called();self.assertEqual(batch['title'],body['title'])
        self.assertTrue(all(self.work.jobs[x]['lyrics']==body['lyrics'] for x in batch['candidate_ids'].values()))
        self.assertTrue(all(self.work.jobs[x]['title']==body['title'] for x in batch['candidate_ids'].values()))
        self.assertEqual(self.drafts.drafts,{})
        mode,payload=fields(self.manual(title=''));self.assertEqual(mode,'advanced')
        self.assertEqual(payload['title'],'雨停以后 我走向清晨')

    def test_advanced_empty_lyrics_rejected_before_any_intent_or_charge(self):
        for lyrics in ('','   '):
            with self.subTest(lyrics=lyrics),self.assertRaisesRegex(ValueError,'填写歌词'):
                self.flow.start(self.manual(lyrics=lyrics))
        self.assertEqual(self.flow.requests,{});self.assertEqual(self.pairs.batches,{})
        self.pair_launch.assert_not_called();self.lyric_launch.assert_not_called()

    def test_manual_advanced_requires_no_deepseek_key(self):
        with patch.dict('os.environ',{'DEEPSEEK_API_KEY':''}):result=self.flow.start(self.manual())
        self.assertEqual(result['stage'],'lyrics');self.pair_launch.assert_called_once()

    def test_simple_configuration_failure_does_not_reserve_request(self):
        with patch.dict('os.environ',{'DEEPSEEK_API_KEY':''}):
            with self.assertRaises(ValueError):self.flow.start(self.body)
        self.assertEqual(self.flow.requests,{});self.pair_launch.assert_not_called()

    def test_parallel_duplicate_requests_start_exactly_one_pair(self):
        with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(lambda _:self.flow.start(copy.deepcopy(self.body)),range(12)))
        self.assertEqual(len({r['id'] for r in results}),1);self.assertEqual(len(self.flow.requests),1)
        self.pair_launch.assert_called_once();self.assertEqual(len(self.pairs.batches),1)

    def test_same_id_cannot_change_mode_payload_or_lyrics(self):
        self.flow.start(self.body)
        for body in ({**self.body,'prompt':'完全不同的创作要求'},self.manual(),{**self.body,'voice':'另外一种人声'}):
            with self.subTest(body=body),self.assertRaises(RuntimeError):self.flow.start(body)
        self.pair_launch.assert_called_once()

    def test_request_ids_cannot_cross_existing_namespaces(self):
        old=self.drafts.start({'request_id':self.body['request_id'],'brief':'旧歌词请求'})
        with self.assertRaises(RuntimeError):self.flow.start(self.body)
        self.assertEqual(old['id'],self.body['request_id']);self.pair_launch.assert_not_called()

    def test_style_1000_characters_supported_and_prompt_total_checked_early(self):
        body=self.manual(style='轻柔流行'*200,prompt='按歌词创作')
        result=self.flow.start(body);self.assertEqual(result['input']['style'],body['style'])
        bad={**self.body,'request_id':str(uuid.uuid4()),'prompt':'歌'*2000,'style':'调'*1000,'voice':'声'*240}
        with self.assertRaisesRegex(ValueError,'超过|过长'):self.flow.start(bad)
        self.assertEqual(len(self.flow.requests),1)

    def test_requested_title_survives_automatic_lyrics(self):
        result=self.flow.start({**self.body,'title':'用户指定歌名'});batch,writer=self.complete_planning(result['id'])
        self.assertEqual(writer.call_count,1);self.assertEqual(batch['title'],'用户指定歌名')

    def test_optional_lyric_assistant_never_creates_a_music_batch(self):
        request={**self.body,'title':'保留的标题','instruction':'歌词更具体一些'}
        result=self.flow.write_lyrics(request);self.assertEqual(result['stage'],'writing')
        self.assertEqual(self.pairs.batches,{});self.pair_launch.assert_not_called()
        draft=self.drafts.read(result['id'])
        with patch.object(self.work,'lyrics',side_effect=lambda job,**_:job.update(title='模型换的标题',lyrics='[VERSE]\n离线写词')):
            self.drafts.run(draft)
        self.assertEqual(draft['title'],'保留的标题');self.assertEqual(draft['stage'],'ready')
        self.assertFalse(self.drafts.public(draft)['music_submitted'])

    def test_simple_cannot_silently_ignore_manual_lyrics_and_instrumental_rejected(self):
        for body in ({**self.body,'lyrics':'不能丢掉我的词'},{**self.body,'instrumental':True},{**self.body,'mode':'other'},
                     {**self.body,'prompt':['wrong type']},{**self.body,'prompt':'短'}):
            with self.subTest(body=body),self.assertRaises(ValueError):self.flow.start(body)
        self.assertEqual(self.flow.requests,{});self.pair_launch.assert_not_called()

    def test_lyric_helper_context_is_in_request_not_mistaken_for_finished_lyrics(self):
        request={**self.body,'lyrics':'用户已经写下的一句歌词','instruction':'延续这句的画面'}
        result=self.flow.write_lyrics(request);draft=self.drafts.read(result['id'])
        self.assertIn(request['lyrics'],draft['brief']);self.assertNotIn('lyrics',draft)
        self.assertEqual(result['stage'],'writing');self.assertEqual(self.pairs.batches,{})
        with self.assertRaises(RuntimeError):self.flow.write_lyrics({**request,'lyrics':'不能用旧请求ID偷换另一句'})
        self.pair_launch.assert_not_called()

    def test_intent_write_failure_prevents_pair_work_and_is_retryable(self):
        with patch.object(self.flow,'save',side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):self.flow.start(self.body)
        self.assertEqual(self.flow.requests,{});self.pair_launch.assert_not_called()
        self.flow.start(self.body);self.pair_launch.assert_called_once()

    def test_batch_write_failure_leaves_no_false_success_cache(self):
        with patch.object(self.pairs,'save',side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):self.flow.start(self.body)
        self.assertEqual(self.pairs.batches,{});self.pair_launch.assert_not_called()
        self.assertEqual(self.flow.start(self.body)['stage'],'error')
        self.flow.resume(self.body['request_id']);self.pair_launch.assert_called_once()

    def test_crash_after_intent_before_batch_recovers_once(self):
        with patch.object(self.pairs,'start',side_effect=SystemExit('lost process')):
            with self.assertRaises(SystemExit):self.flow.start(self.body)
        self.assertEqual(self.flow.requests[self.body['request_id']]['state'],'authorized')
        _,pairs,drafts,flow=self.restore()
        with patch.object(pairs,'launch_draft') as start,patch.object(drafts,'launch') as lyric:
            flow.recover();flow.recover();flow.start(self.body)
            start.assert_called_once();lyric.assert_not_called()

    def test_crash_after_batch_creation_recovers_by_link_not_resubmission(self):
        with patch.object(self.flow,'_bind',side_effect=SystemExit('lost after batch creation')):
            with self.assertRaises(SystemExit):self.flow.start(self.body)
        self.pair_launch.assert_called_once()
        _,pairs,_,flow=self.restore()
        with patch.object(pairs,'start') as start,patch.object(pairs,'resume') as resume:
            flow.recover();flow.recover();flow.start(self.body)
            start.assert_not_called();resume.assert_not_called()
        self.assertEqual(flow.public(flow.read(self.body['request_id']))['batch']['creation_mode'],'simple')

    def test_busy_before_admission_does_not_leave_pending_paid_intent(self):
        self.work.running.add(str(uuid.uuid4()))
        with self.assertRaises(RuntimeError):self.flow.start(self.body)
        self.assertEqual(self.flow.requests,{});self.assertEqual(list((self.root/'creation').iterdir()),[])

    def test_ambiguous_submission_resume_keeps_candidates_and_never_reposts(self):
        result=self.flow.start(self.body);batch,_=self.complete_planning(result['id']);self.launch.reset_mock()
        a=self.work.jobs[batch['candidate_ids']['A']];b=self.work.jobs[batch['candidate_ids']['B']]
        a.update(stage='error',submission_started=True,task_id=None);b.update(stage='ready')
        self.flow.resume(result['id']);self.launch.assert_not_called()
        self.assertEqual(self.pairs.read(result['id'])['candidate_ids'],batch['candidate_ids'])
        self.assertIn('提交结果不确定',a['error'])

    def test_accepted_missing_batch_or_corrupt_request_never_regenerates(self):
        result=self.flow.start(self.body);batch=self.pairs.batches.pop(result['id'])
        (self.root/'batches'/result['id']/'state.json').unlink()
        public=self.flow.public(self.flow.read(result['id']));self.assertEqual(public['stage'],'error');self.assertFalse(public['can_resume'])
        self.pair_launch.reset_mock()
        with self.assertRaisesRegex(RuntimeError,'停止重发'):self.flow.resume(result['id'])
        self.pair_launch.assert_not_called()
        file=self.root/'creation'/result['id']/'state.json';state=json.loads(file.read_text());state['payload']['brief']='tampered';file.write_text(json.dumps(state))
        restored=CreationFlow(self.pairs,self.drafts,self.root/'creation')
        with self.assertRaisesRegex(RuntimeError,'记录不完整'):restored.start(self.body)

    def test_cancel_unknown_request_prevents_late_post_even_after_restart(self):
        identifier=self.body['request_id'];result=self.flow.cancel_unaccepted(identifier)
        self.assertTrue(result['cancelled']);self.assertEqual(self.flow.cancel_unaccepted(identifier),result)
        with self.assertRaisesRegex(RuntimeError,'已取消'):self.flow.start(self.body)
        _,pairs,_,restored=self.restore()
        with patch.object(pairs,'launch_draft') as launch:
            restored.recover()
            with self.assertRaisesRegex(RuntimeError,'已取消'):restored.start(self.body)
            launch.assert_not_called()
        self.pair_launch.assert_not_called();self.assertEqual(restored.list(),[])

    def test_cancel_unaccepted_authorized_intent_stops_startup_recovery(self):
        with patch.object(self.pairs,'start',side_effect=SystemExit('lost before admission')):
            with self.assertRaises(SystemExit):self.flow.start(self.body)
        self.flow.cancel_unaccepted(self.body['request_id'])
        _,pairs,_,restored=self.restore()
        with patch.object(pairs,'launch_draft') as launch:restored.recover();launch.assert_not_called()
        self.assertEqual(restored.list(),[])

    def test_cancel_racing_with_accepted_request_restores_existing_batch(self):
        original=self.flow.start(self.body);self.pair_launch.reset_mock()
        result=self.flow.cancel_unaccepted(original['id'])
        self.assertFalse(result['cancelled']);self.assertEqual(result['creation']['id'],original['id'])
        self.assertEqual(len(self.pairs.batches),1);self.pair_launch.assert_not_called()
        self.assertNotIn(original['id'],self.flow.cancelled)

    def test_cancel_does_not_claim_foreign_or_ambiguous_records(self):
        result=self.flow.start(self.body);self.pairs.batches.pop(result['id'])
        with self.assertRaisesRegex(RuntimeError,'记录不完整'):self.flow.cancel_unaccepted(result['id'])
        other=str(uuid.uuid4());self.drafts.start({'request_id':other,'brief':'另外一个写词任务'})
        with self.assertRaisesRegex(RuntimeError,'其他任务'):self.flow.cancel_unaccepted(other)
        self.assertEqual(self.flow.cancelled,set())

    def test_cancel_disk_failure_does_not_falsely_report_success(self):
        with patch.object(w,'save_json',side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):self.flow.cancel_unaccepted(self.body['request_id'])
        self.assertNotIn(self.body['request_id'],self.flow.cancelled)
        self.flow.start(self.body);self.pair_launch.assert_called_once()

    def test_parallel_cancel_and_start_yield_either_one_batch_or_no_work(self):
        for _ in range(8):
            body={**self.body,'request_id':str(uuid.uuid4())}
            def start():
                try:return self.flow.start(body)
                except RuntimeError:return None
            with ThreadPoolExecutor(max_workers=2) as pool:
                a=pool.submit(start);b=pool.submit(self.flow.cancel_unaccepted,body['request_id']);a.result();cancel=b.result()
            exists=body['request_id'] in self.pairs.batches
            self.assertEqual(exists,not cancel['cancelled'])
            self.assertNotEqual(exists,body['request_id'] in self.flow.cancelled)

if __name__=='__main__':unittest.main()
