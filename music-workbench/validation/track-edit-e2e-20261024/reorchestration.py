"""Revoice a known authored piano harmony as playable, strummed guitar.

This does not transcribe separated audio. Source harmony remains a hypothesis
from runtime_support import file_lock as fcntl
from the original piano job. MIDI/string constraints are measured separately
from the human listening verdict.
"""
from copy import deepcopy
from pathlib import Path
import hashlib, itertools, json, os, subprocess, tempfile, time
import numpy as np
import soundfile as sf
from project import Project, ROOT, save_json

TUNING=[40,45,50,55,59,64]  # sounding MIDI E2 A2 D3 G3 B3 E4

def source_job(project, track_id):
    if not isinstance(track_id,str) or track_id not in project.state['tracks'] or project.state['tracks'][track_id].get('removed'):raise ValueError('请先把新编钢琴加入工程，再选中它重新编配')
    meta=next((t for t in project.meta['tracks'] if t['id']==track_id),None)
    if not meta or not meta.get('generated') or not track_id.startswith('piano_add_'):
        raise ValueError('本次重新编配支持已加入的新编钢琴；原歌曲分离音频尚未通过准确转谱验收')
    for file in sorted((ROOT/'arrangement-jobs').glob('*/state.json')):
        state=json.loads(file.read_text())
        if (state.get('stage')=='ready' and state.get('project_id')==project.state['id'] and
            state.get('result',{}).get('track',{}).get('sha256')==meta['sha256'] and
            state.get('result',{}).get('track',{}).get('id')==track_id and
            (file.parent/'analysis.json').exists() and (file.parent/'notes.json').exists()):
            return meta,state,file.parent
    raise ValueError('找不到这条钢琴的符号编配记录，未用音频猜测冒充重新编配')

def voicing(section, previous=None):
    pcs=set(section['pitch_classes']);options=[]
    # 4–6 contiguous strings, <=4 fretted strings, <=3 fret hand span.
    for bottom in (0,1,2):
        choices=[[f for f in range(13) if (TUNING[s]+f)%12 in pcs] for s in range(bottom,6)]
        for frets in itertools.product(*choices):
            pitches=[TUNING[s]+f for s,f in zip(range(bottom,6),frets)]
            positive=[f for f in frets if f]
            if len(positive)>4 or positive and max(positive)-min(positive)>3:continue
            if set(p%12 for p in pitches)!=pcs or pitches[0]%12!=section['root']:continue
            if any(a>=b for a,b in zip(pitches,pitches[1:])):continue
            position=min(positive) if positive else 0
            cost=position*.7+sum(frets)*.06+abs(np.mean(pitches)-58)*.1
            if previous:cost+=abs(position-previous['position'])*.7
            options.append((cost,{'strings':list(range(bottom,6)),'frets':list(frets),'pitches':pitches,'position':position}))
    if not options:raise ValueError('该和弦暂未找到符合本轮吉他指法约束的排列，停止生成')
    return min(options,key=lambda v:v[0])[1]

def author(analysis,start,end):
    beat=60/analysis['tempo_estimate'];phase=analysis['beat_phase_seconds'];notes=[];shapes=[];previous=None
    for chord in analysis['chords']:
        left,right=max(start,chord['start']),min(end,chord['end'])
        if left>=right:continue
        shape=voicing(chord,previous);previous=shape;shapes.append({**chord,**shape,'start':left,'end':right})
        first=int(np.ceil((left-phase)/(beat/2)-1e-7));last=int(np.ceil((right-phase)/(beat/2)-1e-7))
        ticks=list(range(first,last))
        # Explicit pickup if the selection begins between the original beats.
        events=[(phase+tick*beat/2,tick) for tick in ticks if tick%8 in (0,3,4,5,7)]
        if not events or events[0][0]>left+beat*.7:events.insert(0,(left,first))
        for at,tick in events:
            upward=tick%8 in (3,5,7);strings=list(zip(shape['strings'],shape['frets'],shape['pitches']))
            if upward:strings=list(reversed(strings[-3:]))
            for i,(string,fret,pitch) in enumerate(strings):
                onset=at+.008+i*.009
                off=min(right-.012,end-.02,onset+beat*(.52 if upward else .88))
                if off-onset<.025:continue
                dip=.82 if .42<(at-start)/(end-start)<.64 else 1
                velocity=round((52 if upward else 65)*dip-i*2)
                notes.append({'start_seconds':onset,'end_seconds':off,'pitch':pitch,'velocity':velocity,
                              'chord':chord['chord'],'string':string,'fret':fret,'stroke':'up' if upward else 'down'})
    notes.sort(key=lambda n:(n['start_seconds'],n['string']))
    # A string cannot sustain two fretted notes simultaneously.
    for string in range(6):
        line=[n for n in notes if n['string']==string]
        for a,b in zip(line,line[1:]):a['end_seconds']=min(a['end_seconds'],b['start_seconds']-.002)
    return [n for n in notes if n['end_seconds']>n['start_seconds']],shapes

