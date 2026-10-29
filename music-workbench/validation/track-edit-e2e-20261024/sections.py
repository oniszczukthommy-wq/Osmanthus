"""Source-bound section/lyric navigation; candidates are not claimed music analysis.

No synthesis or alignment is started here. Human boundary corrections are separate
metadata and never mutate the mixer, waveform files, or its audio revision.
"""
from __future__ import annotations
from collections import Counter
from copy import deepcopy
from pathlib import Path
import fcntl, hashlib, json, math, re, threading, time
from project import ROOT, save_json

ENGINE = 'lyric-anchored-sections-1'
SOURCE_KEYS = ('project_id', 'source_sha256', 'vocal_sha256', 'lyrics_sha256', 'basis')
NAMES = {'song':'整首歌词','intro':'前奏','verse':'主歌','pre_chorus':'预副歌',
         'chorus':'副歌','post_chorus':'后副歌','bridge':'桥段','break':'间奏',
         'instrumental':'间奏','solo':'独奏段','outro':'尾奏','transition':'过渡段',
         'hook':'Hook段','build_up':'铺垫段'}
ALIASES = {'前奏':{'intro'}, '主歌':{'verse'}, '预副歌':{'pre_chorus'},
           '导歌':{'pre_chorus'}, '副歌':{'chorus'}, '后副歌':{'post_chorus'},
           '桥段':{'bridge'}, '间奏':{'break','instrumental'}, '独奏段':{'solo'},
           '尾奏':{'outro'}, '尾声':{'outro'}, '过渡段':{'transition'}}
INSTRUMENTAL = {'intro','outro','break','instrumental','solo','transition'}
NUM = r'[0-9零〇一二两三四五六七八九十百]+'

def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def normalized(text):
    return ''.join(c for c in str(text) if c.isalnum()).lower()

def number(text):
    if text.isdigit():return int(text)
    digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
    if text in digits:return digits[text]
    if '百' in text:
        a,b=text.split('百',1);return (digits.get(a,1)*100)+(number(b.lstrip('零')) if b.lstrip('零') else 0)
    if '十' in text:
        a,b=text.split('十',1);return digits.get(a,1)*10+(digits.get(b,0) if b else 0)
    raise ValueError('序号无法识别')

def finite(value):
    if isinstance(value,bool):raise ValueError('时间须为有限数字')
    try:value=float(value)
    except (TypeError,ValueError):raise ValueError('时间须为有限数字') from None
    if not math.isfinite(value):raise ValueError('时间须为有限数字')
    return value

def tag_name(value):
    value=re.sub(r'\s*\d+\s*$','',value.strip()).lower().replace('-','_')
    value=re.sub(r'\s+','_',value)
    aliases={'inst':'instrumental','interlude':'instrumental','前奏':'intro','主歌':'verse',
             '副歌':'chorus','桥段':'bridge','间奏':'instrumental','尾奏':'outro','预副歌':'pre_chorus'}
    return aliases.get(value,value)

def lyric_structure(lyrics):
    """Keep the exact non-tag line indexing used by lyrics.py."""
    sections=[];lines=[];counts=Counter()
    for raw in str(lyrics).splitlines():
        line=raw.strip()
        if not line:continue
        if line.startswith('['):
            match=re.fullmatch(r'\[([^\]]+)\]',line)
            if not match:continue
            raw_tag=match[1];tag=tag_name(raw_tag);counts[tag]+=1
            identifier=f'{tag}-{counts[tag]}' if re.fullmatch(r'[a-z_]+',tag) else f'section-{len(sections)+1}'
            sections.append({'id':identifier,'tag':tag,'raw_tag':raw_tag,'occurrence':counts[tag],
                             'label':f'{NAMES.get(tag,raw_tag)} {counts[tag]}','line_indices':[],
                             'position':len(sections),'kind':'vocal' if tag not in INSTRUMENTAL else 'instrumental_gap'})
        else:
            if not sections:
                counts['song']+=1;sections.append({'id':'song-1','tag':'song','raw_tag':'song','occurrence':1,
                  'label':'整首歌词','line_indices':[],'position':0,'kind':'vocal'})
            sections[-1]['line_indices'].append(len(lines));lines.append({'index':len(lines),'text':line})
    return sections,lines

