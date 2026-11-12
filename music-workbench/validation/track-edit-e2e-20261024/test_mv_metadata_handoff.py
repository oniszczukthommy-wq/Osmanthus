"""Isolated handoff identity tests; no user media or provider calls."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import tempfile
import unittest

from mv_bridge import MVHandoffs, attach_metadata_fingerprint, metadata_fingerprint

HANDOFF='10000000-0000-4000-8000-000000000001'
PROJECT='20000000-0000-4000-8000-000000000002'


class MetadataHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.audio=self.root/'synthetic.mp3'
        self.audio.write_bytes(b'isolated synthetic media bytes')
        self.bridge=MVHandoffs(self.root, 'unused-for-original')
        self.intent={'project_id':PROJECT,'source_kind':'generated_original','revision':None,'fingerprint':'a'*64}
        self.info={'title':'测试歌曲','duration':10.0,'lyrics':'第一句','style':'温暖',
                   'timed_lyrics':[],'cover_url':None}

    def tearDown(self):self.temp.cleanup()

    def resolve(self,intent):
        return attach_metadata_fingerprint({**self.intent,**self.info,'audio_file':self.audio},intent)

    def request(self,metadata=None):
        return {'request_id':HANDOFF,**self.intent,**({'metadata_fingerprint':metadata} if metadata else {})}

    def test_metadata_changes_with_lyrics_timing_and_cover_not_audio_identity(self):
        original=metadata_fingerprint(self.info)
        self.assertEqual(original,metadata_fingerprint(dict(reversed(list(self.info.items())))))
        for change in ({'lyrics':'更新歌词'}, {'timed_lyrics':[{'start':1.,'end':2.,'text':'第一句'}]},
                       {'cover_url':'/api/artwork/test/cover.png'}):
            self.assertNotEqual(original,metadata_fingerprint({**self.info,**change}))
        with self.assertRaisesRegex(RuntimeError,'歌词或信息已变化'):
            attach_metadata_fingerprint({**self.info,'lyrics':'不同'}, {'metadata_fingerprint':original})

    def test_old_request_and_matching_metadata_reuse_existing_handoff(self):
        old=self.bridge.create(self.request(),self.resolve)
        identity=metadata_fingerprint(self.info)
        result=self.bridge.create(self.request(identity),self.resolve)
        self.assertEqual(result['id'],old['id'])
        self.assertEqual(result['metadata_fingerprint'],identity)
        self.assertEqual(len(list(self.bridge.directory.glob('*.json'))),1)

    def test_changed_lyrics_cannot_reuse_old_handoff_id(self):
        old=self.bridge.create(self.request(),self.resolve)
        self.info['lyrics']='后来编辑的歌词'
        with self.assertRaisesRegex(RuntimeError,'另一版歌曲'):
            self.bridge.create(self.request(metadata_fingerprint(self.info)),self.resolve)
        self.assertEqual(self.bridge.public(self.bridge.read(HANDOFF))['lyrics'],old['lyrics'])
        other='30000000-0000-4000-8000-000000000003'
        updated=self.bridge.create({**self.request(metadata_fingerprint(self.info)),'request_id':other},self.resolve)
        self.assertEqual(updated['lyrics'],'后来编辑的歌词')
        self.assertEqual(len(list(self.bridge.directory.glob('*.json'))),2)

    def test_changed_metadata_between_lookup_and_freeze_is_rejected(self):
        wanted=metadata_fingerprint(self.info)
        self.info['timed_lyrics']=[{'start':1.,'end':2.,'text':'第一句'}]
        with self.assertRaisesRegex(RuntimeError,'歌词或信息已变化'):
            self.bridge.create(self.request(wanted),self.resolve)
        self.assertFalse((self.bridge.directory/(HANDOFF+'.json')).exists())

    def test_concurrent_same_identity_has_single_record(self):
        request=self.request(metadata_fingerprint(self.info))
        with ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda _:self.bridge.create(request,self.resolve),range(4)))
        self.assertEqual({item['id'] for item in results},{HANDOFF})
        self.assertEqual(len(list(self.bridge.directory.glob('*.json'))),1)

    def test_reuse_checks_current_metadata_before_returning(self):
        identity=metadata_fingerprint(self.info)
        self.bridge.create(self.request(identity),self.resolve)
        self.info['lyrics']='冻结以后又变更'
        with self.assertRaisesRegex(RuntimeError,'歌词或信息已变化'):
            self.bridge.create(self.request(identity),self.resolve)

    def test_corrupt_legacy_metadata_is_not_reported_as_missing(self):
        self.bridge.create(self.request(),self.resolve)
        file=self.bridge.directory/(HANDOFF+'.json')
        state=json.loads(file.read_text(encoding='utf-8'))
        state['public']['duration']=float('nan')
        file.write_text(json.dumps(state),encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError,'记录损坏'):
            self.bridge.public(self.bridge.read(HANDOFF))


if __name__=='__main__':unittest.main()