def synthesize(notes,tempo,output,name,string_channels=False):
    import mido
    midi=mido.MidiFile(ticks_per_beat=960);track=mido.MidiTrack();midi.tracks.append(track)
    microseconds=mido.bpm2tempo(tempo)
    track.extend([mido.MetaMessage('track_name',name=name),mido.MetaMessage('set_tempo',tempo=microseconds)])
    for channel in range(6 if string_channels else 1):track.append(mido.Message('program_change',channel=channel,program=25))
    events=[]
    for n in notes:
        channel=n['string'] if string_channels else 0
        for at,on in ((n['start_seconds'],True),(n['end_seconds'],False)):
            events.append((round(mido.second2tick(at,960,microseconds)),on,n['pitch'],n['velocity'],channel))
    previous=0
    for tick,on,pitch,velocity,channel in sorted(events,key=lambda e:(e[0],e[1])):
        track.append(mido.Message('note_on' if on else 'note_off',channel=channel,note=pitch,velocity=velocity if on else 0,time=tick-previous));previous=tick
    midi.save(output/(name+'.mid'))
    result=subprocess.run([str(ROOT.parent/'audio-runtime/env/bin/fluidsynth'),'-ni','-g','0.6','-o','synth.reverb.active=0','-o','synth.chorus.active=0',
        '-F',str(output/(name+'.wav')),'-r','44100',str(ROOT.parent/'instrument-generaluser/GeneralUser-GS.sf2'),str(output/(name+'.mid'))],capture_output=True,timeout=60)
    if result.returncode:raise ValueError('吉他音源渲染失败')
    return sf.read(output/(name+'.wav'),dtype='float32',always_2d=True)

