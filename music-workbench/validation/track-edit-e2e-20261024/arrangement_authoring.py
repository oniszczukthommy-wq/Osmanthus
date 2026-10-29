"""Source-conditioned piano/guitar authoring core validated by local audition.

Inputs/notes use absolute song seconds; rendered WAV/MIDI start at the selection.
No project state or base audio is opened or written. Writes are restricted to an
explicit job_root, outside protected song directories, and never replace files.
The accepted musical algorithm and FluidSynth settings are unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from itertools import product
from pathlib import Path
import copy
import hashlib
import json
import math
import re
import subprocess

import mido
import numpy as np
import soundfile as sf
from music21 import harmony

CODE_ROOT = Path(__file__).resolve().parent
TUNING = (40, 45, 50, 55, 59, 64)
# Keep the accepted algorithm version distinct from its integration wrapper.
VERSION = "light-arrangement-isolated-v1"
INTEGRATION_VERSION = "arrangement-authoring-1"


@dataclass(frozen=True)
class AuthoringResources:
    """Read-only assets plus the workbench data root used to protect song files.

    Assets default to this code checkout, even if the workbench root is a test
    root. Pass all asset paths explicitly when deploying a different layout.
    protected_roots supports additional source directories outside the workbench.
    """
    root: Path = CODE_ROOT
    soundfont: Path = CODE_ROOT.parent / "instrument-generaluser/GeneralUser-GS.sf2"
    chords_db: Path = CODE_ROOT / "resources/chords-db/guitar.json"
    synth: Path = CODE_ROOT.parent / "audio-runtime/env/bin/fluidsynth"
    protected_roots: tuple[Path, ...] = ()

    def __post_init__(self):
        for name in ("root", "soundfont", "chords_db", "synth"):
            object.__setattr__(self, name, Path(getattr(self, name)).resolve())
        object.__setattr__(self, "protected_roots", tuple(Path(p).resolve() for p in self.protected_roots))


def _resources(value):
    if value is None:
        return AuthoringResources()
    if not isinstance(value, AuthoringResources):
        raise TypeError("resources must be AuthoringResources")
    return value


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("Non-finite time/pitch value")
    return value


def _output_dir(path, *, job_root, resources):
    """Keep writes within a caller-designated job, never within original data."""
    path, job = Path(path).resolve(), Path(job_root).resolve()
    if path != job and job not in path.parents:
        raise ValueError("Output must remain inside the explicit job_root")
    if job == resources.root:
        raise ValueError("Workbench root is not an output job directory")
    protected = (resources.root / "data", resources.root / "projects", *resources.protected_roots)
    for forbidden in protected:
        forbidden = forbidden.resolve()
        if job == forbidden or forbidden in job.parents or path == forbidden or forbidden in path.parents:
            raise ValueError("Original song directories cannot be output job directories")
    # Also catch source directories outside the configured workbench. Existing
    # song marker files identify read-only source ancestry; a job has state.json.
    for ancestor in (job, *job.parents):
        if any((ancestor/name).is_file() for name in ("preparation.json", "additional-tracks.json", "project.json")):
            raise ValueError("Output job is nested in an existing song project")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _fresh_file(path):
    path = Path(path)
    if path.exists() or path.is_symlink():
        raise FileExistsError("Authoring never overwrites an existing output: " + str(path))
    return path


def _normalize_segments(segments, start, end):
    result = []
    for source_index, raw in enumerate(segments):
        s = _number(raw.get("start_seconds", raw.get("start")))
        e = _number(raw.get("end_seconds", raw.get("end")))
        if e <= s:
            raise ValueError("Harmony segment must have positive duration")
        if e <= start or s >= end:
            continue
        # Audio analyzers use Ab/Bb; music21 spells flat roots as A-/B-.
        # Convert only root and slash-bass accidentals, preserving e.g. b5.
        figure = raw.get("label", raw.get("chord"))
        if isinstance(figure, str):
            figure = re.sub(r'^([A-G])([b♭]+)',
                            lambda m: m[1] + '-' * len(m[2]), figure)
            figure = re.sub(r'/([A-G])([b♭]+)$',
                            lambda m: '/' + m[1] + '-' * len(m[2]), figure)
        symbol = harmony.ChordSymbol(figure)
        pcs = sorted({p.pitchClass for p in symbol.pitches})
        given = sorted({int(x) % 12 for x in raw.get("pitch_classes", pcs)})
        if pcs != given or len(pcs) not in (3, 4):
            raise ValueError("Need a consistent explicit three/four-note chord: " + symbol.figure)
        root = int(raw.get("root_pc", raw.get("root", symbol.root().pitchClass)))
        bass = int(raw.get("bass_pc", symbol.bass().pitchClass))
        if root != symbol.root().pitchClass or bass not in pcs:
            raise ValueError("Chord root/bass conflicts with supplied pitch classes")
        if "/" in symbol.figure and bass != symbol.bass().pitchClass:
            raise ValueError("Slash chord bass conflicts with explicit bass_pc")
        result.append({"source_index": source_index, "start_seconds": max(start, s),
                       "end_seconds": min(end, e), "label": raw.get("label", symbol.figure),
                       "pitch_classes": pcs, "root_pc": root, "bass_pc": bass,
                       "roman": raw.get("roman", "unresolved; no key inference"),
                       "evidence": copy.deepcopy(raw.get("evidence")),
                       "uncertainty": copy.deepcopy(raw.get("uncertainty"))})
    result.sort(key=lambda x: x["start_seconds"])
    if not result:
        raise ValueError("No harmony within selection")
    if any(a["end_seconds"] > b["start_seconds"] + 1e-7 for a, b in zip(result, result[1:])):
        raise ValueError("Overlapping harmony segments require explicit resolution")
    return result


def _vocal_intervals(context, start, end):
    # Unknown voice placement is treated conservatively as active throughout.
    if context is None or "active_intervals" not in context:
        return [(start, end)], "unavailable: conservative sparse support, no detected-response claim"
    intervals = []
    for item in context["active_intervals"]:
        if isinstance(item, dict):
            a = _number(item.get("start_seconds", item.get("start")))
            b = _number(item.get("end_seconds", item.get("end")))
        else:
            a, b = map(_number, item)
        if b <= a:
            raise ValueError("Vocal interval must have positive duration")
        a, b = max(start, a), min(end, b)
        if b > a:
            intervals.append((a, b))
    merged = []
    for a, b in sorted(intervals):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    return merged, context.get("source", "provided active intervals; not proof of audio silence")


def _gaps(active, start, end):
    gaps = []
    cursor = start
    for a, b in active:
        if a - cursor >= .32:
            gaps.append((cursor, a))
        cursor = max(cursor, b)
    if end - cursor >= .32:
        gaps.append((cursor, end))
    return gaps


def _voice_distance(a, b):
    if a is None:
        return abs(np.mean(b) - 66) * .25 + (max(b) - min(b)) * .05
    # Nearest-neighbour costs support unequal 3/4 voice counts without truncation.
    distance = (sum(min(abs(x-y) for y in b) for x in a) / len(a)
                + sum(min(abs(x-y) for y in a) for x in b) / len(b))
    return distance + .5 * abs(max(a)-max(b)) + .1 * abs(np.mean(b)-66)


def _piano_voicing(chord, previous=None):
    # C4–E5, one instance of each required chord tone. No doubled low bass.
    pools = [[p for p in range(60, 77) if p % 12 == pc] for pc in chord["pitch_classes"]]
    choices = []
    explicit_inversion = chord["bass_pc"] != chord["root_pc"]
    for pitches in product(*pools):
        pitches = sorted(pitches)
        if max(pitches)-min(pitches) > 16:
            continue
        if explicit_inversion and pitches[0] % 12 != chord["bass_pc"]:
            continue
        choices.append(pitches)
    if not choices:
        raise ValueError("No piano voicing in declared register for " + chord["label"])
    chosen = min(choices, key=lambda x: _voice_distance(previous, x))
    return {"pitches": chosen, "voice_count": len(chosen), "register_midi": [60, 76],
            "adjacent_intervals": [b-a for a, b in zip(chosen, chosen[1:])],
            "bass_policy": "specified inversion retained" if explicit_inversion else
                           "upper voicing free; original bass stem retains harmonic bass"}


@lru_cache(maxsize=8)
def _guitar_shapes(database_path, database_sha256):
    data = Path(database_path).read_bytes()
    if hashlib.sha256(data).hexdigest() != database_sha256:
        raise ValueError("Chord database changed while reading")
    database = json.loads(data)
    shapes = []
    seen = set()
    for root, entries in database["chords"].items():
        for entry in entries:
            for idx, position in enumerate(entry["positions"]):
                frets, fingers = position["frets"], position["fingers"]
                if len(frets) != 6 or len(fingers) != 6:
                    continue
                strings = [i for i, f in enumerate(frets) if f >= 0]
                absolute_frets = [(f+position.get("baseFret", 1)-1 if f > 0 else 0)
                                  for f in frets if f >= 0]
                pitches = [TUNING[s]+f for s, f in zip(strings, absolute_frets)]
                if pitches != position.get("midi"):
                    continue
                if any(f not in range(5) for f in fingers):
                    continue
                if any((f <= 0 and digit != 0) or (f > 0 and digit == 0)
                       for f, digit in zip(frets, fingers)):
                    continue
                bad = False
                for digit in range(1, 5):
                    used = [f for f, d in zip(frets, fingers) if d == digit and f > 0]
                    if len(used) > 1 and (len(set(used)) != 1 or used[0] not in position.get("barres", [])):
                        bad = True
                pressed = [f for f in absolute_frets if f]
                if bad or (pressed and max(pressed)-min(pressed) > 3) or max(absolute_frets) > 12:
                    continue
                identity = tuple(zip(strings, pitches))
                if identity in seen:
                    continue
                seen.add(identity)
                shapes.append({"strings": strings, "pitches": pitches, "frets": absolute_frets,
                               "fingers": [fingers[s] for s in strings],
                               "base_fret": position.get("baseFret", 1), "barres": position.get("barres", []),
                               "source_entry": root+entry["suffix"], "source_position": idx})
    return shapes


def _guitar_voicing(chord, previous=None, *, database_path):
    choices = [p for p in _guitar_shapes(str(database_path), _sha(database_path))
               if set(x % 12 for x in p["pitches"]) == set(chord["pitch_classes"])
               and min(p["pitches"]) % 12 == chord["bass_pc"]]
    if not choices:
        raise ValueError("No verified database fingering with required bass for " + chord["label"])
    def cost(shape):
        span = max(shape["frets"])-min(shape["frets"])
        register = abs(np.mean(shape["pitches"])-58)*.08
        if previous is None:
            return max(shape["frets"])*.22 + span*.04 + register
        a = dict(zip(previous["strings"], previous["frets"]))
        b = dict(zip(shape["strings"], shape["frets"]))
        common = a.keys() & b.keys()
        return sum(abs(a[s]-b[s]) for s in common)*.25 + len(a.keys() ^ b.keys())*.3 + register
    return copy.deepcopy(min(choices, key=cost))


def _emit(notes, chord_index, chord, pitch, when, duration, velocity, *, string=None, role="support", anchor=None):
    # Explicit damping before harmonic changes; no sustain pedal is used.
    stop = min(when+duration, chord["end_seconds"]-.045)
    if when < chord["start_seconds"] or stop-when < .035:
        return
    note = {"pitch": int(pitch), "start_seconds": round(when, 9), "end_seconds": round(stop, 9),
            "velocity": int(max(1, min(127, velocity))), "chord_index": chord_index,
            "role": role, "anchor_seconds": round(anchor if anchor is not None else when, 9)}
    if string is not None:
        note["string"] = int(string)
    notes.append(note)


def _choke_repeated(notes, instrument):
    groups = {}
    for note in notes:
        key = note["string"] if instrument == "acoustic_guitar" else note["pitch"]
        groups.setdefault(key, []).append(note)
    for group in groups.values():
        group.sort(key=lambda n: n["start_seconds"])
        for a, b in zip(group, group[1:]):
            a["end_seconds"] = min(a["end_seconds"], b["start_seconds"]-.006)
    return sorted([n for n in notes if n["end_seconds"]-n["start_seconds"] >= .025],
                  key=lambda n: (n["start_seconds"], n["pitch"]))


def build_notes(harmony_segments, beats, start, end, instrument, vocal_context=None, *, resources=None):
    """Return absolute notes, selected voicings, assertions, ARR-SPEC and honest audit.

    `beats` are ordinary pulse timestamps, not bar/downbeat labels. Chord change
    timestamps are retained; response gestures use supplied beat/subdivision times.
    """
    resources = _resources(resources)
    start, end = _number(start), _number(end)
    if end <= start or instrument not in ("piano", "acoustic_guitar"):
        raise ValueError("Invalid selection or instrument")
    beats = [_number(b) for b in beats]
    if len(beats) < 2 or any(b <= a for a, b in zip(beats, beats[1:])):
        raise ValueError("At least two strictly increasing ordinary beats required")
    period = float(np.median(np.diff(beats)))
    if not .15 <= period <= 2:
        raise ValueError("Implausible pulse interval; no silent tempo correction")
    chords = _normalize_segments(harmony_segments, start, end)
    active, vocal_source = _vocal_intervals(vocal_context, start, end)
    gaps = _gaps(active, start, end)
    response_grid = sorted(beats + [(a+b)/2 for a, b in zip(beats, beats[1:])])
    notes, voicings = [], []
    previous = None
    for i, chord in enumerate(chords):
        a, b = chord["start_seconds"], chord["end_seconds"]
        singing = any(x <= a < y for x, y in active)
        if instrument == "piano":
            shape = _piano_voicing(chord, previous)
            previous = shape["pitches"]
            # Calm compact support, no low-octave pattern. Top voice is lighter.
            for j, pitch in enumerate(shape["pitches"]):
                _emit(notes, i, chord, pitch, a+.008+j*.006,
                      period*(.62 if singing else .95), (45 if singing else 52)-j,
                      role="light_chord_support", anchor=a)
        else:
            shape = _guitar_voicing(chord, previous, database_path=resources.chords_db)
            previous = shape
            # One occurrence per required pitch class, starting with exact bass.
            pairs = list(zip(shape["strings"], shape["pitches"]))
            lowest = min(pairs, key=lambda x: x[1])
            picked = [lowest]
            for pc in chord["pitch_classes"]:
                if pc != lowest[1] % 12:
                    opts = [p for p in pairs if p[1] % 12 == pc]
                    picked.append(min(opts, key=lambda p: abs(p[1]-62)))
            picked = [picked[0]]+sorted(picked[1:], key=lambda p: p[0])
            spacing = min(period*.28, max(.035, (b-a-.2)/max(1, len(picked)-1)))
            for j, (string, pitch) in enumerate(picked):
                _emit(notes, i, chord, pitch, a+.012+j*spacing,
                      period*(.30 if j == 0 else .70), (40 if j == 0 else 47)+(0 if singing else 5)-(j % 2)*3,
                      string=string, role="bass_once" if j == 0 else "sparse_fingerpick", anchor=a+j*spacing)
        voicings.append({"chord_index": i, "label": chord["label"],
                         "start_seconds": a, "end_seconds": b, **shape})
        # Responses only in supplied score-note gaps >=320ms, never inferred silence.
        for gs, ge in gaps:
            lo, hi = max(a+.85*period, gs+.085), min(b-.15, ge-.08)
            eligible = [t for t in response_grid if lo <= t <= hi-.10]
            if not eligible:
                continue
            t = eligible[0]
            if instrument == "piano":
                for j, pitch in enumerate(shape["pitches"][-2:]):
                    _emit(notes, i, chord, pitch, t+.010+j*.005,
                          min(.75*period, hi-t-.03), 49-j*4,
                          role="score_gap_response", anchor=t)
            else:
                pairs = [(s, p) for s, p in zip(shape["strings"], shape["pitches"]) if s >= 2]
                # A quiet upper-string brush, rather than re-triggering low bass.
                for j, (string, pitch) in enumerate(pairs[-4:]):
                    _emit(notes, i, chord, pitch, t+.010+j*.011,
                          min(.65*period, hi-t-.04), 45-j*2,
                          string=string, role="score_gap_upper_brush", anchor=t)
            break  # At most one short answer within each harmonic segment.
    notes = _choke_repeated(notes, instrument)
    checks = _check_notes(notes, voicings, chords, start, end, instrument)
    if not all(checks.values()):
        raise AssertionError({k: v for k, v in checks.items() if not v})
    arr_spec = {
        "schema": VERSION, "intent": "light harmonic support; preserve existing Mandarin vocal and bass/drums",
        "seed": "deterministic: no random jitter", "selection_seconds": [start, end],
        "meta": {"style_layer": "mc-style-chinese-pop", "language": "Mandarin", "era": "current source recording; no era-specific imitation"},
        "form": [{"harmony_letters": [c["label"] for c in chords], "harmony": [c["roman"] for c in chords],
                  "note": "existing harmony candidates retained; no invented seventh or bar grouping"}],
        "timing": {"ordinary_beats_seconds": beats, "median_pulse_seconds": period,
                   "estimated_bpm_from_pulses": 60/period, "downbeats": "not inferred or claimed verified",
                   "chord_changes": "absolute input boundaries retained", "feel": "straight sparse support"},
        "instrument": instrument, "role": "middle/background harmonic support",
        "range_midi": [min(n["pitch"] for n in notes), max(n["pitch"] for n in notes)],
        "spacing": "3/4-tone piano variable voice distances" if instrument == "piano" else "validated six-string chord shapes; unique-tone picking and upper-string brush",
        "vocal_space": {"active_intervals": active, "score_note_gaps": gaps, "source": vocal_source,
                        "limitation": "score gaps do not prove original audio is silent; hearing still required"},
        "push_pull": {"piano_support_ms": 8, "piano_roll_spacing_ms": 6, "guitar_entry_ms": 12, "guitar_brush_spacing_ms": 11},
        "bass_policy": "original bass unchanged; piano >=C4, guitar low note once per chord at lower velocity",
        "articulation": "no sustain pedal; damp before chord changes; no new fills outside known note gaps",
        "honors": {"exact_input_pitch_classes": "full", "target_time_boundary": "full",
                   "true_played_harmony": "input-dependent", "natural_timbre": "limited by existing SoundFont",
                   "vocal_intelligibility": "audition required", "verified_downbeats": "none"},
        "exemptions": ["No modulation, added seventh, changed vocal melody or extra instrument required by generic skill lint: preservation task.",
                       "Whole-song form/chorus/final-cadence tests out of scope for a short source-conditioned part."],
        "sources": ["mc-harmony/SKILL.md sections 6.1,7.1", "mc-rhythm-section/reference.md sections 5.1-5.4",
                    "mc-orchestration/SKILL.md section 7", "mc-orchestration/reference-keyboard-harp.md sections 3,5.2",
                    "mc-texture-layering/SKILL.md sections 3,4", "mc-style-chinese-pop/SKILL.md sections 2,3.2",
                    "mc-ai-tell-audit/SKILL.md sections 2-4"]}
    audit = _audit(notes, instrument, active, arr_spec)
    return {"instrument": instrument, "start_seconds": start, "end_seconds": end,
            "notes": notes, "voicings": voicings, "harmony_segments": chords,
            "checks": checks, "arr_spec": arr_spec, "audit": audit}


def _check_notes(notes, voicings, chords, start, end, instrument):
    groups = {}
    for n in notes:
        key = n.get("string", n["pitch"])
        groups.setdefault(key, []).append(n)
    checks = {
        "nonempty": bool(notes),
        "time_boundaries": all(start <= n["start_seconds"] < n["end_seconds"] <= end for n in notes),
        "chord_boundaries": all(chords[n["chord_index"]]["start_seconds"] <= n["start_seconds"] < n["end_seconds"] <= chords[n["chord_index"]]["end_seconds"] for n in notes),
        "no_unrequested_pitch_classes": all(n["pitch"] % 12 in chords[n["chord_index"]]["pitch_classes"] for n in notes),
        "all_required_pitch_classes_per_segment": all({n["pitch"] % 12 for n in notes if n["chord_index"] == i} == set(c["pitch_classes"]) for i, c in enumerate(chords)),
        "no_same_string_or_piano_pitch_overlap": all(a["end_seconds"] <= b["start_seconds"] for group in groups.values() for a, b in zip(sorted(group, key=lambda n:n["start_seconds"]), sorted(group, key=lambda n:n["start_seconds"])[1:])),
    }
    if instrument == "piano":
        checks["variable_chord_size_preserved"] = all(len(v["pitches"]) == len(c["pitch_classes"]) for v, c in zip(voicings, chords))
        checks["piano_midrange_no_subbass"] = all(60 <= n["pitch"] <= 76 for n in notes)
    else:
        checks["specified_bass_first"] = all(min((n for n in notes if n["chord_index"] == i), key=lambda n:n["start_seconds"])["pitch"] % 12 == c["bass_pc"] for i,c in enumerate(chords))
        checks["string_pitch_fret_consistency"] = all(n["pitch"] == TUNING[n["string"]] + dict(zip(voicings[n["chord_index"]]["strings"], voicings[n["chord_index"]]["frets"]))[n["string"]] for n in notes)
        checks["positive_fret_span_at_most_three"] = all(not (p := [f for f in v["frets"] if f > 0]) or max(p)-min(p) <= 3 for v in voicings)
    return checks


def _audit(notes, instrument, active, spec):
    entries = []
    names = ["form in multiples of eight", "energy only rises", "unchanged instrumentation", "single harmony loop",
             "predictable four-bar fill", "no arrangement hook", "compressed static dynamics", "all notes rigidly quantized",
             "fixed whole-song duration", "flat vocal delivery", "identical repeated choruses", "unnatural breaths", "uniform ad-libs", "perfect tuned vocal"]
    for i, name in enumerate(names, 1):
        if i in (1, 3, 4, 9):
            status, reason = "scope_exempt", "short additional/reorchestrated part preserves the source form and harmony"
        elif i in (10, 11, 12, 13, 14):
            status, reason = "source_unchanged_not_reaudited", "this helper does not alter or resynthesize the vocal"
        elif i == 5:
            status, reason = "design_checked", "responses depend on supplied score gaps; no modulo-four-bar fill schedule"
        elif i == 8:
            status, reason = "design_checked_listening_pending", "structured 6–12ms attack offsets and instrument-specific gestures; no claim offsets guarantee naturalness"
        elif i == 6:
            status, reason = "intent_exemption", "subordinate light support should not add a competing hook over the original singing"
        else:
            status, reason = "listening_pending", "symbolic velocity variation is recorded but cannot establish musical dynamics"
        entries.append({"id": i, "item": name, "status": status, "reason": reason})
    return {"spec_version": VERSION, "seed": spec["seed"], "accepted": False,
            "listening_status": "pending", "compliance_score": None, "ai_tell_flag_count": None,
            "note": "No invented aggregate rating; measured constraints and audible quality remain separate.",
            "note_count": len(notes), "velocity_range": [min(n["velocity"] for n in notes), max(n["velocity"] for n in notes)],
            "score_gap_response_notes": sum("gap" in n["role"] for n in notes), "items": entries}


def _write_midi(result, path):
    _fresh_file(path)
    midi = mido.MidiFile(ticks_per_beat=960)
    track = mido.MidiTrack(); midi.tracks.append(track)
    # Fixed 120BPM is a time encoding only: notes retain exact local seconds.
    tempo = 500000
    track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    program = 0 if result["instrument"] == "piano" else 25
    channels = range(6) if result["instrument"] == "acoustic_guitar" else range(1)
    for channel in channels:
        track.append(mido.Message("program_change", channel=channel, program=program, time=0))
        track.append(mido.Message("control_change", channel=channel, control=64, value=0, time=0))
    events = []
    for n in result["notes"]:
        for at, on in [(n["start_seconds"], True), (n["end_seconds"], False)]:
            tick = round(mido.second2tick(at-result["start_seconds"], 960, tempo))
            events.append((tick, on, n["pitch"], n["velocity"], n.get("string", 0)))
    last = 0
    for tick, on, pitch, velocity, channel in sorted(events, key=lambda n: (n[0], n[1])):
        track.append(mido.Message("note_on" if on else "note_off", note=pitch, velocity=velocity if on else 0, channel=channel, time=tick-last))
        last = tick
    midi.save(path)


def export_result(result, output_dir, stem, *, job_root, resources=None):
    resources = _resources(resources)
    folder = _output_dir(output_dir, job_root=job_root, resources=resources)
    if Path(stem).name != stem or not stem:
        raise ValueError("stem must be a simple filename stem")
    path = _fresh_file(folder/(stem+".json"))
    with path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(result, ensure_ascii=False, indent=2))
    return path


def validate_midi_roundtrip(result, midi_path):
    starts, actual, now = {}, [], 0.0
    midi = mido.MidiFile(midi_path)
    for msg in midi:
        now += msg.time
        if msg.type not in ("note_on", "note_off"):
            continue
        key = (msg.channel, msg.note)
        if msg.type == "note_on" and msg.velocity:
            if key in starts:
                raise AssertionError("Duplicate MIDI note-on before note-off")
            starts[key] = (now, msg.velocity)
        else:
            if key not in starts:
                raise AssertionError("Unmatched MIDI note-off")
            onset, velocity = starts.pop(key)
            actual.append((key[0], key[1], velocity, onset, now))
    if starts:
        raise AssertionError("Unterminated MIDI notes")
    expected = [(n.get("string", 0), n["pitch"], n["velocity"],
                 n["start_seconds"]-result["start_seconds"], n["end_seconds"]-result["start_seconds"])
                for n in result["notes"]]
    actual.sort(key=lambda x:(x[0],x[1],x[3])); expected.sort(key=lambda x:(x[0],x[1],x[3]))
    if len(actual) != len(expected) or any(a[:3] != b[:3] for a,b in zip(actual,expected)):
        raise AssertionError("MIDI events changed during serialization")
    error = max((abs(a[j]-b[j]) for a,b in zip(actual,expected) for j in (3,4)), default=0)
    tick_seconds = .5/midi.ticks_per_beat
    if error > tick_seconds+1e-9:
        raise AssertionError("MIDI timestamp round-trip exceeds one tick")
    return {"events": len(actual), "max_timestamp_error_seconds": error,
            "tick_seconds": tick_seconds, "within_one_tick": True}


def render_part(result, output_dir, stem, sample_rate=44100, *, job_root, resources=None):
    """Render only a bounded local part; caller owns base/preview mixing decisions."""
    resources = _resources(resources)
    folder = _output_dir(output_dir, job_root=job_root, resources=resources)
    if Path(stem).name != stem or not stem:
        raise ValueError("stem must be a simple filename stem")
    midi_path = folder/(stem+".mid")
    output_path = folder/(stem+"-part.wav")
    # Fail before starting synthesis if an earlier task owns any of these files.
    for path in (midi_path, output_path, folder/(stem+".json"), folder/(stem+"-segments")):
        _fresh_file(path)
    for asset in (resources.synth, resources.soundfont, resources.chords_db):
        if not asset.is_file():
            raise FileNotFoundError("Missing authoring asset: " + str(asset))
    _write_midi(result, midi_path)
    roundtrip = validate_midi_roundtrip(result, midi_path)
    sr = sample_rate
    count = round((result["end_seconds"]-result["start_seconds"])*sr)
    part = np.zeros((count, 2), dtype=np.float32)
    chunk_dir = _output_dir(folder/(stem+"-segments"), job_root=job_root, resources=resources)
    # Render independent harmonic segments, so an uncertain gap cannot carry a
    # previous chord's release tail or resurrect it after the gap.
    chunk_records = []
    for i, chord in enumerate(result["harmony_segments"]):
        a, b = chord["start_seconds"], chord["end_seconds"]
        chunk = {**result, "start_seconds": a, "end_seconds": b,
                 "notes": [n for n in result["notes"] if n["chord_index"] == i]}
        chunk_midi, chunk_raw = chunk_dir/f"{i:02}.mid", chunk_dir/f"{i:02}-raw.wav"
        _write_midi(chunk, chunk_midi)
        run = subprocess.run([str(resources.synth), "-ni", "-g", "0.5", "-o", "synth.reverb.active=0",
                              "-o", "synth.chorus.active=0", "-F", str(chunk_raw), "-r", str(sr),
                              str(resources.soundfont), str(chunk_midi)], capture_output=True, timeout=60)
        if run.returncode:
            raise RuntimeError(run.stderr.decode(errors="replace")[-1000:])
        audio, actual_sr = sf.read(chunk_raw, dtype="float32", always_2d=True)
        if actual_sr != sr:
            raise AssertionError("Synth sample rate mismatch")
        ia, ib = round((a-result["start_seconds"])*sr), round((b-result["start_seconds"])*sr)
        bounded = np.zeros((ib-ia, 2), dtype=np.float32)
        bounded[:min(len(bounded),len(audio))] = audio[:len(bounded)]
        edge = min(round(.03*sr), len(bounded)//4)
        bounded[:edge] *= np.linspace(0,1,edge)[:,None]
        bounded[-edge:] *= np.linspace(1,0,edge)[:,None]
        part[ia:ib] += bounded
        chunk_records.append({"start_seconds": a, "end_seconds": b, "fade_seconds": .03,
                              "release_tail_discarded_beyond_harmonic_segment": True})
    # 30ms selection fade applies to new part only, exactly as frozen protocol.
    fade = min(round(.03*sr), count//4)
    part[:fade] *= np.linspace(0, 1, fade)[:, None]
    part[-fade:] *= np.linspace(1, 0, fade)[:, None]
    peak = float(np.max(np.abs(part)))
    if peak >= 1:
        raise AssertionError("Render clips; no hidden limiter/normalization")
    _fresh_file(output_path)
    sf.write(output_path, part, sr, subtype="FLOAT")
    metadata = {"part_path": str(output_path), "local_midi_path": str(midi_path),
                "absolute_note_json": str(folder/(stem+".json")), "sample_rate": sr,
                "frames": count, "duration_seconds": count/sr, "selection_seconds": [result["start_seconds"],result["end_seconds"]],
                "peak": peak, "rms": float(np.sqrt(np.mean(part**2))), "first_last_frames_zero": bool(not np.any(part[0]) and not np.any(part[-1])),
                "midi_roundtrip": roundtrip, "harmonic_segment_renders": chunk_records,
                "soundfont_sha256": _sha(resources.soundfont), "chords_db_sha256": _sha(resources.chords_db),
                "authoring_integration": INTEGRATION_VERSION,
                "midi_time_encoding": {"tempo_bpm": 120, "ticks_per_beat": 960,
                                       "meaning": "serialization clock only; absolute note timing follows supplied pulse array"},
                "loudness_policy": "raw accepted part, no normalization; caller preserves fixed base and applies accepted new-part RMS policy",
                "mixing": "none; no base files read or written", "listening_accepted": False}
    result["render"] = metadata
    export_result(result, folder, stem, job_root=job_root, resources=resources)
    return metadata