def build_sections(lyrics,aligned_lines,duration):
    """Anchor lyric tags to measured singing, never evenly divide the song."""
    duration=finite(duration)
    if duration<=0:raise ValueError('歌曲时长无效')
    sections,lines=lyric_structure(lyrics);warnings=[];by_index={}
    if aligned_lines:
        expected={v['index'] for v in lines if normalized(v['text'])};previous=0.
        try:
            for position,item in enumerate(aligned_lines):
                index=item['index']
                if position>=len(expected) or index!=sorted(expected)[position]:raise ValueError('歌词行顺序与原文不一致')
                if isinstance(index,bool) or not isinstance(index,int) or index not in expected or index in by_index:raise ValueError('歌词行号与原文不一致')
                if normalized(item['text'])!=normalized(lines[index]['text']):raise ValueError('歌词时间与原文不一致')
                a,b=finite(item.get('start',item.get('start_seconds'))),finite(item.get('end',item.get('end_seconds')))
                if not 0<=a<b<=duration+.05 or a<previous-.020001:raise ValueError('歌词时间顺序或范围无效')
                previous=b;by_index[index]={'start_seconds':round(a,6),'end_seconds':round(min(b,duration),6)}
            if set(by_index)!=expected:raise ValueError('歌词时间未完整覆盖原文')
        except (KeyError,TypeError,ValueError) as exc:
            by_index={};warnings.append(f'歌词定位不可用：{exc}；未据此推断段落')
    for section in sections:
        expected=[i for i in section['line_indices'] if normalized(lines[i]['text'])]
        matched=[by_index[i] for i in expected if i in by_index]
        a=matched[0]['start_seconds'] if matched and len(matched)==len(expected) else None
        b=matched[-1]['end_seconds'] if a is not None else None
        section.update(start_seconds=a,end_seconds=b,vocal_start_seconds=a,vocal_end_seconds=b,
                       confirmed=False,manual=False,boundary_source='actual_vocal_alignment_candidate' if a is not None else 'unlocated',
                       boundary_note='歌词实际演唱范围；乐段切点仍为候选' if a is not None else '等待实际演唱时间，未平均分配歌曲')
    # One empty instrumental tag between measured vocal anchors has an estimated
    # gap. Multiple consecutive empty tags cannot be reliably partitioned.
    for index,section in enumerate(sections):
        if section['line_indices'] or section['tag'] not in INSTRUMENTAL:continue
        left=next((x for x in reversed(sections[:index]) if x['line_indices']),None)
        right=next((x for x in sections[index+1:] if x['line_indices']),None)
        left_pos=left['position'] if left else -1;right_pos=right['position'] if right else len(sections)
        empties=[x for x in sections[left_pos+1:right_pos] if not x['line_indices']]
        if len(empties)!=1 or not by_index:continue
        a=left['end_seconds'] if left else 0.;b=right['start_seconds'] if right else duration
        if a is None or b is None or b-a<=.05:continue
        section.update(start_seconds=a,end_seconds=b,boundary_source='lyric_gap_candidate',
                       boundary_note='由相邻演唱之间的间隙估计，尚未确认真实乐段边界')
    for line in lines:
        section=next(s for s in sections if line['index'] in s['line_indices'])
        line.update(section_id=section['id'],section_label=section['label'],**by_index.get(line['index'],{'start_seconds':None,'end_seconds':None}))
    if sections and not by_index:warnings.append('演唱时间未就绪；可继续使用秒数选区，段落和歌词定位暂不可用')
    return sections,lines,warnings

def score_grid(score):
    unavailable={'status':'unavailable','confirmed':False,'reason':'尚无已核对的整曲拍点；保留秒数与歌词定位'}
    if not isinstance(score,dict):return unavailable
    review=score.get('rhythm_review') or {}
    try:
        bpm=finite(score.get('bpm'));origin=finite(score.get('notation_origin_seconds',review.get('first_downbeat_seconds')))
        if not 30<=bpm<=300 or origin<0 or score.get('meter')!='4/4':return unavailable
    except ValueError:return unavailable
    confirmed=(score.get('tempo_meter_key_accepted') is True and review.get('confirmed_by')=='user' and
               review.get('confirmation_scope')=='whole_song_beat_and_downbeat')
    return {'status':'confirmed' if confirmed else 'candidate','confirmed':confirmed,'bpm':bpm,'meter':'4/4',
            'first_downbeat_seconds':origin,'validation_scope':review.get('confirmation_scope','unreviewed'),
            'reason':'整曲拍点与小节起点已明确确认' if confirmed else 'BPM/小节起点仅为候选或局部试听结果，暂不据此执行小节定位'}

