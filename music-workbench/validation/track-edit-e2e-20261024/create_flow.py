"""Explicit one-click creation, with optional AI lyrics, over the real pair engine.

The user chose this flow in place of mandatory lyric approval. A durable request
records that choice before music work starts; it does not fabricate an approval
draft or bypass the existing provider submission/recovery safeguards.
"""
from __future__ import annotations
import copy,json,os,re,time
from pathlib import Path
import workflow as w
from generation_pairs import digest,prompts,request_fields

POLICY='direct-creation-v1'
AUTO_VOICE='自然清楚的演唱，遵循创作描述中的声线、语种和唱法要求'

def text(value,label,maximum,*,required=False):
    if not isinstance(value,str):raise ValueError(label+'需使用文字填写')
    value=value.strip()
    if len(value)>maximum or (required and not value):raise ValueError(label+f'需1至{maximum}字')
    return value

def idea(body,*,required=False):
    if 'prompt' in body and 'brief' in body and body['prompt']!=body['brief']:
        raise ValueError('创作描述存在两个不同版本，请重新核对')
    value=text(body.get('prompt',body.get('brief','')),'创作描述',2000)
    if required and len(value)<3:raise ValueError('创作描述需3至2000字')
    return value

def default_style(brief):
    for pattern,style in ((r'r&b|rnb|neo.?soul','中文 R&B'),(r'民谣|folk','中文民谣'),
                          (r'摇滚|rock','中文摇滚'),(r'爵士|jazz','中文爵士'),(r'蓝调|blues','中文蓝调')):
        if re.search(pattern,brief,re.I):return style
    return '中文流行'

def title_from_lyrics(lyrics):
    for line in lyrics.splitlines():
        line=line.strip()
        if line and not line.startswith('['):return line[:32]
    return '新歌曲'

def fields(body):
    if not isinstance(body,dict):raise ValueError('创作请求格式无效')
    mode=body.get('mode','simple')
    if mode not in ('simple','advanced'):raise ValueError('请选择简单或高级创作模式')
    instrumental=body.get('instrumental',False)
    if not isinstance(instrumental,bool):raise ValueError('纯器乐选项无效')
    if instrumental:raise ValueError('当前音乐接口尚未验证纯器乐生成，请使用带演唱的歌曲')
    brief=idea(body,required=mode=='simple')
    style=text(body.get('style',''),'风格',1000) or default_style(brief)
    voice=text(body.get('voice',''),'人声描述',240) or AUTO_VOICE
    title=text(body.get('title',''),'歌名',120)
    lyrics=text(body.get('lyrics',''),'歌词',5000)
    if mode=='simple' and lyrics:raise ValueError('自填歌词请使用高级模式，避免歌词被忽略')
    if mode=='advanced' and not lyrics:raise ValueError('请填写歌词，或使用 AI 写词后再生成')
    if not brief:brief='按照用户填写的歌词、风格与人声要求创作完整原创歌曲'
    payload={'request_id':body.get('request_id'),'brief':brief,'style':style,'voice':voice}
    if lyrics:payload['lyrics']=lyrics
    if title:payload['title']=title
    elif lyrics:payload['title']=title_from_lyrics(lyrics)
    payload=request_fields(payload)
    # The full music prompt has a provider cap. Fail before even a lyric call,
    # rather than accepting an overlong style/description combination first.
    prompts(payload)
    return mode,payload

