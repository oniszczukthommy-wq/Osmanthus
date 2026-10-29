"""Real decoded-share invariants, version isolation and frozen artwork."""
from pathlib import Path
from unittest.mock import patch
import base64,hashlib,json,subprocess,unittest,uuid
import numpy as np
import soundfile as sf
from share import ShareManager,sha
import test_export_parts as fixtures
FFMPEG=fixtures.FFMPEG
PCM24=fixtures.PCM24

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6sAAAAASUVORK5CYII=')

class ShareTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.ExportPartsTests();self.fixture.setUp();self.addCleanup(self.fixture.tearDown)
        self.project=self.fixture.project;self.root=self.fixture.root/'share-runtime'
        self.manager=ShareManager(self.root,FFMPEG)
        self.body={'request_id':str(uuid.uuid4()),'project_id':self.project.state['id'],'revision':0,
                   'title':'分享样例','quote':'这句歌词想唱给你听','creator':''}

    def test_mix_is_frozen_after_later_edit_and_decodes(self):
        p=self.project;frozen=p.audio_snapshot();expected=frozen.mix().copy();fingerprint=frozen.fingerprint()
        result=self.manager.create(frozen,self.body)
        p.apply({'type':'track_enabled','track_id':'vocals','enabled':False},'manual',0)
        wave=self.manager.asset(result['id'],'song.wav');audio,rate=sf.read(wave,dtype='float64',always_2d=True)
        self.assertEqual(rate,p.sr);self.assertEqual(audio.shape,expected.shape)
        self.assertLessEqual(float(np.max(np.abs(audio-expected))),PCM24)
        self.assertGreater(float(np.max(np.abs(audio-p.mix()))),.01)
        saved=self.manager.read(result['id']);self.assertEqual(saved['fingerprint'],fingerprint);self.assertEqual(saved['revision'],0)
        decoded=self.fixture.root/'decoded.wav'
        subprocess.run([str(FFMPEG),'-v','error','-i',str(self.manager.asset(result['id'],'song.mp3')),'-c:a','pcm_f32le',str(decoded)],capture_output=True,check=True)
        samples,mp3_rate=sf.read(decoded,always_2d=True)
        self.assertEqual(mp3_rate,p.sr);self.assertLess(abs(len(samples)/mp3_rate-result['duration']),.05)

    def test_duplicate_request_reuses_identical_media_and_encoding(self):
        with patch('share.subprocess.run',wraps=subprocess.run) as encode:
            first=self.manager.create(self.project.audio_snapshot(),self.body)
            again=self.manager.create(self.project.audio_snapshot(),self.body)
            self.assertEqual(encode.call_count,1)
        self.assertEqual(first,again);self.assertEqual(first['files'],again['files'])
        with self.assertRaises(RuntimeError):self.manager.create(self.project.audio_snapshot(),{**self.body,'quote':'不同的歌词'})
        self.assertEqual(first,self.manager.public(self.manager.read(first['id'])))

    def test_different_revision_or_project_cannot_be_mislabeled(self):
        self.project.apply({'type':'track_mix','track_id':'bass','gain_db':-3},'manual',0)
        with self.assertRaises(RuntimeError):self.manager.create(self.project.audio_snapshot(),self.body)
        with self.assertRaises(RuntimeError):self.manager.create(self.project.audio_snapshot(),{**self.body,'revision':1,'project_id':str(uuid.uuid4())})
        self.assertFalse(any(self.manager.directory.glob('*/state.json')))

    def test_artwork_is_context_matched_and_frozen(self):
        cover=self.fixture.root/'original-cover.png';cover.write_bytes(PNG)
        poster=self.fixture.root/'original-poster.png';poster.write_bytes(PNG)
        artwork={'project_id':self.project.state['id'],'source_sha256':self.project.state['source_sha256'],
                 'cover':{'path':str(cover),'sha256':sha(cover)},'poster':{'path':str(poster),'sha256':sha(poster)}}
        result=self.manager.create(self.project.audio_snapshot(),self.body,artwork)
        self.assertTrue(result['cover_url'].endswith('cover.png'));self.assertTrue(result['poster_url'].endswith('poster.png'))
        cover.write_bytes(b'later replacement');poster.unlink()
        self.assertEqual(self.manager.asset(result['id'],'cover.png').read_bytes(),PNG)
        self.assertEqual(self.manager.asset(result['id'],'poster.png').read_bytes(),PNG)

    def test_wrong_artwork_or_hash_is_rejected_without_ready_share(self):
        cover=self.fixture.root/'cover.png';cover.write_bytes(PNG)
        for i,art in enumerate([
            {'project_id':str(uuid.uuid4()),'source_sha256':self.project.state['source_sha256'],'path':str(cover),'sha256':sha(cover)},
            {'project_id':self.project.state['id'],'source_sha256':'different-source','path':str(cover),'sha256':sha(cover)},
            {'project_id':self.project.state['id'],'source_sha256':self.project.state['source_sha256'],'path':str(cover),'sha256':'wrong-hash'}]):
            body={**self.body,'request_id':str(uuid.uuid4())}
            with self.assertRaises(ValueError):self.manager.create(self.project.audio_snapshot(),body,art)
            self.assertEqual(self.manager.read(body['request_id'])['stage'],'error')
            with self.assertRaises(ValueError):self.manager.asset(body['request_id'],'song.mp3')

    def test_corrupted_or_unlisted_media_never_serves(self):
        result=self.manager.create(self.project.audio_snapshot(),self.body)
        for name in ('../state.json','state.json','.lock','cover.svg','unknown.mp3'):
            with self.assertRaises(ValueError):self.manager.asset(result['id'],name)
        path=self.manager.directory/result['id']/'song.mp3';path.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):self.manager.asset(result['id'],'song.mp3')
        with self.assertRaises(ValueError):self.manager.read('../'+result['id'])

    def test_clipping_is_rejected_without_normalizing_or_publishing(self):
        self.project.meta['master_gain']=100
        expected=self.project.mix().copy()
        with patch('share.subprocess.run') as encode:
            with self.assertRaises(ValueError):self.manager.create(self.project.audio_snapshot(),self.body)
            encode.assert_not_called()
        self.assertTrue(np.array_equal(expected,self.project.mix()))
        self.assertEqual(self.manager.read(self.body['request_id'])['stage'],'error')
        with self.assertRaises(ValueError):self.manager.asset(self.body['request_id'],'song.wav')

    def test_share_is_explicitly_local_without_fabricated_public_url(self):
        result=self.manager.create(self.project.audio_snapshot(),self.body)
        self.assertEqual(result['access_scope'],'local_device');self.assertTrue(result['immutable'])
        self.assertEqual(result['local_url'],'/share/'+self.body['request_id'])
        self.assertNotIn('public_url',result);self.assertNotIn('qr',result)
        self.assertIsNone(result['cover_url']);self.assertIsNone(result['poster_url'])
        self.assertEqual(result['share_text'],'《分享样例》\n这句歌词想唱给你听\nOsmanthus')
        self.assertNotIn('创作：',result['share_text'])

    def test_invalid_metadata_never_creates_request_folder(self):
        for field,value in [('title',''),('title','x'*121),('quote','x'*501),('creator','x'*81),('revision',False),('request_id','not-a-uuid')]:
            with self.subTest(field=field):
                with self.assertRaises((ValueError,RuntimeError)):self.manager.create(self.project.audio_snapshot(),{**self.body,field:value})
        self.assertFalse(any(self.manager.directory.glob('*/state.json')))

    def test_source_audio_and_project_file_not_changed_by_sharing(self):
        before={p.name:sha(p) for p in self.fixture.data.iterdir() if p.is_file()}
        self.manager.create(self.project.audio_snapshot(),self.body)
        self.assertEqual(before,{p.name:sha(p) for p in self.fixture.data.iterdir() if p.is_file()})

    def original(self):
        source=self.fixture.root/'complete.mp3';wav=self.fixture.root/'raw.wav'
        sf.write(wav,self.project.mix(),self.project.sr,subtype='PCM_24')
        subprocess.run([str(FFMPEG),'-v','error','-i',str(wav),'-c:a','libmp3lame',str(source)],capture_output=True,check=True)
        identifier=str(uuid.uuid4())
        return {'id':identifier,'title':'未分轨的完整歌曲','download_ready':True},source,{'request_id':str(uuid.uuid4()),'candidate_id':identifier,'quote':'先听歌再决定是否编辑'}

    def test_unprepared_original_freezes_exact_mp3_without_encoding(self):
        job,source,body=self.original();expected=source.read_bytes()
        with patch('share.subprocess.run') as encoder:
            result=self.manager.create_original(job,source,body)
            again=self.manager.create_original(job,source,body)
            encoder.assert_not_called()
        self.assertEqual(result,again);self.assertEqual(result['source_kind'],'generated_original')
        self.assertEqual(result['project_id'],job['id']);self.assertEqual(result['revision'],0)
        self.assertEqual(result['version_label'],'原始生成成品');self.assertIsNone(result['wav_url'])
        self.assertEqual(result['files']['song.mp3']['sha256'],hashlib.sha256(expected).hexdigest())
        source.unlink()
        self.assertEqual(self.manager.asset(result['id'],'song.mp3').read_bytes(),expected)
        self.assertFalse((self.root/'projects').exists())

    def test_original_rejects_incomplete_wrong_identity_and_changed_source(self):
        job,source,body=self.original()
        with self.assertRaises(ValueError):self.manager.create_original({**job,'download_ready':False},source,body)
        with self.assertRaises(RuntimeError):self.manager.create_original(job,source,{**body,'candidate_id':str(uuid.uuid4())})
        with self.assertRaises(ValueError):self.manager.create_original(job,source,{**body,'revision':1})
        self.manager.create_original(job,source,body)
        # A different, valid audio with the same candidate ID cannot replace
        # already shared bytes through request replay.
        second=self.fixture.root/'second.mp3';wav=self.fixture.root/'second.wav'
        sf.write(wav,self.project.mix()*.5,self.project.sr)
        subprocess.run([str(FFMPEG),'-v','error','-i',str(wav),'-c:a','libmp3lame',str(second)],capture_output=True,check=True)
        with self.assertRaises(RuntimeError):self.manager.create_original(job,second,body)

if __name__=='__main__':unittest.main()
