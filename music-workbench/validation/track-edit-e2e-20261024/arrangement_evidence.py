"""Bind reviewed arrangement evidence to exact audio, or analyze the actual range.

This module is read-only. Listening acceptance applies to the reviewed added
parts, never to complete original harmony, a new song, or a new selection.
"""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
from pathlib import Path
import hashlib
import json
import math
import statistics

import soundfile as sf
from project import ROOT as WORKBENCH_ROOT

CODE_ROOT = Path(__file__).resolve().parent
ASSET_ROOT = CODE_ROOT / "assets/arrangement-evidence"
VERSION = "arrangement-evidence-v1"
# Pin the review manifest, not just hashes supplied by a mutable manifest.
TRUSTED_MANIFESTS = {
    "xiang-hai-40-56-v1": "6b351b9b75b98947e9e60483eaf3c018a87f04233f82092c499af9a48d815522",
}
AUDIO_FILES = ("original.wav", "other.wav", "bass.wav", "drums.wav", "vocals.wav")


def _json(path):
    return json.loads(Path(path).read_text())


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _file_sha(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


@lru_cache(maxsize=128)
def _stat_cached_sha(path, device, inode, size, mtime_ns, ctime_ns):
    return _file_sha(path)


def _signature(path, *, fresh=False):
    path = Path(path)
    try:
        stat = path.stat()
        digest = (_file_sha(path) if fresh else _stat_cached_sha(
            str(path.resolve()), stat.st_dev, stat.st_ino, stat.st_size,
            stat.st_mtime_ns, stat.st_ctime_ns))
        return {"sha256": digest, "bytes": stat.st_size}
    except OSError as exc:
        return {"unavailable": type(exc).__name__}


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("编配选区必须是有限数字")
    return float(value)


def _request(data_dir, start, end):
    directory = Path(data_dir).resolve()
    start, end = _number(start), _number(end)
    info = sf.info(directory / "original.wav")
    if not 0 <= start < end <= info.frames / info.samplerate:
        raise ValueError("编配选区必须在实际原曲时长内")
    a, b = round(start * info.samplerate), round(end * info.samplerate)
    if b <= a:
        raise ValueError("编配选区不足一个采样帧")
    meta = _json(directory / "preparation.json")
    if meta.get("sample_rate") != info.samplerate:
        raise ValueError("原曲实际采样率与工程记录不一致")
    return directory, start, end, info, meta, a, b


def _safe_child(directory, name):
    child = (directory / name).resolve()
    if directory.resolve() not in child.parents:
        raise ValueError("证据文件路径越界")
    return child


def _load_bundle(bundle_id):
    directory = _safe_child(ASSET_ROOT, bundle_id)
    path = directory / "manifest.json"
    if _file_sha(path) != TRUSTED_MANIFESTS[bundle_id]:
        raise ValueError("manifest_hash_mismatch")
    manifest = _json(path)
    if manifest.get("schema") != "reviewed-arrangement-evidence/v1":
        raise ValueError("unsupported_manifest_schema")
    assets = {}
    for name, expected in manifest["assets"].items():
        asset = _safe_child(directory, name)
        if _file_sha(asset) != expected:
            raise ValueError("asset_hash_mismatch:" + name)
        assets[name] = _json(asset)
    return manifest, assets


def _live_vocal_paths(manifest):
    job_id = manifest["live_vocal_dependencies"]["score_job_id"]
    job = _safe_child(WORKBENCH_ROOT / "score-jobs", job_id)
    return job / "score.json", job / "user-listening-acceptance.json"


def dependency_key(data_dir, start, end):
    """Cheap repeated request signature; never invokes a music analyzer.

    Audio SHA results are cached only while device/inode/size/mtime/ctime match.
    The worker independently re-hashes reviewed source assets in prepare_inputs.
    """
    directory, start, end, info, meta, a, b = _request(data_dir, start, end)
    bundle_files, live_files = {}, {}
    for bundle_id in sorted(TRUSTED_MANIFESTS):
        folder = ASSET_ROOT / bundle_id
        # Include even broken/tampered assets so previous ready jobs cannot hide
        # corruption behind an unchanged song fingerprint.
        for path in sorted(folder.glob("*.json")):
            bundle_files[str(path.relative_to(ASSET_ROOT))] = _signature(path, fresh=True)
        bundle_files.setdefault(bundle_id + "/manifest.json", {"unavailable": "missing"})
        try:
            manifest, _ = _load_bundle(bundle_id)
            for path in _live_vocal_paths(manifest):
                live_files[str(path.relative_to(Path(WORKBENCH_ROOT).resolve()))] = _signature(path, fresh=True)
        except (OSError, ValueError, KeyError, TypeError):
            pass
    return _digest({
        "version": VERSION, "module": _signature(Path(__file__), fresh=True),
        "legacy_analyzer": _signature(CODE_ROOT / "piano_arrangement.py", fresh=True),
        "selection_frames": [a, b], "sample_rate": info.samplerate,
        "source_generation_sha256": meta.get("source_sha256"),
        "project_id": meta.get("project_id"), "source_frames": info.frames,
        "source_files": {name: _signature(directory / name) for name in AUDIO_FILES},
        "bundle_files": bundle_files, "live_vocal_dependencies": live_files,
    })


def _neighbors(beats, start, end):
    values = sorted({_number(x) for x in beats})
    selected = [x for x in values if start <= x <= end]
    before = [x for x in values if x < start]
    after = [x for x in values if x > end]
    if before:
        selected.insert(0, before[-1])
    if after:
        selected.append(after[0])
    if len(selected) < 2:
        raise ValueError("选区缺少足够的相邻拍点；未编造重拍")
    return selected


def _legacy_grid(analysis, start, end):
    tempo = _number(analysis["tempo_estimate"])
    phase = _number(analysis.get("beat_phase_seconds", 0.0))
    if tempo <= 0:
        raise ValueError("候选速度必须大于零")
    period = 60.0 / tempo
    if not .15 <= period <= 2:
        raise ValueError("候选拍间隔超出编配器范围；未静默修正速度")
    # The adjacent grid anchors may lie outside the selection; all authored
    # notes still must be clipped to it. They are estimates, not downbeats.
    left = math.ceil((start - phase) / period) - 1
    right = math.floor((end - phase) / period) + 1
    if right - left > 100000:
        raise ValueError("候选拍点数量异常")
    return [phase + index * period for index in range(left, right + 1)]


def inputs_from_legacy(analysis, start, end):
    """Convert a saved legacy job without analyzing any audio or upgrading trust."""
    start, end = _number(start), _number(end)
    if not 0 <= start < end:
        raise ValueError("无效的符号编配选区")
    segments, chords = [], []
    for raw in analysis.get("chords", []):
        a, b = max(start, _number(raw["start"])), min(end, _number(raw["end"]))
        if b <= a:
            continue
        root = int(raw["root"])
        pcs = [int(x) for x in raw["pitch_classes"]]
        if not 0 <= root <= 11 or any(not 0 <= pc <= 11 for pc in pcs):
            raise ValueError("旧编配音级无效")
        chord = {**deepcopy(raw), "start": a, "end": b}
        chords.append(chord)
        segments.append({"start_seconds": a, "end_seconds": b, "label": raw["chord"],
                         "root_pc": root, "bass_pc": int(raw.get("bass_pc", root)),
                         "pitch_classes": pcs, "roman": None,
                         "evidence": {"method": "legacy_spectral_triad_candidate",
                                      "relative_score_margin": raw.get("relative_score_margin"),
                                      "bass_basis": "provided" if "bass_pc" in raw else
                                                    "authored_root_position_not_measured_bass"},
                         "uncertainty": ["旧算法候选，未确认完整原和弦；分数差不是准确率。"]})
    segments.sort(key=lambda item: item["start_seconds"])
    chords.sort(key=lambda item: item["start"])
    if not segments:
        raise ValueError("所选区间没有可用的符号和声候选")
    if any(x["end_seconds"] > y["start_seconds"] + 1e-7 for x, y in zip(segments, segments[1:])):
        raise ValueError("旧符号和声区间重叠，需先解决冲突")
    beats = _legacy_grid(analysis, start, end)
    legacy = {**deepcopy(analysis), "range": [start, end], "chords": chords,
              "ordinary_beats_seconds": beats, "analysis_status": "legacy_candidate"}
    evidence = {"method": "saved_legacy_symbolic_analysis", "reviewed": False,
                "listening_status": "candidate", "complete_original_harmony_verified": False,
                "beat_status": "estimated_regular_pulse_with_context_neighbors",
                "downbeat_status": "not_inferred", "exclusion_intervals": [],
                "vocal_context_status": "unavailable_conservative_full_activity"}
    key = _digest({"version": VERSION, "analysis": legacy, "range": [start, end]})
    return {"harmony_segments": segments, "beats": beats, "vocal_context": None,
            "analysis_legacy": legacy, "evidence": evidence,
            "status": "legacy_candidate", "evidence_key": key}


def _reviewed_vocal_context(directory, meta, manifest, assets):
    expected = manifest["live_vocal_dependencies"]
    try:
        score_path, acceptance_path = _live_vocal_paths(manifest)
        if _file_sha(score_path) != expected["score_json_sha256"]:
            return None, "live_score_hash_mismatch"
        if _file_sha(acceptance_path) != expected["acceptance_sha256"]:
            return None, "live_acceptance_hash_mismatch"
        if _file_sha(directory / "vocals.wav") != expected["vocal_sha256"]:
            return None, "live_vocal_hash_mismatch"
        accepted = _json(acceptance_path)
        score = _json(score_path)
        for field in ("project_id", "source_sha256", "vocal_sha256", "lyrics_sha256"):
            if accepted.get(field) != expected[field]:
                return None, "acceptance_source_identity_mismatch:" + field
        if (accepted.get("status") != "user_listening_accepted" or
                accepted.get("score_json_sha256") != expected["score_json_sha256"] or
                accepted.get("score_job_id") != expected["score_job_id"] or
                meta.get("project_id") != expected["project_id"] or
                meta.get("source_sha256") != expected["source_sha256"] or
                score.get("source_sha256") != expected["source_sha256"]):
            return None, "score_acceptance_scope_mismatch"
        return deepcopy(assets["vocal-context.json"]), "verified_live_accepted_score"
    except (OSError, ValueError, KeyError, TypeError):
        return None, "live_accepted_score_unavailable"


def _legacy_analyze(directory, start, end):
    from piano_arrangement import analyze
    return analyze(directory, start, end)


def prepare_inputs(data_dir, start, end):
    directory, start, end, info, meta, a, b = _request(data_dir, start, end)
    rejected = []
    for bundle_id in TRUSTED_MANIFESTS:
        try:
            manifest, assets = _load_bundle(bundle_id)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            rejected.append({"bundle_id": bundle_id, "reason": "bundle_unusable:" + str(exc)[:150]})
            continue
        selection, source = manifest["selection"], manifest["source"]
        if (selection["sample_rate"], selection["start_frame"], selection["end_frame"]) != (info.samplerate, a, b):
            rejected.append({"bundle_id": bundle_id, "reason": "selection_sample_range_mismatch"})
            continue
        if (source["sample_rate"], source["frames"], source["channels"]) != (info.samplerate, info.frames, info.channels):
            rejected.append({"bundle_id": bundle_id, "reason": "source_audio_format_mismatch"})
            continue
        if meta.get("source_sha256") != source["generation_source_sha256"]:
            rejected.append({"bundle_id": bundle_id, "reason": "generation_source_sha_mismatch"})
            continue
        actual = {name: _signature(directory / name, fresh=True).get("sha256") for name in source["files"]}
        wrong = [name for name, digest in source["files"].items() if actual[name] != digest]
        if wrong:
            rejected.append({"bundle_id": bundle_id, "reason": "source_audio_hash_mismatch", "files": wrong})
            continue
        profile = assets["harmony.json"]
        beats = _neighbors(assets["beats.json"]["beats_seconds"], start, end)
        vocal, vocal_status = _reviewed_vocal_context(directory, meta, manifest, assets)
        # Audition boundaries are sample-aligned. Sub-sample-equivalent caller
        # values refer to the same rendered frames, so retain canonical seconds.
        start, end = a / info.samplerate, b / info.samplerate
        segments = deepcopy(profile["harmony_segments"])
        period = statistics.median(y - x for x, y in zip(beats, beats[1:]))
        chords = [{"start": x["start_seconds"], "end": x["end_seconds"], "chord": x["label"],
                   "root": x["root_pc"], "bass_pc": x["bass_pc"],
                   "quality": "minor" if sorted((pc-x["root_pc"]) % 12 for pc in x["pitch_classes"]) == [0, 3, 7] else "major",
                   "pitch_classes": list(x["pitch_classes"])} for x in segments]
        status = "reviewed_excerpt" if vocal is not None else "reviewed_harmony_candidate_context"
        evidence = {"method": "exact_source_range_reviewed_packet", "bundle_id": bundle_id,
                    "reviewed": True, "review_scope": assets["listening-acceptance.json"]["scope"],
                    "listening_status": "reviewed_input_recipe" if vocal is not None else "candidate",
                    "complete_original_harmony_verified": False, "downbeat_status": "not_inferred",
                    "beat_status": profile["beat_status"],
                    "neighbor_beats_status": "computed_context_neighbors_not_separately_accepted",
                    "exclusion_intervals": deepcopy(profile["exclusion_intervals"]),
                    "vocal_context_status": vocal_status, "source_files_sha256": actual,
                    "selection_frames": [a, b], "sample_rate": info.samplerate,
                    "profile_dependencies": deepcopy(manifest["assets"]),
                    "unresolved_events": deepcopy(profile["unresolved_events"]),
                    "rejected_bundles": rejected}
        legacy = {"source_project": meta.get("project_id"), "range": [start, end],
                  "tempo_estimate": 60 / period, "beat_phase_seconds": beats[0],
                  "chords": chords, "key_hypothesis": None, "key_alternatives": [],
                  "ordinary_beats_seconds": beats, "analysis_status": status,
                  "limitations": ["新增伴奏音集已试听，不等于完整原和弦真值。", "未确认重拍或全曲拍号。"]}
        key = _digest({"dependency_key": dependency_key(directory, start, end), "status": status,
                       "evidence": evidence, "vocal_context": vocal})
        legacy.update(evidence_key=key, evidence=deepcopy(evidence))
        return {"harmony_segments": segments, "beats": beats, "vocal_context": vocal,
                "analysis_legacy": legacy, "evidence": evidence, "status": status, "evidence_key": key}
    analysis = _legacy_analyze(directory, start, end)
    result = inputs_from_legacy(analysis, start, end)
    result["status"] = "candidate_analysis"
    result["evidence"].update(method="new_legacy_analysis_of_requested_audio", rejected_bundles=rejected)
    result["evidence_key"] = _digest({"dependency_key": dependency_key(directory, start, end),
                                      "analysis": result["analysis_legacy"], "evidence": result["evidence"]})
    result["analysis_legacy"].update(analysis_status=result["status"], evidence_key=result["evidence_key"],
                                      evidence=deepcopy(result["evidence"]))
    return result