class CreationFlow:
    def __init__(self,pairs,drafts,directory=None):
        self.pairs=pairs;self.drafts=drafts;self.workflow=pairs.workflow;self.lock=self.workflow.lock
        self.directory=Path(directory) if directory else w.ROOT/'workflow'/'creation-requests'
        self.directory.mkdir(parents=True,exist_ok=True);self.requests={};self.corrupt=set()
        # A durable tombstone closes the race between a failed client POST and
        # a later request to cancel an id that has not yet been admitted.
        self.cancelled={p.parent.name for p in self.directory.glob('*/cancelled.json') if w.valid_id(p.parent.name)}
        for file in self.directory.glob('*/state.json'):
            try:
                state=json.loads(file.read_text());identifier=state['id']
                if not w.valid_id(identifier) or file.parent.name!=identifier:raise ValueError('invalid identity')
                if state['mode'] not in ('simple','advanced') or state['payload']['request_id']!=identifier:raise ValueError('invalid payload')
                if digest({'mode':state['mode'],'payload':state['payload']})!=state['request_fingerprint']:raise ValueError('invalid fingerprint')
                self.requests[identifier]=state
            except (ValueError,KeyError,TypeError):
                if w.valid_id(file.parent.name):self.corrupt.add(file.parent.name)

    def save(self,state):
        folder=self.directory/state['id'];folder.mkdir(exist_ok=True);w.save_json(folder/'state.json',state)

    def read(self,identifier):
        if not w.valid_id(identifier):raise ValueError('创作请求标识无效')
        if identifier in self.cancelled:raise ValueError('这次未接受的创作请求已取消')
        if identifier in self.corrupt:raise RuntimeError('创作记录不完整，已停止自动重试，请先核对原任务')
        if identifier not in self.requests:raise ValueError('找不到这次创作请求')
        return self.requests[identifier]

    def _batch(self,state):
        batch=self.pairs.batches.get(state['id'])
        if batch and batch['request_fingerprint']!=digest(state['payload']):
            raise RuntimeError('创作请求与歌曲批次不一致，未提交新的生成')
        return batch

    def public(self,state):
        with self.lock:
            raw=self._batch(state);batch=self.pairs.public(raw) if raw else None
            result={k:copy.deepcopy(state.get(k)) for k in ('id','mode','created_at','policy','error')}
            result.update(request_id=state['id'],stage=batch['stage'] if batch else ('error' if state['state'] in ('error','accepted') else 'submitting'),
                          batch_id=state['id'],batch=batch,input=copy.deepcopy(state['payload']))
            if batch:result['error']=batch.get('error')
            elif state['state']=='accepted':result['error']='原歌曲批次记录不完整，已停止重发以免重复扣费'
            orphaned=any(j.get('batch_id')==state['id'] for j in self.workflow.jobs.values())
            result['can_resume']=bool(batch.get('can_resume_batch')) if batch else state['state']=='error' and not orphaned
            return result

    def list(self):
        with self.lock:return [self.public(s) for s in sorted(self.requests.values(),key=lambda s:s['created_at'],reverse=True) if s['id'] not in self.cancelled]

    def _bind(self,state):
        batch=self._batch(state)
        if not batch:return
        batch.update(creation_request_id=state['id'],creation_mode=state['mode'])
        self.pairs.save(batch)
        state.update(state='accepted',error=None);self.save(state)

    def _submit(self,state):
        identifier=state['id']
        if identifier in self.cancelled:raise RuntimeError('这次创作请求已取消，请使用新的创作请求')
        if self._batch(state):self._bind(state);return self.public(state)
        if state['state']=='accepted' or any(j.get('batch_id')==identifier for j in self.workflow.jobs.values()):
            raise RuntimeError('原歌曲批次记录不完整，已停止重发以免重复扣费')
        try:
            self.pairs.start(copy.deepcopy(state['payload']))
            self._bind(state)
            return self.public(state)
        except Exception as error:
            state.update(state='error',error=str(error)[:700])
            # Preserve the original failure if recording the failure also hits a
            # full/unavailable disk. A durable pre-submit intent already exists.
            try:self.save(state)
            except OSError:pass
            raise

    def start(self,body):
        mode,payload=fields(body);identifier=payload['request_id'];fingerprint=digest({'mode':mode,'payload':payload})
        with self.lock:
            if identifier in self.cancelled:raise RuntimeError('这次创作请求已取消，请使用新的创作请求')
            if identifier in self.corrupt:raise RuntimeError('创作记录不完整，已停止自动重试，请先核对原任务')
            if identifier in self.requests:
                state=self.requests[identifier]
                if state['request_fingerprint']!=fingerprint:raise RuntimeError('同一 request_id 不能用于不同创作模式或内容')
                if self._batch(state):self._bind(state);return self.public(state)
                if state['state']=='authorized':return self._submit(state)
                return self.public(state)
            if identifier in self.pairs.batches or identifier in self.workflow.jobs or identifier in self.drafts.drafts:
                raise RuntimeError('request_id 已用于其他创作任务')
            if self.workflow.running or self.pairs.drafting:raise RuntimeError('已有生成或分轨任务，请等待完成')
            if not os.environ.get('YINCHAO_API_KEY') or (mode=='simple' and not os.environ.get('DEEPSEEK_API_KEY')):
                raise ValueError('本机生成服务尚未配置')
            state={'id':identifier,'mode':mode,'payload':payload,'request_fingerprint':fingerprint,
                   'created_at':time.time(),'policy':POLICY,'state':'authorized','error':None}
            self.save(state);self.requests[identifier]=state
            return self._submit(state)

    def resume(self,identifier):
        with self.lock:
            state=self.read(identifier);batch=self._batch(state)
            if batch:
                self.pairs.resume(identifier);self._bind(state);return self.public(state)
            return self._submit(state)

    def cancel_unaccepted(self,identifier):
        if not w.valid_id(identifier):raise ValueError('创作请求标识无效')
        with self.lock:
            if identifier in self.cancelled:return {'cancelled':True,'request_id':identifier}
            if identifier in self.corrupt:raise RuntimeError('创作记录不完整，不能确认取消，请先核对原任务')
            state=self.requests.get(identifier)
            if state and self._batch(state):return {'cancelled':False,'creation':self.public(state)}
            if (state and state['state']=='accepted') or any(j.get('batch_id')==identifier for j in self.workflow.jobs.values()):
                raise RuntimeError('原歌曲记录不完整，不能取消或重新提交，请先核对原任务')
            if identifier in self.pairs.batches or identifier in self.workflow.jobs or identifier in self.drafts.drafts:
                raise RuntimeError('该请求标识已用于其他任务，不能取消')
            folder=self.directory/identifier;folder.mkdir(exist_ok=True)
            w.save_json(folder/'cancelled.json',{'id':identifier,'cancelled_at':time.time(),'policy':POLICY})
            self.cancelled.add(identifier)
            return {'cancelled':True,'request_id':identifier}

    def recover(self):
        # Call after pair recovery. Existing batches are only linked; the pair
        # manager alone owns restoration of actual provider/processing jobs.
        with self.lock:
            for state in self.requests.values():
                if state['id'] in self.cancelled:continue
                try:
                    if self._batch(state):self._bind(state)
                    elif state['state']=='authorized':self._submit(state)
                except (ValueError,RuntimeError,OSError):continue

    def write_lyrics(self,body):
        if not isinstance(body,dict):raise ValueError('写词请求格式无效')
        brief=idea(body)
        style=text(body.get('style',''),'风格',1000) or default_style(brief)
        voice=text(body.get('voice',''),'人声描述',240) or AUTO_VOICE
        instruction=text(body.get('instruction',''),'写词要求',1000)
        if instruction:brief=(brief+'\n写词要求：'+instruction).strip()
        context=text(body.get('lyrics',''),'参考歌词',5000)
        if context:brief=(brief+'\n参考当前歌词，重新写出一整版歌词：\n'+context).strip()
        if not brief:brief='按照指定风格和人声要求写一首有完整段落的原创中文歌曲'
        if len(brief)>2000:raise ValueError('创作描述、参考歌词与写词要求合计不能超过2000字')
        payload={'request_id':body.get('request_id'),'brief':brief,'style':style,'voice':voice}
        title=text(body.get('title',''),'歌名',120)
        if title:payload['title']=title
        payload=request_fields(payload)
        with self.lock:
            if payload['request_id'] in self.requests or payload['request_id'] in self.corrupt:
                raise RuntimeError('写词请求ID已用于歌曲创作')
            if not os.environ.get('DEEPSEEK_API_KEY'):raise ValueError('本机写词服务尚未配置')
            # Context is inside the brief, not the manual-lyrics field (which
            # would skip the writer). This helper creates a fresh draft only.
            return self.drafts.start(payload)
