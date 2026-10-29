"""Queued analysis must not cache parts against a different mix fingerprint."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from arrangement_adapter import render_guitar, render_piano
from test_candidate_review import fixture


class StaleArrangementMixTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='stale-arrangement-')
        self.root=Path(self.temporary.name)
        self.project,self.piano,_=fixture(self.root/'data')
        self.output=self.root/'job';self.output.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_piano_mix_change_during_analysis_rejected_before_render(self):
        p=self.project
        state={'fingerprint':p.fingerprint(),'start_seconds':2.,'end_seconds':4.}
        changed={}

        def analyze(*_args):
            p.apply({'type':'track_mix','track_id':'bass','gain_db':-3},'manual-during-analysis',p.state['revision'],compact=True)
            changed.update(state=deepcopy(p.state),persisted=p.file.read_bytes(),fingerprint=p.fingerprint())
            return {'analysis_legacy':{'test_only':True}}

        manifest_before=(p.directory/'additional-tracks.json').read_bytes()
        with patch('arrangement_evidence.prepare_inputs',side_effect=analyze), patch('arrangement_adapter._new_part') as render:
            with self.assertRaisesRegex(ValueError,'混音已变化'):
                render_piano(p.directory,state,self.output)
            render.assert_not_called()
        self.assertEqual(p.file.read_bytes(),changed['persisted'])
        self.assertEqual(p.state,changed['state'])
        self.assertEqual(p.fingerprint(),changed['fingerprint'])
        self.assertEqual((p.directory/'additional-tracks.json').read_bytes(),manifest_before)

    def test_guitar_non_source_mix_change_rejected_before_source_lookup(self):
        p=self.project;source=self.piano['id']
        p.apply({'type':'add_part','track_id':source},'fixture',p.state['revision'],compact=True)
        state={'fingerprint':p.fingerprint(),'start_seconds':2.,'end_seconds':4.,
               'source_track_id':source,'source_track_sha256':self.piano['sha256'],
               'source_track_state':deepcopy(p.state['tracks'][source])}
        p.apply({'type':'track_enabled','track_id':'drums','enabled':False},'manual-while-queued',p.state['revision'],compact=True)
        self.assertEqual(p.state['tracks'][source],state['source_track_state'])
        persisted=p.file.read_bytes();fingerprint=p.fingerprint()
        manifest_before=(p.directory/'additional-tracks.json').read_bytes()
        with patch('reorchestration.source_job') as lookup,patch('arrangement_adapter._new_part') as render:
            with self.assertRaisesRegex(ValueError,'混音已变化'):
                render_guitar(p.directory,state,self.output)
            lookup.assert_not_called();render.assert_not_called()
        self.assertEqual(p.file.read_bytes(),persisted)
        self.assertEqual(p.fingerprint(),fingerprint)
        self.assertEqual((p.directory/'additional-tracks.json').read_bytes(),manifest_before)


if __name__=='__main__':unittest.main()
