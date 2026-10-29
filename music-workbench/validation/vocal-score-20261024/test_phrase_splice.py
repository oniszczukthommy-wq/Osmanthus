"""Offline character-preservation contracts for local lyric-grid candidates."""
import copy
import unittest

import textgrid

from phrase_review import checked_splice_grid, grid_characters, splice_grid, validate_spliced_grid


def make_grid(intervals, duration):
    grid = textgrid.TextGrid(minTime=0, maxTime=duration)
    for name in ("texts", "phones"):
        tier = textgrid.IntervalTier(name=name, minTime=0, maxTime=duration)
        for start, end, mark in intervals:
            tier.add(start, end, mark if name == "texts" else "a")
        grid.append(tier)
    return grid


def snapshot(grid):
    return (grid.minTime, grid.maxTime, [
        (tier.name, tier.minTime, tier.maxTime,
         [(i.minTime, i.maxTime, i.mark) for i in tier])
        for tier in grid
    ])


class PhraseSpliceTests(unittest.TestCase):
    def setUp(self):
        self.grid = make_grid([(0, 1, "甲"), (1, 2, "乙"), (2, 3, "丙"), (3, 4, "丁")], 4)
        self.before = snapshot(self.grid)
        self.lyrics = "[VERSE]\n甲，乙！\n[CHORUS]\n丙丁"

    def test_expanded_boundary_that_deletes_neighbour_is_rejected(self):
        local = make_grid([(0, .8, "乙"), (.8, 1.8, "丙")], 2)
        amended, rejection = checked_splice_grid(self.grid, local, .9, 0, 3, self.lyrics)
        self.assertIsNone(amended)
        self.assertEqual(rejection["reason"], "splice_changed_full_lyric_character_sequence")
        self.assertEqual(rejection["expected_character_count"], 4)
        self.assertEqual(rejection["candidate_character_count"], 3)
        self.assertEqual(snapshot(self.grid), self.before)

    def test_cutting_neighbouring_intervals_that_duplicates_text_is_rejected(self):
        local = make_grid([(0, .4, "乙"), (.4, 1, "丙")], 1)
        amended, rejection = checked_splice_grid(self.grid, local, 1.5, 1.5, 2.5, self.lyrics)
        self.assertIsNone(amended)
        self.assertEqual(rejection["candidate_character_count"], 6)
        self.assertEqual(snapshot(self.grid), self.before)

    def test_valid_candidate_preserves_full_text_and_untouched_intervals(self):
        local = make_grid([(0, .7, "乙"), (.7, 2, "丙")], 2)
        local_before = snapshot(local)
        amended, rejection = checked_splice_grid(self.grid, local, 1, 1, 3, self.lyrics)
        self.assertIsNone(rejection)
        self.assertEqual(grid_characters(amended), "甲乙丙丁")
        self.assertEqual([(i.minTime, i.maxTime, i.mark) for i in amended[0]][0], (0, 1, "甲"))
        self.assertEqual([(i.minTime, i.maxTime, i.mark) for i in amended[0]][-1], (3, 4, "丁"))
        self.assertEqual(snapshot(self.grid), self.before)
        self.assertEqual(snapshot(local), local_before)

    def test_same_count_with_wrong_character_order_is_rejected(self):
        local = make_grid([(0, 1, "丙"), (1, 2, "乙")], 2)
        bad = splice_grid(self.grid, local, 1, 1, 3)
        rejection = validate_spliced_grid(self.grid, bad, self.lyrics)
        self.assertEqual(rejection["expected_character_count"], rejection["candidate_character_count"])
        self.assertEqual(rejection["first_mismatch_index"], 1)
        self.assertEqual(snapshot(self.grid), self.before)


if __name__ == "__main__":
    unittest.main()
