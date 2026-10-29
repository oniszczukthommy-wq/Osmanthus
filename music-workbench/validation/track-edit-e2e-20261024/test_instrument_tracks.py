"""Actual-song acceptance: compensated splits, independent edits and recovery."""
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
import hashlib, json, tempfile
import numpy as np
from project import Project, ROOT, save_json
from instruments import Instruments

SOURCE=ROOT/'projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data'

def main():
    checks={};errors={}
    with tempfile.TemporaryDirectory() as tmp:
        directory=Path(tmp)
        for name in ('preparation.json','original.wav','drums.wav','bass.wav','vocals.wav','other.wav','piano.wav','guitar.wav'):
            (directory/name).symlink_to(SOURCE/name)
        save_json(directory/'instrument-separation.json',json.loads((SOURCE/'instrument-separation.json').read_text()))
        p=Project(directory)
        checks['prepared_assets_do_not_auto_add_tracks']=set(p.state['tracks'])=={'drums','bass','vocals','other'}
        def apply(c):return p.apply(c,'manual',p.state['revision'])
        apply({'type':'segment_gain','track_id':'other','mode':'gain','gain_db':-3,'start_seconds':30,'end_seconds':45})
        apply({'type':'track_mix','track_id':'other','gain_db':-2})
        base=p.mix();base_fingerprint=p.fingerprint()
        untouched={name:hashlib.sha256(p.render_track(name).tobytes()).hexdigest() for name in ('drums','bass','vocals')}
        other_key=p.track_digest('other')
        for instrument in ('piano','guitar'):
            apply({'type':'add_instrument','track_id':instrument})
            error=float(np.max(np.abs(base-p.mix())));errors[instrument]=error
            checks[instrument+'_addition_preserves_mix']=error<5e-7
            checks[instrument+'_inherits_existing_other_edits']=p.state['tracks'][instrument]==p.state['tracks']['other']
            checks[instrument+'_has_actual_audio']=float(np.sqrt(np.mean(p.render_track(instrument)**2)))>.001
            checks[instrument+'_source_is_same_length']=p.audio[instrument].shape==p.audio['other'].shape
            checks[instrument+'_invalidates_residual_cache']=p.track_digest('other')!=other_key
            other_key=p.track_digest('other')
        checks['six_track_split_leaves_original_stems_untouched']=all(hashlib.sha256(p.render_track(k).tobytes()).hexdigest()==v for k,v in untouched.items())
        six=p.mix();six_fingerprint=p.fingerprint();piano_key=p.track_digest('piano')
        before_keys={k:p.track_digest(k) for k in p.state['tracks']}
        p.apply({'type':'segment_gain','track_id':'guitar','mode':'mute','start_seconds':30,'end_seconds':45},'dialogue',p.state['revision'])
        muted=p.mix();a,b=30*p.sr,45*p.sr
        checks['guitar_edit_changes_only_selected_audio']=bool(np.array_equal(muted[:a],six[:a]) and np.array_equal(muted[b:],six[b:]) and not np.array_equal(muted[a:b],six[a:b]))
        checks['guitar_edit_does_not_invalidate_other_tracks']=all(p.track_digest(k)==v for k,v in before_keys.items() if k!='guitar')
        apply({'type':'segment_gain','track_id':'guitar','mode':'restore','start_seconds':30,'end_seconds':45})
        checks['manual_restores_dialogue_mute']=bool(np.all(p.envelope('guitar')[a:b]==1))
        # Restore intentionally replaces the inherited Other gain in this range.
        p.move_history('undo',p.state['revision']);checks['undo_manual_restores_dialogue_samples']=np.array_equal(p.mix(),muted)
        p.move_history('undo',p.state['revision']);checks['undo_dialogue_restores_six_tracks']=np.array_equal(p.mix(),six)
        p.move_history('undo',p.state['revision']);checks['undo_guitar_preserves_existing_piano']='guitar' not in p.state['tracks'] and 'piano' in p.state['tracks'] and p.track_digest('piano')==piano_key
        p.move_history('undo',p.state['revision']);checks['undo_both_restores_four_track_fingerprint']=p.fingerprint()==base_fingerprint
        p.move_history('redo',p.state['revision']);p.move_history('redo',p.state['revision'])
        checks['redo_both_restores_six_track_fingerprint']=p.fingerprint()==six_fingerprint
        reloaded=Project(directory)
        checks['reload_keeps_six_tracks_and_audio']=reloaded.state==p.state and np.array_equal(reloaded.mix(),six)
        apply({'type':'track_mix','track_id':'guitar','muted':True})
        apply({'type':'track_mix','track_id':'guitar','solo':True})
        checks['guitar_solo_clears_mute']=p.state['tracks']['guitar']['solo'] and not p.state['tracks']['guitar']['muted']
        apply({'type':'track_mix','track_id':'guitar','muted':True})
        checks['guitar_mute_clears_solo']=p.state['tracks']['guitar']['muted'] and not p.state['tracks']['guitar']['solo']
        with patch('instruments.subprocess.Popen',side_effect=AssertionError('Cached preparation must not run model')):
            checks['repeated_preparation_reuses_verified_assets']=Instruments().start(directory)['stage']=='ready'
        report=json.loads((directory/'instrument-separation.json').read_text());report['assets']['guitar']['sha256']='wrong'
        save_json(directory/'instrument-separation.json',report)
        try:Project(directory)
        except ValueError:checks['tampered_asset_manifest_rejected']=True
    report={'status':'passed' if all(checks.values()) else 'failed','checks':checks,'max_split_mix_error':errors,
            'source_project':SOURCE.parent.name,'listening_quality':'Not evaluated by sample invariants; user must audition bleed/artifacts.'}
    save_json(ROOT/'instrument-track-acceptance.json',report);print(json.dumps(report,ensure_ascii=False,indent=2))
    assert all(checks.values())

if __name__=='__main__':main()
