"""Lyric approval lifecycle: no paid work before durable, versioned confirmation."""
import copy,json,tempfile,threading,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import workflow as w
import generation_pairs as gp
import generation_drafts as gd
from test_lyric_retry import song_with_line

class GenerationDraftTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.runs=self.root/'runs';self.runs.mkdir()
        self.projects=self.root/'projects';self.projects.mkdir()
        for obj,name,value in ((w,'RUNS',self.runs),(w,'PROJECTS',self.projects),
                               (w.STREAM,'ROOT',self.root),(w.STREAM,'JOBS',{})):
            self.stack.enter_context(patch.object(obj,name,value))
        self.stack.enter_context(patch.dict(w.os.environ,{'DEEPSEEK_API_KEY':'unit-test-only','YINCHAO_API_KEY':'unit-test-only','MUSIC_PAID_USAGE_DB':str(self.root/'usage.sqlite3')}))
        self.workflow=w.Workflow();self.pairs=gp.GenerationPairs(self.workflow,self.root/'batches')
        self.manager=gd.GenerationDrafts(self.pairs,self.root/'drafts')
        self.draft_launch=self.stack.enter_context(patch.object(self.manager,'launch'))
        self.pair_launch=self.stack.enter_context(patch.object(self.pairs,'launch_draft'))
        self.worker=self.stack.enter_context(patch.object(w.STREAM,'worker'))
        self.body={'request_id':str(uuid.uuid4()),'brief':'写一首夜晚回家的中文歌曲','style':'中文流行',
                   'voice':'自然温暖的成年男声'}

    def ready(self,manual=False):
        body={**self.body,**({'lyrics':'[VERSE]\n我自己写下的歌词\n[CHORUS]\n请保留每一句原文','title':'自己的歌'} if manual else {})}
        result=self.manager.start(body);draft=self.manager.read(result['id'])
        def writer(job,**kwargs):
            self.assertEqual(kwargs['folder'],self.root/'drafts'/draft['id'])
            self.assertFalse(kwargs['persist_result'])
            job.update(title='回家的路',lyrics='[VERSE]\n夜色落在街道旁\n[CHORUS]\n灯光等我回到家',prompt='not a paid song request')
        with patch.object(self.workflow,'lyrics',side_effect=writer) as write:
            self.manager.run(draft)
            self.assertEqual(write.call_count,0 if manual else 1)
        self.assertEqual(draft['stage'],'ready')
        return draft

    def confirm_body(self,draft):
        public=self.manager.public(draft)
        return {'version':public['version'],'fingerprint':public['fingerprint']}

    def restore(self):
        work=w.Workflow();pairs=gp.GenerationPairs(work,self.root/'batches')
        manager=gd.GenerationDrafts(pairs,self.root/'drafts')
        return work,pairs,manager

    def test_draft_generation_and_edits_never_start_song_or_provider(self):
        draft=self.ready()
        self.manager.update(draft['id'],{'version':1,'lyrics':'[VERSE]\n我改好的歌词','title':'核对后的名字'})
        self.assertEqual(self.manager.public(draft)['version'],2)
        self.assertFalse(self.manager.public(draft)['music_submitted'])
        self.pair_launch.assert_not_called();self.worker.assert_not_called()
        self.assertEqual(self.pairs.batches,{})
        self.assertEqual(self.workflow.jobs,{})
        self.assertFalse(any(self.runs.iterdir()))

    def test_actual_lyric_writer_repairs_overlong_draft_before_any_song_submission(self):
        # Exercise the real lyrics() contract, including its events list, rather
        # than replacing that method with a permissive fake writer.
        for legacy_missing_events in (False,True):
            with self.subTest(legacy_missing_events=legacy_missing_events):
                public=self.manager.start({**self.body,'request_id':str(uuid.uuid4())})
                draft=self.manager.read(public['id'])
                self.assertEqual(draft['events'],[])
                if legacy_missing_events:draft.pop('events')
                requests=[]
                long_song=song_with_line('晚风轻轻吹过城市街角')
                valid_song=song_with_line('晚风吹过城市街角')
                responses=iter((long_song,valid_song))
                def respond(command,**_kwargs):
                    self.assertIn('https://api.deepseek.com/chat/completions',command)
                    payload=command[command.index('--data-binary')+1]
                    requests.append(json.loads(Path(payload[1:]).read_text()))
                    response={'choices':[{'message':{'content':json.dumps(next(responses),ensure_ascii=False)}}],
                              'usage':{'total_tokens':1}}
                    return SimpleNamespace(returncode=0,stdout=json.dumps(response).encode(),stderr=b'')
                with patch.object(w.subprocess,'run',side_effect=respond) as curl:
                    self.manager.run(draft)
                self.assertEqual(curl.call_count,2)
                self.assertEqual(draft['stage'],'ready',draft.get('error'))
                self.assertEqual(draft['lyrics'],w.compile_lyrics(valid_song)[0])
                self.assertEqual(draft['lyric_han_characters'],368)
                self.assertEqual(draft['events'],[{'type':'lyrics_repair','attempt':2}])
                feedback=requests[1]['messages'][-1]['content']
                self.assertIn('460',feedback);self.assertIn('50',feedback)
                saved=json.loads((self.root/'drafts'/draft['id']/'state.json').read_text())
                self.assertEqual(saved['events'],draft['events'])
                self.assertEqual(saved['lyrics'],draft['lyrics'])
                self.assertTrue((self.root/'drafts'/draft['id']/'lyrics-response-attempt-2.json').exists())
                self.assertFalse(self.manager.public(draft)['music_submitted'])
        self.worker.assert_not_called();self.pair_launch.assert_not_called()
        self.assertEqual(self.pairs.batches,{})
        self.assertEqual(self.workflow.jobs,{})
        self.assertFalse(any(self.runs.iterdir()))

    def test_manual_lyrics_need_no_writer_and_remain_verbatim(self):
        draft=self.ready(manual=True);approved=draft['lyrics']
        self.manager.confirm(draft['id'],self.confirm_body(draft))
        batch=self.pairs.read(draft['batch_id'])
        self.assertEqual(batch['lyrics'],approved)
        with patch.object(self.workflow,'lyrics') as writer,patch.object(self.workflow,'launch'):
            self.pairs.draft(batch)
            writer.assert_not_called()
        self.assertTrue(all(self.workflow.jobs[c]['lyrics']==approved for c in batch['candidate_ids'].values()))
        self.worker.assert_not_called()

    def test_save_rejects_stale_version_without_changing_lyrics(self):
        draft=self.ready();old=self.confirm_body(draft)
        self.manager.update(draft['id'],{'version':1,'lyrics':'重新修改的正确歌词'})
        before=copy.deepcopy(draft)
        with self.assertRaises(RuntimeError):self.manager.update(draft['id'],{'version':1,'lyrics':'旧窗口覆盖词'})
        with self.assertRaises(RuntimeError):self.manager.update(draft['id'],{'version':True,'lyrics':'布尔值不能作版本'})
        self.assertEqual(before,draft)
        with self.assertRaises(RuntimeError):self.manager.confirm(draft['id'],old)
        self.pair_launch.assert_not_called();self.worker.assert_not_called()

    def test_confirm_checks_version_and_fingerprint_before_paid_start(self):
        draft=self.ready();body=self.confirm_body(draft)
        for invalid in ({**body,'version':0},{**body,'version':True},{**body,'fingerprint':'different'}, {'version':1}):
            with self.subTest(body=invalid),self.assertRaises(RuntimeError):self.manager.confirm(draft['id'],invalid)
        self.assertEqual(draft['stage'],'ready')
        self.assertIsNone(draft['batch_id'])
        self.assertEqual(self.pairs.batches,{})
        self.pair_launch.assert_not_called()

    def test_confirmation_uses_edited_lyrics_and_one_deterministic_batch(self):
        draft=self.ready();lyrics='[VERSE]\n这是核对修改后的歌词\n[CHORUS]\n写给窗外的那盏灯'
        self.manager.update(draft['id'],{'version':1,'lyrics':lyrics,'title':'确认的歌名','style':'中文民谣','voice':'克制轻柔女声'})
        body=self.confirm_body(draft);first=self.manager.confirm(draft['id'],body)
        second=self.manager.confirm(draft['id'],body)
        expected=str(uuid.uuid5(uuid.UUID(draft['id']),'confirmed-generation'))
        self.assertEqual(first['batch']['id'],expected);self.assertEqual(second['batch']['id'],expected)
        self.assertEqual(self.pair_launch.call_count,1)
        approved=json.loads((self.root/'drafts'/draft['id']/'state.json').read_text())
        self.assertEqual(approved['stage'],'confirmed')
        self.assertEqual(approved['approved_payload']['lyrics'],lyrics)
        self.assertEqual(approved['approved_fingerprint'],body['fingerprint'])
        batch=self.pairs.read(expected)
        self.assertEqual(batch['lyrics'],lyrics);self.assertEqual(batch['title'],'确认的歌名')
        self.assertEqual(batch['lyric_draft_id'],draft['id']);self.assertEqual(batch['lyric_draft_version'],2)

    def test_approved_lyrics_are_immutable_even_before_successful_submission(self):
        draft=self.ready();body=self.confirm_body(draft)
        with patch.object(self.pairs,'start',side_effect=RuntimeError('busy before batch creation')):
            with self.assertRaises(RuntimeError):self.manager.confirm(draft['id'],body)
        self.assertEqual(draft['stage'],'confirmed')
        self.assertFalse(self.manager.public(draft)['can_edit'])
        before=copy.deepcopy(draft['approved_payload'])
        with self.assertRaises(RuntimeError):self.manager.update(draft['id'],{'version':1,'lyrics':'确认后不能偷偷换词'})
        self.manager.confirm(draft['id'],body)
        self.assertEqual(before,draft['approved_payload'])
        self.assertEqual(len(self.pairs.batches),1)
        self.assertEqual(self.pair_launch.call_count,1)

    def test_crash_after_approval_before_batch_creation_recovers_same_payload(self):
        draft=self.ready();self.manager.update(draft['id'],{'version':1,'lyrics':'崩溃前确认的最终歌词'})
        body=self.confirm_body(draft)
        with patch.object(self.pairs,'start',side_effect=SystemExit('simulated process loss after approval')):
            with self.assertRaises(SystemExit):self.manager.confirm(draft['id'],body)
        approved=json.loads((self.root/'drafts'/draft['id']/'state.json').read_text())
        self.assertEqual(approved['stage'],'confirmed')
        self.assertFalse(self.pairs.batches)
        _,pairs,manager=self.restore()
        with patch.object(pairs,'launch_draft') as launch,patch.object(manager.workflow,'lyrics') as writer:
            manager.recover();manager.recover();result=manager.confirm(draft['id'],body)
            self.assertEqual(launch.call_count,1);writer.assert_not_called()
        self.assertEqual(result['batch']['id'],approved['batch_id'])
        self.assertEqual(pairs.read(approved['batch_id'])['lyrics'],approved['approved_payload']['lyrics'])
        self.worker.assert_not_called()

    def test_crash_after_batch_creation_replays_without_another_launch(self):
        draft=self.ready();body=self.confirm_body(draft)
        with patch.object(self.pairs,'read',side_effect=SystemExit('lost process after batch persisted')):
            with self.assertRaises(SystemExit):self.manager.confirm(draft['id'],body)
        expected=draft['batch_id'];self.assertEqual(self.pair_launch.call_count,1)
        self.assertTrue((self.root/'batches'/expected/'state.json').exists())
        _,pairs,manager=self.restore()
        with patch.object(pairs,'launch_draft') as launch:
            manager.recover();result=manager.confirm(draft['id'],body)
            launch.assert_not_called()
        batch=pairs.read(expected)
        self.assertEqual(result['batch']['id'],expected)
        self.assertEqual(batch['lyric_draft_id'],draft['id'])
        self.assertEqual(batch['lyric_approval_fingerprint'],body['fingerprint'])
        self.worker.assert_not_called()

    def test_busy_retry_keeps_exact_approved_batch_id(self):
        draft=self.ready();body=self.confirm_body(draft);self.workflow.running.add('another-song')
        with self.assertRaises(RuntimeError):self.manager.confirm(draft['id'],body)
        identifier=draft['batch_id'];payload=copy.deepcopy(draft['approved_payload'])
        self.assertFalse(self.pairs.batches);self.pair_launch.assert_not_called()
        self.workflow.running.clear();result=self.manager.resume(draft['id'])
        self.assertEqual(result['batch']['id'],identifier)
        self.assertEqual(payload,draft['approved_payload'])
        self.assertEqual(self.pair_launch.call_count,1)

    def test_simultaneous_double_confirmation_launches_once(self):
        draft=self.ready();body=self.confirm_body(draft);barrier=threading.Barrier(2)
        def confirm():barrier.wait(timeout=5);return self.manager.confirm(draft['id'],body)
        with ThreadPoolExecutor(max_workers=2) as workers:
            responses=list(workers.map(lambda _:confirm(),range(2)))
        self.assertEqual(responses[0]['batch']['id'],responses[1]['batch']['id'])
        self.assertEqual(len(self.pairs.batches),1);self.assertEqual(self.pair_launch.call_count,1)

    def test_draft_request_replay_does_not_repeat_lyric_call(self):
        first=self.manager.start(self.body);again=self.manager.start(self.body)
        self.assertEqual(first['id'],again['id']);self.assertEqual(self.draft_launch.call_count,1)
        with self.assertRaises(RuntimeError):self.manager.start({**self.body,'brief':'同一个ID的不同创作要求'})
        self.worker.assert_not_called();self.pair_launch.assert_not_called()

    def test_restart_of_unconfirmed_ready_draft_never_starts_songs(self):
        draft=self.ready();before=copy.deepcopy(draft)
        _,pairs,manager=self.restore()
        with patch.object(pairs,'launch_draft') as launch,patch.object(manager,'launch') as draft_launch:
            manager.recover();manager.recover()
            launch.assert_not_called();draft_launch.assert_not_called()
        self.assertEqual(manager.read(draft['id']),before)
        self.assertFalse(pairs.batches);self.worker.assert_not_called()

    def test_transient_approval_write_failure_cannot_skip_durable_approval_on_retry(self):
        draft=self.ready();body=self.confirm_body(draft)
        save=self.manager.save_state;start=self.pairs.start;failed=False
        def flaky_save(value):
            nonlocal failed
            if value['stage']=='confirmed' and not failed:
                failed=True;raise OSError('simulated transient approval write failure')
            return save(value)
        def require_durable_approval(payload):
            saved=json.loads((self.root/'drafts'/draft['id']/'state.json').read_text())
            self.assertEqual(saved['stage'],'confirmed','Paid start must wait for approval on disk, including retries')
            self.assertEqual(saved['approved_payload'],payload)
            return start(payload)
        with patch.object(self.manager,'save_state',side_effect=flaky_save):
            with self.assertRaises(OSError):self.manager.confirm(draft['id'],body)
            self.pair_launch.assert_not_called();self.assertFalse(self.pairs.batches)
            with patch.object(self.pairs,'start',side_effect=require_durable_approval):
                self.manager.confirm(draft['id'],body)
        self.assertEqual(self.pair_launch.call_count,1)
        self.assertEqual(len(self.pairs.batches),1)

if __name__=='__main__':unittest.main()
