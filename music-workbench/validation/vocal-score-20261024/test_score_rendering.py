"""Portable score renderer discovery and numbered-PDF regression tests."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_review_score as score


class ScoreRenderingTests(unittest.TestCase):
    def test_explicit_musescore_and_font_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            renderer = Path(tmp) / 'MuseScore4.exe'
            font = Path(tmp) / 'font.ttf'
            renderer.touch()
            font.touch()
            with patch.dict(os.environ, {'MUSESCORE_BIN': str(renderer), 'MUSIC_SCORE_FONT': str(font)}):
                self.assertEqual(score.musescore_path(), renderer)
                self.assertEqual(score.score_font_path(), font)

    def test_missing_renderer_has_actionable_error(self):
        with patch.dict(os.environ, {'MUSESCORE_BIN': ''}), patch.object(score.shutil, 'which', return_value=None), patch.object(score.Path, 'is_file', return_value=False):
            with self.assertRaisesRegex(FileNotFoundError, 'MUSESCORE_BIN'):
                score.musescore_path()

    def test_chinese_numbered_pdf(self):
        try:
            import reportlab
            from pypdf import PdfReader
            score.score_font_path()
        except (ImportError, FileNotFoundError):
            self.skipTest('Optional PDF packages or CJK font are unavailable')
        candidate = {'title': '测试歌曲', 'numbered_tonic_name': 'C', 'bpm': 100,
                     'unmapped_lyrics': [], 'notes': []}
        bars = [[{'offset': 0, 'duration': 1, 'number': '1', 'review': False,
                  'accidental': '', 'octave': 0, 'continuation': False, 'lyric': '测'}]]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            score.numbered_pdf(candidate, bars, out)
            pdf = out / 'numbered-score.pdf'
            self.assertGreater(pdf.stat().st_size, 1000)
            self.assertEqual(len(PdfReader(pdf).pages), 1)


if __name__ == '__main__':
    unittest.main()
