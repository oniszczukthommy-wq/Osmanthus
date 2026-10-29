"""Regression checks for the user's actual mute/solo, restore and piano reports."""
from copy import deepcopy
from pathlib import Path
import json, tempfile
import numpy as np
from project import Project, DATA, ROOT, save_json

def main():
    with tempfile.TemporaryDirectory() as tmp:
        directory=Path(tmp)
        for name in ('preparation.json','drums.wav','bass.wav','vocals.wav','other.wav','original.wav','piano.wav'):
            (directory/name).symlink_to(DATA/name)
        p=Project(directory);checks={}
        def apply(c):return p.apply(c,'manual',p.state['revision'])
        def mix(name,**values):return apply({'type':'track_mix','track_id':name,**values})
        def bass():return p.state['tracks']['bass']
        mix('bass',muted=True);mix('bass',solo=True)
        checks['solo_clears_mute']=bass()['solo'] and not bass()['muted']
        mix('bass',muted=True);checks['mute_clears_solo']=bass()['muted'] and not bass()['solo']
        before=deepcopy(p.state)
        try:mix('bass',muted=True,solo=True)
        except ValueError:checks['simultaneous_true_rejected_without_mutation']=p.state==before
        apply({'type':'segment_gain','track_id':'bass','start_seconds':30,'end_seconds':45,'mode':'mute'})
        mix('vocals',solo=True)
        other_before=deepcopy(p.state['tracks']['vocals'])
        apply({'type':'segment_gain','track_id':'bass','start_seconds':30,'end_seconds':45,'mode':'restore'})
        a,b=30*p.sr,45*p.sr
        checks['restore_cancels_segment_silence']=bool(np.all(p.envelope('bass')[a:b]==1))
        checks['restore_cancels_track_mute']=not bass()['muted']
        checks['restore_audible_during_another_solo']=bass()['solo'] and p.state['tracks']['vocals']==other_before
        for name in list(p.state['tracks']):mix(name,solo=False,muted=False)
        mix('other',gain_db=-3)
        apply({'type':'segment_gain','track_id':'other','start_seconds':30,'end_seconds':45,'mode':'gain','gain_db':-6})
        before_audio=p.mix();before_other=p.render_track('other');other_key=p.track_digest('other')
        unchanged={name:p.render_track(name).copy() for name in ('drums','bass','vocals')}
        apply({'type':'add_piano'})
        piano_mix=p.mix();split_error=float(np.max(np.abs(piano_mix-before_audio)))
        checks['piano_added_with_actual_nonzero_audio']='piano' in p.state['tracks'] and float(np.sqrt(np.mean(p.render_track('piano')**2)))>.001
        checks['piano_other_recombine_without_doubling']=bool(split_error<=4*np.finfo(np.float32).eps)
        checks['split_inherits_other_edits_and_gain']=p.state['tracks']['piano']==p.state['tracks']['other']
        checks['split_does_not_touch_other_three_stems']=all(np.array_equal(p.render_track(name),audio) for name,audio in unchanged.items())
        checks['split_invalidates_other_buffer_key']=p.track_digest('other')!=other_key
        p.move_history('undo',p.state['revision'])
        checks['undo_piano_restores_four_track_samples']='piano' not in p.state['tracks'] and np.array_equal(before_audio,p.mix())
        p.move_history('redo',p.state['revision'])
        checks['redo_restores_five_track_samples']='piano' in p.state['tracks'] and np.array_equal(piano_mix,p.mix())
        before_key=p.track_digest('piano');mix('piano',solo=True)
        checks['mix_toggle_reuses_decoded_audio_key']=p.track_digest('piano')==before_key
        checks['no_mute_solo_conflicts']=all(not(t['muted'] and t['solo']) for t in p.state['tracks'].values())
        report={'status':'passed' if all(checks.values()) else 'failed','checks':checks,
                'max_piano_split_mix_difference':split_error,'piano_source':'actual htdemucs_6s estimate of existing song Other stem',
                'quality_note':'Piano bleed and artifacts still need listening; these checks establish state and mix conservation.'}
        save_json(ROOT/'user-fixes-regression.json',report);print(json.dumps(report,ensure_ascii=False,indent=2));assert all(checks.values())

if __name__=='__main__':main()
