"""Single-part experiment: estimate harmony, author MIDI and render a new piano.

Audio-derived chords/tempo are candidates, not a transcription ground truth.
Original stems and saved user edits are never overwritten.
"""
from pathlib import Path
import argparse, fcntl, hashlib, itertools, json, os, subprocess, tempfile, time
import numpy as np
import soundfile as sf
from project import Project, ROOT, save_json

NAMES=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']

def analyze(directory,start,end):
    meta=json.loads((directory/'preparation.json').read_text())
    if not 0<=start<end<=meta['duration_seconds'] or end-start<1:raise ValueError('选区需在歌曲内，且至少1秒')
    drums,sr=sf.read(directory/'drums.wav',dtype='float32',always_2d=True)
    step=round(sr/100);mono=np.mean(drums,axis=1);length=len(mono)//step
    energy=np.sqrt(np.mean(mono[:length*step].reshape(length,step)**2,axis=1)+1e-10)
    onset=np.maximum(np.diff(np.log1p(energy*100),prepend=0),0)
    onset=np.convolve(onset,np.array([.25,.5,.25]),mode='same')
    fft=np.fft.rfft(onset,n=2**int(np.ceil(np.log2(len(onset)*2))))
    ac=np.fft.irfft(fft*fft.conj())[:len(onset)]/np.arange(len(onset),0,-1)
    candidates=[]
    for bpm in np.arange(65,131,.1):
        lag=6000/bpm;score=float(np.interp(lag,np.arange(len(ac)),ac))
        candidates.append((score,float(bpm)))
    candidates.sort(reverse=True);tempo=candidates[0][1];beat=60/tempo
    phases=np.arange(0,beat,.005)
    scores=[float(np.mean(np.interp(np.arange(phase+3*beat,len(onset)/100-3*beat,beat)*100,np.arange(len(onset)),onset))) for phase in phases]
    phase=float(phases[int(np.argmax(scores))])
    other,rate=sf.read(directory/'other.wav',start=round(start*sr),stop=round(end*sr),dtype='float32',always_2d=True)
    bass,_=sf.read(directory/'bass.wav',start=round(start*sr),stop=round(end*sr),dtype='float32',always_2d=True)
    def chroma(audio):
        # Hann-windowed pitch-class energy; no downloaded analysis model.
        y=audio.mean(axis=1)[::2];rate=sr/2;win=8192;hop=1102
        frames=np.lib.stride_tricks.sliding_window_view(y,win)[::hop]
        frequencies=np.fft.rfftfreq(win,1/rate);pitch=69+12*np.log2(np.maximum(frequencies,.001)/440)
        filters=np.zeros((len(frequencies),12))
        for midi in range(40,89):
            weights=np.maximum(0,1-np.abs(pitch-midi)/.55)
            filters[:,midi%12]+=weights
        result=np.zeros((len(frames),12))
        for offset in range(0,len(frames),128):
            spec=np.abs(np.fft.rfft(frames[offset:offset+128]*np.hanning(win),axis=1))**.65
            result[offset:offset+len(spec)]=spec@filters
        result/=np.maximum(np.sum(result,axis=1,keepdims=True),1e-9)
        return result,start+(np.arange(len(frames))*hop+win/2)/rate
    features,times=chroma(other);bass_features,_=chroma(bass)
    if float(np.sqrt(np.mean(other**2)))<1e-5:raise ValueError('选区伴奏过少，暂无法分析和声，请换一个区间')
    middle=np.arange(phase+np.ceil((start-phase)/(2*beat))*2*beat,end,2*beat)
    boundaries=np.r_[start,middle[(middle>start+.08)&(middle<end-.08)],end]
    chords=[];templates=[]
    for root in range(12):
        for quality,intervals in [('major',[0,4,7]),('minor',[0,3,7])]:
            tones=[(root+i)%12 for i in intervals];template=np.full(12,-.12);template[tones]=1/3
            templates.append((root,quality,tones,template))
    emission=[];measurements=[]
    for a,b in zip(boundaries[:-1],boundaries[1:]):
        mask=(times>=a)&(times<b)
        if not mask.any():mask[np.argmin(abs(times-(a+b)/2))]=True
        c=features[mask].mean(axis=0);low=bass_features[mask].mean(axis=0)
        emission.append([float(c@template+.18*low[root]) for root,_,_,template in templates]);measurements.append(c)
    emission=np.array(emission);scores=emission.copy();back=np.zeros_like(scores,dtype=int)
    penalty=np.full((24,24),.012);np.fill_diagonal(penalty,0)
    for i in range(1,len(scores)):
        paths=scores[i-1][:,None]-penalty;back[i]=paths.argmax(axis=0);scores[i]+=paths.max(axis=0)
    route=[int(scores[-1].argmax())]
    for i in range(len(scores)-1,0,-1):route.append(int(back[i,route[-1]]))
    for (a,b),index,e,c in zip(zip(boundaries[:-1],boundaries[1:]),reversed(route),emission,measurements):
        root,quality,tones,_=templates[index];rank=np.sort(e)[::-1]
        chords.append({'start':float(a),'end':float(b),'chord':NAMES[root]+('m' if quality=='minor' else ''),
                       'root':root,'quality':quality,'pitch_classes':tones,'relative_score_margin':float(rank[0]-rank[1]),
                       'chroma':c.tolist()})
    # Key is a descriptive hypothesis only, never used to force local chords.
    profile=features.mean(axis=0);key_scores=[]
    for root in range(12):
        for quality,scale in [('major',[0,2,4,5,7,9,11]),('minor',[0,2,3,5,7,8,10])]:
            score=sum(profile[(root+i)%12] for i in scale)+.1*profile[root]
            key_scores.append((float(score),NAMES[root]+' '+quality))
    key_scores.sort(reverse=True)
    separated=[]
    for score,bpm in candidates:
        if all(abs(bpm-v['bpm'])>3 for v in separated):separated.append({'bpm':round(bpm,2),'score':score})
        if len(separated)==4:break
    return {'source_project':json.loads((directory/'project.json').read_text())['id'],'range':[start,end],
            'tempo_estimate':round(tempo,2),'tempo_candidates':separated,'beat_phase_seconds':phase,
            'key_hypothesis':key_scores[0][1],'key_alternatives':key_scores[:3],'chords':chords,
            'limitations':['Tempo can have half/double-time ambiguity; phase is not a verified downbeat.',
                           'Chords use spectral triad estimates; score margins are not calibrated accuracy.',
                           'Human listening must validate harmony, timing and instrument fit.']}

