"""Explicit, durable lyric approval before either paid song generation task."""
from __future__ import annotations
import copy,json,threading,time,uuid
from pathlib import Path
import workflow as w
from generation_pairs import request_fields,digest

def title_text(value):
    if not isinstance(value,str) or not 1<=len(value.strip())<=120:raise ValueError('歌名需1至120字')
    return value.strip()

class GenerationDrafts:
    def __init__(self,pairs,directory=None):
        self.pairs=pairs;self.workflow=pairs.workflow;self.lock=self.workflow.lock
        self.directory=Path(directory) if directory else w.ROOT/'workflow'/'drafts'
        self.directory.mkdir(parents=True,exist_ok=True);self.drafts={};self.running=set()
        for file in self.directory.glob('*/state.json'):
            try:
                draft=json.loads(file.read_text())
                if w.valid_id(draft['id']):self.drafts[draft['id']]=draft
            except (ValueError,KeyError):continue

    def save_state(self,draft):
        folder=self.directory/draft['id'];folder.mkdir(exist_ok=True);w.save_json(folder/'state.json',draft)

    def read(self,identifier):
        if identifier not in self.drafts:raise ValueError('找不到歌词草稿')
        return self.drafts[identifier]

    @staticmethod
    def content(draft):
        return {k:draft.get(k) for k in ('title','brief','style','voice','lyrics','version')}

    def public(self,draft):
        with self.lock:
            result={k:copy.deepcopy(draft.get(k)) for k in ('id','title','brief','style','voice','lyrics','stage','version','created_at','error','batch_id','approved_at','generation_error')}
            result['fingerprint']=digest(self.content(draft))
            result['can_edit']=draft['stage']=='ready'
            result['can_confirm']=draft['stage'] in ('ready','confirmed')
            result['can_resume']=draft['stage']=='error'
            result['music_submitted']=bool(draft.get('batch_id') in self.pairs.batches)
            return result

    def list(self):
        with self.lock:return [self.public(d) for d in sorted(self.drafts.values(),key=lambda d:d['created_at'],reverse=True)]

    def start(self,body):
        fields=request_fields(body);identifier=fields['request_id']
        with self.lock:
            if identifier in self.drafts:
                draft=self.drafts[identifier]
                if draft['request_fingerprint']!=digest(fields):raise RuntimeError('同一草稿请求ID不能用于不同创作要求')
                return self.public(draft)
            if identifier in self.workflow.jobs or identifier in self.pairs.batches:raise RuntimeError('草稿请求ID已被使用')
            draft={**fields,'id':identifier,'title':fields.get('title','新歌曲'),'version':1,'created_at':time.time(),
                   'request_fingerprint':digest(fields),'stage':'writing','error':None,'batch_id':None,'events':[],
                   'requested_title':fields.get('title')}
            self.drafts[identifier]=draft;self.save_state(draft);self.launch(draft)
            return self.public(draft)

    def launch(self,draft):
        if draft['id'] in self.running:return
        self.running.add(draft['id']);self.workflow.running.add(draft['id'])
        threading.Thread(target=self.run,args=(draft,),daemon=True).start()

    def run(self,draft):
        try:
            draft.setdefault('events',[])
            if not draft.get('lyrics'):self.workflow.lyrics(draft,folder=self.directory/draft['id'],persist_result=False)
            if draft.get('requested_title'):draft['title']=draft['requested_title']
            with self.lock:
                draft.update(stage='ready',error=None)
                self.running.discard(draft['id']);self.workflow.running.discard(draft['id'])
                self.save_state(draft)
        except Exception as error:
            with self.lock:
                draft.update(stage='error',error=str(error)[:700]);self.save_state(draft)
        finally:
            with self.lock:
                self.running.discard(draft['id']);self.workflow.running.discard(draft['id'])

    def resume(self,identifier):
        with self.lock:
            draft=self.read(identifier)
            if draft['stage']=='confirmed':return self.confirm(identifier,{'version':draft['version'],'fingerprint':digest(self.content(draft))})
            if draft['stage']=='error':draft.update(stage='writing',error=None);self.save_state(draft);self.launch(draft)
            return self.public(draft)

    def update(self,identifier,body):
        with self.lock:
            draft=self.read(identifier)
            if draft['stage']!='ready':raise RuntimeError('歌词已确认或仍在处理，请为新的修改创建草稿')
            if isinstance(body.get('version'),bool) or body.get('version')!=draft['version']:raise RuntimeError('歌词版本已更新，请重新读取后再保存')
            lyrics=body.get('lyrics')
            if not isinstance(lyrics,str) or not 1<=len(lyrics.strip())<=5000:raise ValueError('歌词需1至5000字')
            fields=request_fields({'request_id':draft['id'],'brief':draft['brief'],'style':body.get('style',draft['style']),'voice':body.get('voice',draft['voice']),'lyrics':lyrics})
            new={'title':title_text(body.get('title',draft['title'])),'lyrics':fields['lyrics'],'style':fields['style'],'voice':fields['voice']}
            if any(draft.get(k)!=v for k,v in new.items()):draft.update(**new,version=draft['version']+1,updated_at=time.time());self.save_state(draft)
            return self.public(draft)

    def confirm(self,identifier,body):
        with self.lock:
            draft=self.read(identifier)
            if draft['stage'] not in ('ready','confirmed'):raise RuntimeError('请先等待歌词草稿准备完成')
            fingerprint=digest(self.content(draft))
            if isinstance(body.get('version'),bool) or body.get('version')!=draft['version'] or body.get('fingerprint')!=fingerprint:
                raise RuntimeError('歌词或生成设置已变化，请核对当前版本后重新确认')
            if draft['stage']!='confirmed':
                batch_id=str(uuid.uuid5(uuid.UUID(draft['id']),'confirmed-generation'))
                approved={k:draft[k] for k in ('brief','style','voice','lyrics','title')}
                draft.update(stage='confirmed',batch_id=batch_id,approved_at=time.time(),approved_fingerprint=fingerprint,
                             approved_payload={'request_id':batch_id,**approved},generation_error=None)
                self.save_state(draft)  # Approval is durable before any payable call.
            return self.start_approved(draft)

    def start_approved(self,draft):
        try:
            self.save_state(draft)  # Also retry an earlier failed approval write.
            result=self.pairs.start(copy.deepcopy(draft['approved_payload']))
            batch=self.pairs.read(draft['batch_id'])
            batch.update(lyric_draft_id=draft['id'],lyric_draft_version=draft['version'],lyric_approval_fingerprint=draft['approved_fingerprint'])
            self.pairs.save(batch);draft['generation_error']=None;self.save_state(draft)
            return {'draft':self.public(draft),'batch':result}
        except Exception as error:
            draft['generation_error']=str(error)[:700];self.save_state(draft);raise

    def recover(self):
        with self.lock:
            for draft in self.drafts.values():
                if draft['stage']=='writing':self.launch(draft)
                elif draft['stage']=='confirmed':
                    try:self.start_approved(draft)
                    except (RuntimeError,ValueError):pass
