"""Windows score-worker encoding and audio-staging regressions."""
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import scores


class ScoreWindowsTests(unittest.TestCase):
    def test_worker_is_started_in_utf8_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            identifier = str(uuid.uuid4())
            project = SimpleNamespace(directory=Path(tmp), state={'id': identifier})
            context = {'project_id': identifier, 'basis': 'original_complete_lead_vocal'}
            with patch.object(scores, 'JOBS', Path(tmp)), \
                 patch.object(scores, 'source_context', return_value=(context, '中文歌词')), \
                 patch('score_review.active_saved_score', return_value=None), \
                 patch.object(scores.subprocess, 'Popen') as launch:
                launch.return_value.poll.return_value = None
                result = scores.Scores().start(project, {'project_id': identifier, 'request_id': str(uuid.uuid4())})
            args, kwargs = launch.call_args
            self.assertEqual(result['stage'], 'queued')
            self.assertEqual(args[0][1:3], ['-X', 'utf8'])
            self.assertEqual(kwargs['env']['PYTHONUTF8'], '1')
            self.assertEqual(kwargs['env']['PYTHONIOENCODING'], 'utf-8')

    def test_symlink_permission_failure_copies_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source.wav', Path(tmp) / 'staged.wav'
            source.write_bytes(b'original audio')
            with patch.object(Path, 'symlink_to', side_effect=PermissionError('symlinks disabled')):
                scores.stage_alignment_audio(source, target)
            self.assertFalse(target.is_symlink())
            self.assertEqual(target.read_bytes(), source.read_bytes())

    def test_existing_target_is_not_overwritten_on_symlink_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'source.wav', Path(tmp) / 'staged.wav'
            source.write_bytes(b'source')
            target.write_bytes(b'existing')
            with patch.object(Path, 'symlink_to', side_effect=PermissionError('symlinks disabled')):
                with self.assertRaises(PermissionError):
                    scores.stage_alignment_audio(source, target)
            self.assertEqual(target.read_bytes(), b'existing')


if __name__ == '__main__':
    unittest.main()