class Sections:
    def __init__(self,inputs_provider=None):
        self.inputs_provider=inputs_provider;self.lock=threading.RLock()

    def _inputs(self,directory):
        if self.inputs_provider:return deepcopy(self.inputs_provider(Path(directory)))
        from lyrics import Lyrics
        from scores import Scores
        directory=Path(directory);meta=json.loads((directory/'preparation.json').read_text())
        current=Lyrics().latest(directory);context={k:current[k] for k in SOURCE_KEYS}
        job=current.get('job');ready=bool(job and job.get('stage')=='ready')
        if ready and any(job.get(k)!=context[k] for k in ('project_id','vocal_sha256','lyrics_sha256','basis')):raise ValueError('歌词定位与当前人声来源不一致')
        score=None
        manager=Scores();candidate=manager.latest(directory)
        if candidate and candidate.get('stage')=='ready':
            try:
                proposed=json.loads(manager.asset(candidate['id'],'score.json').read_text())
                if all(proposed.get(k)==context[k] for k in SOURCE_KEYS):score=proposed
            except (OSError,ValueError,KeyError):pass
        return {'context':context,'lyrics':current['lyrics'],'duration':meta['duration_seconds'],
                'aligned_lines':job.get('lines',[]) if ready else [],
                'timing':{'status':'ready' if ready else (job.get('stage','unavailable') if job else 'unavailable'),
                          'job_id':job.get('id') if job else None,'method':job.get('method') if job else None},
                'grid':score_grid(score)}

    @staticmethod
    def _record(directory,project_id):
        file=Path(directory)/'section-boundaries.json'
        if not file.exists():return {'schema_version':1,'project_id':project_id,'revision':0,'contexts':{},'history':[]}
        try:
            value=json.loads(file.read_text())
            if value.get('schema_version')!=1 or value.get('project_id')!=project_id:raise ValueError('段落校订来源不一致')
            if isinstance(value.get('revision'),bool) or not isinstance(value.get('revision'),int) or value['revision']<0:raise ValueError('段落版本无效')
            if not isinstance(value.get('contexts'),dict) or not isinstance(value.get('history'),list):raise ValueError('段落校订格式无效')
            for context in value['contexts'].values():
                if not isinstance(context,dict) or not isinstance(context.get('source'),dict) or not isinstance(context.get('boundaries'),dict):raise ValueError('段落校订内容无效')
                if any(not isinstance(v,dict) or v.get('confirmed_by')!='user' for v in context['boundaries'].values()):raise ValueError('段落确认记录无效')
            return value
        except (OSError,ValueError,TypeError,AttributeError) as exc:raise ValueError('段落校订文件无法读取，未覆盖原有校订') from exc

    def _view(self,inputs,record):
        context={k:inputs['context'][k] for k in SOURCE_KEYS};duration=finite(inputs['duration'])
        if hashlib.sha256(inputs['lyrics'].strip().encode()).hexdigest()!=context['lyrics_sha256']:raise ValueError('原始歌词指纹不一致')
        sections,lines,warnings=build_sections(inputs['lyrics'],inputs.get('aligned_lines',[]),duration)
        content=digest({'engine':ENGINE,**context});manual=record['contexts'].get(content,{})
        if manual and manual.get('source')!=context:raise ValueError('段落校订与当前源指纹不一致')
        for section in sections:
            changed=manual.get('boundaries',{}).get(section['id'])
            if changed:
                a,b=finite(changed['start_seconds']),finite(changed['end_seconds'])
                if not 0<=a<b<=duration:raise ValueError('已保存段落边界超出当前歌曲')
                section.update(start_seconds=a,end_seconds=b,confirmed=True,manual=True,
                               boundary_source='manual_confirmed',boundary_note='已由用户校正段落边界')
        grid=deepcopy(inputs.get('grid') or score_grid(None))
        source=digest({'content':content,'timing':inputs.get('timing'),
                       'lines':[(l['index'],l['start_seconds'],l['end_seconds']) for l in lines],'grid':grid})
        navigation=digest({'source':source,'revision':record['revision'],'ranges':[(s['id'],s['start_seconds'],s['end_seconds']) for s in sections]})
        return {'schema_version':1,'engine':ENGINE,**context,'duration':duration,'content_fingerprint':content,
                'sections_revision':record['revision'],'source_fingerprint':source,'navigation_fingerprint':navigation,
                'stage':'ready' if any(s['start_seconds'] is not None for s in sections) else 'awaiting_alignment',
                'timing':deepcopy(inputs.get('timing',{})),'sections':sections,'lines':lines,'grid':grid,
                'warnings':warnings,'accuracy_note':'歌词标签与对齐给出候选范围，不代表自动识别了精确曲式；人工校正不修改音频'}

    def get(self,directory):
        inputs=self._inputs(directory);record=self._record(directory,inputs['context']['project_id'])
        return self._view(inputs,record)

    def update(self,directory,body):
        directory=Path(directory)
        with self.lock:
            with (directory/'.section-boundaries.lock').open('a') as guard:
                fcntl.flock(guard,fcntl.LOCK_EX)
                inputs=self._inputs(directory);record=self._record(directory,inputs['context']['project_id']);view=self._view(inputs,record)
                if body.get('project_id')!=view['project_id']:raise RuntimeError('歌曲已切换，请重新选择段落')
                revision=body.get('sections_revision')
                if isinstance(revision,bool) or not isinstance(revision,int) or revision!=view['sections_revision'] or body.get('source_fingerprint')!=view['source_fingerprint']:
                    raise RuntimeError('歌曲对齐或段落版本已变化，请刷新后重新校正')
                section=next((s for s in view['sections'] if s['id']==body.get('section_id')),None)
                if section is None:raise ValueError('段落标识无效')
                context=record['contexts'].setdefault(view['content_fingerprint'],{'source':{k:view[k] for k in SOURCE_KEYS},'boundaries':{}})
                previous=deepcopy(context['boundaries'].get(section['id']));action=body.get('action','set')
                if action=='reset':context['boundaries'].pop(section['id'],None);changed=None
                elif action=='set':
                    if body.get('confirmed') is not True:raise ValueError('保存段落边界需要明确确认')
                    a,b=finite(body.get('start_seconds')),finite(body.get('end_seconds'))
                    if not 0<=a<b<=view['duration']:raise ValueError('段落边界须在本歌曲时长内，且开始早于结束')
                    a,b=round(a,6),round(b,6)
                    if a>=b:raise ValueError('段落范围过短，无法保存此时间精度')
                    changed={'start_seconds':a,'end_seconds':b,'confirmed_by':'user','updated_at':time.time()}
                    context['boundaries'][section['id']]=changed
                else:raise ValueError('不支持的段落操作')
                record['revision']+=1;record['history'].append({'revision':record['revision'],'content_fingerprint':view['content_fingerprint'],
                    'section_id':section['id'],'action':action,'before':previous,'after':changed,'at':time.time()})
                save_json(directory/'section-boundaries.json',record)
                return self._view(inputs,record)


