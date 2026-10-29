"""Candidate comparisons must preserve the live project and current mixer."""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import tempfile
import unittest
import uuid

import numpy as np
import soundfile as sf

from project import Project, save_json
from candidate_review import CandidateReviews, comparison_gain, seam_metrics


def fixture(directory):
    directory.mkdir(parents=True, exist_ok=True)
    sr=8000
    t=np.arange(sr*6)/sr
    tracks=[]
    for i,name in enumerate(('vocals','drums','bass','other')):
        audio=np.repeat((.035*np.sin(2*np.pi*(120+50*i)*t))[:,None],2,axis=1).astype('float32')
        path=directory/(name+'.wav');sf.write(path,audio,sr,subtype='FLOAT')
        tracks.append({'id':name,'file':path.name,'label':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    meta={'project_id':str(uuid.uuid4()),'source_sha256':'synthetic-song','song_title':'Synthetic review fixture',
          'sample_rate':sr,'frames':len(t),'duration_seconds':6.,'master_gain':.8,'separation_seconds':0,'tracks':tracks}
    save_json(directory/'preparation.json',meta)
    p=Project(directory)
    candidate=np.zeros((len(t),2),dtype='float32')
    candidate[2*sr:4*sr]=np.repeat((.025*np.sin(2*np.pi*360*t[:2*sr]))[:,None],2,axis=1)
    name='piano_add_0123456789';path=directory/(name+'.wav');sf.write(path,candidate,sr,subtype='FLOAT')
    part={'id':name,'file':path.name,'label':'New piano','sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
          'range_seconds':[2.,4.],'generated':True,'operation':'piano'}
    save_json(directory/'additional-tracks.json',{'source_sha256':meta['source_sha256'],'tracks':[part]})
    vocal=.65*p.audio['vocals']
    name='vocal_0123456789ab';path=directory/(name+'.wav');sf.write(path,vocal,sr,subtype='FLOAT')
    voice={'id':name,'file':path.name,'label':'Synthetic voice','sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
           'source_vocal_sha256':tracks[0]['sha256'],'engine':'synthetic','quality_accepted':False}
    save_json(directory/'vocal-variants.json',{'source_sha256':meta['source_sha256'],'variants':[voice]})
    return Project(directory),part,voice


class ExistingCandidateBaseline(unittest.TestCase):
    def test_existing_reducer_candidate_snapshot_and_undo(self):
        with tempfile.TemporaryDirectory() as tmp:
            p,part,_=fixture(Path(tmp)/'data')
            original=p.mix();state=deepcopy(p.state);persisted=p.file.read_bytes()
            preview=p.audio_snapshot();preview.file=Path(tmp)/'preview-only-state.json'
            preview.apply({'type':'add_part','track_id':part['id']},'baseline',preview.state['revision'],compact=True)
            changed=preview.mix();a,b=2*p.sr,4*p.sr
            self.assertTrue(np.array_equal(original[:a],changed[:a]))
            self.assertTrue(np.array_equal(original[b:],changed[b:]))
            self.assertFalse(np.array_equal(original[a:b],changed[a:b]))
            self.assertEqual(p.state,state);self.assertEqual(p.file.read_bytes(),persisted)
            # Undo already exists and restores the exact source mix.
            preview.move_history('undo',preview.state['revision'])
            self.assertTrue(np.array_equal(preview.mix(),original))


class CandidateReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.p,self.part,self.voice=fixture(self.root/'data')
        self.reviews=CandidateReviews(self.root)

    def tearDown(self):self.tmp.cleanup()

    def body(self,kind='arrangement'):
        return {'project_id':self.p.state['id'],'revision':self.p.state['revision'],'kind':kind,
                'candidate_id':(self.part if kind=='arrangement' else self.voice)['id'],
                'preview_start_seconds':2.,'preview_end_seconds':4.}

    def test_prepare_uses_current_mix_without_editing_project(self):
        self.p.apply({'type':'track_enabled','track_id':'drums','enabled':False},'test',0,compact=True)
        self.p.apply({'type':'segment_gain','track_id':'bass','start_seconds':1,'end_seconds':5,'mode':'gain','gain_db':-6},'test',1,compact=True)
        saved=self.p.file.read_bytes();state=deepcopy(self.p.state);expected=self.p.mix()
        review=self.reviews.prepare(self.p,self.body())
        self.assertEqual(self.p.file.read_bytes(),saved);self.assertEqual(self.p.state,state)
        ref,sr=sf.read(self.reviews.asset(review['id'],'reference.wav'),dtype='float32',always_2d=True)
        self.assertTrue(np.allclose(ref,expected*review['matching']['common_peak_gain'],atol=2**-22))
        self.assertTrue(review['checks']['non_target_tracks_unchanged'])
        self.assertTrue(review['checks']['outside_range_sample_identical'])
        self.assertFalse(review['checks']['musical_quality_accepted'])

    def test_apply_is_pinned_and_undo_exact(self):
        baseline=self.p.mix();fp=self.p.fingerprint();review=self.reviews.prepare(self.p,self.body())
        body={'project_id':self.p.state['id'],'revision':self.p.state['revision']}
        command=self.reviews.validated_command(self.p,review['id'],body)
        self.p.apply(command,'candidate-review',body['revision'],compact=True)
        self.assertFalse(np.array_equal(self.p.mix(),baseline))
        self.p.move_history('undo',self.p.state['revision'])
        self.assertEqual(self.p.fingerprint(),fp);self.assertTrue(np.array_equal(self.p.mix(),baseline))
        with self.assertRaises(RuntimeError):
            self.reviews.validated_command(self.p,review['id'],{'project_id':self.p.state['id'],'revision':self.p.state['revision']})

    def test_revision_and_song_switch_rejected(self):
        review=self.reviews.prepare(self.p,self.body());fingerprint=self.p.fingerprint()
        with self.assertRaises(RuntimeError):
            self.reviews.validated_command(self.p,review['id'],{'project_id':str(uuid.uuid4()),'revision':0})
        self.p.apply({'type':'track_enabled','track_id':'bass','enabled':False},'test',0,compact=True)
        with self.assertRaises(RuntimeError):
            self.reviews.validated_command(self.p,review['id'],{'project_id':self.p.state['id'],'revision':1})
        self.assertNotEqual(self.p.fingerprint(),fingerprint)

    def test_current_voice_mix_matches_candidate_and_backing(self):
        self.p.apply({'type':'track_mix','track_id':'vocals','gain_db':-6},'test',0,compact=True)
        review=self.reviews.prepare(self.p,self.body('vocal'))
        self.assertEqual(review['range_seconds'],[0.,6.])
        self.assertEqual(review['requested_preview_range_seconds'],[2.,4.])
        base=self.p.mix();command=self.reviews.validated_command(self.p,review['id'],self.body('vocal'))
        self.p.apply(command,'review',self.p.state['revision'],compact=True)
        out,rate=sf.read(self.reviews.asset(review['id'],'candidate-actual.wav'),dtype='float32',always_2d=True)
        self.assertTrue(np.allclose(out,self.p.mix()*review['matching']['common_peak_gain'],atol=2**-22))
        self.assertTrue(all(self.p.state['tracks'][k]['gain_db']==0 for k in ('drums','bass','other')))
        self.assertFalse(np.array_equal(base,self.p.mix()))

    def test_candidate_audio_tampering_rejected(self):
        review=self.reviews.prepare(self.p,self.body());saved=self.p.file.read_bytes()
        with (self.p.directory/self.part['file']).open('ab') as f:f.write(b'tampered')
        with self.assertRaises(ValueError):self.reviews.validated_command(self.p,review['id'],self.body())
        self.assertEqual(saved,self.p.file.read_bytes())

    def test_candidate_metadata_tampering_rejected(self):
        review=self.reviews.prepare(self.p,self.body());path=self.p.directory/'additional-tracks.json'
        data=json.loads(path.read_text());data['tracks'][0]['label']='Changed';save_json(path,data)
        with self.assertRaises(RuntimeError):self.reviews.validated_command(self.p,review['id'],self.body())

    def test_identical_prepare_reuses_files_but_malformed_cache_does_not_block(self):
        bad=self.reviews.directory/'bad';bad.mkdir();(bad/'state.json').write_text('invalid json')
        first=self.reviews.prepare(self.p,self.body());second=self.reviews.prepare(self.p,self.body())
        self.assertEqual(first['id'],second['id'])
        self.assertEqual(len(list(self.reviews.directory.glob('*/reference.wav'))),1)

    def test_reorchestration_preview_matches_reducer_and_keeps_other_tracks(self):
        self.p.apply({'type':'add_part','track_id':self.part['id']},'test',0,compact=True)
        audio=np.zeros_like(self.p.audio['vocals']);sr=self.p.sr
        audio[round(2.5*sr):round(3.5*sr)]=np.repeat((.022*np.sin(2*np.pi*280*np.arange(sr)/sr))[:,None],2,axis=1)
        name='guitar_arr_abcdef1234';path=self.p.directory/(name+'.wav');sf.write(path,audio,sr,subtype='FLOAT')
        asset={'id':name,'file':path.name,'label':'Guitar rearranged','sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
               'range_seconds':[2.5,3.5],'operation':'reorchestrate','replaces_track_id':self.part['id'],
               'source_track_sha256':self.part['sha256'],'source_track_state':deepcopy(self.p.state['tracks'][self.part['id']])}
        manifest=json.loads((self.p.directory/'additional-tracks.json').read_text());manifest['tracks'].append(asset)
        save_json(self.p.directory/'additional-tracks.json',manifest)
        body={**self.body(),'candidate_id':name}
        original=self.p.mix();review=self.reviews.prepare(self.p,body)
        self.assertEqual({x['id'] for x in review['targets']},{name,self.part['id']})
        command=self.reviews.validated_command(self.p,review['id'],body);self.p.apply(command,'review',self.p.state['revision'],compact=True)
        actual=self.p.mix();a,b=round(2.5*sr),round(3.5*sr)
        self.assertTrue(np.array_equal(original[:a],actual[:a]) and np.array_equal(original[b:],actual[b:]))
        self.assertFalse(np.array_equal(original[a:b],actual[a:b]))
        self.assertTrue(review['checks']['non_target_tracks_unchanged'])

    def test_invalid_candidate_identifier_rejected(self):
        for identifier in (None,'../../project','piano_add_bad'):
            with self.assertRaises(ValueError):self.reviews.prepare(self.p,{**self.body(),'candidate_id':identifier})

    def test_preview_file_tampering_rejected(self):
        review=self.reviews.prepare(self.p,self.body());path=self.reviews.asset(review['id'],'candidate.wav')
        with path.open('ab') as f:f.write(b'tampered')
        with self.assertRaises(ValueError):self.reviews.asset(review['id'],'candidate.wav')
        with self.assertRaises(ValueError):self.reviews.asset(review['id'],'../../data/project.json')

    def test_candidate_outside_scope_is_rejected(self):
        path=self.p.directory/self.part['file'];audio,rate=sf.read(path,dtype='float32',always_2d=True)
        audio[0]=.01;sf.write(path,audio,rate,subtype='FLOAT')
        manifest=json.loads((self.p.directory/'additional-tracks.json').read_text())
        manifest['tracks'][0]['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        save_json(self.p.directory/'additional-tracks.json',manifest)
        with self.assertRaises(ValueError):self.reviews.prepare(self.p,self.body())

    def test_preview_range_must_overlap_and_be_finite(self):
        for start,end in ((0,1),(float('nan'),3),(2,True),(4,2)):
            with self.assertRaises(ValueError):self.reviews.prepare(self.p,{**self.body(),'preview_start_seconds':start,'preview_end_seconds':end})

    def test_matching_and_seam_flags_are_diagnostic(self):
        a=np.ones((800,2),dtype='float32')*.1;b=a*.5
        matching=comparison_gain(a,b)
        self.assertAlmostEqual(matching['candidate_gain_db'],6.,places=4)
        self.assertTrue(matching['preview_only'])
        loud=a*20
        lowered=comparison_gain(a,loud)
        self.assertLessEqual(float(np.max(loud))*lowered['common_peak_gain'],.9500001)
        b[400:]+=.2
        seams=seam_metrics(a,b,[.05],8000)
        self.assertTrue(seams[0]['needs_listening'])

    def test_inactive_voice_is_visible_but_cannot_apply_without_audition(self):
        self.p.apply({'type':'track_enabled','track_id':'vocals','enabled':False},'test',0,compact=True)
        review=self.reviews.prepare(self.p,self.body('vocal'))
        self.assertFalse(review['can_apply']);self.assertFalse(review['checks']['audible_mix_changed'])
        with self.assertRaises(ValueError):self.reviews.validated_command(self.p,review['id'],self.body('vocal'))


if __name__=='__main__':unittest.main()
