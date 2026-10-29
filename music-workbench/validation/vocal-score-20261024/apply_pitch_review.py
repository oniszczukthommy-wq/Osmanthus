"""Apply an explicitly chosen listening reference to one source-bound note."""
from pathlib import Path
import argparse,copy,hashlib,json,sys
import mido
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from scores import source_context,JOBS
from vocal_sources import lead_vocal_source

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def apply(data,analysis):
    file=data/lead_vocal_source(data)['corrections_file']
    if not file.exists():return
    config=json.loads(file.read_text());fixes=[f for f in config['corrections'] if f['type']=='set_note_pitch']
    if not fixes:return
    context,_=source_context(data)
    if config['vocal_sha256']!=context['vocal_sha256'] or config['lyrics_sha256']!=context['lyrics_sha256']:raise ValueError('听辨校订与当前原唱或歌词不匹配')
    path=analysis/'rain-vocal-notes.json';raw=json.loads(path.read_text());before=copy.deepcopy(raw)
    if raw['source_sha256']!=context['vocal_sha256']:raise ValueError('音符分析与听辨来源不一致')
    applied=raw.setdefault('user_pitch_reviews',[])
    for fix in fixes:
        if fix.get('confirmed_by')!='user' or fix.get('confirmation_scope')!='selected_reference_pitch_only':raise ValueError('音高校订必须有明确的试听选择')
        prior=next((x for x in applied if x['id']==fix['id']),None)
        if prior:
            if prior!=fix:raise ValueError('已应用的音高校订已改变，请从原始候选重新校订')
            continue
        source=JOBS/fix['source_score_job_id']/'score.json'
        if sha(source)!=fix['source_score_sha256']:raise ValueError('听辨参考谱面已改变')
        score=json.loads(source.read_text())
        if any(score[k]!=context[k] for k in ('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis')):raise ValueError('听辨参考来自另一首歌或人声')
        reference=fix['reference']
        for key in ('audio','midi'):
            asset=reference[key];name=asset['file']
            if Path(name).name!=name or sha(data/name)!=asset['sha256']:raise ValueError('试听参考文件校验失败')
        t=0;events=[]
        for m in mido.MidiFile(data/reference['midi']['file']).tracks[0]:
            t+=m.time
            if m.type=='note_on' and m.velocity:events.append((t,m.note))
        if (reference['note_on_tick'],fix['midi']) not in events:raise ValueError('选中的音高与试听 MIDI 不一致')
        a,b=fix['source_range_seconds'];matches=[n for n in raw['notes'] if n['voiced'] and abs(n['start_seconds']-a)<1e-6 and abs(n['end_seconds']-b)<1e-6 and n['midi']==fix['expected_midi']]
        source_note=[n for n in score['notes'] if n.get('lyric_index')==fix['lyric_index']]
        if len(matches)!=1 or len(source_note)!=1 or source_note[0]['midi']!=fix['expected_midi'] or abs(source_note[0]['start_seconds']-a)>1e-6 or abs(source_note[0]['end_seconds']-b)>1e-6:raise ValueError('听辨校订锚点已改变，未覆盖新的分析')
        n=matches[0];n['pre_user_review_pitch']={k:n[k] for k in ('midi','midi_float','cents_from_equal_temperament')}
        n.update(midi=fix['midi'],midi_float=float(fix['midi']),cents_from_equal_temperament=0.,pitch_origin='user_selected_listening_reference',human_reference_id=fix['id'])
        applied.append(copy.deepcopy(fix))
    if raw==before:return
    (analysis/'rain-vocal-notes.before-user-pitch-review.json').write_text(json.dumps(before,ensure_ascii=False,indent=2))
    path.write_text(json.dumps(raw,ensure_ascii=False,indent=2))
    print({'user_pitch_reviews':len(applied),'whole_score_accuracy_accepted':False},flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--data-dir',type=Path,required=True);p.add_argument('--analysis-dir',type=Path,required=True);a=p.parse_args();apply(a.data_dir,a.analysis_dir)
