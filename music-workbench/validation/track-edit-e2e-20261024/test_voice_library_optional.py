"""An optional private voice archive must not be required by public source."""
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest

from voice_library import VoiceLibrary
from voice_presets import PRESETS


class OptionalVoiceLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.library = self.directory / 'references'
        self.library.mkdir()
        self.project = self.directory / 'project'
        self.project.mkdir()
        self.identifier = PRESETS[0]['reference_voice_id']

    def write_json(self, name, data):
        (self.library / name).write_text(json.dumps(data), encoding='utf-8')

    def fixture(self, *, manifest=True, sample=True):
        data = b'local checksum fixture; not an actual singing sample'
        (self.library / 'samples').mkdir()
        if sample:
            (self.library / 'samples' / 'reference.mp3').write_bytes(data)
        self.write_json('knowledge-base.json', {'voices': [{
            'web_voice_id': self.identifier, 'name': 'Local fixture',
            'sample_status': 'downloaded', 'local_sample': 'samples/reference.mp3',
        }]})
        if manifest:
            self.write_json('preview-manifest.json', {'manifest': [{
                'web_voice_id': self.identifier, 'status': 'downloaded',
                'sha256': hashlib.sha256(data).hexdigest(),
            }]})

    def test_absent_archive_returns_empty_catalog_and_no_selected_reference(self):
        (self.project / 'voice-reference-selection.json').write_text(
            json.dumps({'voice_id': self.identifier}))
        library = VoiceLibrary(self.library)
        result = library.catalog(self.project)
        self.assertEqual(result['voices'], [])
        self.assertEqual(result['count'], 0)
        self.assertIsNone(result['selected'])
        with self.assertRaises(ValueError):
            library.select(types.SimpleNamespace(directory=self.project), self.identifier)
        self.assertEqual(json.loads((self.project / 'voice-reference-selection.json').read_text()),
                         {'voice_id': self.identifier})

    def test_missing_manifest_never_advertises_unverified_preview(self):
        self.fixture(manifest=False)
        library = VoiceLibrary(self.library)
        self.assertEqual(library.catalog(self.project)['voices'], [])
        with self.assertRaisesRegex(ValueError, '未配置'):
            library.asset(self.identifier)

    def test_missing_sample_is_skipped(self):
        self.fixture(sample=False)
        library = VoiceLibrary(self.library)
        self.assertEqual(library.catalog(self.project)['count'], 0)
        with self.assertRaisesRegex(ValueError, '未配置'):
            library.asset(self.identifier)

    def test_real_local_reference_keeps_existing_checksum_and_selection_behavior(self):
        self.fixture()
        library = VoiceLibrary(self.library)
        result = library.catalog(self.project)
        self.assertEqual(result['count'], 1)  # Other preset references are absent.
        self.assertEqual(result['voices'][0]['id'], self.identifier)
        self.assertEqual(library.asset(self.identifier), (self.library / 'samples/reference.mp3').resolve())
        selected = library.select(types.SimpleNamespace(directory=self.project), self.identifier)
        self.assertEqual(selected['voice_id'], self.identifier)
        self.assertEqual(library.catalog(self.project)['selected'], selected)

    def test_bad_checksum_and_path_are_still_rejected(self):
        self.fixture()
        sample = self.library / 'samples/reference.mp3'
        sample.write_bytes(b'tampered data')
        library = VoiceLibrary(self.library)
        self.assertEqual(library.catalog(self.project)['count'], 0)
        with self.assertRaisesRegex(ValueError, '校验失败'):
            library.asset(self.identifier)
        library.voices[self.identifier]['local_sample'] = '../outside.mp3'
        with self.assertRaisesRegex(ValueError, '路径无效'):
            library.asset(self.identifier)


if __name__ == '__main__':
    unittest.main()
