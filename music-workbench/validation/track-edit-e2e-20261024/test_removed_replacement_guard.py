"""A removed replacement must not restore over changed source edits.

Tiny isolated synthetic projects only; no model, worker or user's project.
"""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import tempfile
import unittest

import numpy as np
import soundfile as sf

from candidate_review import CandidateReviews
from project import Project, save_json
from test_candidate_review import fixture


class RemovedReplacementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='removed-replacement-')
        self.root = Path(self.temporary.name)
        self.project, self.piano, _ = fixture(self.root / 'data')
        p = self.project
        p.apply({'type':'add_part','track_id':self.piano['id']}, 'fixture', p.state['revision'], compact=True)
        self.guitar = 'guitar_arr_1122334455'
        path = p.directory / (self.guitar + '.wav')
        sf.write(path, p.audio[self.piano['id']] * .9, p.sr, subtype='FLOAT')
        asset = {'id':self.guitar,'file':path.name,'label':'Synthetic replacement guard',
                 'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'range_seconds':[2.,4.],
                 'operation':'reorchestrate','replaces_track_id':self.piano['id'],
                 'source_track_sha256':self.piano['sha256'],
                 'source_track_state':deepcopy(p.state['tracks'][self.piano['id']])}
        manifest = json.loads((p.directory / 'additional-tracks.json').read_text())
        manifest['tracks'].append(asset)
        save_json(p.directory / 'additional-tracks.json', manifest)
        self.project = p = Project(p.directory)
        p.apply({'type':'replace_part','track_id':self.guitar}, 'fixture', p.state['revision'], compact=True)
        self.accepted_mix = p.mix()
        self.accepted_fingerprint = p.fingerprint()
        self.source_after_replacement = deepcopy(p.state['tracks'][self.piano['id']])
        p.apply({'type':'remove_track','track_id':self.guitar}, 'fixture', p.state['revision'], compact=True)
        self.reviews = CandidateReviews(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def body(self):
        p = self.project
        return {'project_id':p.state['id'],'revision':p.state['revision'],'kind':'arrangement',
                'candidate_id':self.guitar,'preview_start_seconds':2.,'preview_end_seconds':4.}

    def assert_rejected_without_mutation(self, command):
        p = self.project
        before = deepcopy(p.state); persisted = p.file.read_bytes(); fingerprint = p.fingerprint()
        with self.assertRaises(ValueError):
            p.apply(command, 'guard-test', p.state['revision'], compact=True)
        self.assertEqual(p.state, before)
        self.assertEqual(p.file.read_bytes(), persisted)
        self.assertEqual(p.fingerprint(), fingerprint)

    def test_normal_remove_restore_retains_single_replacement_mute(self):
        p = self.project
        review = self.reviews.prepare(p, self.body())
        self.assertTrue(review['can_apply'])
        command = self.reviews.validated_command(p, review['id'], self.body())
        p.apply(command, 'review', p.state['revision'], compact=True)
        self.assertEqual(p.state['tracks'][self.piano['id']], self.source_after_replacement)
        self.assertEqual(p.fingerprint(), self.accepted_fingerprint)
        self.assertTrue(np.array_equal(p.mix(), self.accepted_mix))

    def test_source_gain_change_rejects_restore_and_candidate_review(self):
        p = self.project
        p.apply({'type':'track_mix','track_id':self.piano['id'],'gain_db':-3}, 'manual', p.state['revision'], compact=True)
        self.assert_rejected_without_mutation({'type':'replace_part','track_id':self.guitar})
        before = p.file.read_bytes()
        with self.assertRaises(ValueError):
            self.reviews.prepare(p, self.body())
        self.assertEqual(p.file.read_bytes(), before)

    def test_source_segment_restore_rejects_double_layer(self):
        p = self.project
        p.apply({'type':'segment_gain','track_id':self.piano['id'],'mode':'restore',
                 'start_seconds':2.,'end_seconds':4.}, 'manual', p.state['revision'], compact=True)
        self.assertTrue(np.any(p.render_track(self.piano['id'])[2*p.sr+100:4*p.sr-100]))
        self.assert_rejected_without_mutation({'type':'replace_part','track_id':self.guitar})
        self.assertTrue(p.state['tracks'][self.guitar]['removed'])

    def test_removed_replacement_cannot_be_readded_as_add_part(self):
        self.assert_rejected_without_mutation({'type':'add_part','track_id':self.guitar})


if __name__ == '__main__':
    unittest.main()