def _guard(view):
    return {k:view[k] for k in ('project_id','source_fingerprint','sections_revision','navigation_fingerprint')}

def _resolved(view,start,end,kind,label,**details):
    if start is None or end is None:return {'status':'unavailable','reason':'该段落或歌词尚无可靠时间，请先用秒数定位','selection_guard':_guard(view)}
    start,end=finite(start),finite(end)
    if not 0<=start<end<=finite(view['duration']):return {'status':'unavailable','reason':'定位范围超出当前歌曲','selection_guard':_guard(view)}
    return {'status':'resolved','kind':kind,'label':label,'start_seconds':start,'end_seconds':end,'selection_guard':_guard(view),**details}

def _choices(values):
    return [{k:v.get(k) for k in ('id','label','start_seconds','end_seconds','confirmed')} for v in values]

def _section_request(text,sections):
    found=[]
    # Match longer names first so pre/post-chorus is not also called chorus.
    occupied=[]
    for alias in sorted(ALIASES,key=len,reverse=True):
        for match in re.finditer(re.escape(alias),text):
            if any(match.start()<b and match.end()>a for a,b in occupied):continue
            occupied.append((match.start(),match.end()));candidates=[s for s in sections if s['tag'] in ALIASES[alias]]
            prefix=text[max(0,match.start()-10):match.start()];suffix=text[match.end():match.end()+10]
            ordinal=re.search(r'第\s*('+NUM+r')\s*(?:次|遍|段|个|回)?\s*$',prefix)
            if not ordinal:ordinal=re.match(r'\s*(?:的)?第\s*('+NUM+r')\s*(?:次|遍|段|个|回)?',suffix)
            if not ordinal:ordinal=re.match(r'\s*([0-9]+)(?:次|遍|段|个|回)?',suffix)
            last=bool(re.search(r'最后(?:一(?:次|遍|段|个))?(?:的)?\s*$',prefix))
            if ordinal:
                try:index=number(ordinal.group(1))-1
                except ValueError:index=-1
                chosen=[candidates[index]] if 0<=index<len(candidates) else []
                found.append((alias,chosen,True,candidates))
            elif last:found.append((alias,candidates[-1:] if candidates else [],True,candidates))
            else:found.append((alias,candidates,False,candidates))
    return found

