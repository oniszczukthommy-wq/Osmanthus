"""Immutable local share snapshots; no upload or invented public share links."""
from __future__ import annotations
from runtime_support import file_lock as fcntl, media_binary
import copy, hashlib, json, os, subprocess, tempfile, threading, time, uuid
from types import SimpleNamespace
from pathlib import Path
import numpy as np
import soundfile as sf
from project import ROOT

ENGINE='local-share-snapshot-1'

def valid_id(value):
    try:return isinstance(value,str) and str(uuid.UUID(value))==value
    except (ValueError,TypeError,AttributeError):return False

def sha(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()

def save_json(path,value):
    temporary=path.with_name('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)

def text_field(body,name,default,limit,required=False):
    value=body.get(name,default)
    if not isinstance(value,str) or len(value.strip())>limit or (required and not value.strip()):
        label={'title':'歌名','quote':'歌词摘句','creator':'署名'}.get(name,name)
        raise ValueError(f'{label}内容无效或超过{limit}字')
    return value.strip()

class ShareManager:
    def __init__(self,root=ROOT,ffmpeg=None):
        self.root=Path(root);self.directory=self.root/'shares';self.directory.mkdir(parents=True,exist_ok=True)
        self.ffmpeg=Path(ffmpeg) if ffmpeg else media_binary('ffmpeg')
        self.lock=threading.RLock()

    def read(self,identifier):
        if not valid_id(identifier):raise ValueError('分享标识无效')
        path=self.directory/identifier/'state.json'
        if not path.is_file():raise ValueError('找不到这份分享')
        result=json.loads(path.read_text())
        if result.get('id')!=identifier:raise ValueError('分享记录身份不一致')
        return result

    def public(self,state):
        identifier=state['id'];ready=state['stage']=='ready'
        result={k:copy.deepcopy(state.get(k)) for k in ('id','stage','created_at','finished_at','title','quote','creator','project_id','revision','fingerprint','source_sha256','source_kind','duration','sample_rate','frames','error')}
        result.update(engine=ENGINE,immutable=True,access_scope='local_device',
            scope_note='本机预览链接仅能在运行 Osmanthus 的这台电脑打开；对外分享请发送音频或封面文件。',
            local_url=f'/share/{identifier}' if ready else None,
            share_text='\n'.join(x for x in [f'《{state["title"]}》',state.get('quote'),('创作：'+state['creator']) if state.get('creator') else '', 'Osmanthus'] if x))
        result['version_label']='原始生成成品' if state.get('source_kind')=='generated_original' else f'混音版本 {state["revision"]}'
        assets=state.get('assets',{}) if ready else {}
        result['files']={name:{'url':f'/api/shares/{identifier}/files/{name}',**{k:v for k,v in entry.items() if k in ('sha256','bytes','mime')}} for name,entry in assets.items()}
        for field,filename in [('audio_url','song.mp3'),('wav_url','song.wav')]:result[field]=result['files'].get(filename,{}).get('url')
        for field,prefix in [('cover_url','cover.'),('poster_url','poster.')]:
            result[field]=next((v['url'] for n,v in result['files'].items() if n.startswith(prefix)),None)
        return result

    def asset(self,identifier,name):
        state=self.read(identifier)
        if state['stage']!='ready' or not isinstance(name,str) or name not in state.get('assets',{}):raise ValueError('分享文件不存在或尚未完成')
        if Path(name).name!=name or name.startswith('.'):raise ValueError('分享文件标识无效')
        path=self.directory/identifier/name
        if not path.is_file() or sha(path)!=state['assets'][name]['sha256']:raise ValueError('分享文件校验失败')
        return path

    def _artwork(self,artwork,project,work):
        """Only server-selected raster assets with matching song provenance."""
        if not artwork:return {}
        if not isinstance(artwork,dict) or artwork.get('project_id')!=project.state['id'] or artwork.get('source_sha256')!=project.state['source_sha256']:
            raise ValueError('封面或海报与当前歌曲不匹配')
        entries={'cover':artwork.get('cover') or ({'path':artwork['path'],'sha256':artwork.get('sha256')} if artwork.get('path') else None),'poster':artwork.get('poster')}
        records={}
        for kind,entry in entries.items():
            if not entry:continue
            if not isinstance(entry,dict) or not entry.get('path') or not entry.get('sha256'):raise ValueError('封面或海报缺少校验记录')
            source=Path(entry['path']);suffix=source.suffix.lower()
            if suffix=='.jpeg':suffix='.jpg'
            if suffix not in ('.png','.jpg','.webp') or not source.is_file() or sha(source)!=entry['sha256']:
                raise ValueError('封面或海报文件校验失败')
            name=kind+suffix;target=work/name
            # Freeze exact bytes; later cover regeneration cannot change a share.
            with source.open('rb') as src,target.open('wb') as dst:
                for chunk in iter(lambda:src.read(1024*1024),b''):dst.write(chunk)
            records[name]={'sha256':sha(target),'bytes':target.stat().st_size,'mime':{'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[suffix]}
        return records

    def create(self,project,body,artwork=None):
        """Call with Project.audio_snapshot(), after the server context guard.

        Rendering must happen outside the server's global edit lock. Repeated
        UUIDs reuse the frozen result; an altered request cannot overwrite it.
        Artwork is a trusted server mapping, never a path accepted from JSON.
        """
        identifier=body.get('request_id')
        if not valid_id(identifier):raise ValueError('分享请求需要有效 request_id')
        if body.get('project_id')!=project.state['id']:raise RuntimeError('歌曲已经切换，请重新打开分享')
        if isinstance(body.get('revision'),bool) or not isinstance(body.get('revision'),int):raise ValueError('分享版本无效')
        project.check_revision(body.get('revision'))
        fields={'title':text_field(body,'title',project.state['title'],120,True),'quote':text_field(body,'quote','',500),
                'creator':text_field(body,'creator','',80),'project_id':project.state['id'],'revision':project.state['revision'],
                'fingerprint':project.fingerprint(),'source_sha256':project.state['source_sha256'],'source_kind':'current_mix'}
        signature=hashlib.sha256(json.dumps(fields,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            folder=self.directory/identifier;folder.mkdir(exist_ok=True)
            with (folder/'.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                state_file=folder/'state.json'
                if state_file.exists():
                    state=self.read(identifier)
                    if state.get('request_fingerprint')!=signature:raise RuntimeError('同一分享请求不能改为其他歌曲、版本或文案')
                    if state['stage']=='ready':return self.public(state)
                else:
                    state={'id':identifier,**fields,'request_fingerprint':signature,'created_at':time.time(),'stage':'preparing','engine':ENGINE,'assets':{}}
                state.update(stage='preparing',error=None);save_json(state_file,state)
                try:
                    # Validate finiteness before creating any public media asset.
                    mix=project.mix();peak=float(np.max(np.abs(mix))) if len(mix) else 0
                    if not len(mix) or not np.isfinite(mix).all() or peak>1:
                        raise ValueError('当前混音峰值超过0dBFS或音频无效，请降低轨道音量后再分享')
                    with tempfile.TemporaryDirectory(dir=folder,prefix='.prepare-') as temporary:
                        work=Path(temporary);assets=self._artwork(artwork,project,work)
                        wav=work/'song.wav';mp3=work/'song.mp3'
                        sf.write(wav,mix,project.sr,subtype='PCM_24')
                        encoded=subprocess.run([str(self.ffmpeg),'-nostdin','-y','-v','error','-i',str(wav),'-codec:a','libmp3lame','-b:a','256k',str(mp3)],capture_output=True,timeout=120)
                        if encoded.returncode:raise ValueError('分享音频编码未完成，请重试')
                        for name,mime in [('song.wav','audio/wav'),('song.mp3','audio/mpeg')]:
                            path=work/name;assets[name]={'sha256':sha(path),'bytes':path.stat().st_size,'mime':mime}
                        # Publish ready last: a reader never observes partial assets.
                        for name in assets:os.replace(work/name,folder/name)
                        state.update(stage='ready',assets=assets,duration=len(mix)/project.sr,sample_rate=project.sr,frames=len(mix),
                                     peak=peak,finished_at=time.time(),tracks=copy.deepcopy(project.state['tracks']),
                                     generation_job_id=project.meta.get('generation_job_id'))
                        save_json(state_file,state)
                    return self.public(state)
                except Exception as error:
                    state.update(stage='error',error=str(error)[:500],finished_at=time.time());save_json(state_file,state)
                    raise

    def create_original(self,job,source_path,body,artwork=None):
        """Share a downloaded original candidate without stem preparation.

        source_path must be supplied by the server from its owned workflow run.
        The downloaded MP3 is copied byte-for-byte, never re-encoded or mixed.
        """
        identifier=body.get('request_id');candidate_id=body.get('candidate_id')
        if not valid_id(identifier):raise ValueError('分享请求需要有效 request_id')
        if not valid_id(candidate_id) or job.get('id')!=candidate_id:raise RuntimeError('生成成品与分享歌曲不匹配')
        if body.get('project_id',candidate_id)!=candidate_id:raise RuntimeError('分享身份与生成成品不匹配')
        revision=body.get('revision',0)
        if isinstance(revision,bool) or not isinstance(revision,int) or revision!=0:raise ValueError('原始生成成品的分享版本应为0')
        if not job.get('download_ready'):raise ValueError('完整歌曲尚未准备好，暂不能分享')
        source=Path(source_path)
        if not source.is_file() or source.suffix.lower()!='.mp3':raise ValueError('完整歌曲文件不可用')
        original_sha=sha(source)
        try:
            info=sf.info(source)
            if info.format!='MP3' or info.frames<=0 or info.samplerate<=0:raise ValueError('生成成品不是有效MP3')
        except RuntimeError as error:raise ValueError('生成成品音频无法读取') from error
        fields={'title':text_field(body,'title',job.get('title','新歌曲'),120,True),'quote':text_field(body,'quote','',500),
                'creator':text_field(body,'creator','',80),'project_id':candidate_id,'revision':0,
                'fingerprint':original_sha,'source_sha256':original_sha,'source_kind':'generated_original'}
        signature=hashlib.sha256(json.dumps(fields,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            folder=self.directory/identifier;folder.mkdir(exist_ok=True)
            with (folder/'.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX);state_file=folder/'state.json'
                if state_file.exists():
                    state=self.read(identifier)
                    if state.get('request_fingerprint')!=signature:raise RuntimeError('同一分享请求不能改为其他歌曲、版本或文案')
                    if state['stage']=='ready':return self.public(state)
                else:state={'id':identifier,**fields,'request_fingerprint':signature,'created_at':time.time(),'stage':'preparing','engine':ENGINE,'assets':{}}
                state.update(stage='preparing',error=None);save_json(state_file,state)
                try:
                    with tempfile.TemporaryDirectory(dir=folder,prefix='.prepare-') as temporary:
                        work=Path(temporary)
                        context=SimpleNamespace(state={'id':candidate_id,'source_sha256':original_sha})
                        assets=self._artwork(artwork,context,work)
                        target=work/'song.mp3'
                        with source.open('rb') as src,target.open('wb') as dst:
                            for chunk in iter(lambda:src.read(1024*1024),b''):dst.write(chunk)
                        if sha(target)!=original_sha:raise RuntimeError('生成成品在分享期间发生变化，请重试')
                        assets['song.mp3']={'sha256':original_sha,'bytes':target.stat().st_size,'mime':'audio/mpeg'}
                        for name in assets:os.replace(work/name,folder/name)
                        state.update(stage='ready',assets=assets,duration=info.frames/info.samplerate,sample_rate=info.samplerate,
                                     frames=info.frames,finished_at=time.time(),generation_job_id=candidate_id)
                        save_json(state_file,state)
                    return self.public(state)
                except Exception as error:
                    state.update(stage='error',error=str(error)[:500],finished_at=time.time());save_json(state_file,state)
                    raise
