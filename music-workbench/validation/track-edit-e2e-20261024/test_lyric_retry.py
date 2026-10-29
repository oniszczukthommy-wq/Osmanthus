"""Offline regression: measured lyric repair must finish before song submission."""
from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import workflow as w


def song_with_line(line: str) -> dict:
    """46 sung lines: ten characters gives 460, eight gives 368."""
    counts = (0, 8, 8, 0, 8, 8, 6, 8, 0)
    return {
        "title": "离线歌词测试",
        "style_prompt": "中文流行风格，温暖钢琴与木吉他，主副歌有层次并自然结束",
        "sections": [
            {"tag": tag, "lines": [line] * count}
            for tag, count in zip(w.LYRIC_TAGS, counts)
        ],
    }


class LyricRetryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.temp = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.runs = self.temp / "runs"
        self.projects = self.temp / "projects"
        self.runs.mkdir()
        self.projects.mkdir()
        self.stack.enter_context(patch.object(w, "RUNS", self.runs))
        self.stack.enter_context(patch.object(w, "PROJECTS", self.projects))
        self.stack.enter_context(patch.object(w.STREAM, "ROOT", self.temp))
        self.stack.enter_context(patch.object(w.STREAM, "JOBS", {}))
        self.persist = self.stack.enter_context(patch.object(w.STREAM, "persist"))
        self.events = self.stack.enter_context(patch.object(w.STREAM, "event"))
        self.provider = self.stack.enter_context(patch.object(w.STREAM, "worker"))
        self.stack.enter_context(
            patch.dict(w.os.environ, {"DEEPSEEK_API_KEY": "unit-test-placeholder-key"})
        )
        self.service = w.Workflow()
        identifier = str(uuid.uuid4())
        (self.runs / identifier).mkdir()
        self.job = {
            "id": identifier,
            "brief": "沿着城市街角回家的原创中文流行歌曲",
            "style": "中文流行",
            "voice": "温暖自然的男声",
            "origin": "new_generation",
            "download_ready": False,
            "stage": "lyrics",
            "events": [],
        }
        self.requests = []

    def deepseek_responses(self, songs):
        responses = iter(songs)

        def respond(command, **_kwargs):
            # Read the actual payload at call time; later repair mutates request.
            self.assertIn("https://api.deepseek.com/chat/completions", command)
            payload = command[command.index("--data-binary") + 1]
            self.assertTrue(payload.startswith("@"))
            self.requests.append(json.loads(Path(payload[1:]).read_text()))
            body = {
                "choices": [{"message": {"content": json.dumps(next(responses), ensure_ascii=False)}}],
                "usage": {"total_tokens": 1},
            }
            return SimpleNamespace(
                returncode=0, stdout=json.dumps(body).encode("utf-8"), stderr=b""
            )

        return respond

    def assert_measured_shortening_feedback(self, request):
        feedback = request["messages"][-1]["content"]
        self.assertEqual(request["messages"][-1]["role"], "user")
        measured, _ = json.JSONDecoder().raw_decode(feedback[feedback.index("{"):])
        self.assertEqual(measured["actual_han_characters"], 460)
        self.assertEqual(measured["over_maximum"], 50)
        self.assertEqual(measured["below_minimum"], 0)
        self.assertEqual([s["tag"] for s in measured["sections"]], w.LYRIC_TAGS)
        lengths = [n for s in measured["sections"] for n in s["line_han_characters"]]
        self.assertEqual(lengths, [10] * 46, "Repair must include actual sung-line lengths.")
        self.assertRegex(
            feedback, r"(?:8|八)\s*(?:个)?\s*(?:汉)?字",
            "Repair must give an actionable eight-character line target.",
        )

    def test_third_attempt_can_repair_two_overlong_results(self):
        long_song = song_with_line("晚风轻轻吹过城市街角")
        valid_song = song_with_line("晚风吹过城市街角")
        with patch.object(
            w.subprocess, "run",
            side_effect=self.deepseek_responses([long_song, long_song, valid_song]),
        ) as calls:
            self.service.lyrics(self.job)

        self.assertEqual(calls.call_count, 3)
        self.assert_measured_shortening_feedback(self.requests[1])
        self.assert_measured_shortening_feedback(self.requests[2])
        self.assertEqual(self.job["lyric_han_characters"], 368)
        self.assertEqual(w.compile_lyrics(valid_song)[0], self.job["lyrics"])
        self.assertIn(self.job["voice"], self.job["prompt"])
        self.persist.assert_called_once_with(self.job)
        self.provider.assert_not_called()

    def test_three_invalid_results_stop_before_paid_song_submission(self):
        long_song = song_with_line("晚风轻轻吹过城市街角")
        with patch.object(
            w.subprocess, "run",
            side_effect=self.deepseek_responses([long_song] * 3),
        ) as calls:
            self.service.run(self.job)

        self.assertEqual(calls.call_count, 3, "An invalid lyric result has a bounded retry budget.")
        self.assertEqual(len(self.requests), 3)
        self.assert_measured_shortening_feedback(self.requests[1])
        self.assert_measured_shortening_feedback(self.requests[2])
        self.assertEqual(self.job["stage"], "error")
        self.assertIn("460", self.job["pipeline_error"])
        self.assertNotIn("lyrics", self.job)
        self.assertNotIn("prompt", self.job)
        self.assertFalse(self.job.get("submission_started", False))
        self.assertIsNone(self.job.get("task_id"))
        self.provider.assert_not_called()


if __name__ == "__main__":
    unittest.main()
