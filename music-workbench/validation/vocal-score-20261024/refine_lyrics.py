"""Refit a merged sung note only when local GAME, TIFA and YIN support it."""
from pathlib import Path
import argparse,copy,hashlib,json,os,shutil,subprocess,sys
import numpy as np,soundfile as sf,textgrid
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from scores import source_context
from vocal_sources import lead_vocal_source
from build_review_score import align_lyrics

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def refine(data,analysis):
    context,lyrics=source_context(data);source=data/lead_vocal_source(data)['file']
    rawfile=analysis/'rain-vocal-notes.json';gridfile=analysis/'tifa-rain/rain-vocals.TextGrid'
    original=json.loads(rawfile.read_text());raw=copy.deepcopy(original)
    if digest(source)!=raw['source_sha256']:raise ValueError('局部复核与实际人声不匹配')
    grid=textgrid.TextGrid.fromFile(str(gridfile));notes=[n for n in raw['notes'] if n['voiced']]
    characters,mapping,missing,lines=align_lyrics(notes,gridfile,lyrics)
    report={'method':'local_GAME_TIFA_refit_with_independent_YIN','source_sha256':context['vocal_sha256'],
            'unmapped_before':[c['char'] for c in missing],'refinements':[],'accuracy_accepted':False}
    directory=analysis/'local-refinements';directory.mkdir(exist_ok=True);attempts=0
    for char in missing:
        if attempts>=3:break
        note_index=next((i for i,n in enumerate(notes) if n['start_seconds']<=char['anchor']<n['end_seconds']),None)
        owner=mapping.get(note_index)
        if note_index is None or owner is None or owner['index']!=char['index']-1:continue
        span=notes[note_index];linechars=[c for c in characters if c['line_index']==char['line_index']]
        a=max(0,linechars[0]['start']-.18);b=linechars[-1]['end']+.18
        if b-a>12:continue
        attempts+=1
        folder=directory/f'line-{char["line_index"]}';folder.mkdir(exist_ok=True)
        audio=folder/'phrase.wav';info=sf.info(source);y,sr=sf.read(source,start=round(a*info.samplerate),stop=round(b*info.samplerate),dtype='float32',always_2d=True)
        sf.write(audio,y,sr,subtype='FLOAT');(folder/'phrase.txt').write_text(lines[char['line_index']])
        calls=[('run_tifa.py',[audio,'--output-dir',folder/'tifa']),('game_onnx.py',[source,'--start',a,'--end',b,'--output',folder/'game.json'])]
        for script,args in calls:
            with (folder/'inference.log').open('ab') as log:
                result=subprocess.run([sys.executable,str(ROOT/script),*map(str,args)],stdout=log,stderr=log,timeout=180)
            if result.returncode:raise ValueError('局部音符复核未完成，未补写缺字')
        local=json.loads((folder/'game.json').read_text());localgrid=textgrid.TextGrid.fromFile(str(folder/'tifa/phrase.TextGrid'))
        candidates=[n for n in local['notes'] if n['voiced'] and n['start_seconds']>=span['start_seconds']-.015 and n['end_seconds']<=span['end_seconds']+.015]
        if not 2<=len(candidates)<=3:continue
        if abs(candidates[0]['start_seconds']-span['start_seconds'])>.015 or abs(candidates[-1]['end_seconds']-span['end_seconds'])>.015:continue
        if any(n['end_seconds']-n['start_seconds']<.1 for n in candidates):continue
        if any(abs(left['end_seconds']-right['start_seconds'])>.02 for left,right in zip(candidates,candidates[1:])):continue
        # This repair addresses a measured pitch change hidden by one global
        # note. A forced transcript alone never manufactures a repeated note.
        if len({n['midi'] for n in candidates})<2:continue
        texts=next(t for t in localgrid if t.name=='texts');intervals=[i for i in texts if i.mark]
        if ''.join(i.mark for i in intervals)!=''.join(c['char'] for c in linechars):continue
        ordinal=char['index']-linechars[0]['index'];new_anchor=a+intervals[ordinal].minTime
        if min(abs(n['start_seconds']-new_anchor) for n in candidates[1:])>.1:continue
        import librosa
        mono=librosa.resample(y.mean(axis=1),orig_sr=sr,target_sr=22050)
        pitches=69+12*np.log2(librosa.yin(mono,fmin=110,fmax=880,sr=22050,frame_length=1024,hop_length=220)/440)
        times=a+np.arange(len(pitches))*220/22050;checks=[]
        for n in candidates:
            mask=(times>=n['start_seconds']+.035)&(times<=n['end_seconds']-.035)
            difference=abs(float(np.median(pitches[mask]))-n['midi_float'])*100 if mask.any() else float('inf')
            checks.append(difference)
        if any(value>50 for value in checks):continue
        lo,hi=owner['start'],char['end'];local_lo=a+intervals[ordinal-1].minTime;local_hi=a+intervals[ordinal].maxTime
        if abs(local_lo-lo)>.04 or abs(local_hi-hi)>.04:continue
        amended=copy.deepcopy(grid)
        for tier in amended:
            localtier=next((t for t in localgrid if t.name==tier.name),None)
            if localtier is None:continue
            values=[]
            for interval in tier:
                if interval.maxTime<=lo or interval.minTime>=hi:values.append(copy.deepcopy(interval))
                else:
                    if interval.minTime<lo:values.append(textgrid.Interval(interval.minTime,lo,interval.mark))
                    if interval.maxTime>hi:values.append(textgrid.Interval(hi,interval.maxTime,interval.mark))
            for interval in localtier:
                start=max(lo,a+interval.minTime);end=min(hi,a+interval.maxTime)
                if end>start:values.append(textgrid.Interval(start,end,interval.mark))
            tier.intervals=sorted(values,key=lambda v:v.minTime)
        updated=copy.deepcopy(raw);position=next(i for i,n in enumerate(updated['notes']) if n==span)
        replacements=[{**n,'local_refinement':True} for n in candidates]
        updated['notes'][position:position+1]=replacements
        proposed=folder/'proposed.TextGrid';amended.write(str(proposed))
        _,_,newmissing,_=align_lyrics([n for n in updated['notes'] if n['voiced']],proposed,lyrics)
        if char['index'] in {c['index'] for c in newmissing} or not {c['index'] for c in newmissing}.issubset({c['index'] for c in missing}):continue
        raw=updated;grid=amended;missing=newmissing
        report['refinements'].append({'lyric':char['char'],'with_previous_lyric':owner['char'],'source_range':[span['start_seconds'],span['end_seconds']],
                                      'measured_notes':candidates,'yin_difference_cents':checks,'method':'measured_local_refit_not_human_confirmation'})
    if report['refinements']:
        shutil.copy2(rawfile,analysis/'rain-vocal-notes.before-refinement.json');shutil.copy2(gridfile,analysis/'tifa-rain/rain-vocals.before-refinement.TextGrid')
        report['original_notes_sha256']=digest(rawfile);report['original_textgrid_sha256']=digest(gridfile)
        raw['local_refinements']=report['refinements'];rawfile.write_text(json.dumps(raw,ensure_ascii=False,indent=2));grid.write(str(gridfile))
    _,_,after,_=align_lyrics([n for n in raw['notes'] if n['voiced']],gridfile,lyrics)
    report['unmapped_after']=[c['char'] for c in after];report['attempt_limit']=3;report['attempts']=attempts;(analysis/'local-refinement-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print({'refined':len(report['refinements']),'unmapped_before':report['unmapped_before'],'unmapped_after':report['unmapped_after']},flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--data-dir',type=Path,required=True);p.add_argument('--analysis-dir',type=Path,required=True);args=p.parse_args();refine(args.data_dir,args.analysis_dir)
