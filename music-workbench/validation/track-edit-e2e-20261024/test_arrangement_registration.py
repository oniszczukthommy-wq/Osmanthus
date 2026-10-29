"""Content IDs refer to audio PCM, while receipts pin immutable WAV bytes."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import hashlib
import json
import tempfile
import time
import unittest

import numpy as np

from arrangement_adapter import _register


class ArrangementRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='arrangement-register-')
        self.directory = Path(self.temporary.name)
        self.project = SimpleNamespace(directory=self.directory, sr=8000,
                                       meta={'source_sha256':'isolated-register-fixture'})
        self.part = np.zeros((800,2),dtype='float32')
        self.part[100:700,0] = .02
        self.part[100:700,1] = -.02
        self.metadata = {'id':'piano_add_1122334455','operation':'piano',
                         'instrument':'piano','range_seconds':[0.,.1]}

    def tearDown(self):
        self.temporary.cleanup()

    def register(self, part=None):
        return _register(self.project,self.part if part is None else part,deepcopy(self.metadata))

    def test_identical_pcm_at_new_wav_timestamp_reuses_original_receipt(self):
        first = self.register()
        path = self.directory / first['file']
        original_bytes = path.read_bytes()
        # libsndfile FLOAT WAV PEAK chunk timestamps have whole-second resolution.
        time.sleep(1.1)
        second = self.register()
        self.assertEqual(path.read_bytes(),original_bytes)
        self.assertEqual(first['sha256'],second['sha256'])
        self.assertEqual(second['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
        manifest=json.loads((self.directory/'additional-tracks.json').read_text())
        self.assertEqual(len(manifest['tracks']),1)
        self.assertEqual(manifest['tracks'][0]['sha256'],second['sha256'])
        self.assertEqual(first['label'],second['label'])
        self.assertEqual(first['ordinal'],second['ordinal'])

    def test_different_pcm_under_same_id_is_rejected_without_overwrite(self):
        first=self.register();path=self.directory/first['file'];manifest=self.directory/'additional-tracks.json'
        audio_before=path.read_bytes();manifest_before=manifest.read_bytes()
        changed=self.part.copy();changed[300,0]+=.01
        with self.assertRaises(ValueError):self.register(changed)
        self.assertEqual(path.read_bytes(),audio_before)
        self.assertEqual(manifest.read_bytes(),manifest_before)
        self.assertFalse(list(self.directory.glob('.arrangement-*.wav')))

    def test_manifest_hash_mismatch_is_not_silently_repaired(self):
        first=self.register();path=self.directory/first['file'];manifest=self.directory/'additional-tracks.json'
        # Legal WAV readers ignore trailing bytes; decoded PCM is unchanged.
        # A receipt mismatch must still fail, not silently authorize tampering.
        with path.open('ab') as stream:stream.write(b'changed-after-registration')
        changed=path.read_bytes();manifest_before=manifest.read_bytes()
        with self.assertRaises(ValueError):self.register()
        self.assertEqual(path.read_bytes(),changed)
        self.assertEqual(manifest.read_bytes(),manifest_before)


if __name__=='__main__':unittest.main()
