"""Immutable music-to-MV handoffs and a fixed loopback MV service gateway."""
from pathlib import Path
import copy, hashlib, http.client, json, math, os, re, subprocess, threading, time, uuid
import numpy as np

ID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
def valid_id(value):return isinstance(value,str) and bool(ID.fullmatch(value))
def metadata_fingerprint(info):
    """Identify the handoff metadata independently of its audio revision."""
    fields={k:info.get(k) for k in ('title','duration','lyrics','style','timed_lyrics','cover_url')}
    encoded=json.dumps(fields,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()
def attach_metadata_fingerprint(info,expected=None):
    value=metadata_fingerprint(info)
    if expected and 'metadata_fingerprint' in expected and expected['metadata_fingerprint']!=value:
        raise RuntimeError('歌曲的歌词或信息已变化，请重新点击创作MV')
    return {**info,'metadata_fingerprint':value}
def atomic(path,value):
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2));os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)
def digest(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()

class MVHandoffs:
    def __init__(self,root,ffmpeg):
        self.root=Path(root).resolve();self.directory=self.root/'mv-handoffs';self.directory.mkdir(exist_ok=True)
        (self.directory/'audio').mkdir(exist_ok=True);self.ffmpeg=ffmpeg;self.lock=threading.RLock()
    def read(self,identifier):
        if not valid_id(identifier):raise ValueError('MV任务标识无效')
        file=self.directory/(identifier+'.json')
        if not file.exists():raise ValueError('找不到这次MV创作')
        try:state=json.loads(file.read_text())
        except Exception:raise RuntimeError('MV交接记录损坏，未重新创建')
        if state.get('id')!=identifier:raise RuntimeError('MV交接记录不匹配')
        return state
    def public(self,state):
        if not isinstance(state.get('public'),dict):raise RuntimeError('MV交接记录损坏，未重新创建')
        result=copy.deepcopy(state['public'])
        try:result.setdefault('metadata_fingerprint',metadata_fingerprint(result))
        except (TypeError,ValueError):raise RuntimeError('MV交接记录损坏，未重新创建') from None
        return result
    def audio(self,identifier):
        state=self.read(identifier);file=Path(state['audio_file']).resolve()
        if not file.is_relative_to(self.root) or not file.is_file() or digest(file)!=state['public']['audio_sha256']:raise RuntimeError('交接音频已变化，请从歌曲重新创建MV')
        return file
    def create(self,body,resolve):
        identifier=body.get('request_id')
        if not valid_id(identifier) or not valid_id(body.get('project_id')):raise ValueError('缺少有效的MV创作标识')
        intent={k:body.get(k) for k in ('project_id','source_kind','revision','fingerprint')}
        # Preserve legacy request signatures when the new field is absent.
        if 'metadata_fingerprint' in body:
            if not isinstance(body['metadata_fingerprint'],str) or not re.fullmatch(r'[a-f0-9]{64}',body['metadata_fingerprint']):
                raise ValueError('歌词或歌曲信息标识无效，请重新打开 MV 入口')
            intent['metadata_fingerprint']=body['metadata_fingerprint']
        if intent['source_kind'] not in ('current_mix','generated_original'):raise ValueError('请选择歌曲原音频或当前混音')
        signature=hashlib.sha256(json.dumps(intent,sort_keys=True).encode()).hexdigest()
        with self.lock:
            file=self.directory/(identifier+'.json')
            if file.exists():
                state=self.read(identifier)
                if state.get('intent_sha256')!=signature:
                    legacy={k:intent[k] for k in ('project_id','source_kind','revision','fingerprint')}
                    legacy_signature=hashlib.sha256(json.dumps(legacy,sort_keys=True).encode()).hexdigest()
                    if ('metadata_fingerprint' not in intent or state.get('intent_sha256')!=legacy_signature or
                        metadata_fingerprint(state['public'])!=intent['metadata_fingerprint']):
                        raise RuntimeError('原MV请求对应另一版歌曲，请重新创建')
                # A metadata-aware caller must still match the currently frozen
                # source, even when a prior handoff can be reused.
                if 'metadata_fingerprint' in intent:resolve(intent)
                self.audio(identifier);return self.public(state)
            # The resolver validates the requested revision before freezing audio.
            info=resolve(intent);snapshot=info.pop('snapshot',None);source=info.pop('audio_file',None)
            if snapshot is not None:
                mix=snapshot.mix()
                if not np.isfinite(mix).all() or np.max(np.abs(mix))>1:raise ValueError('当前混音超过0dBFS，请降低音量后创建MV')
                identity=hashlib.sha256((info['project_id']+info['fingerprint']).encode()).hexdigest()
                source=self.directory/'audio'/(identity+'.mp3')
                if not source.exists():
                    temporary=source.with_name(identity+'.'+uuid.uuid4().hex+'.tmp.mp3')
                    try:
                        result=subprocess.run([str(self.ffmpeg),'-nostdin','-y','-v','error','-f','f32le','-ar',str(snapshot.sr),'-ac',str(mix.shape[1]),'-i','pipe:0','-codec:a','libmp3lame','-b:a','256k',str(temporary)],input=mix.astype('<f4',copy=False).tobytes(),capture_output=True,timeout=90)
                        if result.returncode:raise RuntimeError('MV音乐编码未完成，原歌曲未修改')
                        os.replace(temporary,source)
                    finally:temporary.unlink(missing_ok=True)
            source=Path(source).resolve()
            if not source.is_relative_to(self.root) or not source.is_file():raise ValueError('交接音频尚未准备好')
            public={**info,'id':identifier,'audio_sha256':digest(source),'audio_bytes':source.stat().st_size,'audio_url':f'/api/mv/handoffs/{identifier}/audio.mp3','url':f'/mv/?music={identifier}#canvas','created_at':time.time()}
            state={'id':identifier,'intent_sha256':signature,'audio_file':str(source),'public':public}
            atomic(file,state);return self.public(state)

def proxy_mv(handler,port):
    """Forward only the /mv namespace to one configured loopback service."""
    prefix='/mv';route=handler.path[len(prefix):] or '/'
    if not route.startswith('/') or route.startswith('//'):return handler.json(400,{'error':'MV路径无效'})
    method=handler.command;length=int(handler.headers.get('Content-Length','0'))
    if method not in ('GET','HEAD','POST','PUT','DELETE'):return handler.json(405,{'error':'MV不支持这个操作'})
    if length<0 or length>80_000_000:return handler.json(413,{'error':'MV请求过大'})
    payload=handler.rfile.read(length) if length else None
    headers={k:handler.headers[k] for k in ('Content-Type','Range','X-Filename') if handler.headers.get(k)}
    headers['Host']=f'127.0.0.1:{port}';headers['Origin']=f'http://127.0.0.1:{port}'
    connection=http.client.HTTPConnection('127.0.0.1',port,timeout=120);started=False
    try:
        connection.request(method,route,body=payload,headers=headers);response=connection.getresponse()
        content_type=response.getheader('Content-Type','application/octet-stream')
        html=method!='HEAD' and 'text/html' in content_type
        content=response.read() if html else None
        if html:content=content.replace(b'<head>',b'<head><base href="/mv/">',1)
        handler.send_response(response.status);started=True
        for key in ('Content-Type','Content-Range','Accept-Ranges','Content-Disposition','Cache-Control','X-Content-Type-Options'):
            value=response.getheader(key)
            if value:handler.send_header(key,value)
        size=str(len(content)) if html else response.getheader('Content-Length')
        if size is not None:handler.send_header('Content-Length',size)
        else:handler.send_header('Connection','close');handler.close_connection=True
        handler.end_headers()
        if method=='HEAD':return
        if html:handler.wfile.write(content)
        else:
            while True:
                chunk=response.read(65536)
                if not chunk:break
                handler.wfile.write(chunk)
    except (ConnectionError,OSError,http.client.HTTPException):
        if not started:handler.json(502,{'error':'MV服务暂未启动，请启动视频服务后重试'})
        handler.close_connection=True
    finally:connection.close()
