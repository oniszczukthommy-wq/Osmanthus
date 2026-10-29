"""Source-bound listening choice and shared notation timing, without audio stretching."""
from pathlib import Path
import hashlib,json,math,sys
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from scores import JOBS,valid_id

def selected_rhythm(data,config,context):
    review=config.get('rhythm_review')
    if not review:return None
    if review.get('confirmed_by')!='user' or review.get('confirmation_scope')!='selected_excerpt_beat_and_downbeat':raise ValueError('节拍方案需要明确的试听选择')
    if not valid_id(review['source_score_job_id']):raise ValueError('节拍参考任务无效')
    file=JOBS/review['source_score_job_id']/'score.json'
    if hashlib.sha256(file.read_bytes()).hexdigest()!=review['source_score_sha256']:raise ValueError('节拍参考谱面已改变')
    original=json.loads(file.read_text())
    if any(original.get(k)!=context[k] for k in ('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis')):raise ValueError('节拍方案与当前歌曲不匹配')
    assets={}
    for kind in ('manifest','audio'):
        item=review[kind];name=item['file']
        if Path(name).name!=name:raise ValueError('节拍参考文件名无效')
        path=data/name
        if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('节拍试听参考文件校验失败')
        assets[kind]=path
    manifest=json.loads(assets['manifest'].read_text());choices=[v for v in manifest['variants'] if v['label']==review['selected_label']]
    if len(choices)!=1:raise ValueError('未找到选中的节拍方案')
    choice=choices[0]
    if manifest['source_score_sha256']!=review['source_score_sha256'] or hashlib.sha256((data/'original.wav').read_bytes()).hexdigest()!=manifest['source_audio_sha256']:raise ValueError('节拍试听与原始音频不一致')
    bpm=float(choice['bpm']);downbeat=float(choice['first_downbeat_candidate_seconds'])
    if not math.isfinite(bpm) or not 30<=bpm<=300 or not math.isfinite(downbeat) or downbeat<0 or choice['meter']!='4/4':raise ValueError('当前不支持此节拍方案')
    return {**review,'bpm':bpm,'meter':'4/4','first_downbeat_seconds':downbeat,'excerpt_range_seconds':choice['source_range_seconds'],'whole_score_accuracy_accepted':False}

def notation_origin(rhythm,first_note):
    if rhythm is None:return 0.
    origin=rhythm['first_downbeat_seconds'];bar=240/rhythm['bpm']
    # A lead-vocal score may omit the initial partial instrumental bar. If a
    # vocal occurs there, include its preceding full bar instead of dropping it.
    if first_note<origin:origin-=math.ceil((origin-first_note)/bar)*bar
    return origin

def _quantize_span(start,end,bpm,origin,previous,step):
    left=(start-origin)*bpm/60;right=(end-origin)*bpm/60
    center_left=round(left/step);center_right=round(right/step);candidates=[]
    for i in range(center_left-1,center_left+2):
        a=i*step
        if a<previous-1e-8 or a<0:continue
        for j in range(center_right-1,center_right+2):
            b=j*step
            if b<=a:continue
            cost=(a-left)**2+(b-right)**2+2*((b-a)-(right-left))**2
            candidates.append((cost,a,b))
    if not candidates:
        a=max(previous,max(0,round(left/step)*step));return a,max(a+step,round(right/step)*step),step
    _,a,b=min(candidates);return a,b,step

def quantize_span(start,end,bpm,origin,previous,quantum):
    step=quantum/2 if end-start<.08 else quantum
    a,b,step=_quantize_span(start,end,bpm,origin,previous,step)
    error=max(abs(origin+a*60/bpm-start),abs(origin+b*60/bpm-end))
    ratio=(b-a)*60/bpm/(end-start)
    if step==quantum and (error>.065 or ratio>1.8 or ratio<.55):
        return _quantize_span(start,end,bpm,origin,previous,quantum/2)
    return a,b,step

def units(duration):
    if duration in (.0625,.09375,.125,.1875,.25,.375,.5,.75,1,1.5):return [duration]
    return [1]*int(duration)+([round(duration%1,6)] if duration%1 else []) if duration>=1 else [duration]

def beams(duration):
    return 4 if duration<=.09375 else 3 if duration<=.1875 else 2 if duration<=.375 else 1 if duration<=.75 else 0

def dotted(duration):return duration in (.09375,.1875,.375,.75,1.5)

def visual_slots(bar,width,minimum):
    """Reserve readable glyph spacing without changing any musical duration."""
    base=[minimum*len(units(item['duration'])) for item in bar]
    if sum(base)>width:raise ValueError('本小节符号过密，需要更宽的谱面')
    remaining=width-sum(base);result=[];cursor=0.
    for item,reserved in zip(bar,base):
        span=reserved+remaining*item['duration']/4
        result.append((cursor,span));cursor+=span
    return result

def unit_positions(duration,width,minimum):
    values=units(duration);extra=width-minimum*len(values);cursor=0.;result=[]
    for value in values:
        result.append(cursor);cursor+=minimum+extra*value/duration
    return result
