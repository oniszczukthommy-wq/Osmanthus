"""Conservative phrase-level repair of measured singing, always a candidate.

No supplied lyric can create a pitch. New/split notes require local GAME and
independent pYIN evidence. Phrase text realignment retains every supplied
character and is never treated as independent recognition or human acceptance.
"""
from pathlib import Path
import copy,hashlib,importlib.util,json,subprocess,sys
import numpy as np,soundfile as sf,textgrid
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from scores import source_context
from vocal_sources import lead_vocal_source
from build_review_score import align_lyrics
from game_onnx import Game

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def stable_core_runs(values,minimum_frames=9):
    """Do not promote a brief edge glide to a separate fixed-pitch note."""
    values=np.array(values,copy=True);edited=np.zeros(len(values),bool)
    while True:
        cuts=np.r_[0,np.where(np.diff(values)!=0)[0]+1,len(values)]
        if len(cuts)<3:break
        if cuts[1]-cuts[0]<minimum_frames:
            edited[:cuts[1]]=True;values[:cuts[1]]=values[cuts[1]];continue
        if cuts[-1]-cuts[-2]<minimum_frames:
            edited[cuts[-2]:]=True;values[cuts[-2]:]=values[cuts[-2]-1];continue
        break
    cuts=np.r_[0,np.where(np.diff(values)!=0)[0]+1,len(values)]
    return values,cuts,int(edited.sum())
def sections(lyrics):
    result=[];index=0
    for line in lyrics.splitlines():
        if line.strip().startswith('['):result.append({'name':line.strip(),'start':index,'end':index})
        elif line.strip():
            if not result:result.append({'name':'song','start':0,'end':0})
            index+=1;result[-1]['end']=index
    return [s for s in result if s['end']>s['start']]

def splice_grid(grid,local,offset,lo,hi):
    """Splice one measured time span, preserving other intervals byte-for-value."""
    amended=copy.deepcopy(grid)
    for tier in amended:
        source=next((t for t in local if t.name==tier.name),None)
        if source is None:continue
        values=[]
        for interval in tier:
            if interval.maxTime<=lo or interval.minTime>=hi:values.append(copy.deepcopy(interval))
            else:
                if interval.minTime<lo:values.append(textgrid.Interval(interval.minTime,lo,interval.mark))
                if interval.maxTime>hi:values.append(textgrid.Interval(hi,interval.maxTime,interval.mark))
        for interval in source:
            a=max(lo,offset+interval.minTime);b=min(hi,offset+interval.maxTime)
            if b>a:values.append(textgrid.Interval(a,b,interval.mark))
        tier.intervals=sorted(values,key=lambda v:v.minTime)
        if any(a.maxTime>b.minTime+1e-6 for a,b in zip(tier.intervals,tier.intervals[1:])):raise ValueError('局部歌词区间重叠，未发布修正')
    return amended

def normalized_lyric_characters(lyrics):
    """Use the same text normalization as the final score alignment gate."""
    return ''.join(ch for line in lyrics.splitlines()
                   if line.strip() and not line.strip().startswith('[')
                   for ch in line if ch.isalnum())

def grid_characters(grid):
    tier=next((t for t in grid if t.name=='texts'),None)
    if tier is None:return None
    return ''.join(ch for interval in tier for ch in interval.mark if ch.isalnum())

def validate_spliced_grid(original,amended,lyrics):
    """Return a rejection rather than letting one local candidate abort scoring."""
    expected=normalized_lyric_characters(lyrics)
    if grid_characters(original)!=expected:
        return {'reason':'original_grid_does_not_match_full_lyrics'}
    candidate=grid_characters(amended)
    if candidate is None:return {'reason':'splice_missing_texts_tier'}
    if candidate!=expected:
        mismatch=next((i for i,(a,b) in enumerate(zip(expected,candidate)) if a!=b),min(len(expected),len(candidate)))
        return {'reason':'splice_changed_full_lyric_character_sequence',
                'expected_character_count':len(expected),'candidate_character_count':len(candidate),
                'first_mismatch_index':mismatch,
                'expected_character':expected[mismatch:mismatch+1],
                'candidate_character':candidate[mismatch:mismatch+1]}
    return None

