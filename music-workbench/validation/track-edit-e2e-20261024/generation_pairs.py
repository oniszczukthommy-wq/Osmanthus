"""Two independent song candidates sharing lyrics, explicit selection before stems."""
from __future__ import annotations
import copy, hashlib, json, os, re, threading, time, uuid
from pathlib import Path
import workflow as w

BATCHES=w.ROOT/'workflow'/'batches'
POLICY='dual-song-minimal-style-v1'

def request_fields(body):
    identifier=body.get('request_id')
    if not w.valid_id(identifier):raise ValueError('缺少有效 request_id')
    brief=str(body.get('brief','')).strip()
    style=str(body.get('style','中文流行')).strip()
    voice=str(body.get('voice',w.DEFAULT_VOICE)).strip()
    if not 3<=len(brief)<=2000:raise ValueError('创作要求需3至2000字')
    if not 1<=len(style)<=1000:raise ValueError('风格需1至1000字')
    if not 1<=len(voice)<=240:raise ValueError('人声描述需1至240字')
    fields={'request_id':identifier,'brief':brief,'style':style,'voice':voice}
    if 'lyrics' in body:
        lyrics=body['lyrics']
        if not isinstance(lyrics,str) or not 1<=len(lyrics.strip())<=5000:raise ValueError('自填歌词需1至5000字')
        fields['lyrics']=lyrics.strip()
    if 'title' in body:
        title=body['title']
        if not isinstance(title,str) or not 1<=len(title.strip())<=120:raise ValueError('歌名需1至120字')
        fields['title']=title.strip()
    return fields

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

def style_traits(brief,style):
    """Small reviewed descriptors, not an artist clone or a prescribed section map."""
    # An explicit exclusion/only constraint takes priority over our optional roster.
    restricted=re.search(r'不要|不用|不需要|禁止|禁用|避免|去掉|不加|不能|只用|只要|仅用|仅限|只有|只保留|without|\bno\b|\bonly\b',brief+' '+style,re.I)
    if restricted:
        return '严格保留用户指定的配器、节奏与限制；在允许范围内增强乐器之间的呼应，保持人声清楚。','constraint-preserving'
    key=style.lower()
    if any(x in key for x in ('r&b','rnb','neo-soul')):
        return '电钢琴与清音吉他为主要伴奏；鼓和贝斯用松弛的切分律动；伴奏适度留白，让人声清晰。','mc-style-citypop-rnb'
    if any(x in key for x in ('民谣','folk')):
        return '木吉他指弹与轻扫弦形成层次，轻鼓辅助自然律动；伴奏为叙述性人声留出空间。','reviewed-acoustic-folk'
    if any(x in key for x in ('摇滚','rock')):
        return '吉他短动机与贝斯鼓组相互呼应；保持乐队律动的推动力，人声与乐器主次清楚。','mc-style-rock-band'
    if any(x in key for x in ('爵士','jazz')):
        return '伴奏用简洁的爵士和声色彩与切分应答；避免所有乐器同时填满，突出主唱乐句。','mc-style-jazz'
    return '用简短可记忆的器乐动机呼应人声；配器有疏密变化，突出歌词与主旋律。','mc-arrangement-arch'

def prompts(batch):
    arrangement=f"用户创作要求：{batch['brief']}\n用户指定风格：{batch['style']}。完整演唱提供的歌词，目标150至210秒，自然收尾。"
    if len(arrangement)>3000:raise ValueError('创作描述与风格合计过长，生成提示词不能超过3000字符')
    base=w.compile_generation_prompt(arrangement,batch['voice'])
    traits,source=style_traits(batch['brief'],batch['style'])
    enhanced=base+'\n不改变上述用户要求，在不冲突时采用以下编曲建议：'+traits
    if len(enhanced)>3000:raise ValueError('生成提示词超过接口长度限制')
    return {'A':{'prompt':base,'strategy':'baseline','skill_source':None},
            'B':{'prompt':enhanced,'strategy':'minimal_traits','skill_source':source}}

def definitely_failed(job):
    return any(e.get('type')=='provider_status' and e.get('status') in ('fail','cancelled') for e in job.get('events',[]))