def _resolve_reference(message,view):
    """Deterministic explicit selection only; ambiguity never becomes whole-song edit."""
    text=str(message).strip()
    if not text:return {'status':'not_found'}
    if re.search(r'(?:最后一句|第'+NUM+r'句).{0,4}(?:后面|后边|之后|前面|之前)',text):
        return {'status':'ambiguous','reason':'歌词之外的位置没有明确终点，请选择一个秒数区间','selection_guard':_guard(view)}
    if re.search(r'[”」\"\']\s*(?:这句)?(?:的)?(?:后面|之后|后边|前面|之前)',text):
        return {'status':'ambiguous','reason':'请给出这句歌词前后要修改的具体秒数区间，未选中歌词本身','selection_guard':_guard(view)}
    if '倒数' in text and (any(alias in text for alias in ALIASES) or '句' in text):
        return {'status':'ambiguous','reason':'倒数表达暂不自动换算，请选具体段落或歌词序号','selection_guard':_guard(view)}
    if re.search(r'第'+NUM+r'(?:次|遍|段|个|回)?\s*(?:和|及|、|或|/|到|至)\s*第?'+NUM+r'(?:次|遍|段|个|回)?\s*(?:副歌|主歌|桥段|间奏)',text):
        return {'status':'ambiguous','reason':'这句话指定了多个段落，请一次选择一个连续区间','selection_guard':_guard(view)}
    sections=view.get('sections',[]);requests=_section_request(text,sections)
    if len(requests)>1:
        # Repeating the same label once in a request is still an explicit single
        # target, but combinations of independent sections are not one range.
        identities=[tuple(x['id'] for x in r[1]) for r in requests]
        if len(set(identities))!=1:return {'status':'ambiguous','reason':'这句话指定了多个段落，请一次选一个连续区间','selection_guard':_guard(view)}
        requests=requests[:1]
    explicit_time=re.search(r'(?<![-\d.])(\d+(?:\.\d+)?)\s*(?:秒)?\s*(?:到|至|[~～—–-])\s*(\d+(?:\.\d+)?)\s*秒',text)
    target=None
    if requests:
        alias,choices,explicit,all_choices=requests[0]
        if not choices:return {'status':'unavailable','reason':f'当前歌词结构中找不到指定的{alias}，未据此猜测区间','choices':_choices(all_choices),'selection_guard':_guard(view)}
        if len(choices)>1:return {'status':'ambiguous','reason':f'这首歌有{len(choices)}段{alias}，请指定第几遍或直接选择','choices':_choices(choices),'selection_guard':_guard(view)}
        target=choices[0]
    has_bars='小节' in text
    if has_bars:
        grid=view.get('grid',{})
        if not grid.get('confirmed') or grid.get('meter')!='4/4':return {'status':'unavailable','reason':'整曲拍点和小节起点尚未确认，不能把小节换算成秒；请用段落、歌词或秒数','selection_guard':_guard(view)}
        bar=240/finite(grid['bpm']);origin=finite(grid['first_downbeat_seconds'])
        if target:
            if not target.get('confirmed') or target.get('start_seconds') is None:return {'status':'unavailable','reason':'该段落边界尚未人工确认为小节起点，不能据此截取前后小节','selection_guard':_guard(view)}
            start,end=target['start_seconds'],target['end_seconds']
            match=re.search(r'(前|头|后|最后)\s*('+NUM+r')\s*(?:个)?小节',text)
            if not match:return {'status':'ambiguous','reason':'请说明该段落前几小节或后几小节，也可使用秒数','selection_guard':_guard(view)}
            anchor=start if match.group(1) in ('前','头') else end
            if abs((anchor-origin)/bar-round((anchor-origin)/bar))>.025/bar:
                return {'status':'unavailable','reason':'段落边界没有对齐已确认的小节网格，请使用秒数','selection_guard':_guard(view)}
            count=number(match.group(2));span=count*bar
            if count<1 or span>end-start+.000001:return {'status':'unavailable','reason':'请求的小节数超出选定段落','selection_guard':_guard(view)}
            a,b=(start,start+span) if match.group(1) in ('前','头') else (end-span,end)
            return _resolved(view,a,b,'bars',target['label']+' · '+match.group(0),section_id=target['id'],boundary_confirmed=True)
        match=re.search(r'第\s*('+NUM+r')\s*(?:小节)?\s*(?:到|至|[~～—–-])\s*第?\s*('+NUM+r')\s*小节',text)
        if not match:match=re.search(r'第\s*('+NUM+r')\s*小节',text)
        if not match:return {'status':'ambiguous','reason':'请给出第几到第几小节，或使用秒数','selection_guard':_guard(view)}
        first=number(match.group(1));last=number(match.group(2)) if match.lastindex==2 else first
        if first<1 or last<first:return {'status':'unavailable','reason':'小节范围无效','selection_guard':_guard(view)}
        return _resolved(view,origin+(first-1)*bar,origin+last*bar,'bars',match.group(0))
    if re.search(r'(?:第|前|后|最后)'+NUM+r'拍',text):
        return {'status':'unavailable','reason':'拍内定位还没有明确的小节与已确认网格，请使用歌词或秒数','selection_guard':_guard(view)}
    if '倒数' in text and '句' in text:
        return {'status':'ambiguous','reason':'请选取具体歌词或给出正序句号，未按倒数表达猜测区间','selection_guard':_guard(view)}
    if re.search(r'前半(?:段|部分)?|后半(?:段|部分)?|前几拍|后几拍',text) and (requests or '小节' in text):
        return {'status':'ambiguous','reason':'这个段内位置还不明确，请选择具体秒数或一句歌词','selection_guard':_guard(view)}
    quoted=re.findall(r'[“「\"\']([^”」\"\']{2,160})[”」\"\']',text)
    queries=[normalized(x) for x in quoted if len(normalized(x))>=2]
    lines=view.get('lines',[])
    matches=[]
    if queries:
        if len(queries)>1:return {'status':'ambiguous','reason':'请一次选一句歌词，或用秒数给出连续区间','selection_guard':_guard(view)}
        matches=[l for l in lines if queries[0] in normalized(l['text'])]
        if not matches:return {'status':'unavailable','reason':'这句歌词没有明确匹配当前原文，请选歌词列表或使用秒数','selection_guard':_guard(view)}
    else:
        message_key=normalized(text)
        matches=[l for l in lines if len(normalized(l['text']))>=3 and normalized(l['text']) in message_key]
        if matches:
            longest=max(len(normalized(l['text'])) for l in matches)
            matches=[l for l in matches if len(normalized(l['text']))==longest]
    if matches:
        if target:matches=[l for l in matches if l['section_id']==target['id']]
        ordinal=re.search(r'第\s*('+NUM+r')\s*(?:次|遍)\s*(?:唱|出现)',text)
        if ordinal and not target:
            index=number(ordinal.group(1))-1;matches=matches[index:index+1] if index>=0 else []
        if len(matches)!=1:
            return {'status':'ambiguous' if matches else 'unavailable','reason':'这句歌词重复出现，请指定哪一遍副歌或在列表选择' if matches else '该歌词不在指定段落中','choices':[{'line_index':l['index'],'label':l['section_label']+' · '+l['text'],'start_seconds':l['start_seconds'],'end_seconds':l['end_seconds']} for l in matches],'selection_guard':_guard(view)}
        line=matches[0]
        if explicit_time:
            a,b=map(float,explicit_time.groups())
            if line['start_seconds'] is None or not line['start_seconds']<=a<b<=line['end_seconds']:
                return {'status':'ambiguous','reason':'指定秒数和这句歌词的范围不一致，请确认要修改哪一处','selection_guard':_guard(view)}
            return _resolved(view,a,b,'seconds',line['section_label']+' · '+explicit_time.group(0),line_index=line['index'],section_id=line['section_id'])
        return _resolved(view,line['start_seconds'],line['end_seconds'],'lyric',line['section_label']+' · '+line['text'],line_index=line['index'],section_id=line['section_id'])
    if target:
        if explicit_time:
            a,b=map(float,explicit_time.groups())
            if target['start_seconds'] is None or not target['start_seconds']<=a<b<=target['end_seconds']:
                return {'status':'ambiguous','reason':'指定秒数与该段落范围不一致，请确认要使用哪一个区间','selection_guard':_guard(view)}
            return _resolved(view,a,b,'seconds',target['label']+' · '+explicit_time.group(0),section_id=target['id'])
        ordinal_line=re.search(r'第\s*('+NUM+r')\s*句(?:歌词)?',text)
        final_line='最后一句' in text
        if ordinal_line or final_line:
            group=[l for l in lines if l['section_id']==target['id']]
            index=-1 if final_line else number(ordinal_line.group(1))-1
            if not group or (not final_line and not 0<=index<len(group)):
                return {'status':'unavailable','reason':'歌词句序号超出指定段落','selection_guard':_guard(view)}
            line=group[index]
            return _resolved(view,line['start_seconds'],line['end_seconds'],'lyric',line['section_label']+' · '+line['text'],line_index=line['index'],section_id=line['section_id'])
        if re.search(r'(?:前|后|最后)'+NUM+r'句|开头|末尾|中间|后半|前半',text):return {'status':'ambiguous','reason':'请把段内位置指定为歌词或秒数，未直接选中整段','selection_guard':_guard(view)}
        return _resolved(view,target['start_seconds'],target['end_seconds'],'section',target['label'],section_id=target['id'],boundary_confirmed=target['confirmed'],boundary_source=target['boundary_source'])
    if '最后一句' in text:
        if not lines:return {'status':'unavailable','reason':'当前没有歌词行','selection_guard':_guard(view)}
        line=lines[-1]
        return _resolved(view,line['start_seconds'],line['end_seconds'],'lyric',line['section_label']+' · '+line['text'],line_index=line['index'],section_id=line['section_id'])
    ordinal=re.search(r'第\s*('+NUM+r')\s*句(?:歌词)?',text)
    if ordinal:
        index=number(ordinal.group(1))-1;line=next((l for l in lines if l['index']==index),None)
        if line:return _resolved(view,line['start_seconds'],line['end_seconds'],'lyric',line['section_label']+' · '+line['text'],line_index=line['index'],section_id=line['section_id'])
        return {'status':'unavailable','reason':'歌词句序号超出当前原文','selection_guard':_guard(view)}
    if re.search(r'第'+NUM+r'段|前半首|后半首|高潮|中间那段',text):
        return {'status':'ambiguous','reason':'这个段落称呼没有唯一对应，请指定第几遍主歌/副歌、歌词或秒数','selection_guard':_guard(view)}
    if re.search(r'整首|整曲|全曲',text):return _resolved(view,0.,view['duration'],'song','整首歌曲')
    return {'status':'not_found'}


def resolve_reference(message,view):
    """Public result uses both reason and message for simple HTTP/UI consumers."""
    try:
        result=_resolve_reference(message,view)
    except (ValueError,KeyError,TypeError,OverflowError):
        result={'status':'unavailable','reason':'当前定位依据不完整或序号无效，未猜测音乐区间'}
    if result.get('reason'):result['message']=result['reason']
    return result
