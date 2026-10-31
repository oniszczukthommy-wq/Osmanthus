"""Short local microphone transcription; never executes or applies the transcript."""
from __future__ import annotations
from runtime_support import check_process, file_lock as fcntl, media_binary, venv_python
import argparse, hashlib, json, math, os, subprocess, threading, time, uuid, wave
from pathlib import Path
ROOT=Path(os.environ.get('MUSIC_WORKBENCH_ROOT',str(Path(__file__).resolve().parent))).resolve()

def save_json(path,value):
    temporary=path.with_name('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2));os.replace(temporary,path)

BASE=Path(__file__).resolve().parent.parent/'speech-input-20261028'
PYTHON=venv_python(BASE/'.venv')
MODEL=BASE/'model-base'
FFMPEG=media_binary('ffmpeg')
MAX_BYTES=8*1024*1024
MAX_SECONDS=60
ENGINE='faster-whisper-base-1.2.1-cpu-int8'
WORKING=('queued','decoding','transcribing')
TYPES={'audio/webm','audio/ogg','audio/mp4','audio/wav','audio/x-wav','audio/mpeg','video/webm'}

def valid_id(value):
    try:return isinstance(value,str) and str(uuid.UUID(value))==value
    except (ValueError,TypeError,AttributeError):return False

def alive(pid):
    if not isinstance(pid,int) or isinstance(pid,bool):return False
    try:check_process(pid);return True
    except (OSError,OverflowError):return False

class SpeechInput:
    def __init__(self,root=ROOT):
        self.root=Path(root);self.directory=self.root/'speech-jobs';self.directory.mkdir(exist_ok=True)
        self.lock=threading.RLock();self.children=[]

    def read(self,identifier):
        if not valid_id(identifier):raise ValueError('录音请求标识无效')
        file=self.directory/identifier/'state.json'
        if not file.exists():raise ValueError('找不到录音识别任务')
        return json.loads(file.read_text())

    def public(self,state):
        stage=state['stage']
        if stage in WORKING and not alive(state.get('pid')) and time.time()-state['created_at']>15:
            stage='interrupted'
        fields=('id','project_id','source_revision','created_at','duration_seconds','text','segments','language','input_sha256')
        result={k:state[k] for k in fields if k in state}
        result.update(stage=stage,engine=ENGINE,elapsed_seconds=round((state.get('finished_at') or time.time())-state['created_at'],3),review_before_send=True)
        if stage in ('error','interrupted'):result['error']=state.get('error') or '语音识别进程已停止，请重新录音；尚未修改歌曲'
        return result

    def start(self,payload,request_id,project_id,revision,content_type):
        if not valid_id(request_id) or not valid_id(project_id):raise ValueError('录音请求或工程标识无效')
        if isinstance(revision,bool) or not isinstance(revision,int) or revision<0:raise ValueError('录音工程版本无效')
        if not isinstance(payload,bytes) or not 0<len(payload)<=MAX_BYTES:raise ValueError('录音需大于0且不超过8MB')
        mime=str(content_type or '').split(';')[0].strip().lower()
        if mime not in TYPES:raise ValueError('请上传浏览器录音或 WAV、MP3 音频')
        signature=hashlib.sha256(payload).hexdigest()
        with self.lock:
            folder=self.directory/request_id
            if (folder/'state.json').exists():
                old=self.read(request_id)
                if (old['project_id'],old['source_revision'],old['input_sha256'])!=(project_id,revision,signature):
                    raise RuntimeError('同一录音请求不能改为其他音频或歌曲')
                return self.public(old)
            if not PYTHON.is_file() or not (MODEL/'model.bin').is_file():raise ValueError('本地语音识别模型尚未准备好')
            self.children=[child for child in self.children if child.poll() is None]
            for file in self.directory.glob('*/state.json'):
                previous=json.loads(file.read_text())
                if self.public(previous)['stage'] in WORKING:raise RuntimeError('上一段语音还在识别，请完成后再录音')
            folder.mkdir(exist_ok=True)
            (folder/'recording.bin').write_bytes(payload)
            state={'id':request_id,'project_id':project_id,'source_revision':revision,'input_sha256':signature,'content_type':mime,'created_at':time.time(),'stage':'queued','pid':None,'engine':ENGINE}
            save_json(folder/'state.json',state)
            try:
                with (folder/'worker.log').open('ab') as log:
                    child=subprocess.Popen([str(PYTHON),str(Path(__file__).resolve()),'--root',str(self.root),'--run-job',request_id],stdout=log,stderr=log,start_new_session=True,env={**os.environ,'MUSIC_WORKBENCH_ROOT':str(self.root),'OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'1','TOKENIZERS_PARALLELISM':'false'})
                self.children.append(child)
            except Exception:
                state.update(stage='error',error='本地语音识别未能启动，请重试',finished_at=time.time());save_json(folder/'state.json',state)
            return self.public(state)

def run_job(root,identifier):
    root=Path(root);folder=root/'speech-jobs'/identifier
    state=json.loads((folder/'state.json').read_text())
    def stage(value,**fields):
        state.update(stage=value,**fields);save_json(folder/'state.json',state)
    try:
        stage('decoding',pid=os.getpid())
        # Decode at most 61 seconds, then reject overlong inputs rather than
        # silently transcribing a truncation. Browser WebM often has no duration.
        wave_path=folder/'recording-16k.wav'
        command=[str(FFMPEG),'-nostdin','-y','-v','error','-i',str(folder/'recording.bin'),'-t','61','-ar','16000','-ac','1','-c:a','pcm_s16le',str(wave_path)]
        result=subprocess.run(command,capture_output=True,timeout=70)
        if result.returncode:raise ValueError('录音无法解码，请重新录音')
        with wave.open(str(wave_path),'rb') as wav:
            duration=wav.getnframes()/wav.getframerate();frames=wav.readframes(wav.getnframes())
        if not .2<=duration<=MAX_SECONDS+.1:raise ValueError('请录制0.2至60秒的语音')
        # Prevent silent input from producing a hallucinated command.
        import numpy as np
        samples=np.frombuffer(frames,dtype='<i2').astype(np.float32)/32768
        if not len(samples) or float(np.sqrt(np.mean(samples*samples)))<.0002:
            raise ValueError('没有听到清楚的语音，请靠近麦克风后重试')
        stage('transcribing',duration_seconds=duration)
        with (BASE/'inference.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            from faster_whisper import WhisperModel
            model=WhisperModel(str(MODEL),device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)
            segments,info=model.transcribe(str(wave_path),language='zh',beam_size=5,vad_filter=True,condition_on_previous_text=False,initial_prompt='音乐编辑。钢琴，吉他，贝斯，鼓，人声。秒，分贝。')
            values=[{'start':s.start,'end':s.end,'text':s.text.strip()} for s in segments]
            text=''.join(s['text'] for s in values).strip()
        if not text:raise ValueError('没有识别到清楚的语音，请重新录制')
        stage('ready',text=text,segments=values,language=info.language,finished_at=time.time())
    except Exception as error:
        message=str(error) if isinstance(error,ValueError) else '本地语音识别失败，请重录；歌曲尚未修改'
        stage('error',error=message[:400],error_type=type(error).__name__,finished_at=time.time())

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--run-job',required=True);args=parser.parse_args()
    if not valid_id(args.run_job):raise ValueError('无效录音任务')
    run_job(args.root,args.run_job)
