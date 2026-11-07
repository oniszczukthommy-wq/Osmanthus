"""Local, isolated upload-to-stems jobs. No provider calls or project mutation."""
from __future__ import annotations
import argparse, json, os, re, shutil, subprocess, sys, threading, time, uuid
from pathlib import Path
from project import ROOT, save_json
from runtime_support import check_process, media_binary

MAX_BYTES = 150 * 1024 * 1024
MAX_SECONDS = 600
EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a'}
LABELS = {'vocals':'人声', 'drums':'鼓组', 'bass':'贝斯', 'other':'其他伴奏'}

def valid_id(value):
    try: return str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError): return False

def alive(pid):
    try:
        if not isinstance(pid, int) or pid <= 0: return False
        check_process(pid); return True
    except (OSError, ValueError, OverflowError): return False

class StemSplit:
    def __init__(self, root=ROOT):
        self.root=Path(root).resolve(); self.directory=self.root/'.local'/'stem-split-jobs'
        self.directory.mkdir(parents=True,exist_ok=True); self.lock=threading.RLock(); self.children=[]

    def read(self, identifier):
        if not valid_id(identifier): raise ValueError('找不到分轨任务')
        try: state=json.loads((self.directory/identifier/'state.json').read_text(encoding='utf-8'))
        except (OSError, ValueError): raise ValueError('找不到分轨任务')
        if (state.get('status') in ('queued','processing') and state.get('pid') and not alive(state['pid'])) or (state.get('status')=='queued' and not state.get('pid') and time.time()-state.get('created_at',0)>120):
            state.update(status='error',error='分轨任务中断，请重新上传',finished_at=time.time()); save_json(self.directory/identifier/'state.json',state)
        return state

    def public(self, state):
        identifier=state['id']; status=state['status']
        result={k:state.get(k) for k in ('id','status','error','filename')}
        result['stems']=[{'id':name,'label':label,'url':f'/api/stem-split/jobs/{identifier}/stems/{name}.wav'} for name,label in LABELS.items()] if status=='ready' else []
        return result

    def asset(self, identifier, name):
        if name not in {x+'.wav' for x in LABELS}: raise ValueError('找不到分轨文件')
        if self.read(identifier)['status']!='ready': raise ValueError('分轨尚未完成')
        path=self.directory/identifier/'output'/name
        if path.is_symlink() or not path.is_file(): raise ValueError('找不到分轨文件')
        return path

    def start(self, stream, length, filename):
        if not isinstance(length,int) or not 0<length<=MAX_BYTES: raise ValueError('音频文件需大于 0 且不超过 150 MB')
        filename=str(filename or '').replace('\\','/').split('/')[-1].strip()
        extension=Path(filename).suffix.lower()
        if extension not in EXTENSIONS: raise ValueError('请上传 MP3、WAV、FLAC 或 M4A 格式的音频')
        filename=''.join(c for c in filename if c.isprintable())[:180] or 'audio'+extension
        with self.lock:
            for f in self.directory.glob('*/state.json'):
                try:
                    state=self.read(f.parent.name)
                    if state.get('status') in ('queued','processing'): raise ValueError('已有音频正在分轨，请等待完成')
                except (OSError, json.JSONDecodeError): continue
            identifier=str(uuid.uuid4()); folder=self.directory/identifier; folder.mkdir()
            source=folder/('source'+extension)
            try:
                remaining=length
                with source.open('xb') as output:
                    while remaining:
                        chunk=stream.read(min(1024*1024,remaining))
                        if not chunk: raise ValueError('文件上传不完整，请重新上传')
                        output.write(chunk); remaining-=len(chunk)
                with source.open('rb') as f: head=f.read(16)
                if not ((extension=='.wav' and len(head)>=12 and head[:4] in (b'RIFF',b'RF64') and head[8:12]==b'WAVE') or
                        (extension=='.flac' and head[:4]==b'fLaC') or
                        (extension=='.m4a' and len(head)>=12 and head[4:8]==b'ftyp') or
                        (extension=='.mp3' and (head[:3]==b'ID3' or len(head)>=2 and head[0]==255 and head[1]&224==224))):
                    raise ValueError('文件内容与音频格式不符，请检查后重新上传')
                state={'id':identifier,'filename':filename,'extension':extension,'status':'queued','error':None,'created_at':time.time()}
                save_json(folder/'state.json',state)
                flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
                with (folder/'worker.log').open('ab') as log:
                    child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--root',str(self.root),'--worker',identifier],stdout=log,stderr=subprocess.STDOUT,creationflags=flags)
                self.children.append(child)
                # The worker owns later writes; avoid overwriting its state after spawning.
                return self.public(state)
            except Exception:
                shutil.rmtree(folder,ignore_errors=True); raise

def worker(root, identifier):
    if not valid_id(identifier): raise ValueError('无效任务')
    folder=Path(root)/'.local'/'stem-split-jobs'/identifier
    state=json.loads((folder/'state.json').read_text(encoding='utf-8'))
    def update(status, **fields):
        state.update(status=status,**fields); save_json(folder/'state.json',state)
    try:
        update('processing',pid=os.getpid())
        source=folder/('source'+state['extension']); decoded=folder/'decoded.wav'
        # Whitelist local file/pipe only, decode no more than 601 seconds and reject longer input.
        result=subprocess.run([str(media_binary('ffmpeg')),'-nostdin','-y','-v','error','-protocol_whitelist','file,pipe','-i',str(source),'-vn','-t',str(MAX_SECONDS+1),'-ar','44100','-ac','2','-c:a','pcm_s16le',str(decoded)],capture_output=True,timeout=300)
        if result.returncode or not decoded.is_file(): raise ValueError('音频无法解码，请检查文件')
        import soundfile as sf
        info=sf.info(str(decoded))
        if info.frames<=0: raise ValueError('音频为空，请检查文件')
        if info.frames/info.samplerate>MAX_SECONDS: raise ValueError('音频时长不能超过 10 分钟')
        output=folder/'output'; output.mkdir()
        command=[sys.executable,str(Path(__file__).resolve().parent/'prepare.py'),'--source',str(decoded),'--output',str(output),'--title',state['filename'],'--project-id',identifier]
        result=subprocess.run(command,stdout=sys.stdout,stderr=subprocess.STDOUT,timeout=1200,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if result.returncode: raise RuntimeError('分轨处理失败，请检查模型与依赖后重试')
        if not all((output/(name+'.wav')).is_file() for name in LABELS): raise RuntimeError('分轨结果不完整，请重试')
        update('ready',finished_at=time.time())
    except Exception as exc:
        update('error',error=(str(exc) if isinstance(exc,(ValueError,RuntimeError)) else '分轨处理失败，请重试')[:300],finished_at=time.time())

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--root',required=True); p.add_argument('--worker',required=True); args=p.parse_args(); worker(args.root,args.worker)
