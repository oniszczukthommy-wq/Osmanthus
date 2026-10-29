"""Acceptance invariants on actual song samples, including overlapping edits."""
import hashlib, json, tempfile
from pathlib import Path
import numpy as np
from project import Project, DATA, ROOT, save_json

def main():
    with tempfile.TemporaryDirectory() as temp:
        work=Path(temp)
        for path in DATA.glob('*.wav'):
            if '-' not in path.stem: (work/path.name).symlink_to(path)
        (work/'preparation.json').symlink_to(DATA/'preparation.json')
        p=Project(work); original=p.mix(); hashes={k:hashlib.sha256(v.tobytes()).hexdigest() for k,v in p.audio.items()}
        baseline_fingerprint=p.fingerprint();a,b=30*p.sr,45*p.sr
        p.apply({'type':'segment_gain','track_id':'bass','start_seconds':30,'end_seconds':45,'mode':'mute','gain_db':0},'dialogue',0)
        muted=p.mix();outside=np.r_[np.arange(0,a),np.arange(b,len(muted))]
        edit_error=float(np.max(np.abs((muted-original)-(p.render_track('bass')-p.audio['bass'])*p.meta['master_gain'])))
        float32_tolerance=4*float(np.finfo(np.float32).eps)
        checks={'outside_segment_sample_identical':bool(np.array_equal(original[outside],muted[outside])),
                'bass_segment_center_silent':bool(np.max(np.abs(p.render_track('bass')[a+1000:b-1000]))==0),
                'other_track_audio_arrays_unchanged':all(hashlib.sha256(v.tobytes()).hexdigest()==hashes[k] for k,v in p.audio.items()),
                'mix_change_matches_bass_change':edit_error<=float32_tolerance}
        p.apply({'type':'segment_gain','track_id':'bass','start_seconds':30,'end_seconds':45,'mode':'gain','gain_db':-6},'manual',1)
        gain_mix=p.mix();gain=10**(-6/20)
        checks['manual_overrides_dialogue_mute']=bool(np.allclose(p.envelope('bass')[a+1000:b-1000],gain))
        checks['manual_outside_unchanged']=bool(np.array_equal(original[outside],gain_mix[outside]))
        p.move_history('undo',2);checks['undo_manual_restores_dialogue_samples']=bool(np.array_equal(muted,p.mix()))
        p.move_history('undo',3);checks['undo_all_restores_baseline_samples']=bool(np.array_equal(original,p.mix()))
        checks['undo_restores_baseline_fingerprint']=p.fingerprint()==baseline_fingerprint
        p.move_history('redo',4);p.move_history('redo',5);checks['redo_restores_manual_samples']=bool(np.array_equal(gain_mix,p.mix()))
        # Later edits nested in earlier ones must not move fade edges outside
        # the NEW selection; a naive split-range implementation fails here.
        before=p.mix();x,y=35*p.sr,40*p.sr
        p.apply({'type':'segment_gain','track_id':'bass','start_seconds':35,'end_seconds':40,'mode':'mute','gain_db':0},'manual',6)
        after=p.mix();checks['nested_edit_outside_new_selection_unchanged']=bool(np.array_equal(before[:x],after[:x]) and np.array_equal(before[y:],after[y:]))
        snapshot=p.fingerprint();revision=p.state['revision']
        try:p.apply({'type':'segment_gain','track_id':'bass','start_seconds':40,'end_seconds':30,'mode':'mute','gain_db':0},'manual',revision)
        except ValueError:checks['invalid_range_does_not_mutate']=p.fingerprint()==snapshot and p.state['revision']==revision
        try:p.move_history('undo',revision-1)
        except RuntimeError:checks['stale_revision_does_not_mutate']=p.fingerprint()==snapshot
        p.move_history('undo',revision)
        p.apply({'type':'track_mix','track_id':'vocals','gain_db':-1},'manual',p.state['revision'])
        checks['new_edit_after_undo_discards_redo_branch']=p.state['cursor']==len(p.state['history'])
        report={'status':'passed' if all(checks.values()) else 'failed','source':'actual YinChao 末班车的窗 separated float32 audio',
                'duration_seconds':p.meta['duration_seconds'],'checks':checks,
                'max_mute_outside_error':float(np.max(np.abs(original[outside]-muted[outside]))),
                'max_mix_difference_invariant_error':edit_error,'float32_arithmetic_tolerance':float32_tolerance,
                'note':'Reducer/sample invariants; actual DeepSeek and browser acceptance recorded separately.'}
        save_json(ROOT/'sample-invariants.json',report);print(json.dumps(report,ensure_ascii=False,indent=2))
        assert all(checks.values()),report

if __name__=='__main__':main()