class GenerationPairs:
    def __init__(self,workflow,directory=None):
        self.workflow=workflow;self.lock=workflow.lock
        self.directory=Path(directory) if directory else BATCHES
        self.directory.mkdir(parents=True,exist_ok=True)
        self.batches={};self.drafting=set()
        for file in self.directory.glob('*/state.json'):
            try:
                batch=json.loads(file.read_text())
                if w.valid_id(batch['id']):self.batches[batch['id']]=batch
            except (ValueError,KeyError):continue

    def save(self,batch):
        folder=self.directory/batch['id'];folder.mkdir(exist_ok=True)
        w.save_json(folder/'state.json',batch)

    def read(self,identifier):
        batch=self.batches.get(identifier)
        if not batch:raise ValueError('找不到该双方案批次')
        return batch

    def candidate(self,batch,identifier):
        if identifier not in batch.get('candidate_ids',{}).values():raise ValueError('候选不属于该批次的当前方案')
        job=self.workflow.jobs.get(identifier)
        if not job or job.get('batch_id')!=batch['id']:raise ValueError('候选与批次身份不一致')
        return job

    def public(self,batch):
        with self.lock:
            result={k:copy.deepcopy(batch.get(k)) for k in ('id','title','brief','style','voice','lyrics','created_at','policy','error','selected_candidate_id','creation_request_id','creation_mode')}
            candidates=[]
            for slot,identifier in batch.get('candidate_ids',{}).items():
                job=self.workflow.jobs.get(identifier)
                if not job:continue
                value=self.workflow.public(job)
                # Strategy stays in server-side records; client sees neutral alternatives.
                for key in ('prompt','origin'):value.pop(key,None)
                value.update(label='方案 '+slot,can_select=bool(job.get('download_ready')),
                    can_resume=(job.get('stage')=='error' and bool(job.get('task_id')) and not definitely_failed(job)),
                    can_retry_generation=definitely_failed(job),
                    media={'stream':f'/api/generation/media/{identifier}/stream' if job.get('pipe_url') else None,
                           'complete':f'/api/generation/media/{identifier}/complete' if job.get('download_ready') else None})
                candidates.append(value)
            result['candidates']=candidates
            selected=self.workflow.jobs.get(batch.get('selected_candidate_id'))
            if selected:
                result['stage']='ready' if selected.get('stage')=='ready' else 'preparation_error' if selected.get('stage')=='error' else 'preparing'
            elif candidates:
                available=any(c['can_select'] for c in candidates)
                settled=all(c['stage'] in ('awaiting_selection','error') for c in candidates)
                result['stage']='awaiting_selection' if settled and available else 'error' if settled else 'partially_available' if available else 'generating'
            else:result['stage']=batch['stage']
            result['project_id']=selected['id'] if selected and selected.get('stage')=='ready' else None
            result['generation_in_progress']=any(c['stage'] not in ('awaiting_selection','error','ready') and not c.get('download_ready') for c in candidates)
            result['can_resume_batch']=not candidates and batch['id'] not in self.drafting
            return result

    def list(self):
        with self.lock:return [self.public(b) for b in sorted(self.batches.values(),key=lambda b:b['created_at'],reverse=True)]

    def start(self,body):
        fields=request_fields(body);identifier=fields['request_id']
        with self.lock:
            if identifier in self.batches:
                batch=self.batches[identifier]
                if batch['request_fingerprint']!=digest(fields):raise RuntimeError('同一 request_id 不能用于不同创作要求')
                return self.public(batch)
            if identifier in self.workflow.jobs:raise RuntimeError('request_id 已用于其他任务')
            if self.workflow.running or self.drafting:raise RuntimeError('已有生成或分轨任务，请等待完成')
            if not os.environ.get('YINCHAO_API_KEY') or (not fields.get('lyrics') and not os.environ.get('DEEPSEEK_API_KEY')):raise ValueError('本机生成服务尚未配置')
            batch={**fields,'id':identifier,'request_fingerprint':digest(fields),'created_at':time.time(),
                'title':fields.get('title','新歌曲'),'stage':'lyrics','policy':POLICY,'model':'v4.5','events':[],
                'candidate_ids':{},'attempts':{'A':[],'B':[]},'retry_requests':{},'selected_candidate_id':None,'error':None,
                'requested_title':fields.get('title')}
            # A failed disk write must not leave a cached, non-durable batch that
            # a replay could mistake for an accepted request.
            self.save(batch);self.batches[identifier]=batch;self.launch_draft(batch)
            return self.public(batch)

    def launch_draft(self,batch):
        if batch['id'] in self.drafting:return
        self.drafting.add(batch['id']);self.workflow.running.add(batch['id'])
        threading.Thread(target=self.draft,args=(batch,),daemon=True).start()

    def ensure_candidates(self,batch):
        strategies=batch['strategies']
        for slot in ('A','B'):
            identifier=batch['candidate_ids'][slot]
            if identifier in self.workflow.jobs:continue
            now=time.time()
            job={'id':identifier,'batch_id':batch['id'],'candidate_slot':slot,'selected_for_preparation':False,
                'title':batch['title'],'brief':batch['brief'],'style':batch['style'],'voice':batch['voice'],
                'model':batch['model'],'lyrics':batch['lyrics'],**strategies[slot],
                'voice_control':'text_timbre_prompt','voice_exact_identity':False,'project_id':identifier,
                'created_at':now,'status':'pending','stage':'generating','origin':'dual_generation',
                'events':[],'first_stream_seconds':None,'first_play_seconds':None,'done_seconds':None,
                'download_ready':False,'buffering_events':0}
            self.workflow.jobs[identifier]=job;w.STREAM.persist(job)

    def draft(self,batch):
        try:
            if not batch.get('lyrics'):
                self.workflow.lyrics(batch,folder=self.directory/batch['id'],persist_result=False)
                if batch.get('requested_title'):batch['title']=batch['requested_title']
            with self.lock:
                batch.update(strategies=prompts(batch),stage='generating',error=None)
                if not batch['candidate_ids']:
                    batch['candidate_ids']={slot:str(uuid.uuid5(uuid.UUID(batch['id']),slot+':0')) for slot in ('A','B')}
                    batch['attempts']={slot:[identifier] for slot,identifier in batch['candidate_ids'].items()}
                self.save(batch)  # Persist identities before creating any payable task.
                self.ensure_candidates(batch)
                for identifier in batch['candidate_ids'].values():self.launch_candidate(self.workflow.jobs[identifier])
        except Exception as error:
            with self.lock:
                batch.update(stage='error',error=str(error)[:700]);self.save(batch)
        finally:
            with self.lock:
                self.drafting.discard(batch['id']);self.workflow.running.discard(batch['id'])

    def launch_candidate(self,job):
        if job.get('submission_started') and not job.get('task_id') and not job.get('download_ready'):
            self.workflow.stage(job,'error',error='提交结果不确定，未自动重发，需先核对供应商任务')
            return
        if definitely_failed(job) and not job.get('download_ready'):return
        if job.get('stage')=='ready':return
        if job.get('download_ready') and not job.get('selected_for_preparation'):
            self.workflow.stage(job,'awaiting_selection',error=None,pipeline_error=None);return
        self.workflow.launch(job)

    def resume(self,identifier):
        with self.lock:
            batch=self.read(identifier)
            if not batch.get('candidate_ids'):
                batch.update(stage='lyrics',error=None);self.save(batch);self.launch_draft(batch)
            else:
                self.ensure_candidates(batch)
                for candidate_id in batch['candidate_ids'].values():
                    job=self.workflow.jobs[candidate_id]
                    job['selected_for_preparation']=candidate_id==batch.get('selected_candidate_id')
                    self.launch_candidate(job)
            return self.public(batch)

    def select(self,identifier,candidate_id):
        with self.lock:
            batch=self.read(identifier);job=self.candidate(batch,candidate_id)
            if not job.get('download_ready') or not (w.RUNS/candidate_id/'complete.mp3').is_file():raise RuntimeError('完整歌曲尚未准备好，暂不能采用')
            if any(i!=candidate_id and (self.workflow.jobs.get(i,{}).get('stage')=='separating' or
                   (self.workflow.jobs.get(i,{}).get('selected_for_preparation') and self.workflow.jobs.get(i,{}).get('download_ready')))
                   for i in self.workflow.running):
                raise RuntimeError('已有歌曲正在分轨，请完成后再采用其他歌曲')
            old=batch.get('selected_candidate_id')
            if old and old!=candidate_id and old in self.workflow.running:raise RuntimeError('已选歌曲正在分轨，请完成后再切换方案')
            if old and old!=candidate_id:
                previous=self.workflow.jobs[old];previous['selected_for_preparation']=False;w.STREAM.persist(previous)
            batch['selected_candidate_id']=candidate_id;self.save(batch)
            job['selected_for_preparation']=True;w.STREAM.persist(job)
            self.launch_candidate(job)
            return self.public(batch)

    def retry(self,identifier,candidate_id,request_id):
        """Explicit new paid attempt ONLY for a provider-confirmed terminal failure."""
        if not w.valid_id(request_id):raise ValueError('重试需要独立的 request_id')
        with self.lock:
            batch=self.read(identifier)
            replay=batch['retry_requests'].get(request_id)
            if replay:
                if replay['old_candidate_id']!=candidate_id:raise RuntimeError('重试 request_id 与原候选不匹配')
                return self.public(batch)
            job=self.candidate(batch,candidate_id)
            if candidate_id in self.workflow.running:raise RuntimeError('候选仍在运行，请等待结果')
            if job.get('download_ready') or not definitely_failed(job):raise RuntimeError('仅供应商明确失败的候选可重新生成；网络或下载错误请恢复原任务')
            slot=job['candidate_slot'];new_id=str(uuid.uuid5(uuid.UUID(batch['id']),'retry:'+request_id))
            batch['candidate_ids'][slot]=new_id;batch['attempts'][slot].append(new_id)
            batch['retry_requests'][request_id]={'old_candidate_id':candidate_id,'new_candidate_id':new_id}
            self.save(batch);self.ensure_candidates(batch);self.launch_candidate(self.workflow.jobs[new_id])
            return self.public(batch)

    def recover(self):
        # Only this manager restores candidates; legacy recovery skips batch jobs.
        for identifier,batch in list(self.batches.items()):
            if batch.get('stage')=='error' and not batch.get('candidate_ids'):continue
            self.resume(identifier)
