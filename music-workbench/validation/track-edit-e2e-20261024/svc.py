"""Full-song voice conversion candidates, independent of the live project edits."""
from runtime_support import check_process, file_lock as fcntl, venv_python
from pathlib import Path
import argparse, hashlib, json, os, subprocess, threading, time, uuid
import numpy as np,soundfile as sf
from project import ROOT,save_json,Project
from scores import valid_id
from voice_library import VoiceLibrary

BASE=ROOT.parent/'vocal-resinging-20261025';JOBS=ROOT/'svc-jobs'
PYTHON=venv_python(ROOT.parent/'seed-vc-20261025/.venv')
ENGINE='yingmusic-full-hybrid-50-1';VOICE='226869000163476'
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def alive(pid):
    try:check_process(int(pid));return True
    except (ProcessLookupError,ValueError,TypeError):return False

class Conversions:
    def __init__(self):JOBS.mkdir(exist_ok=True);self.lock=threading.Lock();self.children=[]
    def read(self,identifier):
        if not valid_id(identifier):raise ValueError('换声任务标识无效')
        file=JOBS/identifier/'state.json'
        if not file.exists():raise ValueError('找不到换声任务')
        return json.loads(file.read_text())
    def public(self,state):
        self.children=[p for p in self.children if p.poll() is None]
        stage=state['stage']
        if stage in ('queued','converting','preparing') and (state.get('pid') and not alive(state['pid']) or not state.get('pid') and time.time()-state['created_at']>15):stage='interrupted'
        result={k:state[k] for k in ('id','project_id','voice_id','voice_name','created_at')}
        result.update(stage=stage,quality_accepted=False,elapsed_seconds=round((state.get('finished_at') or time.time())-state['created_at'],1))
        progress=Path(state['render_dir'])/'progress.json'
        if progress.exists():
            try:
                p=json.loads(progress.read_text());result.update(chunks_finished=p.get('chunks_finished',0),source_seconds=p.get('source_seconds'),chunks_started=p.get('chunks_started',0))
            except ValueError:pass
        if stage=='ready':
            result.update(candidate=state['candidate'],files={name:f'/api/svc/jobs/{state["id"]}/files/{name}' for name in state['files']},conversion_seconds=state['conversion_seconds'])
            acceptance=JOBS/state['id']/'user-listening-acceptance.json'
            if acceptance.exists():
                try:
                    accepted=json.loads(acceptance.read_text())
                    if (accepted.get('status')=='user_listening_accepted' and accepted.get('conversion_job_id')==state['id'] and
                        accepted.get('project_id')==state['project_id'] and accepted.get('candidate_id')==state['candidate']['id'] and
                        accepted.get('candidate_sha256')==state['candidate']['sha256']):
                        result.update(quality_accepted=True,acceptance_scope=accepted.get('scope'))
                except (ValueError,OSError):pass
        if stage in ('error','interrupted'):result['error']=state.get('error','本地换声任务已停止，原歌曲保留，可以重试')
        return result
    def latest(self,directory):
        meta=json.loads((directory/'preparation.json').read_text())
        states=[json.loads(p.read_text()) for p in JOBS.glob('*/state.json')]
        states=[s for s in states if s['project_id']==meta['project_id'] and s['source_sha256']==meta['source_sha256']]
        file=directory/'vocal-variants.json';manifest=json.loads(file.read_text()) if file.exists() else {'variants':[]}
        candidates=[a for a in manifest['variants'] if a.get('engine')==ENGINE and not a.get('rejected_by_user')]
        return {'job':self.public(max(states,key=lambda s:s['created_at'])) if states else None,'candidates':list(reversed(candidates)),
                'supported_voice_ids':[VOICE],'current_variant':json.loads((directory/'project.json').read_text())['tracks'].get('vocals',{}).get('voice_variant','original')}
    def start(self,project,body):
        with self.lock:
            if 'vocals' not in project.state['tracks'] or project.state['tracks']['vocals'].get('removed'):raise ValueError('请先恢复人声轨道，再制作换声候选')
            identifier=body.get('request_id');voice=body.get('voice_id',VOICE)
            if not valid_id(identifier):raise ValueError('缺少有效的换声请求标识')
            if voice!=VOICE:raise ValueError('目前先验证已选的“抒情男声”，其他音色尚未完成唱歌转换验证')
            library=VoiceLibrary();target=library.asset(voice)
            source=next(t for t in project.meta['tracks'] if t['id']=='vocals')
            context={'engine':ENGINE,'project_id':project.state['id'],'source_sha256':project.meta['source_sha256'],'vocal_sha256':source['sha256'],'target_sha256':digest(target),'voice_id':voice}
            if (JOBS/identifier/'state.json').exists():
                old=self.read(identifier)
                if any(old.get(k)!=v for k,v in context.items()):raise ValueError('同一请求不能用于其他歌曲或歌手')
                return self.public(old)
            for file in JOBS.glob('*/state.json'):
                old=json.loads(file.read_text())
                if all(old.get(k)==v for k,v in context.items()) and self.public(old)['stage'] not in ('error','interrupted'):return self.public(old)
            folder=JOBS/identifier;folder.mkdir();render=folder/'render';render.mkdir()
            # Adopt only the already running, hash-matched validation. Never start
            # a second expensive inference when the same full song is in flight.
            trial=BASE/'full-yingmusic-lyrical-male';run=trial/'run.json'
            external=None
            if run.exists():
                prior=json.loads(run.read_text())
                if prior.get('source_sha256')==context['vocal_sha256'] and (alive(prior.get('pid')) or (trial/'report.json').exists()):render=trial;external=prior['pid']
            state={**context,'id':identifier,'voice_name':'抒情男声','data_dir':str(project.directory.resolve()),'source_file':source['file'],
                   'created_at':time.time(),'stage':'queued','render_dir':str(render.resolve()),'external_pid':external}
            save_json(folder/'state.json',state)
            with (folder/'worker.log').open('a') as log:
                child=subprocess.Popen([os.path.abspath(venv_python(ROOT.parent/'audio-separation/.venv', 'OSMANTHUS_SEPARATION_PYTHON', fallback=True)),str(ROOT/'svc.py'),'--run-job',identifier],stdout=log,stderr=log,start_new_session=True,
                    env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
            self.children.append(child);return self.public(state)
    def asset(self,identifier,name):
        state=self.read(identifier)
        if state['stage']!='ready' or name not in state.get('files',{}):raise ValueError('换声文件尚未准备好')
        path=JOBS/identifier/name
        if digest(path)!=state['files'][name]:raise ValueError('换声文件校验失败')
        return path

def work(identifier):
    manager=Conversions();state=manager.read(identifier);folder=JOBS/identifier;data=Path(state['data_dir']);render=Path(state['render_dir'])
    def stage(value,**kwargs):state.update(stage=value,**kwargs);save_json(folder/'state.json',state)
    stage('queued',pid=os.getpid())
    try:
        with (ROOT/'score-jobs/.engine.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            source=data/state['source_file'];meta=json.loads((data/'preparation.json').read_text())
            if digest(source)!=state['vocal_sha256'] or meta['source_sha256']!=state['source_sha256']:raise ValueError('固定原唱来源已改变')
            child=None;engine_pid=state.get('external_pid')
            stage('converting')
            if not engine_pid:
                with (render/'worker.log').open('a') as log:
                    child=subprocess.Popen([str(PYTHON),str(BASE/'convert_yingmusic.py'),'--device','mps','--hybrid','--full','--source-override',str(source),'--label',str(render),'--progress',str(render/'progress.json')],stdout=log,stderr=log,
                        env={**os.environ,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
                engine_pid=child.pid
            stage('converting',engine_pid=engine_pid)
            deadline=time.monotonic()+7200
            while not (render/'report.json').exists():
                if child and child.poll() is not None or not child and not alive(engine_pid):raise ValueError('整曲换声未完成，请查看本地日志；原唱和所有编辑保留')
                if time.monotonic()>deadline:
                    if child:child.terminate()
                    raise ValueError('整曲换声超时；原工程未修改')
                time.sleep(3)
            if child:child.wait(timeout=30)
            report=json.loads((render/'report.json').read_text());stage('preparing')
            if report['source_sha256']!=state['vocal_sha256'] or report['target_sha256']!=state['target_sha256'] or report.get('semi_tone_shift')!=0:raise ValueError('换声结果与固定原唱或目标音色不一致')
            original,sr=sf.read(source,dtype='float32',always_2d=True);converted,rate=sf.read(report['output'],dtype='float32',always_2d=True)
            if rate!=sr or not np.isfinite(converted).all() or converted.shape[1]!=1:raise ValueError('换声采样率或音频数据无效')
            tail=len(original)-len(converted)
            if not 0<=tail<=1024:raise ValueError('换声未保持完整歌曲时长，停止发布')
            if tail:converted=np.pad(converted,((0,tail),(0,0)))
            rms=float(np.sqrt(np.mean(converted**2)))
            if rms<1e-6:raise ValueError('换声结果为空或无声')
            gain=min(float(np.sqrt(np.mean(original**2)))/rms,.90/max(float(np.max(np.abs(converted))),1e-8))
            vocal=np.repeat(converted,original.shape[1],axis=1)*gain
            # Preserve every current instrumental sample and mixer setting.
            # Solve only the candidate-vocal gain interval that keeps this mix
            # below the export ceiling; do not normalize the whole project.
            project=Project(data);settings=project.state['tracks'].get('vocals')
            if settings is None:raise ValueError('当前工程已删除人声轨道，请先恢复人声轨道再换声')
            audible=not settings['muted'] and (not any(t['solo'] for t in project.state['tracks'].values()) or settings['solo'])
            factor=10**(settings['gain_db']/20)*project.meta['master_gain'] if audible else 0.
            fixed=project.mix()-project.render_track('vocals')*factor
            delta=vocal*project.envelope('vocals')[:,None]*factor
            mask=np.abs(delta)>1e-8;ceiling=.98
            if np.max(np.abs(fixed[~mask]),initial=0)>ceiling:raise ValueError('当前伴奏峰值已超出安全余量，请降低伴奏音量后重试；原工程未修改')
            lower=(-ceiling-fixed[mask])/delta[mask];upper=(ceiling-fixed[mask])/delta[mask]
            min_scale=max(0.,float(np.max(np.minimum(lower,upper),initial=0)))
            max_scale=min(1.,float(np.min(np.maximum(lower,upper),initial=1)))
            if max_scale<min_scale or max_scale<=0:raise ValueError('当前混音无法仅调整新主唱避免削波，请降低伴奏音量后重试')
            before_peak=float(np.max(np.abs(fixed+delta)));vocal*=max_scale;gain*=max_scale
            headroom_check={'vocal_only_scale':max_scale,'candidate_gain_db':float(20*np.log10(max_scale)),
                            'mix_peak_before':before_peak,'mix_peak_after':float(np.max(np.abs(fixed+delta*max_scale))),
                            'ceiling':ceiling,'project_fingerprint':project.fingerprint(),'project_revision':project.state['revision']}
            del project,fixed,delta,mask,lower,upper
            asset_id='vocal_'+identifier.replace('-','')[:12];filename=asset_id+'.wav'
            temporary=data/(filename+'.tmp.wav');sf.write(temporary,vocal,sr,subtype='FLOAT');os.replace(temporary,data/filename)
            candidate={'id':asset_id,'file':filename,'sha256':digest(data/filename),'label':'抒情男声 · 整曲换声候选','preset_id':'reference-'+VOICE,
                       'engine':ENGINE,'job_id':identifier,'source_vocal_sha256':state['vocal_sha256'],'source_score_job_id':None,'reference_voice_id':VOICE,
                       'duration_seconds':len(vocal)/sr,'quality_accepted':False,'attribution':'YingMusic-SVC-full；已有抒情男声音色参考；私人非商业原型'}
            backing=sum(sf.read(data/t['file'],dtype='float32',always_2d=True)[0] for t in meta['tracks'] if t['id']!='vocals')
            a=backing+original;b=backing+vocal;headroom=min(1.,.95/max(float(np.max(np.abs(a))),float(np.max(np.abs(b))),1e-8))
            for name,wave in [('candidate-vocal.wav',vocal),('reference-vocal.wav',original),('candidate-mix.wav',b*headroom),('reference-mix.wav',a*headroom)]:sf.write(folder/name,wave,sr,subtype='PCM_24')
            report.update(candidate=candidate,tail_padding_frames=tail,output_gain=gain,comparison_master_gain=headroom,
                          current_mix_headroom=headroom_check,preview_scope='原始未编辑伴奏的固定A/B；应用到工程后使用当前全部轨道修改',quality_accepted=False)
            save_json(folder/'report.json',report)
            files={name:digest(folder/name) for name in ('candidate-vocal.wav','reference-vocal.wav','candidate-mix.wav','reference-mix.wav','report.json')}
            with (data/'.vocal-candidates.lock').open('a') as guard:
                fcntl.flock(guard,fcntl.LOCK_EX);file=data/'vocal-variants.json';manifest=json.loads(file.read_text()) if file.exists() else {'source_sha256':state['source_sha256'],'variants':[]}
                if manifest['source_sha256']!=state['source_sha256']:raise ValueError('主唱候选目录来源不匹配')
                manifest['variants']=[a for a in manifest['variants'] if a['id']!=asset_id]+[candidate];save_json(file,manifest)
            stage('ready',candidate=candidate,files=files,conversion_seconds=report['inference_seconds'],finished_at=time.time())
    except Exception as exc:stage('error',error=str(exc)[:250],finished_at=time.time());raise

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--run-job',required=True);work(parser.parse_args().run_job)
