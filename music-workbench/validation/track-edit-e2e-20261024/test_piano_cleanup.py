"""Real-audio invariants for reversible cleanup and compensated Other stem."""
from pathlib import Path
import hashlib, json, tempfile
import numpy as np
import soundfile as sf
from project import Project, DATA, ROOT, save_json

def main():
    original_sha=hashlib.sha256((DATA/'piano.wav').read_bytes()).hexdigest()
    report=json.loads((DATA/'piano-cleanup.json').read_text());checks={}
    checks['original_file_unchanged']=original_sha==report['input_sha256']
    with tempfile.TemporaryDirectory() as temp:
        directory=Path(temp)
        for name in ('preparation.json','drums.wav','bass.wav','vocals.wav','other.wav','original.wav','piano.wav','piano-gentle.wav','piano-strong.wav','piano-cleanup.json'):
            (directory/name).symlink_to(DATA/name)
        project=Project(directory)
        def apply(c):return project.apply(c,'manual',project.state['revision'])
        apply({'type':'add_piano'})
        original_mix=project.mix();original_key=project.track_digest('piano');other_key=project.track_digest('other')
        original_fingerprint=project.fingerprint()
        untouched={k:project.render_track(k).copy() for k in ('bass','vocals','drums')}
        apply({'type':'piano_cleanup','track_id':'piano','level':'gentle'})
        gentle_mix=project.mix();difference=float(np.max(np.abs(gentle_mix-original_mix)))
        checks['five_track_mix_conserved']=difference<=4*float(np.finfo(np.float32).eps)
        checks['other_three_tracks_unchanged']=all(np.array_equal(a,project.render_track(k)) for k,a in untouched.items())
        checks['piano_asset_cache_invalidated']=project.track_digest('piano')!=original_key
        checks['compensated_other_asset_cache_invalidated']=project.track_digest('other')!=other_key
        checks['source_version_in_project_fingerprint']=project.fingerprint()!=original_fingerprint
        checks['gentle_is_actual_different_audio']=not np.array_equal(project.render_track('piano'),project.audio['piano'])
        for name in ('gentle','strong'):
            audio,sr=sf.read(DATA/f'piano-{name}.wav',dtype='float32',always_2d=True)
            checks[name+'_valid_audio']=bool(audio.shape==project.audio['piano'].shape and sr==project.sr and np.all(np.isfinite(audio)) and np.max(np.abs(audio))<=.981)
        project.move_history('undo',project.state['revision'])
        checks['undo_returns_original_audio_and_fingerprint']=np.array_equal(original_mix,project.mix()) and project.fingerprint()==original_fingerprint
        project.move_history('redo',project.state['revision'])
        checks['redo_restores_gentle_mix']=np.array_equal(gentle_mix,project.mix())
        apply({'type':'piano_cleanup','track_id':'piano','level':'original'})
        checks['selector_can_restore_original_piano']=np.array_equal(project.render_track('piano'),project.audio['piano'])
        result={'status':'passed' if all(checks.values()) else 'failed','checks':checks,
                'max_recombined_mix_difference':difference,
                'quality_status':'Engineering checks only; listening improvement not asserted without user review.'}
        save_json(ROOT/'piano-cleanup-invariants.json',result);print(json.dumps(result,ensure_ascii=False,indent=2));assert all(checks.values())

if __name__=='__main__':main()
