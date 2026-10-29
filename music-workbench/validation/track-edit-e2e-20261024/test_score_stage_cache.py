"""Offline stage-cache contracts; all data is temporary and inference is stubbed."""
from pathlib import Path
from copy import deepcopy
from unittest.mock import patch
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
import wave
import textgrid
import scores
from lyrics import characters_from_grid, lyric_lines, timed_lines


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False))


class StageCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='score-stage-cache-')
        self.root = Path(self.temporary.name).resolve()
        self.jobs = self.root / 'score-jobs'
        self.jobs.mkdir()
        self.backend = self.root / 'backend'
        (self.backend / 'output').mkdir(parents=True)
        self.patches = [patch.object(scores, 'ROOT', self.root),
                        patch.object(scores, 'JOBS', self.jobs),
                        patch.object(scores, 'BASE', self.backend)]
        for item in self.patches:
            item.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])
        self.identifier = str(uuid.uuid4())
        self.data = self.root / 'data'
        self.data.mkdir()
        self.audio = self.data / 'vocals.wav'
        with wave.open(str(self.audio), 'wb') as handle:
            handle.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
            handle.writeframes(b'\0\0' * 16000)
        self.lyrics = '[VERSE]\n晨光'
        write_json(self.root / 'workflow/runs' / self.identifier / 'state.json', {'lyrics': self.lyrics})
        meta = {'generation_job_id': self.identifier, 'project_id': self.identifier,
                'source_sha256': 'a' * 64, 'duration_seconds': 2.,
                'tracks': [{'id': 'vocals', 'file': 'vocals.wav',
                            'sha256': scores.file_sha256(self.audio)}]}
        write_json(self.data / 'preparation.json', meta)
        self.context = scores.source_context(self.data)[0]
        self.raw = {'engine': 'GAME-1.0.3-medium-onnx',
                    'source_sha256': self.context['vocal_sha256'], 'range_seconds': [0., 2.],
                    'notes': [{'start_seconds': .2, 'end_seconds': .6, 'voiced': True,
                               'midi_float': 60., 'midi': 60, 'cents_from_equal_temperament': 0.},
                              {'start_seconds': 1., 'end_seconds': 1.5, 'voiced': True,
                               'midi_float': 62., 'midi': 62, 'cents_from_equal_temperament': 0.}],
                    'chunks': [{'duration': 2.}], 'accuracy_accepted': False}

    def transcription(self):
        identifier = str(uuid.uuid4())
        folder = self.jobs / identifier
        write_json(folder / 'state.json', {**self.context, 'id': identifier, 'stage': 'error', 'created_at': 1})
        write_json(folder / 'analysis/rain-vocal-notes.json', self.raw)
        return identifier, folder

    def alignment(self):
        identifier = str(uuid.uuid4())
        folder = self.root / 'lyric-jobs' / identifier
        (folder / 'input').mkdir(parents=True)
        (folder / 'alignment').mkdir()
        shutil.copyfile(self.audio, folder / 'input/vocal.wav')
        (folder / 'input/vocal.txt').write_text('\n'.join(lyric_lines(self.lyrics)))
        grid = textgrid.TextGrid(minTime=0, maxTime=2)
        tier = textgrid.IntervalTier(name='texts', minTime=0, maxTime=2)
        tier.add(.2, .6, '晨')
        tier.add(1., 1.5, '光')
        grid.append(tier)
        grid.write(str(folder / 'alignment/vocal.TextGrid'))
        lines = timed_lines(self.lyrics, characters_from_grid(folder / 'alignment/vocal.TextGrid'), 2.)
        write_json(folder / 'timing.json', {'lines': lines, 'duration': 2.})
        state = {**self.context, 'id': identifier, 'created_at': 1, 'stage': 'ready',
                 'engine': 'tifa-lyric-lines-1', 'lyrics': self.lyrics,
                 'timing_sha256': scores.file_sha256(folder / 'timing.json')}
        write_json(folder / 'state.json', state)
        return identifier, folder

    def test_failed_job_can_supply_complete_raw_with_silent_tail(self):
        identifier, _ = self.transcription()
        found = scores.cached_transcription(self.context, 2.)
        self.assertEqual(found['id'], identifier)
        self.assertLess(self.raw['notes'][-1]['end_seconds'], self.raw['range_seconds'][1])

    def test_transcription_rejects_wrong_hash_partial_range_and_invalid_notes(self):
        _, folder = self.transcription()
        cases = []
        wrong = deepcopy(self.raw); wrong['source_sha256'] = 'b' * 64; cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['range_seconds'] = [0, 1.5]; cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['range_seconds'] = [.2, 2]; cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['notes'][0]['midi_float'] = float('nan'); cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['notes'][0]['end_seconds'] = float('inf'); cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['notes'][1]['start_seconds'] = .4; cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['notes'][1]['end_seconds'] = 2.5; cases.append(wrong)
        wrong = deepcopy(self.raw); wrong['notes'] = []; cases.append(wrong)
        for index, raw in enumerate(cases):
            with self.subTest(index=index):
                write_json(folder / 'analysis/rain-vocal-notes.json', raw)
                self.assertIsNone(scores.cached_transcription(self.context, 2.))

    def test_transcription_rejects_wrong_state_context_and_broken_json(self):
        _, folder = self.transcription()
        state = json.loads((folder / 'state.json').read_text())
        state['lyrics_sha256'] = 'wrong'
        write_json(folder / 'state.json', state)
        self.assertIsNone(scores.cached_transcription(self.context, 2.))
        state['lyrics_sha256'] = self.context['lyrics_sha256']
        write_json(folder / 'state.json', state)
        (folder / 'analysis/rain-vocal-notes.json').write_text('{partial')
        self.assertIsNone(scores.cached_transcription(self.context, 2.))

    def test_ready_lyric_alignment_matches_textgrid_and_timing(self):
        identifier, _ = self.alignment()
        self.assertEqual(scores.cached_lyric_alignment(self.context, self.lyrics, 2.)['id'], identifier)

    def test_alignment_rejects_wrong_audio_and_lyrics(self):
        _, folder = self.alignment()
        (folder / 'input/vocal.wav').write_bytes(b'wrong audio')
        self.assertIsNone(scores.cached_lyric_alignment(self.context, self.lyrics, 2.))
        shutil.copyfile(self.audio, folder / 'input/vocal.wav')
        (folder / 'input/vocal.txt').write_text('错误歌词')
        self.assertIsNone(scores.cached_lyric_alignment(self.context, self.lyrics, 2.))

    def test_alignment_rejects_corrupt_timing_and_rehashed_semantic_change(self):
        _, folder = self.alignment()
        timing_path = folder / 'timing.json'
        timing = json.loads(timing_path.read_text())
        timing['lines'][0]['start'] = .3
        write_json(timing_path, timing)
        self.assertIsNone(scores.cached_lyric_alignment(self.context, self.lyrics, 2.))
        state = json.loads((folder / 'state.json').read_text())
        state['timing_sha256'] = scores.file_sha256(timing_path)
        write_json(folder / 'state.json', state)
        self.assertIsNone(scores.cached_lyric_alignment(self.context, self.lyrics, 2.))

    def artifacts(self, output):
        write_json(output / 'score.json', {**self.context, 'summary': {'candidate': True}})
        for name in ('vocal-score.musicxml', 'vocal-melody.mid', 'staff-score.pdf',
                     'numbered-score.pdf', 'numbered-score.svg', 'score-melody.wav', 'original-vocal.wav'):
            (output / name).write_bytes(b'offline artifact fixture')

    def run_job(self, force=False, analysis_source=None):
        identifier = str(uuid.uuid4())
        folder = self.jobs / identifier
        write_json(folder / 'state.json', {**self.context, 'id': identifier, 'data_dir': str(self.data),
                   'created_at': 2, 'stage': 'queued', 'force_recompute': force,
                   'analysis_source_job_id': analysis_source})
        calls = []
        def run(command, **kwargs):
            script = Path(command[1]).name
            calls.append(script)
            if script == 'game_onnx.py':
                write_json(Path(command[command.index('--output') + 1]), self.raw)
            if script == 'run_tifa.py':
                target = Path(command[command.index('--output-dir') + 1])
                target.mkdir()
                _, source = self.alignment()
                shutil.copyfile(source / 'alignment/vocal.TextGrid', target / 'rain-vocals.TextGrid')
            if script == 'build_review_score.py':
                self.artifacts(Path(command[command.index('--output-dir') + 1]))
            return subprocess.CompletedProcess(command, 0, stdout=b'offline stub\n')
        with patch.object(scores.subprocess, 'run', side_effect=run):
            scores.work(identifier)
        return json.loads((folder / 'state.json').read_text()), folder, calls

    def test_work_reuses_completed_stages_without_model_calls_or_acceptance(self):
        transcription_id, transcription_folder = self.transcription()
        alignment_id, alignment_folder = self.alignment()
        source_hash = scores.file_sha256(alignment_folder / 'alignment/vocal.TextGrid')
        state, folder, calls = self.run_job()
        self.assertEqual(state['stage'], 'ready')
        self.assertEqual(state['reused_transcription_job_id'], transcription_id)
        self.assertEqual(state['reused_lyric_alignment_job_id'], alignment_id)
        self.assertNotIn('game_onnx.py', calls)
        self.assertNotIn('run_tifa.py', calls)
        self.assertTrue((folder / 'analysis/tifa-rain/rain-vocals.TextGrid').is_file())
        self.assertFalse((folder / 'analysis/tifa-rain/vocal.TextGrid').exists())
        self.assertEqual(scores.file_sha256(alignment_folder / 'alignment/vocal.TextGrid'), source_hash)
        self.assertFalse(scores.Scores().public(state)['accuracy_accepted'])

    def test_force_recompute_bypasses_automatic_stage_caches(self):
        self.transcription(); self.alignment()
        state, _, calls = self.run_job(force=True)
        self.assertIn('game_onnx.py', calls)
        self.assertIn('run_tifa.py', calls)
        self.assertNotIn('reused_transcription_job_id', state)
        self.assertNotIn('reused_lyric_alignment_job_id', state)

    def test_explicit_ready_analysis_reuse_remains_available(self):
        identifier, folder = self.transcription()
        state = json.loads((folder / 'state.json').read_text())
        state['stage'] = 'ready'
        write_json(folder / 'state.json', state)
        _, alignment = self.alignment()
        shutil.copytree(alignment / 'alignment', folder / 'analysis/tifa-rain')
        (folder / 'analysis/tifa-rain/vocal.TextGrid').rename(folder / 'analysis/tifa-rain/rain-vocals.TextGrid')
        state, _, calls = self.run_job(force=True, analysis_source=identifier)
        self.assertEqual(state['stage'], 'ready')
        self.assertNotIn('game_onnx.py', calls)
        self.assertNotIn('run_tifa.py', calls)
        self.assertFalse(scores.Scores().public(state)['accuracy_accepted'])

    def test_existing_complete_artifact_cache_remains_available(self):
        output = self.backend / 'output/cached'
        output.mkdir()
        self.artifacts(output)
        state, _, calls = self.run_job()
        self.assertTrue(state['reused_analysis'])
        self.assertEqual(calls, [])
        self.assertFalse(scores.Scores().public(state)['accuracy_accepted'])

    def test_unrelated_broken_or_nonobject_complete_cache_is_skipped(self):
        output = self.backend / 'output/cached'
        output.mkdir()
        self.artifacts(output)
        for index, content in enumerate(('{half-written', '[1,2,3]')):
            path = self.backend / 'output' / ('broken-' + str(index)) / 'score.json'
            path.parent.mkdir()
            path.write_text(content)
            os.utime(path, (4102444800 + index, 4102444800 + index))
        state, _, calls = self.run_job()
        self.assertEqual(state['stage'], 'ready')
        self.assertTrue(state['reused_analysis'])
        self.assertEqual(calls, [])

    def test_force_recompute_does_not_read_broken_complete_cache(self):
        broken = self.backend / 'output/broken/score.json'
        broken.parent.mkdir()
        broken.write_text('{half-written')
        original_read = Path.read_text
        def guarded_read(path, *args, **kwargs):
            if path == broken:
                raise AssertionError('force_recompute must not read the complete cache')
            return original_read(path, *args, **kwargs)
        with patch.object(Path, 'read_text', new=guarded_read):
            state, _, calls = self.run_job(force=True)
        self.assertEqual(state['stage'], 'ready')
        self.assertFalse(state['reused_analysis'])
        self.assertIn('game_onnx.py', calls)
        self.assertIn('run_tifa.py', calls)

    def test_launcher_preserves_low_memory_eight_second_default(self):
        project = type('FixtureProject', (), {'directory': self.data, 'state': {'id': self.identifier}})()
        manager = scores.Scores()
        with patch.dict(os.environ, {}, clear=True), patch.object(scores.subprocess, 'Popen') as launch:
            launch.return_value.poll.return_value = None
            manager.start(project, {'request_id': str(uuid.uuid4()), 'project_id': self.identifier})
        self.assertEqual(launch.call_args.kwargs['env']['MUSIC_GAME_CHUNK_SECONDS'], '8')


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(StageCacheTests))
    print(json.dumps({'status': 'passed' if result.wasSuccessful() else 'failed',
                      'tests_run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
                      'scope': 'Temporary WAV/TextGrid/JSON fixtures; inference and engraving subprocesses stubbed; no network or user-project writes.'}, indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