def checked_splice_grid(grid,local,offset,lo,hi,lyrics):
    """Pure candidate construction: accepted copy or explicit rejection details."""
    try:amended=splice_grid(grid,local,offset,lo,hi)
    except ValueError as error:
        return None,{'reason':'splice_interval_validation_failed','detail':str(error)}
    rejection=validate_spliced_grid(grid,amended,lyrics)
    return (None,rejection) if rejection else (amended,None)

def review(data,analysis):
    import librosa
    data=Path(data);analysis=Path(analysis);context,lyrics=source_context(data)
    rawfile=analysis/'rain-vocal-notes.json';gridfile=analysis/'tifa-rain/rain-vocals.TextGrid'
    raw=json.loads(rawfile.read_text());grid=textgrid.TextGrid.fromFile(str(gridfile));source=data/lead_vocal_source(data)['file']
    if sha(source)!=raw['source_sha256']:raise ValueError('乐句复核与原始人声不匹配')
    if raw.get('phrase_review_version')==1:return
    original_raw=copy.deepcopy(raw);original_grid=copy.deepcopy(grid)
    def aligned(notes=None,g=None):
        path=analysis/'phrase-review-grid.TextGrid';(g or grid).write(str(path))
        return align_lyrics([n for n in (notes or raw['notes']) if n['voiced']],path,lyrics)
    chars,mapping,missing,lines=aligned()
    if not missing:return
    folder=analysis/'phrase-review';folder.mkdir(exist_ok=True)
    report={'source_sha256':sha(source),'review_code_sha256':sha(Path(__file__)),'game_adapter_sha256':sha(ROOT/'game_onnx.py'),'accuracy_accepted':False,'alignment_repairs':[],'alignment_rejections':[],'note_repairs':[],
            'missing_before':[{'index':c['index'],'char':c['char']} for c in missing],
            'limitations':['pYIN/GAME agreement is not accuracy.','Forced text is not independent ASR.','Repaired notes and lyric timing still require listening.']}
    waveform,sr=sf.read(source,dtype='float32',always_2d=True);duration=len(waveform)/sr
    mono=librosa.resample(waveform.mean(axis=1),orig_sr=sr,target_sr=22050)
    f0,v,prob=librosa.pyin(mono,fmin=80,fmax=880,sr=22050,frame_length=2048,hop_length=220)
    times=np.arange(len(f0))*220/22050;pitch=librosa.hz_to_midi(f0)
    rms=librosa.feature.rms(y=mono,frame_length=2048,hop_length=220)[0][:len(times)]
    energy_floor=max(1e-4,float(np.median(rms[v]))*.06) if v.any() else 1e-4
    strong=v&np.isfinite(pitch)&(prob>=.5)&(rms>=energy_floor)
    np.savez_compressed(folder/'pyin-evidence.npz',times=times,pitch=pitch,voiced=v,probability=prob,rms=rms)
    def check(n):
        mask=(times>=n['start_seconds']+.025)&(times<n['end_seconds']-.025);good=mask&strong
        voiced=mask&v&np.isfinite(pitch)&(rms>=energy_floor)
        return {'voiced_fraction':float(good.sum()/max(1,mask.sum())),
                'median_pitch_difference_cents':float(np.median(abs(pitch[good]-n['midi_float']))*100) if good.any() else None,
                'voiced_flag_fraction':float(voiced.sum()/max(1,mask.sum())),
                'voiced_flag_pitch_difference_cents':float(np.median(abs(pitch[voiced]-n['midi_float']))*100) if voiced.any() else None}
    neural_model=None;neural_cache={};neural_unavailable=False
    def neural_check(n,index):
        nonlocal neural_model,neural_unavailable
        if neural_unavailable:return None
        if neural_model is None:
            module_path=ROOT.parent/'yingmusic-svc-20261025/modules/rmvpe.py'
            cached=ROOT.parent/'seed-vc-20261025/checkpoints/models--lj1995--VoiceConversionWebUI/snapshots'
            weights=next(cached.glob('*/rmvpe.pt'),None)
            if not module_path.exists() or weights is None:neural_unavailable=True;return None
            import torch
            torch.set_num_threads(2)
            spec=importlib.util.spec_from_file_location('score_rmvpe_evidence',module_path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            neural_model=module.RMVPE(str(weights),is_half=False,device='cpu')
            report['rmvpe_evidence']={'model_sha256':sha(weights),'module_sha256':sha(module_path),'score_is_not_calibrated_accuracy':True}
        if index not in neural_cache:
            import torch
            group=[c for c in chars if c['line_index']==index];a=max(0,group[0]['start']-.35);b=min(duration,group[-1]['end']+.35)
            y=librosa.resample(waveform[round(a*sr):round(b*sr)].mean(axis=1),orig_sr=sr,target_sr=16000)
            with torch.inference_mode():hidden=neural_model.mel2hidden(neural_model.mel_extractor(torch.from_numpy(y).float().unsqueeze(0),center=True)).squeeze(0).cpu().numpy()
            f=neural_model.decode(hidden,thred=.03);t=a+np.arange(len(f))*.01;mid=69+12*np.log2(np.maximum(f,1e-6)/440);salience=hidden.max(axis=1)
            neural_cache[index]=(t,mid,f>0,salience)
        t,mid,valid,salience=neural_cache[index];mask=(t>=n['start_seconds']+.02)&(t<n['end_seconds']-.02);good=mask&valid&(salience>=.2)
        return {'voiced_fraction':float(good.sum()/max(1,mask.sum())),
                'median_pitch_difference_cents':float(np.median(abs(mid[good]-n['midi_float']))*100) if good.any() else None,
                'median_salience':float(np.median(salience[good])) if good.any() else None}
    def supported(n,index=None):
        if n['end_seconds']-n['start_seconds']<.09:return False
        c=check(n)
        if c['voiced_fraction']>=.6 and c['median_pitch_difference_cents'] is not None and c['median_pitch_difference_cents']<=50:return True
        # Fast transitions can have low pYIN voicing posterior despite stable
        # F0. Do not lower that threshold alone: require a second, neural F0
        # estimate as well as pYIN's voiced flag and pitch agreement.
        if index is None or c['voiced_flag_fraction']<.6 or c['voiced_flag_pitch_difference_cents'] is None or c['voiced_flag_pitch_difference_cents']>50:return False
        neural=neural_check(n,index)
        if neural and neural['voiced_fraction']>=.6 and neural['median_pitch_difference_cents'] is not None and neural['median_pitch_difference_cents']<=50:
            n['rmvpe_evidence']=neural;return True
        return False
    protected=[];fixfile=data/lead_vocal_source(data)['corrections_file']
    if fixfile.exists():protected=[f['source_range_seconds'] for f in json.loads(fixfile.read_text()).get('corrections',[])]
    def protected_span(a,b):return any(a<z and b>x for x,z in protected)
    # Long gaps inside a text block are a warning, not a reason to invent text.
    # Reset a badly aligned repeated section only if its opening pitch/rhythm
    # pattern agrees with an earlier measured occurrence in the same song.
    jobs=[];covered=set();voiced=[n for n in raw['notes'] if n['voiced']]
    for section in sections(lyrics):
        indices=set(range(section['start'],section['end']));group=[c for c in chars if c['line_index'] in indices]
        if len(indices)<3 or sum(c['end']-c['start']<.06 for c in group)<2:continue
        first=section['start'];earlier=next((i for i in range(first) if lines[i]==lines[first]),None)
        if earlier is None:continue
        ref=[n for j,n in enumerate(voiced) if mapping.get(j,{}).get('line_index')==earlier][:5]
        if len(ref)<5:continue
        opening=group[0]['start'];candidates=[]
        for i,n in enumerate(voiced):
            part=voiced[i:i+5]
            if len(part)<5 or abs(n['start_seconds']-opening)>2:continue
            if [p['midi'] for p in part]!=[p['midi'] for p in ref]:continue
            ratios=[(p['end_seconds']-p['start_seconds'])/(r['end_seconds']-r['start_seconds']) for p,r in zip(part,ref)]
            if all(.5<=r<=2 for r in ratios):candidates.append(n['start_seconds'])
        if len(candidates)!=1:continue
        start=max(0,candidates[0]-.2);end=min(duration,group[-1]['end']+1)
        # Continue through a measured held final vowel rather than cropping it
        # at the faulty old forced-alignment endpoint.
        cursor=np.searchsorted(times,group[-1]['end']);last=cursor;gap=0
        while cursor<len(times) and times[cursor]<min(duration,group[-1]['end']+8):
            if strong[cursor]:last=cursor;gap=0
            else:gap+=1
            if gap>20:break
            cursor+=1
        if last<len(times):end=max(end,min(duration,float(times[last])+.2))
        if not 1<=end-start<=60:continue
        jobs.append({'name':f'section-{first:02d}','indices':indices,'start':start,'end':end,'text':'\n'.join(lines[i] for i in sorted(indices)),
                     'old_start':group[0]['start'],'old_end':group[-1]['end'],'kind':'repeated_section','measured_opening':candidates[0]});covered|=indices
    for index in sorted({c['line_index'] for c in missing}-covered)[:16]:
        group=[c for c in chars if c['line_index']==index]
        jobs.append({'name':f'line-{index:02d}','indices':{index},'start':max(0,group[0]['start']-.35),'end':min(duration,group[-1]['end']+.35),
                     'old_start':group[0]['start'],'old_end':group[-1]['end'],'text':lines[index],'kind':'line'})
    for job in jobs:
        path=folder/(job['name']+'.wav');sf.write(path,waveform[round(job['start']*sr):round(job['end']*sr)],sr,subtype='FLOAT');path.with_suffix('.txt').write_text(job['text']);job['audio']=path
    if jobs:
        with (folder/'tifa.log').open('wb') as log:
            process=subprocess.run([sys.executable,str(ROOT/'run_tifa.py'),*[str(j['audio']) for j in jobs],'--output-dir',str(folder/'aligned')],stdout=log,stderr=log,timeout=300)
        if process.returncode:raise ValueError('乐句复核未完成，保留旧候选谱')
    for job in jobs:
        local=textgrid.TextGrid.fromFile(str(folder/'aligned'/(job['name']+'.TextGrid')))
        intervals=[i for i in next(t for t in local if t.name=='texts') if i.mark]
        if ''.join(i.mark for i in intervals)!=''.join(c for c in job['text'] if c.isalnum()) or any(i.maxTime-i.minTime<.06 for i in intervals):continue
        lo=min(job['start'],job['old_start']);hi=max(job['end'],job['old_end'])
        amended,rejection=checked_splice_grid(grid,local,job['start'],lo,hi,lyrics)
        details={'kind':job['kind'],'lines':sorted(job['indices']),'range_seconds':[lo,hi]}
        if rejection:
            report['alignment_rejections'].append({**details,**rejection})
            print({'phrase_alignment_candidate_rejected':{**details,**rejection}},flush=True)
            continue
        _,_,before_missing,_=aligned()
        try:_,_,after_missing,_=aligned(g=amended)
        except ValueError as error:
            rejection={**details,'reason':'candidate_alignment_validation_failed','detail':str(error)}
            report['alignment_rejections'].append(rejection)
            print({'phrase_alignment_candidate_rejected':rejection},flush=True)
            continue
        before_set={c['index'] for c in before_missing};after_set={c['index'] for c in after_missing}
        if not after_set<before_set:continue
        grid=amended;report['alignment_repairs'].append({'kind':job['kind'],'lines':sorted(job['indices']),'range_seconds':[lo,hi],
               'measured_opening':job.get('measured_opening'),'resolved_indices':sorted(before_set-after_set),'human_accuracy_accepted':False})
    chars,mapping,missing,lines=aligned();model=Game();line_cache={}
    def line_notes(index):
        if index not in line_cache:
            group=[c for c in chars if c['line_index']==index];a=max(0,group[0]['start']-.35);b=min(duration,group[-1]['end']+.35)
            result=model.extract(waveform[round(a*sr):round(b*sr)],sr,offset=a)
            line_cache[index]=[n for n in result['notes'] if n['voiced']]
        return line_cache[index]
    def guided_split(span,index):
        from scipy.ndimage import median_filter
        neural_check(span,index)
        if index not in neural_cache:return []
        t,mid,valid,salience=neural_cache[index];positions=np.where((t>=span['start_seconds'])&(t<span['end_seconds']))[0]
        if len(positions)<18:return []
        reliable=valid[positions]&(salience[positions]>=.2)
        if reliable.mean()<.65:return []
        # Only measured stable F0 changes may introduce a barrier. Neither the
        # requested character count nor its timing is used to choose barriers.
        values=np.interp(np.arange(len(positions)),np.where(reliable)[0],mid[positions][reliable])
        values=median_filter(np.rint(values),size=5,mode='nearest').astype(int)
        values,cuts,edge_frames=stable_core_runs(values)
        if not 2<=len(cuts)-1<=3 or any((b-a)*.01<.09 for a,b in zip(cuts,cuts[1:])):return []
        boundaries=[span['start_seconds'],*[float(t[positions[c]]) for c in cuts[1:-1]],span['end_seconds']]
        group=[c for c in chars if c['line_index']==index];a=max(0,group[0]['start']-.35);b=min(duration,group[-1]['end']+.35)
        # Use GAME's pitch estimator on these independently measured regions.
        # Do not run the stochastic segmenter again and reintroduce incidental
        # boundaries inside the stable F0 cores.
        result=model.extract(waveform[round(a*sr):round(b*sr)],sr,offset=a,steps=0,known_boundary_seconds=[t for t in boundaries if a<t<b])
        candidate=[n for n in result['notes'] if n['voiced'] and n['start_seconds']>=span['start_seconds']-.025 and n['end_seconds']<=span['end_seconds']+.025]
        combined=[]
        for n in candidate:
            if combined and combined[-1]['midi']==n['midi'] and abs(combined[-1]['end_seconds']-n['start_seconds'])<.015:
                previous=combined[-1];left=previous['end_seconds']-previous['start_seconds'];right=n['end_seconds']-n['start_seconds']
                previous['midi_float']=(previous['midi_float']*left+n['midi_float']*right)/(left+right);previous['end_seconds']=n['end_seconds']
                previous['cents_from_equal_temperament']=round((previous['midi_float']-previous['midi'])*100,2)
            else:combined.append(n)
        candidate=combined
        expected=[int(values[c]) for c in cuts[:-1]]
        if [n['midi'] for n in candidate]!=expected:return []
        for n in candidate:n['measured_boundary_guidance']={'method':'RMVPE stable F0 change, then direct GAME estimator and independent pYIN validation','boundaries':boundaries,'segmentation_seed':model.seed,'stochastic_segmentation_steps':0,'edge_transition_frames_reassigned':edge_frames,'minimum_stable_pitch_seconds':.09,'edge_glides_remain_a_listening_review_item':True}
        return candidate
    # Split a measured pitch change missed in a full-song chunk. Same-pitch
    # syllable repeats remain unresolved here; text alone cannot create them.
    for char in missing:
        span=next((n for n in raw['notes'] if n['voiced'] and n['start_seconds']<=char['anchor']<n['end_seconds']),None)
        if span is None or protected_span(span['start_seconds'],span['end_seconds']):continue
        def eligible(candidate):
            return (2<=len(candidate)<=3 and len({n['midi'] for n in candidate})>=2 and
                    abs(candidate[0]['start_seconds']-span['start_seconds'])<=.025 and abs(candidate[-1]['end_seconds']-span['end_seconds'])<=.025 and
                    all(abs(a['end_seconds']-b['start_seconds'])<=.02 for a,b in zip(candidate,candidate[1:])) and
                    all(supported(n,char['line_index']) for n in candidate))
        candidates=[copy.deepcopy(n) for n in line_notes(char['line_index']) if n['start_seconds']>=span['start_seconds']-.025 and n['end_seconds']<=span['end_seconds']+.025]
        if not eligible(candidates):candidates=guided_split(span,char['line_index'])
        if not eligible(candidates):continue
        candidates[0]['start_seconds']=span['start_seconds'];candidates[-1]['end_seconds']=span['end_seconds']
        for n in candidates:n.update(local_refinement=True,refinement_method='phrase_GAME_independent_pYIN_split')
        proposed=copy.deepcopy(raw['notes']);position=proposed.index(span);proposed[position:position+1]=candidates
        _,_,old_missed,_=aligned();_,_,new_missed,_=aligned(notes=proposed)
        if not {c['index'] for c in new_missed}<{c['index'] for c in old_missed}:continue
        raw['notes']=proposed;report['note_repairs'].append({'type':'split_measured_pitch_change','source_range':[span['start_seconds'],span['end_seconds']],'notes':candidates,'pitch_evidence':[check(n) for n in candidates]})
    # Recover voiced material swallowed by an overly long unvoiced segment.
    # The crop uses measured voicing rather than the desired syllable count.
    for span in list(raw['notes']):
        if span['voiced'] or span['end_seconds']-span['start_seconds']<.15 or protected_span(span['start_seconds'],span['end_seconds']):continue
        related=[c for c in chars if min(c['end'],span['end_seconds'])-max(c['start'],span['start_seconds'])>.08]
        if not related:continue
        mask=strong&(times>=span['start_seconds'])&(times<span['end_seconds']);positions=np.where(mask)[0]
        if not len(positions):continue
        groups=np.split(positions,np.where(np.diff(positions)>9)[0]+1);newnotes=[]
        for group in groups:
            a=max(span['start_seconds'],float(times[group[0]]));b=min(span['end_seconds'],float(times[group[-1]])+.01)
            if b-a<.18 or not any(a<c['end'] and b>c['start'] for c in related):continue
            left=max(0,a-.08);right=min(duration,b+.08)
            result=model.extract(waveform[round(left*sr):round(right*sr)],sr,offset=left)
            for n in result['notes']:
                if not n['voiced']:continue
                n['start_seconds']=max(span['start_seconds'],a,n['start_seconds']);n['end_seconds']=min(span['end_seconds'],b,n['end_seconds'])
                if not supported(n):continue
                n.update(local_refinement=True,refinement_method='voiced_tail_GAME_independent_pYIN_recovery');newnotes.append(n)
        if not newnotes:continue
        newnotes.sort(key=lambda n:n['start_seconds'])
        merged=[]
        def owner(n):return next((c['index'] for c in chars if c['start']<=n['start_seconds']+.03<c['end']),None)
        for n in newnotes:
            if merged and merged[-1]['midi']==n['midi'] and abs(merged[-1]['end_seconds']-n['start_seconds'])<.015 and owner(merged[-1]) is not None and owner(merged[-1])==owner(n):
                previous=merged[-1];left=previous['end_seconds']-previous['start_seconds'];right=n['end_seconds']-n['start_seconds']
                previous['midi_float']=(previous['midi_float']*left+n['midi_float']*right)/(left+right);previous['end_seconds']=n['end_seconds'];previous['cents_from_equal_temperament']=round((previous['midi_float']-previous['midi'])*100,2)
            else:merged.append(n)
        newnotes=merged;replacement=[];cursor=span['start_seconds']
        for n in newnotes:
            if n['start_seconds']<cursor-1e-6:raise ValueError('恢复音符重叠，未发布修正')
            if n['start_seconds']>cursor:replacement.append({**span,'start_seconds':cursor,'end_seconds':n['start_seconds']})
            replacement.append(n);cursor=n['end_seconds']
        if cursor<span['end_seconds']:replacement.append({**span,'start_seconds':cursor})
        position=raw['notes'].index(span);raw['notes'][position:position+1]=replacement
        report['note_repairs'].append({'type':'recover_measured_voiced_tail','source_range':[span['start_seconds'],span['end_seconds']],'notes':newnotes,'pitch_evidence':[check(n) for n in newnotes]})
    _,_,after,_=aligned();report['missing_after']=[{'index':c['index'],'char':c['char']} for c in after]
    if not {c['index'] for c in after}.issubset({c['index'] for c in align_lyrics([n for n in original_raw['notes'] if n['voiced']],gridfile,lyrics)[2]}):raise ValueError('复核引入新的未定位歌词，未发布')
    if any(a['end_seconds']>b['start_seconds']+1e-5 for a,b in zip(raw['notes'],raw['notes'][1:])):raise ValueError('音符时间线重叠，未发布')
    report['source_unchanged']=sha(source)==context['vocal_sha256'];assert report['source_unchanged']
    (analysis/'rain-vocal-notes.before-phrase-review.json').write_text(json.dumps(original_raw,ensure_ascii=False,indent=2));original_grid.write(str(analysis/'tifa-rain/rain-vocals.before-phrase-review.TextGrid'))
    raw['phrase_review_version']=1;raw['alignment_refinements']=report['alignment_repairs'];raw.setdefault('local_refinements',[]).extend(report['note_repairs'])
    rawfile.write_text(json.dumps(raw,ensure_ascii=False,indent=2));grid.write(str(gridfile));(analysis/'phrase-review-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print({'phrase_review':True,'alignment_repairs':len(report['alignment_repairs']),'alignment_rejections':len(report['alignment_rejections']),'note_repairs':len(report['note_repairs']),'unmapped_before':len(report['missing_before']),'unmapped_after':len(report['missing_after'])},flush=True)
    return report

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--data-dir',type=Path,required=True);p.add_argument('--analysis-dir',type=Path,required=True);a=p.parse_args();review(a.data_dir,a.analysis_dir)
