"""Local immutable singer candidates; creation never modifies the live mixer."""
from pathlib import Path
import argparse,fcntl,hashlib,json,os,shutil,subprocess,threading,time,uuid
import numpy as np,soundfile as sf
from project import ROOT,save_json
from scores import Scores,BASE as SCORE_BASE
BASE=ROOT.parent/'vocal-resinging-20261025';JOBS=ROOT/'vocal-jobs';PYTHON=SCORE_BASE/'.venv/bin/python';ENGINE='qixuan-score-resinging-1'
PRESETS=[{'id':'qixuan-2.7.0','name':'绮萱 · 清亮女声','enabled':False,'reason':'用户反馈声音机械、不自然，已停用此方案','attribution':'AI 合成；绮萱；DiffSinger；声码器 OpenVPI Team','scope':'仅保留实验记录'}]

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def valid_id(value):
 try:return str(uuid.UUID(value))==value
 except (ValueError,TypeError,AttributeError):return False

def reference(project):
 manager=Scores();variant=project.state['tracks'].get('vocals',{}).get('voice_variant','original')
 if variant!='original':identifier=project.vocal_assets[variant]['source_score_job_id']
 else:
  latest=manager.latest(project.directory)
  if not latest or latest['stage']!='ready':raise ValueError('请先为这首歌生成并核对演唱谱，再制作重唱候选')
  identifier=latest['id']
 state=manager.read(identifier);score_path=manager.asset(identifier,'score.json');score=json.loads(score_path.read_text())
 if score['project_id']!=project.state['id'] or score['source_sha256']!=project.state['source_sha256']:raise ValueError('旋律来源与歌曲不匹配')
 # A candidate can be re-sung from its pinned melody instead of transcribing
 # its own prior synthesis again (which would accumulate transcription drift).
 audio=project.directory/'vocals.wav'
 if digest(audio)!=score['vocal_sha256']:
  asset=next((a for a in project.vocal_assets.values() if a['sha256']==score['vocal_sha256']),None)
  if not asset:raise ValueError('找不到该演唱谱对应的固定主唱音频')
  audio=project.directory/asset['file']
 grid=score_path.parent/'analysis/tifa-rain/rain-vocals.TextGrid'
 if not grid.exists():
  cached=SCORE_BASE/'output/review-v2/score.json';old=json.loads(cached.read_text())
  if any(old[k]!=score[k] for k in ('vocal_sha256','lyrics_sha256')):raise ValueError('缺少对应的人声音素对齐文件，请重新生成演唱谱')
  grid=SCORE_BASE/'tifa-rain/rain-vocals.TextGrid'
 return {'score_job_id':identifier,'score_file':str(score_path),'score_sha256':digest(score_path),'vocal_file':str(audio),'vocal_sha256':score['vocal_sha256'],'textgrid_file':str(grid),'textgrid_sha256':digest(grid)}