def render(directory,state,output):
    started=time.perf_counter();p=Project(directory);source=state['source_track_id']
    meta,_,job=source_job(p,source)
    if meta['sha256']!=state['source_track_sha256'] or p.state['tracks'][source]!=state['source_track_state']:
        raise ValueError('源钢琴已发生变化，请按当前状态重新生成候选')
    analysis=json.loads((job/'analysis.json').read_text());start,end=state['start_seconds'],state['end_seconds']
    oldnotes=[{**n,'start_seconds':max(start,n['start_seconds']),'end_seconds':min(end,n['end_seconds'])}
              for n in json.loads((job/'notes.json').read_text()) if n['start_seconds']<end and n['end_seconds']>start]
    notes,shapes=author(analysis,start,end)
    if not notes or not oldnotes:raise ValueError('所选区间没有可重新编配的符号内容')
    save_json(output/'analysis.json',analysis);save_json(output/'source-notes.json',oldnotes);save_json(output/'notes.json',notes);save_json(output/'guitar-fingerings.json',shapes)
    a,b=round(start*p.sr),round(end*p.sr);source_audio=p.audio[source];target_rms=float(np.sqrt(np.mean(source_audio[a:b]**2)))
    if target_rms<1e-7:raise ValueError('选区钢琴音量过低，无法进行有效对比')
    def prepare(items,name,channels=False):
        audio,sr=synthesize(items,analysis['tempo_estimate'],output,name,channels)
        if sr!=p.sr:raise ValueError('音源采样率与工程不一致')
        part=np.zeros_like(source_audio);count=min(len(part),len(audio));part[:count]=audio[:count];part[:a]=0;part[b:]=0
        fade=min(round(.03*sr),(b-a)//2);part[a:a+fade]*=np.linspace(0,1,fade)[:,None];part[b-fade:b]*=np.linspace(1,0,fade)[:,None]
        rms=float(np.sqrt(np.mean(part[a:b]**2)))
        if rms<1e-9:raise ValueError('吉他渲染为空')
        return part*(target_rms/rms)
    timbre=prepare(oldnotes,'timbre-only');part=prepare(notes,'guitar-rearranged',True)
    # Match the canonical reducer's 5ms internal fade when replacing the old part.
    baseline=p.mix();old=p.render_track(source);gain=10**(state['source_track_state']['gain_db']/20)*p.meta['master_gain']
    audible=not state['source_track_state']['muted'] and (not any(t['solo'] for t in p.state['tracks'].values() if not t.get('removed')) or state['source_track_state']['solo'])
    oldenv=p.envelope(source);p.state['tracks'][source]['segments'].append({'start_frame':a,'end_frame':b,'gain':0})
    kept=p.render_track(source);p.state['tracks'][source]=deepcopy(state['source_track_state'])
    additions=[part,timbre];scale=1.
    if audible:
        for candidate in additions:
            for _ in range(32):
                mixed=baseline+(kept-old+candidate*oldenv[:,None]*scale)*gain
                if float(np.max(np.abs(mixed)))<=max(.98,float(np.max(np.abs(baseline)))):break
                scale*=.90
    part*=scale;timbre*=scale
    checks={'all_notes_in_harmony':all(n['pitch']%12 in next(c['pitch_classes'] for c in analysis['chords'] if c['chord']==n['chord']) for n in notes),
            'string_tuning_exact':all(n['pitch']==TUNING[n['string']]+n['fret'] for n in notes),
            'bounded_hand_span':all(max([f for f in s['frets'] if f] or [0])-min([f for f in s['frets'] if f] or [0])<=3 for s in shapes),
            'at_most_four_fretted_strings':all(sum(f>0 for f in s['frets'])<=4 for s in shapes),
            'no_string_overlap':all(a['end_seconds']<=b['start_seconds'] for s in range(6) for a,b in zip([n for n in notes if n['string']==s],[n for n in notes if n['string']==s][1:])),
            'changed_note_events':[(n['start_seconds'],n['pitch']) for n in notes]!=[(n['start_seconds'],n['pitch']) for n in oldnotes],
            'inside_selection':all(start<=n['start_seconds']<n['end_seconds']<=end for n in notes),
            'zero_audio_outside_selection':not np.any(part[:a]) and not np.any(part[b:])}
    if not all(checks.values()):raise ValueError('重新编配约束校验未通过')
    identifier='guitar_arr_'+hashlib.sha256((state['source_track_sha256']+json.dumps(state['source_track_state'],sort_keys=True)).encode()+part.tobytes()).hexdigest()[:10]
    file=directory/(identifier+'.wav')
    with tempfile.NamedTemporaryFile(dir=directory,suffix='.wav',delete=False) as handle:temp=Path(handle.name)
    try:
        sf.write(temp,part,p.sr,subtype='FLOAT');digest=hashlib.sha256(temp.read_bytes()).hexdigest()
        try:os.link(temp,file)
        except FileExistsError:
            if hashlib.sha256(file.read_bytes()).hexdigest()!=digest:raise ValueError('候选文件冲突，未覆盖已有音频')
    finally:temp.unlink(missing_ok=True)
    metadata={'id':identifier,'label':'木吉他重新编配','color':'#d3b58e','file':file.name,'sha256':digest,'generated':True,
              'instrument':'acoustic_guitar','operation':'reorchestrate','range_seconds':[start,end],
              'replaces_track_id':source,'source_track_sha256':meta['sha256'],'source_track_state':state['source_track_state'],
              'note':'沿用新编钢琴的和声记录，按六弦指法、上下扫弦重新编配；原曲和声识别与听感仍待验收'}
    manifest_file=directory/'additional-tracks.json'
    with (directory/'.additional-tracks.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX);manifest=json.loads(manifest_file.read_text())
        if manifest['source_sha256']!=p.meta['source_sha256']:raise ValueError('候选与歌曲来源不一致')
        existing=next((m for m in manifest['tracks'] if m['id']==identifier),None)
        ordinal=existing.get('ordinal',1) if existing else max([m.get('ordinal',i+1) for i,m in enumerate(manifest['tracks'])]+[0])+1
        metadata.update(ordinal=ordinal,label=existing['label'] if existing else f'木吉他编配 {ordinal}')
        manifest['tracks']=[m for m in manifest['tracks'] if m['id']!=identifier]+[metadata];save_json(manifest_file,manifest)
    def mix(candidate):return baseline+(kept-old+candidate*oldenv[:,None])*gain if audible else baseline.copy()
    for name,audio in [('A-piano',baseline),('B-timbre-only',mix(timbre)),('C-guitar-rearranged',mix(part)),
                       ('piano-only',old*gain),('guitar-only',part*oldenv[:,None]*gain),('timbre-only-isolated',timbre*oldenv[:,None]*gain)]:
        sf.write(output/(name+'.wav'),audio[a:b],p.sr,subtype='PCM_24')
    spec=json.loads((job/'ARR-SPEC.json').read_text());spec['intent']['one_thing']='保留原钢琴和声伴奏功能，改写成木吉他扫弦，原演唱、鼓贝斯及其他轨道保持不变'
    spec['arrangement']['roster']=[{'id':identifier,'instrument':'GeneralUser GS steel-string guitar','midi':{'program':25,'bank':0,'channel':1},
        'string_channels':[1,2,3,4,5,6],'role':'和声伴奏','register_sounding_midi':[min(n['pitch'] for n in notes),max(n['pitch'] for n in notes)],'technique':'六弦标准定弦；连续4–6弦，根音最低；最多4根按品弦；按品跨度≤3；下扫+上扫，逐弦9ms',
        'entry':start,'exit':end}]
    spec['meta'].update(title=p.state['title']+'：钢琴改编木吉他',target_duration=f'{end-start:.2f} seconds')
    spec['meta']['upstream']['brief']=f'将{source}的{start:g}–{end:g}秒改编为木吉他扫弦，保留和声与其他声部'
    spec['form'][0].update(bars=(end-start)/(60/analysis['tempo_estimate'])/4,harmony_letters='| '+' | '.join(c['chord'] for c in shapes)+' |')
    from piano_arrangement import NAMES
    tonic=NAMES.index(analysis['key_hypothesis'].split()[0]);degrees=['I','bII','II','bIII','III','IV','#IV','V','bVI','VI','bVII','VII']
    def degree(c):
        value=degrees[(c['root']-tonic)%12]
        return value.lower() if c['quality']=='minor' else value
    spec['form'][0]['harmony']='| '+' | '.join(degree(c) for c in shapes)+' |'
    spec['arrangement']['groove']={'feel':'straight strummed accompaniment','push_pull':[{'part':identifier,'offset_ms':8,'note':'每次扫弦开始拖8ms，逐弦再错开9ms'}]}
    spec['checks']['listening_accepted']=False;spec['checks']['exemptions'].append('局部重新编配，沿用源候选的未校准和声/拍点假设；不是原歌曲音频准确转谱。')
    save_json(output/'ARR-SPEC.json',spec)
    audit={'compliance_checks':checks,'accepted':False,'ai_tell_audit':{str(i):'N/A original song unchanged' for i in range(1,15)},
           'listening_required':['和声是否相容','扫弦律动是否贴合','是否抢人声','采样音色是否自然','原钢琴是否正确替换'],
           'note':'No human quality verdict or fabricated AI-tell score.'}
    audit['ai_tell_audit'].update({'2':'Velocity dip in middle; actual energy/listening pending','3':'Enters/exits selection','7':'Velocity varied, RMS comparison aligned; naturalness pending','8':'8ms laid-back stroke plus 9ms string spread, not random jitter'})
    save_json(output/'audit.json',audit)
    if not all(checks.values()):raise ValueError('重新编配约束校验未通过')
    report={'status':'candidate_rendered','track':metadata,'note_count':len(notes),'source_note_count':len(oldnotes),'headroom_scale':scale,
            'source_job_id':job.name,'range_seconds':[start,end],'seconds':round(time.perf_counter()-started,3),'musical_acceptance':'pending_human_listening'}
    save_json(output/'render-report.json',report);return report
