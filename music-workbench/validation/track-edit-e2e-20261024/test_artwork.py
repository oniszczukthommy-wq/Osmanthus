"""Exercise paid-call deduplication and crash recovery without network charges."""
import json, shutil, tempfile, threading, time, unittest, uuid
from pathlib import Path
from unittest.mock import patch
import artwork
from PIL import Image

class ArtworkTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        # This solid PNG is only a local unit-test fixture, never product art.
        self.fixture=self.root/'fixture.png';Image.new('RGB',(1024,1024),(40,60,80)).save(self.fixture)
        self.reference={'project_id':str(uuid.uuid4()),'title':'晨光列车','lyrics':'晨光列车带我去远方','style':'中文流行','source_sha256':''}
        self.calls=[];self.downloads=[]
        self.real_download=artwork.download_image
        def call(body,target):
            self.calls.append(body)
            receipt={'output':{'choices':[{'message':{'content':[{'image':'https://test.aliyuncs.com/cover.png'}]}}]},'request_id':'saved-receipt'}
            artwork.save_json(target,receipt);return receipt
        def download(url,target):
            self.downloads.append(url);shutil.copy2(self.fixture,target)
            return {'sha256':artwork.digest(target),'width':1024,'height':1024,'bytes':target.stat().st_size}
        self.call=patch.object(artwork,'call_image',side_effect=call).start()
        self.download=patch.object(artwork,'download_image',side_effect=download).start()
        self.env=patch.dict('os.environ',{'ARTWORK_API_KEY':'test-secret','ARTWORK_API_BASE_URL':'https://dashscope.aliyuncs.com'}).start()
        self.manager=artwork.Artwork(self.root)

    def tearDown(self):
        self.wait();patch.stopall();self.temp.cleanup()

    def wait(self):
        deadline=time.monotonic()+5
        while self.manager.running and time.monotonic()<deadline:time.sleep(.005)
        self.assertIsNone(self.manager.running)

    def state(self,job):return self.manager.public(self.manager.read(job['id']))

    def test_parallel_ensure_and_late_audio_hash_charge_once(self):
        ids=[]
        threads=[threading.Thread(target=lambda:ids.append(self.manager.ensure(self.reference)['id'])) for _ in range(8)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.wait();self.assertEqual(len(set(ids)),1);self.assertEqual(len(self.calls),1)
        updated=self.manager.ensure({**self.reference,'source_sha256':'a'*64})
        self.assertEqual(updated['source_sha256'],'a'*64);self.assertEqual(len(self.calls),1)
        self.assertEqual(self.manager.asset(updated['id']).name,'cover.png')

    def test_download_resume_uses_saved_paid_receipt(self):
        original=self.download.side_effect
        self.download.side_effect=RuntimeError('network interruption')
        job=self.manager.ensure(self.reference);self.wait()
        self.assertTrue(self.state(job)['can_resume_download']);self.assertEqual(len(self.calls),1)
        self.download.side_effect=original
        self.manager.resume(job['id']);self.wait()
        self.assertEqual(self.state(job)['stage'],'ready');self.assertEqual(len(self.calls),1)

    def test_crash_after_submission_does_not_resubmit(self):
        with patch.object(self.manager,'launch_next'):
            job=self.manager.ensure(self.reference)
        state=self.manager.read(job['id']);state.update(stage='generating',submission_started=True);self.manager.save(state)
        self.manager=artwork.Artwork(self.root);self.manager.recover();self.wait()
        self.assertEqual(self.state(job)['stage'],'interrupted');self.assertEqual(len(self.calls),0)
        with self.assertRaises(RuntimeError):self.manager.resume(job['id'])

    def test_recover_does_not_interrupt_live_worker_and_queue_finishes(self):
        entered=threading.Event();release=threading.Event();original=self.call.side_effect
        def slow(*args):entered.set();release.wait(2);return original(*args)
        self.call.side_effect=slow
        first=self.manager.ensure(self.reference);self.assertTrue(entered.wait(1))
        second=self.manager.ensure({**self.reference,'project_id':str(uuid.uuid4()),'title':'雨后慢行'})
        self.manager.recover();self.assertEqual(self.state(first)['stage'],'generating')
        release.set();self.wait()
        self.assertEqual(self.state(first)['stage'],'ready');self.assertEqual(self.state(second)['stage'],'ready')
        self.assertEqual(len(self.calls),2)

    def test_explicit_retry_request_is_idempotent(self):
        original=self.call.side_effect;self.call.side_effect=RuntimeError('submission status unknown')
        first=self.manager.ensure(self.reference);self.wait()
        self.call.side_effect=original;request_id=str(uuid.uuid4())
        retry=self.manager.retry(first['id'],request_id);again=self.manager.retry(first['id'],request_id);self.wait()
        self.assertEqual(retry['id'],again['id']);self.assertEqual(len(self.calls),1)
        self.assertEqual(self.state(retry)['retry_of'],first['id'])
        self.assertEqual(self.manager.ensure(self.reference)['id'],retry['id'])

    def test_approved_import_and_checksum_reject_changed_file(self):
        job=self.manager.seed_approved(self.reference,self.fixture,note='fixture import')
        self.assertEqual(job['provider'],'built-in-imagegen-user-approved');self.assertEqual(len(self.calls),0)
        self.assertEqual(self.manager.ensure(self.reference)['id'],job['id'])
        with self.assertRaises(ValueError):self.manager.asset(job['id'],'../state.json')
        self.manager.asset(job['id']).write_bytes(b'changed')
        with self.assertRaises(ValueError):self.manager.asset(job['id'])

    def test_public_metadata_and_prompt_do_not_leak_credentials_or_lyrics(self):
        job=self.manager.ensure(self.reference);self.wait()
        public=json.dumps(self.state(job));self.assertNotIn('test-secret',public);self.assertNotIn('test.aliyuncs',public)
        prompt=self.calls[0]['input']['messages'][0]['content'][0]['text']
        self.assertNotIn(self.reference['lyrics'],prompt);self.assertIn('IMAGE ONLY',prompt)

    def test_invalid_client_values_cannot_reach_provider(self):
        for ref in ({**self.reference,'project_id':'../../etc'}, {**self.reference,'source_sha256':'wrong'}, {**self.reference,'title':''}):
            with self.assertRaises(ValueError):self.manager.ensure(ref)
        for url in ('http://test.aliyuncs.com/x','https://aliyuncs.com.evil.example/x','file:///tmp/x'):
            with self.assertRaises(ValueError):self.real_download(url,self.root/'x')
        self.assertEqual(len(self.calls),0)

if __name__=='__main__':unittest.main()