class Vocals:
 def __init__(self):JOBS.mkdir(exist_ok=True);self.lock=threading.Lock();self.children=[]
 def read(self,identifier):
  if not valid_id(identifier):raise ValueError('重唱任务标识无效')
  file=JOBS/identifier/'state.json'
  if not file.exists():raise ValueError('重唱任务不存在')
  return json.loads(file.read_text())
 def public(self,state):
  stage=state['stage'];self.children=[p for p in self.children if p.poll() is None]
  if stage in ('queued','synthesizing','preparing'):
   try:
    if state.get('pid'):os.kill(state['pid'],0)
    elif time.time()-state['created_at']>15:stage='interrupted'
   except ProcessLookupError:stage='interrupted'
  result={k:state[k] for k in ('id','project_id','preset_id','created_at')};result.update(stage=stage,elapsed_seconds=round((state.get('finished_at') or time.time())-state['created_at'],2),quality_accepted=False)
  progress=JOBS/state['id']/'render/progress.json'
  if progress.exists():
   try:
    data=json.loads(progress.read_text());chunks=data.get('chunks',[])
    result['rendered_seconds']=round(chunks[-1]['end_seconds'],1) if chunks else 0
   except ValueError:pass
  if stage=='ready':result.update(candidate=state['candidate'],files={k:f'/api/vocals/jobs/{state["id"]}/files/{k}' for k in state['files']},synthesis_seconds=state['synthesis_seconds'],reused_completed_synthesis=state.get('reused_completed_synthesis',False))
  if stage in ('error','interrupted'):result['error']=state.get('error') or '重唱进程已停止，原歌曲和修改已保留，可重新生成'
  return result
 def latest(self,project_id):
  values=[json.loads(p.read_text()) for p in JOBS.glob('*/state.json')];values=[s for s in values if s['project_id']==project_id]
  return self.public(max(values,key=lambda s:s['created_at'])) if values else None
 def start(self,project,body):
  with self.lock:
   identifier=body.get('request_id');preset=body.get('preset_id','qixuan-2.7.0')
   if not valid_id(identifier):raise ValueError('重唱请求标识无效')
   if preset not in [p['id'] for p in PRESETS if p.get('enabled')]:raise ValueError('该重唱声库听感未达标，已停用；当前改为验证已有音色库')
   if (JOBS/identifier/'state.json').exists():
    old=self.read(identifier)
    if old['project_id']!=project.state['id'] or old['preset_id']!=preset:raise ValueError('同一请求不能用于其他歌曲或歌手')
    return self.public(old)
   ref=reference(project)
   key=digest(ref['score_file'])+ref['vocal_sha256']+preset+ENGINE
   if not body.get('force_new'):
    for f in JOBS.glob('*/state.json'):
     old=json.loads(f.read_text())
     if old.get('config_key')==key and self.public(old)['stage'] not in ('error','interrupted'):return self.public(old)
   state={'id':identifier,'project_id':project.state['id'],'source_sha256':project.state['source_sha256'],'source_revision':project.state['revision'],'data_dir':str(project.directory.resolve()),'preset_id':preset,'created_at':time.time(),'stage':'queued','config_key':key,'engine':ENGINE,'force_new':bool(body.get('force_new')),'reference':ref}
   folder=JOBS/identifier;folder.mkdir();save_json(folder/'state.json',state)
   with (folder/'worker.log').open('ab') as log:
    child=subprocess.Popen([str(PYTHON),str(ROOT/'vocals.py'),'--run-job',identifier],stdout=log,stderr=log,start_new_session=True,env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
   self.children.append(child);return self.public(state)
 def asset(self,identifier,name):
  state=self.read(identifier)
  if state['stage']!='ready' or name not in state.get('files',{}):raise ValueError('重唱文件尚未准备完成')
  file=JOBS/identifier/name
  if digest(file)!=state['files'][name]:raise ValueError('重唱文件校验失败')
  return file

def work(identifier):
 manager=Vocals();state=manager.read(identifier);folder=JOBS/identifier
 def stage(value,**kw):state.update(stage=value,**kw);save_json(folder/'state.json',state)
 stage('queued',pid=os.getpid())
 try:
  with (JOBS/'.engine.lock').open('a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX);ref=state['reference'];data=Path(state['data_dir']);meta=json.loads((data/'preparation.json').read_text())
   if meta['source_sha256']!=state['source_sha256']:raise ValueError('歌曲来源已改变')
   for path,key in [('score_file','score_sha256'),('vocal_file','vocal_sha256'),('textgrid_file','textgrid_sha256')]:
    if digest(ref[path])!=ref[key]:raise ValueError('固定旋律、人声或音素输入发生变化')
   render=folder/'render';cached=BASE/'full/report.json';reused=False;stage('synthesizing')
   if not state['force_new'] and cached.exists():
    old=json.loads(cached.read_text())
    if old['source_score_sha256']==ref['score_sha256'] and old['source_vocal_sha256']==ref['vocal_sha256'] and old['start_seconds']==0 and abs(old['end_seconds']-meta['duration_seconds'])<.02:
     render.mkdir();shutil.copy2(cached,render/'report.json');shutil.copy2(cached.parent/'qixuan-vocal.wav',render/'qixuan-vocal.wav');reused=True
   if not reused:
    result=subprocess.run([str(PYTHON),str(BASE/'resynthesize.py'),'--score',ref['score_file'],'--textgrid',ref['textgrid_file'],'--vocal',ref['vocal_file'],'--output',str(render)],timeout=1800)
    if result.returncode:raise ValueError('主唱合成失败，原工程未修改')
   stage('preparing');report=json.loads((render/'report.json').read_text());original,sr=sf.read(ref['vocal_file'],dtype='float32',always_2d=True);synth,rate=sf.read(render/'qixuan-vocal.wav',dtype='float32',always_2d=True)
   if sr!=rate or len(synth)!=len(original):raise ValueError('新主唱未对齐完整歌曲时间线')
   raw_rms=float(np.sqrt(np.mean(synth**2)));target_rms=float(np.sqrt(np.mean(original**2)));gain=min(target_rms/max(raw_rms,1e-8),.90/max(float(np.max(np.abs(synth))),1e-8))
   vocal=np.repeat(synth,2,axis=1)*gain
   if original.shape[1]!=2:raise ValueError('源工程需要立体声')
   asset_id='vocal_'+identifier.replace('-','')[:12];filename=asset_id+'.wav';temporary=data/(filename+'.tmp.wav');sf.write(temporary,vocal,sr,subtype='FLOAT');os.replace(temporary,data/filename)
   asset={'id':asset_id,'file':filename,'sha256':digest(data/filename),'label':'绮萱 · 重唱候选','preset_id':state['preset_id'],'source_score_job_id':ref['score_job_id'],'source_score_sha256':ref['score_sha256'],'source_vocal_sha256':ref['vocal_sha256'],'job_id':identifier,'duration_seconds':len(vocal)/sr,'attribution':report['attribution'],'quality_accepted':False}
   # A separate manifest lock serializes candidate publication. No project state
   # is written; existing edits can continue while synthesis runs.
   with (data/'.vocal-candidates.lock').open('a') as guard:
    fcntl.flock(guard,fcntl.LOCK_EX);manifest_file=data/'vocal-variants.json';manifest=json.loads(manifest_file.read_text()) if manifest_file.exists() else {'source_sha256':meta['source_sha256'],'variants':[]}
    if manifest['source_sha256']!=meta['source_sha256']:raise ValueError('主唱目录来源不匹配')
    manifest['variants'].append(asset);save_json(manifest_file,manifest)
   sf.write(folder/'candidate-vocal.wav',vocal,sr,subtype='PCM_24');sf.write(folder/'reference-vocal.wav',original,sr,subtype='PCM_24')
   # Raw backing comparison; all instrumental samples exactly identical in A/B.
   backing=sum(sf.read(data/t['file'],dtype='float32',always_2d=True)[0] for t in meta['tracks'] if t['id']!='vocals')
   a=backing+original;b=backing+vocal;headroom=min(1.,.95/max(np.max(np.abs(a)),np.max(np.abs(b)),1e-8))
   sf.write(folder/'reference-mix.wav',a*headroom,sr,subtype='PCM_24');sf.write(folder/'candidate-mix.wav',b*headroom,sr,subtype='PCM_24')
   report.update(output_gain=gain,comparison_master_gain=float(headroom),preview_scope='原始未编辑伴奏的固定A/B，未包含当前轨道静音与音量修改；应用后使用当前工程混音',new_voice_asset=asset,quality_accepted=False)
   save_json(folder/'report.json',report);files={name:digest(folder/name) for name in ['candidate-vocal.wav','reference-vocal.wav','reference-mix.wav','candidate-mix.wav','report.json']}
   stage('ready',finished_at=time.time(),candidate=asset,files=files,synthesis_seconds=report['elapsed_seconds'],reused_completed_synthesis=reused)
 except Exception as error:stage('error',error=str(error)[:260],finished_at=time.time());raise

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--run-job',required=True);work(parser.parse_args().run_job)
