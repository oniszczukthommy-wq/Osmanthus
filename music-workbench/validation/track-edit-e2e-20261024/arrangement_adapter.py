"""Connect the auditioned authoring core to immutable workbench candidates.

Analysis provenance and listening acceptance belong to their exact source/range.
Creating a candidate registers an asset, never changes the user's mix or history.
"""
from copy import deepcopy
from pathlib import Path
import fcntl
import hashlib
import json
import math
import os
import tempfile
import time

import numpy as np
import soundfile as sf

from project import ROOT, Project, save_json

CODE_ROOT = Path(__file__).resolve().parent
ENGINE = 'instrument-evidence-authoring-2'


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def rms(audio):
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))


def dependency_key(directory, start, end, source_job_directory=None):
    """No music analysis or rendering in the request handler."""
    from arrangement_evidence import dependency_key as evidence_key
    paths = [CODE_ROOT / 'arrangement_adapter.py', CODE_ROOT / 'arrangement_authoring.py',
             CODE_ROOT / 'resources/chords-db/guitar.json',
             CODE_ROOT.parent / 'instrument-generaluser/GeneralUser-GS.sf2',
             CODE_ROOT.parent / 'audio-runtime/env/bin/fluidsynth']
    hashes = {str(path): digest(path) for path in paths}
    if source_job_directory:
        job = Path(source_job_directory)
        for name in ('inputs.json', 'analysis.json', 'notes.json'):
            if (job / name).is_file():
                hashes[str(job / name)] = digest(job / name)
    payload = {'engine': ENGINE, 'files': hashes,
               'evidence': evidence_key(Path(directory), start, end)}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _new_part(project, inputs, start, end, instrument, output):
    from arrangement_authoring import AuthoringResources, build_notes, render_part
    resources = AuthoringResources(root=ROOT, protected_roots=(project.directory,))
    # An arbitrary selection can leave only a few milliseconds of an edge
    # chord. Keep silence there rather than force incomplete chord tones or
    # extend the preceding harmony beyond its known interval.
    minimum = .11 if instrument == 'piano' else .22
    segments, omitted = [], []
    for chord in inputs['harmony_segments']:
        left, right = max(start, chord['start_seconds']), min(end, chord['end_seconds'])
        if right <= left:
            continue
        if right - left < minimum:
            omitted.append({'start_seconds': left, 'end_seconds': right, 'label': chord['label'],
                            'reason': 'too_short_for_complete_support_gesture_kept_silent'})
        else:
            segments.append(chord)
    if not segments:
        raise ValueError('选区内可编配的和声片段过短，请扩大选区；原声部未改变')
    result = build_notes(segments, inputs['beats'], start, end,
                         instrument, inputs.get('vocal_context'), resources=resources)
    result['selection_omissions'] = omitted
    rendered = render_part(result, output / 'authored', instrument,
                           sample_rate=project.sr, job_root=output, resources=resources)
    core, rate = sf.read(rendered['part_path'], dtype='float32', always_2d=True)
    a, b = round(start * project.sr), round(end * project.sr)
    # Absolute timeline rounding can differ by one sample from round(end-start).
    if rate != project.sr or core.shape[1] != 2 or abs(len(core) - (b - a)) > 1:
        raise ValueError('编配声部的采样率或长度与工程不符')
    if len(core) != b - a:
        corrected = np.zeros((b - a, 2), dtype=np.float32)
        corrected[:min(len(core), len(corrected))] = core[:len(corrected)]
        core = corrected
    if not np.isfinite(core).all() or rms(core) <= 1e-8:
        raise ValueError('编配声部为空或含无效数据')
    # Match the accepted listening pack's final selection fade.
    fade = min(round(.03 * project.sr), len(core) // 2)
    core = core.copy()
    core[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[:, None]
    core[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
    notes = [{**n, 'chord': result['harmony_segments'][n['chord_index']]['label']}
             for n in result['notes']]
    save_json(output / 'notes.json', notes)
    save_json(output / 'voicings.json', result['voicings'])
    save_json(output / 'ARR-SPEC.json', {'format': 'local-authoring-plan', **result['arr_spec']})
    save_json(output / 'audit.json', {'compliance_checks': result['checks'],
                                    'authoring_audit': result['audit'],
                                    'selection_omissions': omitted,
                                    'musical_acceptance': 'requires_current_mix_audition'})
    return core, result, rendered


def _scale_for_headroom(baseline, change, scale=1.0):
    limit = max(.98, float(np.max(np.abs(baseline))))
    if float(np.max(np.abs(baseline + change * scale))) <= limit:
        return scale
    low, high = 0., scale
    for _ in range(28):
        mid = (low + high) / 2
        if float(np.max(np.abs(baseline + change * mid))) <= limit:
            low = mid
        else:
            high = mid
    return low


def _register(project, part, metadata):
    """Content-addressed WAV and atomic catalog only; no project.json writes."""
    directory = project.directory
    final = directory / (metadata['id'] + '.wav')
    with tempfile.NamedTemporaryFile(dir=directory, prefix='.arrangement-', suffix='.wav', delete=False) as temp:
        temporary = Path(temp.name)
    try:
        sf.write(temporary, part, project.sr, subtype='FLOAT')
        value = digest(temporary)
        try:
            os.link(temporary, final)
        except FileExistsError:
            if digest(final) != value:
                # FLOAT WAV includes a timestamp in its PEAK chunk. Identical
                # PCM rendered later can therefore have different file bytes.
                # Preserve the original immutable file and its catalog hash.
                info = sf.info(final)
                existing, rate = sf.read(final, dtype='float32', always_2d=True)
                expected = np.asarray(part, dtype=np.float32)
                if (rate != project.sr or info.subtype != 'FLOAT'
                        or existing.shape != expected.shape
                        or not np.array_equal(existing, expected)):
                    raise ValueError('同名编配候选内容不一致，未覆盖已有文件')
                value = digest(final)
    finally:
        temporary.unlink(missing_ok=True)
    metadata.update(file=final.name, sha256=value, generated=True, arrangement_engine=ENGINE)
    with (directory / '.additional-tracks.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest_path = directory / 'additional-tracks.json'
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'source_sha256': project.meta['source_sha256'], 'tracks': []}
        if manifest['source_sha256'] != project.meta['source_sha256']:
            raise ValueError('编配候选与歌曲来源不一致')
        previous = next((m for m in manifest['tracks'] if m['id'] == metadata['id']), None)
        if previous and previous.get('sha256') != value:
            raise ValueError('已有编配候选文件与登记记录不一致，请检查文件；未更新候选')
        ordinal = previous.get('ordinal', 1) if previous else max([m.get('ordinal', i + 1) for i, m in enumerate(manifest['tracks'])] + [0]) + 1
        prefix = '木吉他编配' if metadata.get('operation') == 'reorchestrate' else '钢琴伴奏'
        metadata.update(ordinal=ordinal, label=previous['label'] if previous else f'{prefix} {ordinal}')
        manifest['tracks'] = [m for m in manifest['tracks'] if m['id'] != metadata['id']] + [metadata]
        save_json(manifest_path, manifest)
    return metadata


def _save_inputs(output, inputs):
    save_json(output / 'inputs.json', inputs)
    save_json(output / 'analysis.json', inputs['analysis_legacy'])


def render_piano(directory, state, output, stage=None):
    from arrangement_evidence import prepare_inputs
    began = time.perf_counter()
    directory, output = Path(directory), Path(output)
    if stage:
        stage('analyzing')
    inputs = prepare_inputs(directory, state['start_seconds'], state['end_seconds'])
    _save_inputs(output, inputs)
    if stage:
        stage('rendering')
    project = Project(directory)
    if project.fingerprint() != state['fingerprint']:
        raise ValueError('排队或分析期间混音已变化，请按当前工程重新生成候选')
    start, end = state['start_seconds'], state['end_seconds']
    a, b = round(start * project.sr), round(end * project.sr)
    core, authored, rendered = _new_part(project, inputs, start, end, 'piano', output)
    if (directory / 'original.wav').is_file():
        reference, rate = sf.read(directory / 'original.wav', start=a, stop=b, dtype='float32', always_2d=True)
        if rate != project.sr or reference.shape != core.shape:
            raise ValueError('原曲与编配选区的格式不一致')
    else:
        # Explicit fallback for older prepared projects without an original WAV.
        reference = sum(project.audio[k][a:b] for k in ('vocals', 'drums', 'bass', 'other'))
    core *= (rms(reference) * .18) / max(rms(core), 1e-12)
    part = np.zeros_like(project.audio['vocals'])
    part[a:b] = core
    baseline = project.mix()
    scale = _scale_for_headroom(baseline, part * project.meta['master_gain'])
    part *= scale
    if rms(part[a:b]) <= 1e-8:
        raise ValueError('当前混音没有可用余量，请先调低音量再生成候选')
    provenance = json.dumps({'engine': ENGINE, 'inputs': inputs}, sort_keys=True).encode()
    identifier = 'piano_add_' + hashlib.sha256(provenance + part.tobytes()).hexdigest()[:10]
    metadata = _register(project, part, {
        'id': identifier, 'color': '#f1c1dd', 'instrument': 'piano', 'operation': 'piano',
        'range_seconds': [start, end], 'analysis_status': inputs.get('status', 'candidate'),
        'analysis_evidence': inputs.get('evidence', {}),
        'note': '轻钢琴候选；和声依据与句间留白已记录，请在当前混音中试听后加入。'})
    report = {'status': 'candidate_rendered', 'track': metadata, 'note_count': len(authored['notes']),
              'headroom_scale': scale, 'range_seconds': [start, end],
              'source_project_revision': project.state['revision'],
              'seconds': round(time.perf_counter() - began, 3), 'authoring_checks': authored['checks'],
              'selection_omissions': authored['selection_omissions'],
              'midi_roundtrip': rendered['midi_roundtrip'], 'analysis_status': inputs.get('status'),
              'musical_acceptance': 'requires_current_mix_audition'}
    save_json(output / 'render-report.json', report)
    return report


def render_guitar(directory, state, output, stage=None):
    from arrangement_evidence import inputs_from_legacy
    from reorchestration import source_job
    began = time.perf_counter()
    directory, output = Path(directory), Path(output)
    project = Project(directory)
    if project.fingerprint() != state['fingerprint']:
        raise ValueError('排队期间混音已变化，请按当前工程重新生成候选')
    source = state['source_track_id']
    metadata, _, job = source_job(project, source)
    if metadata['sha256'] != state['source_track_sha256'] or project.state['tracks'][source] != state['source_track_state']:
        raise ValueError('源钢琴已发生变化，请按当前状态重新生成候选')
    start, end = state['start_seconds'], state['end_seconds']
    if (job / 'inputs.json').is_file():
        inputs = deepcopy(json.loads((job / 'inputs.json').read_text()))
        inputs['reuse_source_range'] = [start, end]
    else:
        inputs = inputs_from_legacy(json.loads((job / 'analysis.json').read_text()), start, end)
    _save_inputs(output, inputs)
    save_json(output / 'source-notes.json', json.loads((job / 'notes.json').read_text()))
    if stage:
        stage('rendering')
    core, authored, rendered = _new_part(project, inputs, start, end, 'acoustic_guitar', output)
    a, b = round(start * project.sr), round(end * project.sr)
    source_rms = rms(project.audio[source][a:b])
    if source_rms <= 1e-8:
        raise ValueError('选区钢琴声部过静，无法进行有效编配对照')
    core *= source_rms / max(rms(core), 1e-12)
    part = np.zeros_like(project.audio[source])
    part[a:b] = core
    # Simulate exactly the reducer's inherited state and old-part interval mute.
    baseline = project.mix()
    old = project.render_track(source)
    envelope = project.envelope(source)
    source_state = deepcopy(state['source_track_state'])
    project.state['tracks'][source]['segments'].append({'start_frame': a, 'end_frame': b, 'gain': 0.})
    kept = project.render_track(source)
    project.state['tracks'][source] = source_state
    gain = 10 ** (source_state['gain_db'] / 20) * project.meta['master_gain']
    audible = not source_state['muted'] and (not any(t['solo'] for t in project.state['tracks'].values() if not t.get('removed')) or source_state['solo'])
    scale = 1.
    if audible:
        kept_mix = baseline + (kept - old) * gain
        scale = _scale_for_headroom(kept_mix, part * envelope[:, None] * gain)
    part *= scale
    if rms(part[a:b]) <= 1e-8:
        raise ValueError('当前混音没有可用余量，请先调整源声部音量')
    key = json.dumps({'source_state': source_state, 'inputs': inputs}, sort_keys=True).encode() + metadata['sha256'].encode()
    identifier = 'guitar_arr_' + hashlib.sha256(ENGINE.encode() + key + part.tobytes()).hexdigest()[:10]
    candidate = _register(project, part, {
        'id': identifier, 'color': '#d3b58e', 'instrument': 'acoustic_guitar', 'operation': 'reorchestrate',
        'range_seconds': [start, end], 'replaces_track_id': source,
        'source_track_sha256': metadata['sha256'], 'source_track_state': source_state,
        'analysis_status': inputs.get('status', 'legacy_candidate'),
        'analysis_evidence': inputs.get('evidence', {}),
        'note': '沿用源钢琴的和声音集，按吉他指型、拨弦与轻扫弦重写；先试听再替换。'})
    report = {'status': 'candidate_rendered', 'track': candidate, 'note_count': len(authored['notes']),
              'source_job_id': job.name, 'headroom_scale': scale, 'range_seconds': [start, end],
              'seconds': round(time.perf_counter() - began, 3), 'authoring_checks': authored['checks'],
              'selection_omissions': authored['selection_omissions'],
              'midi_roundtrip': rendered['midi_roundtrip'], 'musical_acceptance': 'requires_current_mix_audition'}
    save_json(output / 'render-report.json', report)
    return report
