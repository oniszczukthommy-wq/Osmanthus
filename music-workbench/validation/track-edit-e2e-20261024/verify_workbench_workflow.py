"""Verify real same-page generation, streaming, project edits and downloads."""
import hashlib, io, json, subprocess
import numpy as np
import soundfile as sf
from project import Project, ROOT, save_json

def read(name):return json.loads((ROOT/name).read_text())

def main():
    start=read('workflow-generation-start.json');identifier=start['generation']['job']['id']
    job=read(f'workflow/runs/{identifier}/state.json')
    baseline=read('workflow-new-baseline.json');dialogue=read('workflow-new-dialogue.json')
    manual=read('workflow-new-manual.json');exports=read('workflow-new-exports.json')
    first=read('workflow-stream-playing.json');before_refresh=read('workflow-before-refresh.json')
    after_refresh=read('workflow-after-refresh.json');restarted=read('workflow-restarted.json');guard=read('workflow-context-guard.json')
    directory=ROOT/'projects'/identifier/'data';project=Project(directory)
    source=ROOT/'workflow/runs'/identifier/'complete.mp3'
    checks={
        'actual_deepseek_lyrics_and_yinchao_submission':bool(job.get('lyrics')) and (source.parent/'lyrics-response.json').exists() and bool(job.get('task_id')),
        'one_paid_song_submission':sum(e['type']=='submitted' for e in job['events'])==1,
        'duplicate_live_request_returns_original_task':read('workflow-live-idempotency.json')['same_job_id'],
        'native_browser_plays_before_generation_done':first['generation']['job']['status']=='stream' and first['generation']['player']['source']=='stream' and not first['generation']['player']['paused'] and first['generation']['player']['currentTime']>1,
        'stream_continues_into_separation':before_refresh['generation']['job']['stage']=='separating' and before_refresh['generation']['player']['source']=='stream' and before_refresh['generation']['player']['currentTime']>first['generation']['player']['currentTime'],
        'refresh_keeps_same_existing_job':after_refresh['generation']['job']['id']==identifier,
        'automatic_open_uses_generation_job_as_project_id':after_refresh['editor']==identifier and baseline['project']['id']==identifier,
        'project_prepared_from_exact_generated_audio':project.meta['source_sha256']==hashlib.sha256(source.read_bytes()).hexdigest(),
        'scoped_track_urls_belong_to_same_song':all(t['audio_url'].startswith(f'/audio/{identifier}/') for t in baseline['project']['tracks']),
        'actual_dialogue_edits_new_song_bass':dialogue['editor']['project']['id']==identifier and next(t for t in dialogue['editor']['project']['tracks'] if t['id']=='bass')['segments'][-1]['gain']==0,
        'dialogue_pauses_unedited_generation_preview':dialogue['generation']['player']['paused'],
        'manual_edits_same_project':manual['editor']['project']['id']==identifier and next(t for t in manual['editor']['project']['tracks'] if t['id']=='bass')['segments'][-1]['gain']==10**(-6/20),
        'other_three_actual_browser_buffers_unchanged':all(baseline['hashes'][k]==manual['hashes'][k] for k in ('drums','vocals','other')),
        'bass_actual_browser_buffer_changed':baseline['hashes']['bass']!=manual['hashes']['bass'],
        'undo_returns_dialogue_mute':next(t for t in manual['undone']['tracks'] if t['id']=='bass')['segments'][-1]['gain']==0,
        'edited_audio_playback_clock_advances':manual['editor']['currentTime']>31 and not manual['editor']['telemetry']['audioErrors'],
        'exports_reference_same_generation_and_project':all(e['project_id']==identifier and e['generation_job_id']==identifier for e in exports),
        'download_hashes_match_exported_files':all(hashlib.sha256((ROOT/f'workflow-new-edited.{e["format"]}').read_bytes()).hexdigest()==e['sha256'] for e in exports),
        'wrong_project_is_rejected_even_with_current_revision':guard['wrong_project_with_matching_revision_status']==409 and guard['current_project_unchanged'],
        'legacy_user_project_preserved':guard['legacy_project_settings_preserved'],
        'server_restart_restores_same_project_and_revision':restarted['editor']['project']['id']==identifier and restarted['editor']['project']['revision']==manual['editor']['project']['revision'],
        'server_restart_restores_same_job':restarted['generation']['job']['id']==identifier and restarted['generation']['job']['stage']=='ready',
        'offline_restart_and_duplicate_safeguards_passed':read('workflow-recovery-checks.json')['status']=='passed',
    }
    wav,sr=sf.read(ROOT/'workflow-new-edited.wav',dtype='float32',always_2d=True)
    project.state['tracks']=exports[0]['tracks'];expected=project.mix()
    error=float(np.max(np.abs(wav-expected)))
    checks['wav_is_full_song']=len(wav)==project.meta['frames'] and sr==project.sr
    checks['wav_matches_current_project_mix']=error<=1/2**23
    project.state['tracks']={t['id']:{k:t[k] for k in ('segments','gain_db','muted','solo','cleanup') if k in t} for t in baseline['project']['tracks']}
    raw=project.mix();memory=io.BytesIO();sf.write(memory,raw,project.sr,format='WAV',subtype='PCM_24');memory.seek(0);base24,_=sf.read(memory,dtype='float32',always_2d=True)
    a,b=30*sr,45*sr
    checks['unselected_wav_samples_bit_identical']=bool(np.array_equal(wav[:a],base24[:a]) and np.array_equal(wav[b:],base24[b:]))
    ffmpeg=ROOT.parent/'audiocraft/conda-env/bin/ffmpeg'
    result=subprocess.run([str(ffmpeg),'-v','error','-i',str(ROOT/'workflow-new-edited.mp3'),'-f','null','-'],capture_output=True)
    checks['mp3_decodes_completely']=result.returncode==0
    report={'status':'passed' if all(checks.values()) else 'failed',
        'scope':'One newly generated AI-sung song: one webpage brief -> real DeepSeek lyrics -> real YinChao -> stream playback -> automatic separation/project opening -> dialogue/manual edits -> WAV/MP3 exports',
        'title':job['title'],'job_and_project_id':identifier,'checks':checks,
        'first_stream_seconds':job['first_stream_seconds'],'first_browser_play_seconds':job['first_play_seconds'],
        'generation_done_seconds':job['done_seconds'],'separation_seconds':job['preparation_seconds'],
        'engineering_ready_seconds':round(job['finished_at']-job['created_at'],3),
        'audio_duration_seconds':project.meta['duration_seconds'],'max_export_error':error,
        'documented_new_song_cost_cny':job.get('documented_song_price_cny'),'cost_note':'One song list price; DeepSeek tokens separate, not account billing reconciliation.',
        'remaining_acceptance':{'duration_150_210_seconds':read('workflow-new-song-audio-audit.json')['duration_target_150_210_met'],
            'human_listening':'pending','instrument_specific_rearranging':'not completed','accurate_singing_score':'not completed','fixed_singer_switching':'not completed'}}
    save_json(ROOT/'workflow-acceptance.json',report);print(json.dumps(report,ensure_ascii=False,indent=2));assert all(checks.values())

if __name__=='__main__':main()