def render(directory,analysis,output):
    import mido
    started=time.perf_counter();start,end=analysis['range'];beat=60/analysis['tempo_estimate'];phase=analysis['beat_phase_seconds']
    previous=np.array([55,60,65]);notes=[];voicings=[]
    for section in analysis['chords']:
        pcs=section['pitch_classes'];choices=[[n for n in range(52,74) if n%12==pc] for pc in pcs]
        candidates={tuple(sorted(v)) for v in itertools.product(*choices) if max(v)-min(v)<=16}
        voice=min(candidates,key=lambda v:sum((np.array(v)-previous)**2)+.15*sum((np.array(v)-np.array([55,60,65]))**2))
        previous=np.array(voice);voicings.append({**section,'voicing':voice})
        first=int(np.ceil((section['start']-phase)/(beat/2)-1e-6))
        for tick in range(first,int(np.ceil((section['end']-phase)/(beat/2)-1e-6))):
            at=phase+tick*beat/2
            if at<start or at>=end-.22:continue
            # Light broken voicing, one periodic breath; no bass doubling.
            if tick%16==15:continue
            index=[0,2,1,2][tick%4];delay=[.006,.009,.004,.011][tick%4]
            at=max(start,at+delay);duration=min(beat*.7,end-at-.03)
            if duration<=.03:continue
            phrase=(at-start)/(end-start);dip=.80 if .42<phrase<.64 else 1
            velocity=round([55,43,49,45][tick%4]*dip)
            notes.append({'start_seconds':at,'end_seconds':at+duration,'pitch':voice[index],'velocity':velocity,'chord':section['chord']})
    midi=mido.MidiFile(ticks_per_beat=960);track=mido.MidiTrack();midi.tracks.append(track)
    tempo=mido.bpm2tempo(analysis['tempo_estimate'])
    track.extend([mido.MetaMessage('track_name',name='New piano accompaniment'),mido.MetaMessage('set_tempo',tempo=tempo),
                  mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.Message('program_change',channel=0,program=0)])
    events=[]
    for n in notes:
        for at,on in ((n['start_seconds'],True),(n['end_seconds'],False)):
            events.append((round(mido.second2tick(at,960,tempo)),on,n['pitch'],n['velocity']))
    previous_tick=0
    for tick,on,pitch,velocity in sorted(events,key=lambda e:(e[0],e[1])):
        track.append(mido.Message('note_on' if on else 'note_off',note=pitch,velocity=velocity if on else 0,time=tick-previous_tick));previous_tick=tick
    midi.save(output/'new-piano.mid');save_json(output/'notes.json',notes)
    synth=ROOT.parent/'audio-runtime/env/bin/fluidsynth';sf2=ROOT.parent/'instrument-generaluser/GeneralUser-GS.sf2'
    result=subprocess.run([str(synth),'-ni','-g','0.6','-o','synth.reverb.active=0','-o','synth.chorus.active=0',
                           '-F',str(output/'synth.wav'),'-r','44100',str(sf2),str(output/'new-piano.mid')],capture_output=True,timeout=60)
    if result.returncode:raise ValueError('钢琴音源渲染失败：'+result.stderr.decode(errors='replace')[-200:])
    p=Project(directory);part=np.zeros_like(p.audio['other']);rendered,sr=sf.read(output/'synth.wav',dtype='float32',always_2d=True)
    if sr!=p.sr:raise ValueError('音源采样率与工程不一致')
    count=min(len(part),len(rendered));part[:count]=rendered[:count];a,b=round(start*sr),round(end*sr)
    part[:a]=0;part[b:]=0;fade=round(.03*sr);part[a:a+fade]*=np.linspace(0,1,fade)[:,None];part[b-fade:b]*=np.linspace(1,0,fade)[:,None]
    original_rms=float(np.sqrt(np.mean(p.audio['other'][a:b]**2)));part_rms=float(np.sqrt(np.mean(part[a:b]**2)))
    if part_rms<1e-8:raise ValueError('钢琴音源渲染为空')
    baseline=p.mix();raw=sum(p.audio[k] for k in ('drums','bass','other','vocals'))*p.meta['master_gain']
    target=min(.03,max(original_rms*.4,float(np.sqrt(np.mean(raw[a:b]**2)))*.13))
    part*=target/part_rms
    # Adjust only the new part if needed. Existing samples retain their gain.
    scale=1.
    for base in (baseline,raw):
        limit=max(.98,float(np.max(np.abs(base))))
        if float(np.max(np.abs(base+part*p.meta['master_gain']*scale)))>limit:
            lo,hi=0.,scale
            for _ in range(24):
                mid=(lo+hi)/2
                if float(np.max(np.abs(base+part*p.meta['master_gain']*mid)))<=limit:lo=mid
                else:hi=mid
            scale=lo
    part*=scale;digest=hashlib.sha256(part.tobytes()).hexdigest()[:10];identifier='piano_add_'+digest
    file=directory/(identifier+'.wav')
    # Never overwrite audio already referenced by an open project/history.
    with tempfile.NamedTemporaryFile(dir=directory,suffix='.wav',prefix='.piano-',delete=False) as temp:temporary=Path(temp.name)
    try:
        sf.write(temporary,part,sr,subtype='FLOAT');digest=hashlib.sha256(temporary.read_bytes()).hexdigest()
        try:os.link(temporary,file)
        except FileExistsError:
            if hashlib.sha256(file.read_bytes()).hexdigest()!=digest:raise ValueError('已有钢琴候选校验失败，未覆盖')
    finally:temporary.unlink(missing_ok=True)
    metadata={'id':identifier,'label':'新增钢琴','color':'#f1c1dd','file':file.name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),
              'generated':True,'range_seconds':[start,end],'note':'根据估计和声新写的钢琴伴奏，听感待验收'}
    manifest_file=directory/'additional-tracks.json'
    with (directory/'.additional-tracks.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        manifest=json.loads(manifest_file.read_text()) if manifest_file.exists() else {'source_sha256':p.meta['source_sha256'],'tracks':[]}
        if manifest['source_sha256']!=p.meta['source_sha256']:raise ValueError('新增声部与源歌曲不匹配')
        existing=next((m for m in manifest['tracks'] if m['id']==identifier),None)
        ordinal=existing.get('ordinal',1) if existing else max([m.get('ordinal',i+1) for i,m in enumerate(manifest['tracks'])]+[0])+1
        metadata.update(ordinal=ordinal,label=existing['label'] if existing else f'钢琴伴奏 {ordinal}')
        manifest['tracks']=[m for m in manifest['tracks'] if m['id']!=identifier]+[metadata];save_json(manifest_file,manifest)
    sf.write(output/'reference-before.wav',raw[a:b],sr,subtype='PCM_24')
    sf.write(output/'reference-with-piano.wav',(raw+part*p.meta['master_gain'])[a:b],sr,subtype='PCM_24')
    sf.write(output/'piano-only.wav',part[a:b]*p.meta['master_gain'],sr,subtype='PCM_24')
    tonic=NAMES.index(analysis['key_hypothesis'].split()[0]);degrees=['I','bII','II','bIII','III','IV','#IV','V','bVI','VI','bVII','VII']
    def roman(c):
        degree=degrees[(c['root']-tonic)%12]
        return degree.lower() if c['quality']=='minor' else degree
    harmony='| '+' | '.join(roman(c) for c in analysis['chords'])+' |'
    scope=f'{start:g}–{end:g}秒';duration=end-start
    spec={'spec_version':'1.0','meta':{'title':p.state['title']+'：新增钢琴局部验证','style_layer':'mc-style-chinese-pop',
          'key':analysis['key_hypothesis'],'meter':'4/4','tempo':analysis['tempo_estimate'],'target_duration':f'{int(duration//60)}:{duration%60:05.2f}',
          'deliverable':['stems','midi','full_mix'],'upstream':{'brief':f'为当前歌曲{scope}新增钢琴伴奏，原声部与演唱保留'}},
          'intent':{'one_thing':'在原歌中新增可独立编辑的轻钢琴伴奏',
                    'reference_pair':[{'track':p.state['title']+'原始Other '+scope,'borrow':'沿用估计和声，不复制原配器音符'},
                                      {'track':p.state['title']+'原始演唱 '+scope,'borrow':'人声保持前景，钢琴不作主旋律'}],
                    'listener_situation':'桌面工作台中对比原片段与新增钢琴片段','emotional_arc':[{'section':'excerpt','mood':'轻铺底—留白—回归','value':3}]},
          'form':[{'id':'excerpt','name':'Instrumental','start_bar':1,'bars':(end-start)/beat/4,
                   'harmony':harmony,'harmony_letters':'| '+' | '.join(c['chord'] for c in analysis['chords'])+' |','note':'沿用原曲片段；未重新定义原曲曲式'}],
          'arrangement':{'roster':[{'id':identifier,'instrument':'GeneralUser GS Grand Piano','midi':{'program':0,'bank':0,'channel':1},
                                   'role':'和声铺底','band':'中低至中频','entry':f'{start:g}秒','exit':f'{end:g}秒'}],
                         'groove':{'feel':'straight','push_pull':[{'part':identifier,'offset_ms':6,'note':'固定4–11ms轻拖拍'}]},
                         'energy_curve':{'excerpt':'中部减弱后回归'},'subtraction_events':[{'at':{'section':'excerpt','bar_offset':0},'what':'每16个八分格留一个休止','why':'给演唱留空间'}]},
          'checks':{'scope':'single_part_candidate','exemptions':['时长、拍号、调性为局部音频分析候选，不是已验证转谱。',
                      '全曲结构、离调、段落对比及主旋律发展不适用于局部加轨；原曲保持原样。',
                      '参考对为同歌不同声部，不伪造已听辨的外部参考。'],'listening_accepted':False}}
    save_json(output/'ARR-SPEC.json',spec);save_json(output/'voicings.json',voicings)
    audit={'scope':'single newly authored piano part','accepted':False,'compliance_checks':{'notes_stay_in_estimated_chords':all(n['pitch']%12 in next(c['pitch_classes'] for c in analysis['chords'] if c['chord']==n['chord']) for n in notes),
           'notes_stay_in_selected_interval':all(start<=n['start_seconds']<n['end_seconds']<=end for n in notes),
           'nonconstant_velocities':len(set(n['velocity'] for n in notes))>1,'outside_interval_digital_silence':not np.any(part[:a]) and not np.any(part[b:])},
           'ai_tell_audit':{'1':'N/A full-song form unchanged','2':'Measured velocity dip in middle','3':'Enters and exits selected interval',
           '4':'Estimated progression varies; recognition accuracy pending','5':'N/A no drums authored','6':'N/A accompaniment role; no lead hook authored',
           '7':'Velocity varies; listening pending','8':'Fixed small timing offsets recorded in MIDI','9':'N/A full song unchanged',
           '10':'N/A original vocal unchanged','11':'N/A original choruses unchanged','12':'N/A original breath unchanged',
           '13':'N/A no new ad-libs','14':'N/A no new vocal pitch'},'listening_required':['和弦与原声是否相容','拍点/律动是否贴合','音区与演唱是否抢占','音源自然度和混音音量']}
    save_json(output/'audit.json',audit)
    report={'status':'candidate_rendered','track':metadata,'note_count':len(notes),'duration_seconds':len(part)/sr,
            'range_seconds':[start,end],'piano_rms':float(np.sqrt(np.mean(part[a:b]**2))),
            'headroom_scale':scale,'source_project_revision':p.state['revision'],'seconds':round(time.perf_counter()-started,3),
            'musical_acceptance':'pending_human_listening','unchanged_original_tracks':list(p.state['tracks'])}
    save_json(output/'render-report.json',report);return report

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--data-dir',required=True,type=Path)
    parser.add_argument('--start',type=float,default=30);parser.add_argument('--end',type=float,default=45);parser.add_argument('--render',action='store_true');parser.add_argument('--output-dir',type=Path)
    args=parser.parse_args();output=args.output_dir or args.data_dir.parent/'piano-addition';output.mkdir(exist_ok=True,parents=True)
    result=analyze(args.data_dir,args.start,args.end);save_json(output/'analysis.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='chords'},ensure_ascii=False));print([(x['start'],x['chord']) for x in result['chords']])
    if args.render:print(json.dumps(render(args.data_dir,result,output),ensure_ascii=False))
