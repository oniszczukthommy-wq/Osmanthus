"""Verify saved browser evidence and actual downloaded, full-length audio."""
from pathlib import Path
import hashlib, io, json, subprocess
import numpy as np
import soundfile as sf
from project import Project, ROOT, DATA, save_json

def read(name):return json.loads((ROOT/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    baseline=read('browser-baseline.json');dialogue=read('browser-dialogue-mute.json');manual=read('browser-manual-gain.json')
    undo=read('browser-history.json');exports=read('browser-exports.json')
    muted_hash=read('browser-muted-buffer-hashes.json');manual_hash=read('browser-manual-buffer-hashes.json')
    playback=read('browser-edited-playback.json');drag=read('browser-waveform-drag.json')
    unsupported=read('browser-unsupported-request.json');reopened=read('browser-reopened.json')
    project=Project();saved=project.state['tracks'];sr=project.sr;a,b=30*sr,45*sr
    project.state['tracks']=project.state['history'][0]['before'];base=project.mix()
    quantized=io.BytesIO();sf.write(quantized,base,sr,format='WAV',subtype='PCM_24');quantized.seek(0)
    base24,_=sf.read(quantized,dtype='float32',always_2d=True)
    muted,_=sf.read(ROOT/'browser-dialogue-muted.wav',dtype='float32',always_2d=True)
    edited,_=sf.read(ROOT/'browser-manual-gain.wav',dtype='float32',always_2d=True)
    checks={
        'same_project_id_dialogue_manual_undo':len({x['project']['id'] for x in [baseline,dialogue,manual,*undo]})==1,
        'actual_dialogue_tool_applied':dialogue['project']['history'][0]['origin']=='dialogue' and dialogue['project']['tracks'][1]['segments'][0]['gain']==0,
        'manual_edit_overrides_same_bass_segment':manual['project']['tracks'][1]['segments'][-1]=={'start_frame':a,'end_frame':b,'gain':10**(-6/20)},
        'other_browser_playback_buffers_identical':all(muted_hash[k]==manual_hash[k] for k in ('drums','vocals','other')),
        'bass_browser_playback_buffer_changed':muted_hash['bass']!=manual_hash['bass'],
        'undo_manual_restores_dialogue_state':undo[0]['project']['fingerprint']==dialogue['project']['fingerprint'],
        'undo_all_restores_baseline_state':undo[1]['project']['fingerprint']==baseline['project']['fingerprint'],
        'redo_restores_both_states':undo[2]['project']['fingerprint']==dialogue['project']['fingerprint'] and undo[3]['project']['fingerprint']==manual['project']['fingerprint'],
        'edited_playback_clock_advanced_in_selection':playback['currentTime']>32 and any(e['type']=='play' and e.get('mode')=='mix' for e in playback['telemetry']['events']),
        'no_recorded_browser_audio_errors':not playback['telemetry']['audioErrors'],
        'wav_export_is_entire_song':len(edited)==project.meta['frames'] and sf.info(ROOT/'browser-manual-gain.wav').samplerate==sr,
        'muted_export_outside_selection_bit_identical':bool(np.array_equal(muted[:a],base24[:a]) and np.array_equal(muted[b:],base24[b:])),
        'gain_export_outside_selection_bit_identical':bool(np.array_equal(edited[:a],base24[:a]) and np.array_equal(edited[b:],base24[b:])),
        'edit_audible_energy_present':float(np.sqrt(np.mean((edited[a:b]-muted[a:b])**2)))>.001,
        'browser_downloads_match_server_hashes':all(sha(ROOT/f'browser-manual-gain.{x["format"]}')==x['sha256'] for x in exports),
        'native_waveform_drag_sets_range':abs(drag['dragged']['start_seconds']-35)<.2 and abs(drag['dragged']['end_seconds']-40)<.2,
        'unsupported_instrument_generation_did_not_mutate_project':unsupported['state']['project']['revision']==6 and unsupported['state']['project']['fingerprint']==manual['project']['fingerprint'],
        'reload_retains_same_project_and_edits':reopened['project']['id']==manual['project']['id'] and reopened['project']['fingerprint']==manual['project']['fingerprint']}
    project.state['tracks']=saved
    expected=project.mix();checks['export_matches_current_project_with_24bit_quantization']=float(np.max(np.abs(edited-expected)))<=1/2**23
    probe=ROOT.parent/'audiocraft/conda-env/bin/ffprobe';ffmpeg=probe.with_name('ffmpeg')
    info=json.loads(subprocess.check_output([str(probe),'-v','error','-show_format','-show_streams','-of','json',str(ROOT/'browser-manual-gain.mp3')]))
    decode=subprocess.run([str(ffmpeg),'-v','error','-i',str(ROOT/'browser-manual-gain.mp3'),'-f','null','-'],capture_output=True)
    checks['mp3_decodes_and_contains_entire_song']=decode.returncode==0 and abs(float(info['format']['duration'])-project.meta['duration_seconds'])<.1
    audit_files=list((ROOT/'audits').glob('*.json'))
    calls=[{'audit':p.name,'elapsed_seconds':read('audits/'+p.name)['elapsed_seconds'],
            'usage':read('audits/'+p.name)['response'].get('usage')} for p in audit_files]
    report={'status':'passed' if all(checks.values()) else 'failed','scope':'One real YinChao song: separation -> waveform -> actual DeepSeek segment mute -> manual gain -> undo/redo -> playback -> whole-song WAV/MP3 downloads',
            'source_sha256':project.meta['source_sha256'],'project_id':project.state['id'],
            'duration_seconds':project.meta['duration_seconds'],'checks':checks,'model_calls':calls,
            'max_export_vs_float_mix_error':float(np.max(np.abs(edited-expected))),
            'selected_segment_muted_vs_gain_difference_rms':float(np.sqrt(np.mean((edited[a:b]-muted[a:b])**2))),
            'preparation_seconds':project.meta['separation_seconds'],
            'human_listening_acceptance':'pending user review; no musical quality score fabricated',
            'remaining':['AI-separated stem bleed and listening quality','Instrument-specific piano/guitar isolation and new-part generation',
                         'Accurate singing score with verified pitch/rhythm/lyrics','150–210 second generation control',
                         'Stable preset singer switching','Generation page integration beyond this existing-song acceptance']}
    save_json(ROOT/'acceptance-report.json',report)
    print(json.dumps(report,ensure_ascii=False,indent=2));assert all(checks.values())

if __name__=='__main__':main()
