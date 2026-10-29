"""Decoded-file invariants for frozen range and routed stem exports."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import hashlib,json,subprocess,tempfile,unittest,uuid,zipfile
import numpy as np
import soundfile as sf

from export_parts import export_parts
from project import Project,save_json

FFMPEG=Path(__file__).resolve().parent.parent/'audiocraft/conda-env/bin/ffmpeg'
PCM24=1/2**23

class ExportPartsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.data=self.root/'data';self.data.mkdir();self.output=self.root/'exports'
        rate=16000;count=rate*2;t=np.arange(count)/rate
        self.meta={'project_id':str(uuid.uuid4()),'generation_job_id':str(uuid.uuid4()),
                   'song_title':'导出取样验证','source_sha256':'verified-fixture-source',
                   'sample_rate':rate,'frames':count,'duration_seconds':count/rate,
                   'master_gain':.7,'separation_seconds':0,'tracks':[]}
        # Different channels/frequencies make accidental summation or source
        # selection visible instead of using identical or all-zero tracks.
        for i,name in enumerate(('vocals','drums','bass','other')):
            audio=np.stack([.08*np.sin(2*np.pi*(130+i*71)*t),
                            .06*np.cos(2*np.pi*(170+i*59)*t)],axis=1).astype('float32')
            p=self.data/(name+'.wav');sf.write(p,audio,rate,subtype='FLOAT')
            self.meta['tracks'].append({'id':name,'file':p.name,'label':name,
                'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'color':'#ccbb99'})
        save_json(self.data/'preparation.json',self.meta)
        self.project=Project(self.data)

    def tearDown(self):self.temp.cleanup()

    def export(self,scope='range',kind='wav',**kw):
        return export_parts(self.project.audio_snapshot(),{'scope':scope,'format':kind,
            'start_seconds':.30003,'end_seconds':1.20002,**kw},self.output,FFMPEG)

    def read(self,report):
        payload=(self.output/report['filename']).read_bytes()
        self.assertEqual(hashlib.sha256(payload).hexdigest(),report['sha256'])
        self.assertEqual(len(payload),report['bytes'])
        return sf.read(BytesIO(payload),dtype='float64',always_2d=True)

    def stems(self,report):
        payload=(self.output/report['filename']).read_bytes()
        self.assertEqual(hashlib.sha256(payload).hexdigest(),report['sha256'])
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            manifest=json.loads(archive.read('manifest.json'))
            waves={r['track_id']:sf.read(BytesIO(archive.read(r['file'])),dtype='float64',always_2d=True)[0]
                   for r in manifest['tracks']}
        return manifest,waves

    def test_range_is_exact_selected_frames_with_pcm24_quantization(self):
        report=self.export();audio,rate=self.read(report)
        a,b=round(.30003*rate),round(1.20002*rate)
        expected=self.project.mix()[a:b]
        self.assertEqual(audio.shape,expected.shape)
        self.assertLessEqual(float(np.max(np.abs(audio-expected))),PCM24)
        self.assertEqual(report['frames'],b-a)
        self.assertEqual(report['range_seconds'],[a/rate,b/rate])
        self.assertEqual(report['project_id'],self.project.state['id'])
        self.assertEqual(report['generation_job_id'],self.meta['generation_job_id'])

    def test_stems_sum_matches_current_mix_with_mute_gain_segment_and_master(self):
        p=self.project
        p.apply({'type':'track_mix','track_id':'vocals','gain_db':-7},'manual',0)
        p.apply({'type':'segment_gain','track_id':'bass','mode':'mute','gain_db':0,
                 'start_seconds':.45,'end_seconds':.75},'manual',1)
        p.apply({'type':'track_enabled','track_id':'drums','enabled':False},'manual',2)
        manifest,waves=self.stems(self.export('stems'))
        result=np.sum(list(waves.values()),axis=0)
        self.assertLessEqual(float(np.max(np.abs(result-p.mix()))),len(waves)*PCM24+2*np.finfo(np.float32).eps)
        self.assertTrue(np.all(waves['drums']==0))
        r=next(r for r in manifest['tracks'] if r['track_id']=='drums')
        self.assertFalse(r['audible'])
        self.assertEqual(r['gain'],0)
        self.assertEqual(manifest['revision'],3)
        self.assertEqual(manifest['fingerprint'],p.fingerprint())

    def test_segment_edit_changes_only_selected_stem_interval(self):
        _,before=self.stems(self.export('stems'))
        p=self.project;a,b=8000,12800
        p.apply({'type':'segment_gain','track_id':'bass','mode':'gain','gain_db':-12,
                 'start_seconds':a/p.sr,'end_seconds':b/p.sr},'manual',0)
        _,after=self.stems(self.export('stems'))
        for name in before:
            if name!='bass':self.assertTrue(np.array_equal(before[name],after[name]))
        self.assertTrue(np.array_equal(before['bass'][:a],after['bass'][:a]))
        self.assertTrue(np.array_equal(before['bass'][b:],after['bass'][b:]))
        self.assertGreater(float(np.max(np.abs(before['bass'][a:b]-after['bass'][a:b]))),.01)

    def test_solo_and_removed_stems_follow_current_mix(self):
        p=self.project
        p.apply({'type':'track_mix','track_id':'vocals','solo':True},'manual',0)
        p.apply({'type':'remove_track','track_id':'other'},'manual',1)
        manifest,waves=self.stems(self.export('stems'))
        self.assertNotIn('other',waves)
        self.assertTrue(np.all(waves['bass']==0))
        self.assertTrue(np.all(waves['drums']==0))
        self.assertLessEqual(float(np.max(np.abs(waves['vocals']-p.mix()))),PCM24)
        self.assertEqual(len(manifest['tracks']),3)

    def test_snapshot_export_retains_revision_after_live_edits(self):
        p=self.project;frozen=p.audio_snapshot();expected=frozen.mix().copy();fingerprint=frozen.fingerprint()
        p.apply({'type':'track_enabled','track_id':'vocals','enabled':False},'manual',0)
        report=export_parts(frozen,{'scope':'range','format':'wav','start_seconds':0,'end_seconds':2},self.output,FFMPEG)
        audio,_=self.read(report)
        self.assertEqual(report['revision'],0)
        self.assertEqual(report['fingerprint'],fingerprint)
        self.assertLessEqual(float(np.max(np.abs(audio-expected))),PCM24)
        self.assertGreater(float(np.max(np.abs(audio-p.mix()))),.01)

    def test_history_restore_recovers_exact_samples_and_keeps_redo_exports(self):
        p=self.project;initial=p.mix().copy()
        p.apply({'type':'track_mix','track_id':'vocals','gain_db':-9},'manual',0)
        middle=p.mix().copy()
        p.apply({'type':'segment_gain','track_id':'bass','mode':'mute','gain_db':0,
                 'start_seconds':.5,'end_seconds':1.1},'manual',1)
        p.apply({'type':'track_enabled','track_id':'drums','enabled':False},'manual',2)
        latest=p.mix().copy();history=deepcopy(p.state['history'])

        view=p.restore_history(0,3)
        self.assertTrue(np.array_equal(initial,p.mix()))
        self.assertEqual(p.state['revision'],4)
        self.assertTrue(view['can_redo'])
        restored,_=self.read(self.export(start_seconds=0,end_seconds=2))
        self.assertLessEqual(float(np.max(np.abs(restored-initial))),PCM24)

        view=p.restore_history(1,4)
        self.assertTrue(np.array_equal(middle,p.mix()))
        self.assertEqual(p.state['cursor'],1)
        self.assertTrue(view['can_redo'])
        restored,_=self.read(self.export(start_seconds=0,end_seconds=2))
        self.assertLessEqual(float(np.max(np.abs(restored-middle))),PCM24)
        self.assertEqual(history,p.state['history'])

        p.move_history('redo',5);p.move_history('redo',6)
        self.assertTrue(np.array_equal(latest,p.mix()))
        self.assertFalse(p.view()['can_redo'])
        before=deepcopy(p.state)
        with self.assertRaises(RuntimeError):p.restore_history(0,6)
        for invalid in (-1,4,True,1.5):
            with self.subTest(cursor=invalid),self.assertRaises(ValueError):p.restore_history(invalid,7)
        self.assertEqual(before,p.state)
        self.assertTrue(np.array_equal(latest,p.mix()))

    def test_invalid_range_never_publishes_an_export(self):
        for a,b in ((1,.5),(-1,1),(0,3),(float('nan'),1),(0,float('inf')),(True,1),(None,1),(0,1e-8)):
            with self.subTest(start=a,end=b),self.assertRaises(ValueError):self.export(start_seconds=a,end_seconds=b)
        self.assertFalse(self.output.exists())

    def test_identical_zip_snapshot_has_identical_bytes(self):
        first=self.export('stems');first_bytes=(self.output/first['filename']).read_bytes()
        second=self.export('stems')
        self.assertEqual(first['filename'],second['filename'])
        self.assertEqual(first['sha256'],second['sha256'])
        self.assertEqual(first_bytes,(self.output/second['filename']).read_bytes())

    def test_export_does_not_mutate_project_or_source_files(self):
        state=deepcopy(self.project.state);datahashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.data.glob('*.wav')}
        self.export();self.export('stems')
        self.assertEqual(state,self.project.state)
        self.assertEqual(datahashes,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.data.glob('*.wav')})

    @unittest.skipUnless(FFMPEG.exists(),'ffmpeg unavailable')
    def test_mp3_selection_decodes_full_selected_duration(self):
        report=self.export(kind='mp3');path=self.output/report['filename'];decoded=self.root/'decoded.wav'
        subprocess.run([str(FFMPEG),'-nostdin','-v','error','-i',str(path),str(decoded)],check=True,capture_output=True)
        audio,rate=sf.read(decoded,always_2d=True)
        self.assertEqual(len(audio),report['frames'])
        self.assertEqual(rate,self.project.sr)
        self.assertTrue(np.isfinite(audio).all())
        self.assertGreater(float(np.max(np.abs(audio))),.01)

if __name__=='__main__':unittest.main()
