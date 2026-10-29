"""Offline integration checks for the song-completion artwork handoff.

The byte fixture is not musical evidence. All provider and subprocess calls
are blocked; the real Workflow.run, state persistence and stage changes run.
"""
import hashlib
import json
import tempfile
import time
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import workflow as w


class ArtworkWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.runs = self.root / 'runs'
        self.runs.mkdir()
        self.projects = self.root / 'projects'
        self.projects.mkdir()
        for owner, name, value in (
            (w, 'RUNS', self.runs), (w, 'PROJECTS', self.projects),
            (w.STREAM, 'ROOT', self.root), (w.STREAM, 'JOBS', {}),
        ):
            self.stack.enter_context(patch.object(owner, name, value))
        self.provider = self.stack.enter_context(patch.object(
            w.STREAM, 'worker', side_effect=AssertionError('paid music call blocked')))
        self.process = self.stack.enter_context(patch.object(
            w.subprocess, 'run', side_effect=AssertionError('external process blocked')))
        self.work = w.Workflow()
        self.writer = self.stack.enter_context(patch.object(
            self.work, 'lyrics', side_effect=AssertionError('approved lyrics must not be rewritten')))
        self.audio = b'Offline complete-audio fixture; not a playable song.'
        self.job = {
            'id': str(uuid.uuid4()), 'project_id': '', 'batch_id': str(uuid.uuid4()),
            'candidate_slot': 'A', 'selected_for_preparation': False,
            'origin': 'new_generation', 'title': '雨后归途', 'style': '中文民谣',
            'voice': '温暖自然的男声', 'lyrics': '[VERSE]\n走过雨后的街\n[CHORUS]\n沿着灯光回家',
            'prompt': 'approved music prompt', 'created_at': time.time(),
            'status': 'pending', 'stage': 'generating', 'download_ready': False,
            'events': [],
        }
        self.job['project_id'] = self.job['id']
        self.work.jobs[self.job['id']] = self.job
        self.work.running.add(self.job['id'])
        w.STREAM.persist(self.job)
        self.folder = self.runs / self.job['id']

    def saved(self):
        return json.loads((self.folder / 'state.json').read_text())

    def test_completed_generation_enqueues_cover_for_exact_audio_and_keeps_approved_lyrics(self):
        approved_lyrics = self.job['lyrics']
        artwork_id = str(uuid.uuid4())

        def finish_download(job):
            (self.folder / 'complete.mp3').write_bytes(self.audio)
            job.update(download_ready=True, status='done', duration_seconds=180.0)
            w.STREAM.event(job, 'download_ready')

        def enqueue(reference):
            if not reference['source_sha256']:
                self.assertFalse(self.job['download_ready'])
                self.assertEqual(reference['title'], '雨后归途')
                return {'id': artwork_id, 'stage': 'queued'}
            self.assertTrue(self.job['download_ready'])
            self.assertTrue((self.folder / 'complete.mp3').is_file())
            self.assertEqual(reference, {
                'project_id': self.job['id'], 'title': '雨后归途',
                'lyrics': approved_lyrics, 'style': '中文民谣',
                'source_sha256': hashlib.sha256(self.audio).hexdigest(),
            })
            # Returning a queued job must not delay song selection until image
            # generation completes. Artwork's queue/deduplication is tested in
            # test_artwork.py; this checks the actual workflow handoff.
            return {'id': artwork_id, 'stage': 'queued'}

        self.provider.side_effect = finish_download
        ensure = Mock(side_effect=enqueue)
        self.work.artwork = SimpleNamespace(ensure=ensure)
        self.work.run(self.job)

        self.provider.assert_called_once_with(self.job)
        self.assertEqual(ensure.call_count, 2)
        self.writer.assert_not_called()
        self.process.assert_not_called()
        self.assertEqual(self.job['stage'], 'awaiting_selection')
        self.assertTrue(self.job['download_ready'])
        self.assertEqual(self.job['lyrics'], approved_lyrics)
        self.assertNotIn(self.job['id'], self.work.running)
        saved = self.saved()
        self.assertEqual(saved['artwork_job_id'], artwork_id)
        self.assertEqual(saved['lyrics'], approved_lyrics)
        self.assertEqual(saved['stage'], 'awaiting_selection')
        self.assertEqual((self.folder / 'complete.mp3').read_bytes(), self.audio)

    def test_artwork_failure_keeps_completed_candidate_available_without_regeneration(self):
        approved_lyrics = self.job['lyrics']
        (self.folder / 'complete.mp3').write_bytes(self.audio)
        self.job.update(download_ready=True, status='done', duration_seconds=180.0)
        ensure = Mock(side_effect=RuntimeError('image service unavailable'))
        self.work.artwork = SimpleNamespace(ensure=ensure)
        self.work.run(self.job)

        ensure.assert_called_once()
        self.provider.assert_not_called()
        self.writer.assert_not_called()
        self.process.assert_not_called()
        self.assertEqual(self.job['stage'], 'awaiting_selection')
        self.assertEqual(self.job['status'], 'done')
        self.assertTrue(self.job['download_ready'])
        self.assertIsNone(self.job.get('error'))
        self.assertIsNone(self.job.get('pipeline_error'))
        self.assertEqual(self.job['lyrics'], approved_lyrics)
        self.assertNotIn(self.job['id'], self.work.running)
        self.assertEqual(sum(e['type'] == 'artwork_unavailable' for e in self.job['events']), 1)
        self.assertEqual(self.saved()['stage'], 'awaiting_selection')
        self.assertEqual((self.folder / 'complete.mp3').read_bytes(), self.audio)


if __name__ == '__main__':
    unittest.main()
