"""Apply source-bound acoustic review candidates; never imply human accuracy approval."""
from pathlib import Path
import argparse,copy,hashlib,json,sys
import textgrid
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from vocal_sources import lead_vocal_source
from phrase_review import splice_grid
from build_review_score import align_lyrics
from scores import source_context

def apply(data,analysis):
    vocal=lead_vocal_source(data);file=data/vocal['corrections_file']
    if not file.exists():return
    config=json.loads(file.read_text());fixes=[f for f in config['corrections'] if f['type']=='measured_phrase_candidate']
    if not fixes:return
    context,lyrics=source_context(data)
    if config['vocal_sha256']!=context['vocal_sha256'] or config.get('lyrics_sha256')!=context['lyrics_sha256']:raise ValueError('声学复核与当前原唱或歌词不一致')
    rawpath=analysis/'rain-vocal-notes.json';gridpath=analysis/'tifa-rain/rain-vocals.TextGrid'
    raw=json.loads(rawpath.read_text());grid=textgrid.TextGrid.fromFile(str(gridpath));before=copy.deepcopy(raw)
    if raw['source_sha256']!=context['vocal_sha256']:raise ValueError('复核音频来源不匹配')
    done=set(raw.get('measured_review_ids',[]));report=[]
    for fix in fixes:
        if fix['id'] in done:
            prior=next((f for f in raw.get('measured_review_candidates',[]) if f['id']==fix['id']),None)
            if prior!=fix:raise ValueError('已应用的复核记录已改变，请从原始分析重新复核')
            continue
        if fix.get('confirmed_by')!='acoustic_review' or fix.get('accuracy_accepted') is not False:raise ValueError('候选复核不得伪装成人工准确性验收')
        old=fix['source_notes'];positions=[i for i,n in enumerate(raw['notes']) if n==old[0]]
        if len(positions)!=1:raise ValueError('声学复核锚点已改变，未覆盖新的分析')
        i=positions[0]
        if raw['notes'][i:i+len(old)]!=old:raise ValueError('声学复核区间已改变')
        replacement=copy.deepcopy(fix['replacement_notes']);a,b=fix['source_range_seconds']
        if abs(old[0]['start_seconds']-a)>1e-6 or abs(old[-1]['end_seconds']-b)>1e-6:raise ValueError('原始复核区间不匹配')
        if not replacement or abs(replacement[0]['start_seconds']-a)>1e-6 or abs(replacement[-1]['end_seconds']-b)>1e-6:raise ValueError('复核不能扩张原始音符区间')
        if any(n['end_seconds']<=n['start_seconds'] for n in replacement) or any(abs(x['end_seconds']-y['start_seconds'])>1e-5 for x,y in zip(replacement,replacement[1:])):raise ValueError('复核时间线不连续')
        for n in replacement:
            if n['voiced']:
                proof=n.get('acoustic_evidence',{})
                if proof.get('game_stem_midi')!=n['midi'] or proof.get('game_mix_midi')!=n['midi'] or proof.get('rmvpe_frames',0)<5 or abs(proof.get('rmvpe_median_midi',-100)-n['midi'])>.6:raise ValueError('候选音符缺少原混音、人声和独立音高依据')
                n.update(local_refinement=True,refinement_method='source_bound_acoustic_candidate',review_candidate_id=fix['id'])
        raw['notes'][i:i+len(old)]=replacement
        patch=fix.get('alignment_patch')
        if patch:
            name=patch['file']
            if Path(name).name!=name or not name.endswith('.TextGrid'):raise ValueError('读音复核文件名无效')
            path=data/name
            if hashlib.sha256(path.read_bytes()).hexdigest()!=patch['sha256']:raise ValueError('读音复核文件已改变')
            grid=splice_grid(grid,textgrid.TextGrid.fromFile(str(path)),patch['offset_seconds'],*patch['range_seconds'])
            raw.setdefault('alignment_refinements',[]).append({'kind':'pronunciation_review','review_id':fix['id'],'reading':patch['reading'],'range_seconds':patch['range_seconds'],'human_accuracy_accepted':False})
        done.add(fix['id']);report.append(fix)
    if not report:return
    if any(x['end_seconds']>y['start_seconds']+1e-5 for x,y in zip(raw['notes'],raw['notes'][1:])):raise ValueError('候选音符重叠')
    temp=analysis/'review-candidate-grid.TextGrid';grid.write(str(temp))
    old_missing=align_lyrics([n for n in before['notes'] if n['voiced']],gridpath,lyrics)[2]
    new_missing=align_lyrics([n for n in raw['notes'] if n['voiced']],temp,lyrics)[2]
    if not {c['index'] for c in new_missing}.issubset({c['index'] for c in old_missing}):raise ValueError('复核引入新的未定位歌词')
    (analysis/'rain-vocal-notes.before-acoustic-review.json').write_text(json.dumps(before,ensure_ascii=False,indent=2))
    raw['measured_review_ids']=sorted(done);raw['measured_review_candidates']=report
    rawpath.write_text(json.dumps(raw,ensure_ascii=False,indent=2));grid.write(str(gridpath))
    (analysis/'acoustic-review-report.json').write_text(json.dumps({'source_context':context,'applied':report,'missing_before':old_missing,'missing_after':new_missing,'accuracy_accepted':False},ensure_ascii=False,indent=2))
    print({'acoustic_candidates':len(report),'missing_before':len(old_missing),'missing_after':len(new_missing)},flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--data-dir',type=Path,required=True);p.add_argument('--analysis-dir',type=Path,required=True);a=p.parse_args();apply(a.data_dir,a.analysis_dir)
