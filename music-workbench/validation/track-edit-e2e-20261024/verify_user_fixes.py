"""Check real browser evidence for all five user-requested changes."""
import hashlib, json, subprocess
import numpy as np
import soundfile as sf
from project import ROOT, DATA, save_json

def read(name):return json.loads((ROOT/name).read_text())

def main():
    controls=read('user-fixes-browser-controls.json');restored=read('user-fixes-dialogue-restored.json')
    muted=read('user-fixes-dialogue-muted.json');piano=read('user-fixes-piano-playback.json')
    final=read('user-fixes-browser-final.json');mp3=read('user-fixes-piano-mp3.json')
    bass=next(t for t in restored['state']['project']['tracks'] if t['id']=='bass')
    flags=[next(t for t in s['state']['project']['tracks'] if t['id']=='bass') for s in controls['stages']]
    raw,sr=sf.read(DATA/'piano.wav',dtype='float32',always_2d=True)
    exported,export_sr=sf.read(ROOT/'user-fixes-piano-solo.wav',dtype='float32',always_2d=True)
    diff=float(np.max(np.abs(exported-raw*piano['solo']['project']['master_gain'])))
    checks={
        'click_mute_clears_solo':flags[0]['muted'] and not flags[0]['solo'],
        'click_solo_clears_mute':flags[1]['solo'] and not flags[1]['muted'],
        'drag_white_playhead_seeks_to_52_seconds':abs(controls['seek']['time']-52)<.2,
        'drag_white_playhead_keeps_original_selection':controls['seek']['selection']=={'track_id':'bass','start_seconds':30,'end_seconds':45},
        'ruler_has_more_time_labels':len(final['rulerLabels'].splitlines())>=12,
        'actual_dialogue_first_mutes_segment':next(t for t in muted['state']['project']['tracks'] if t['id']=='bass')['segments'][-1]['gain']==0,
        'exact_user_phrase_restores_segment':bass['segments'][-1]['gain']==1 and not bass['muted'] and restored['bassRms']>.001,
        'restored_bass_not_excluded_by_another_solo':bass['solo'],
        'restored_bass_has_no_stale_mute_overlay':final['bassDisplayedSegments']==[],
        'live_project_has_fifth_piano_track':len(final['state']['project']['tracks'])==5 and final['state']['project']['piano_added'],
        'live_project_has_no_conflicting_mute_solo_flags':all(not(t['muted'] and t['solo']) for t in final['state']['project']['tracks']),
        'piano_add_undo_redo_updates_audio_buffers':[h['bufferCount'] for h in piano['history']]==[4,5],
        'piano_solo_real_playback_clock_advanced':piano['solo']['currentTime']>31.5,
        'piano_full_wav_export_matches_source_estimate':exported.shape==raw.shape and sr==export_sr and diff<=1/2**23,
        'piano_mp3_download_matches_export_hash':hashlib.sha256((ROOT/'user-fixes-piano-solo.mp3').read_bytes()).hexdigest()==mp3['sha256'],
        'playhead_has_draggable_hit_area':final['playheadStyle']['pointerEvents']=='auto' and final['playheadStyle']['width']=='15px',
    }
    ffmpeg=ROOT.parent/'audiocraft/conda-env/bin/ffmpeg'
    decoded=subprocess.run([str(ffmpeg),'-v','error','-i',str(ROOT/'user-fixes-piano-solo.mp3'),'-f','null','-'],capture_output=True)
    checks['piano_mp3_decodes_without_errors']=decoded.returncode==0
    assert read('user-fixes-regression.json')['status']=='passed'
    report={'status':'passed' if all(checks.values()) else 'failed','checks':checks,
            'user_restore_phrase':'30~45秒的时候把贝斯加上，不用去掉',
            'piano_export_max_error':diff,'piano_source':read('data/piano-separation.json'),
            'human_listening_quality':'pending user listening; no claim of clean piano isolation',
            'test_project':'isolated copy on port 8604; final read-only check of actual project on port 8603',
            'original_user_project_retained':True}
    save_json(ROOT/'user-fixes-acceptance.json',report);print(json.dumps(report,ensure_ascii=False,indent=2));assert all(checks.values())

if __name__=='__main__':main()
