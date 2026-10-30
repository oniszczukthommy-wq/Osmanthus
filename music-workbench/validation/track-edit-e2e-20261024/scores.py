"""Durable, read-only lead-vocal score jobs, independent of mixer state."""
from pathlib import Path
import argparse,fcntl,hashlib,json,math,os,re,shutil,subprocess,threading,time,uuid
from project import ROOT,save_json
from vocal_sources import lead_vocal_source
BASE=ROOT.parent/'vocal-score-20261024';PYTHON=BASE/'.venv/bin/python';JOBS=ROOT/'score-jobs';ENGINE='singing-score-review-2'

def valid_id(value):
 try:return str(uuid.UUID(value))==value
 except (ValueError,TypeError,AttributeError):return False

def source_context(directory):
 meta=json.loads((directory/'preparation.json').read_text());identifier=meta.get('generation_job_id')
 if not valid_id(identifier):raise ValueError('这首歌尚未关联原始歌词，无法可靠进行词音对照')
 file=ROOT/'workflow/runs'/identifier/'state.json'
 if not file.exists():raise ValueError('找不到原始歌词记录')
 generation=json.loads(file.read_text());lyrics=generation.get('lyrics','').strip()
 if not lyrics:raise ValueError('原始歌词为空')
 vocal=lead_vocal_source(directory)
 if not vocal:raise ValueError('请先完成歌曲人声分轨')
 corrections=directory/vocal['corrections_file']
 if corrections.exists() and json.loads(corrections.read_text()).get('vocal_sha256')!=vocal['sha256']:raise ValueError('现有校订与新的人声不匹配，请重新校订')
 context={'corrections_sha256':hashlib.sha256(corrections.read_bytes() if corrections.exists() else b'[]').hexdigest(),'project_id':meta['project_id'],'source_sha256':meta['source_sha256'],'vocal_sha256':vocal['sha256'],
          'lyrics_sha256':hashlib.sha256(lyrics.encode()).hexdigest(),'engine':ENGINE,'basis':vocal['basis']}
 return context,lyrics

def file_sha256(path):
 digest=hashlib.sha256()
 with Path(path).open('rb') as source:
  for block in iter(lambda:source.read(1024*1024),b''):digest.update(block)
 return digest.hexdigest()

def step_timeout(script,duration):
 """Allow bounded CPU analysis time in proportion to the complete song."""
 if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or duration<=0:raise ValueError('歌曲时长无效，无法确定本地出谱时限')
 return math.ceil(min(1800,max(600,duration*8+120))) if script in ('game_onnx.py','run_tifa.py') else 600

def completed_game_transcription(raw,context,duration):
 """Accept a whole-source GAME result, not a partial or refined score artifact."""
 try:
  if not isinstance(raw,dict):return False
  if raw.get('engine')!='GAME-1.0.3-medium-onnx' or raw.get('source_sha256')!=context['vocal_sha256']:return False
  if any(key in raw for key in ('phrase_review_version','local_refinements','alignment_refinements','measured_review_ids','pitch_review_changes')):return False
  span=raw['range_seconds']
  if len(span)!=2 or any(isinstance(v,bool) or not math.isfinite(float(v)) for v in span):return False
  if abs(float(span[0]))>1e-6 or abs(float(span[1])-duration)>1e-6:return False
  notes=raw['notes']
  if not isinstance(notes,list) or not notes:return False
  # Completeness comes from the processed range, not a forced final note:
  # a valid performance can end well before the last silent audio frames.
  previous=0.;tolerance=.020001
  for note in notes:
   start,end=note['start_seconds'],note['end_seconds']
   if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (start,end)):return False
   if not 0<=start<end<=duration+tolerance or start<previous-1e-5:return False
   if not isinstance(note['voiced'],bool):return False
   if note['voiced']:
    pitch,rounded=note['midi_float'],note['midi']
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=127 for v in (pitch,rounded)):return False
    if rounded!=round(pitch):return False
   elif note.get('midi_float') is not None or note.get('midi') is not None:return False
   cents=note.get('cents_from_equal_temperament')
   if cents is not None and (isinstance(cents,bool) or not isinstance(cents,(int,float)) or not math.isfinite(cents)):return False
   previous=end
  if 'chunks' in raw:
   chunks=raw['chunks']
   if not isinstance(chunks,list) or not chunks:return False
   lengths=[chunk['duration'] for chunk in chunks]
   if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0 for v in lengths):return False
   if abs(sum(lengths)-duration)>1e-5:return False
  return True
 except (KeyError,TypeError,ValueError,OverflowError):return False

def cached_states(folder):
 values=[]
 for manifest in folder.glob('*/state.json'):
  try:
   saved=json.loads(manifest.read_text())
   if not isinstance(saved,dict):continue
   created=float(saved.get('created_at',0))
   if not valid_id(saved.get('id')) or saved['id']!=manifest.parent.name or not math.isfinite(created):continue
   values.append((created,saved,manifest.parent))
  except (OSError,ValueError,TypeError):continue
 return sorted(values,key=lambda value:value[0],reverse=True)

def cached_transcription(context,duration,exclude_job_id=None):
 for _,saved,folder in cached_states(JOBS):
  if saved['id']==exclude_job_id or any(saved.get(k)!=v for k,v in context.items()):continue
  analysis=folder/'analysis'
  # Prefer an untouched snapshot when a later stage has refined the main file.
  for name in ('rain-vocal-notes.before-refinement.json','rain-vocal-notes.before-phrase-review.json','rain-vocal-notes.json'):
   path=analysis/name
   try:
    raw=json.loads(path.read_text())
    if completed_game_transcription(raw,context,duration):return {'id':saved['id'],'path':path,'sha256':file_sha256(path)}
   except (OSError,ValueError,TypeError):continue
 return None

def cached_lyric_alignment(context,lyrics,duration):
 # Imported lazily: lyrics.py uses source_context from this module.
 from lyrics import characters_from_grid,lyric_lines,timed_lines
 expected_text='\n'.join(lyric_lines(lyrics))
 keys=('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis')
 for _,saved,folder in cached_states(ROOT/'lyric-jobs'):
  if saved.get('stage')!='ready' or saved.get('engine')!='tifa-lyric-lines-1' or any(saved.get(k)!=context[k] for k in keys):continue
  try:
   timing_path=folder/'timing.json';grid=folder/'alignment/vocal.TextGrid'
   if saved.get('lyrics')!=lyrics or file_sha256(timing_path)!=saved.get('timing_sha256'):continue
   if file_sha256(folder/'input/vocal.wav')!=context['vocal_sha256']:continue
   if (folder/'input/vocal.txt').read_text()!=expected_text:continue
   timing=json.loads(timing_path.read_text())
   if isinstance(timing['duration'],bool) or not math.isfinite(float(timing['duration'])) or abs(float(timing['duration'])-duration)>1e-6:continue
   lines=timed_lines(lyrics,characters_from_grid(grid),duration)
   if lines!=timing['lines']:continue
   return {'id':saved['id'],'directory':folder/'alignment','grid_sha256':file_sha256(grid)}
  except (OSError,ValueError,TypeError,KeyError,StopIteration,OverflowError):continue
 return None

class Scores:
 def __init__(self):self.lock=threading.Lock();self.children=[];JOBS.mkdir(exist_ok=True)
 def read(self,identifier):
  if not valid_id(identifier):raise ValueError('演唱谱任务标识无效')
  file=JOBS/identifier/'state.json'
  if not file.exists():raise ValueError('找不到该演唱谱任务')
  return json.loads(file.read_text())
 def public(self,state):
  stage=state['stage'];self.children=[p for p in self.children if p.poll() is None]
  if stage in ('queued','transcribing','aligning','refining','checking','engraving'):
   try:
    if state.get('pid'):os.kill(state['pid'],0)
    elif time.time()-state['created_at']>15:stage='interrupted'
   except ProcessLookupError:stage='interrupted'
  result={k:state[k] for k in ('id','project_id','created_at','basis')};result.update(stage=stage,elapsed_seconds=round((state.get('finished_at') or time.time())-state['created_at'],2),accuracy_accepted=False)
  result.update({key:state[key] for key in ('reused_transcription_job_id','reused_lyric_alignment_job_id') if state.get(key)})
  result.update({key:state[key] for key in ('kind','base_review_revision','base_score_job_id','changed_note_ids') if key in state})
  if stage=='ready':
   result.update(summary=state['summary'],files={k:f'/api/scores/jobs/{state["id"]}/files/{k}' for k in state['files']},reused_analysis=state.get('reused_analysis',False))
   result['score_sha256']=state['files'].get('score.json')
   acceptance=JOBS/state['id']/'user-listening-acceptance.json'
   if acceptance.exists():
    try:
     accepted=json.loads(acceptance.read_text())
     matches=(accepted.get('status')=='user_listening_accepted' and accepted.get('project_id')==state['project_id'] and
              accepted.get('score_job_id')==state['id'] and accepted.get('score_json_sha256')==state['files'].get('score.json') and
              all(accepted.get('files',{}).get(name)==state['files'].get(name) for name in ('staff-score.pdf','numbered-score.pdf')))
     if matches:result.update(accuracy_accepted=True,acceptance_scope='current_song_current_score_user_listening')
    except (ValueError,OSError):pass
  if stage in ('error','interrupted'):result['error']=state.get('error') or '本地出谱任务已中断，可重试；歌曲工程未改变'
  return result
 def latest(self,directory):
  context,_=source_context(directory);values=[]
  from score_review import active_saved_score
  reviewed=active_saved_score(directory,context)
  if reviewed:return reviewed
  for f in JOBS.glob('*/state.json'):
   s=json.loads(f.read_text())
   if s.get('kind')=='manual_review_candidate':continue
   if all(s.get(k)==v for k,v in context.items()):values.append(s)
  return self.public(max(values,key=lambda s:s['created_at'])) if values else None
 def start(self,project,body):
  with self.lock:
   identifier=body.get('request_id')
   if not valid_id(identifier):raise ValueError('请提供有效的演唱谱请求标识')
   if (JOBS/identifier/'state.json').exists():
    state=self.read(identifier)
    if state['project_id']!=body.get('project_id'):raise ValueError('同一请求不能用于不同歌曲')
    return self.public(state)
   context,lyrics=source_context(project.directory)
   if context['project_id']!=project.state['id']:raise ValueError('歌词与歌曲工程不匹配')
   # Human edits and listening confirmations are source-bound. Rechecking a
   # score must not silently replace them with a fresh stochastic analysis.
   from score_review import active_saved_score
   reviewed=active_saved_score(project.directory,context)
   if reviewed:return reviewed
   key=hashlib.sha256(json.dumps(context,sort_keys=True).encode()).hexdigest()
   force=body.get('force_recompute',False)
   if not isinstance(force,bool):raise ValueError('复核开关必须为布尔值')
   analysis_source=body.get('analysis_source_job_id')
   if analysis_source:
    prior=self.read(analysis_source)
    if prior['stage']!='ready' or any(prior.get(k)!=v for k,v in context.items() if k!='corrections_sha256') or not (JOBS/analysis_source/'analysis/rain-vocal-notes.json').exists():raise ValueError('已有分析与当前人声或歌词不一致，不能复用')
   active=[]
   for f in JOBS.glob('*/state.json'):
    old=json.loads(f.read_text())
    if old.get('kind')=='manual_review_candidate':continue
    if old.get('config_key')==key and self.public(old)['stage'] not in ('error','interrupted'):active.append(old)
   if active and not force:return self.public(max(active,key=lambda s:s['created_at']))
   state={**context,'id':identifier,'config_key':key,'data_dir':str(project.directory.resolve()),'created_at':time.time(),'stage':'queued','force_recompute':force,'analysis_source_job_id':analysis_source}
   directory=JOBS/identifier;directory.mkdir();save_json(directory/'state.json',state)
   with (directory/'worker.log').open('a') as log:
    try:
     child=subprocess.Popen([str(PYTHON),str(ROOT/'scores.py'),'--run-job',identifier],stdout=log,stderr=log,start_new_session=True,
      env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1',
           'MUSIC_GAME_CHUNK_SECONDS':os.environ.get('MUSIC_GAME_CHUNK_SECONDS','8')})
     self.children.append(child)
    except OSError as e:state.update(stage='error',error=str(e)[:200],finished_at=time.time());save_json(directory/'state.json',state)
   return self.public(state)
 def asset(self,identifier,name):
  state=self.read(identifier)
  if state['stage']!='ready' or name not in state.get('files',{}):raise ValueError('该谱面文件尚未准备好')
  path=JOBS/identifier/name
  if not path.is_file():raise ValueError('谱面文件缺失，请重新生成')
  if hashlib.sha256(path.read_bytes()).hexdigest()!=state['files'][name]:raise ValueError('谱面文件校验失败，请重新生成')
  return path

def work(identifier):
 manager=Scores();state=manager.read(identifier);directory=JOBS/identifier;file=directory/'state.json'
 worker_lock=(directory/'.worker.lock').open('a')
 try:fcntl.flock(worker_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:
  worker_lock.close();raise ValueError('该出谱任务仍在运行，不能同时恢复')
 def stage(name,**kw):state.update(stage=name,**kw);save_json(file,state)
 def run(script,args):
  timeout=step_timeout(script,duration)
  stage(state['stage'],active_step=script,step_timeout_seconds=timeout,step_started_at=time.time())
  with (directory/'pipeline.log').open('ab',buffering=0) as log:
   log.write(f'\n[{script}] attempt={state["attempt"]} timeout={timeout}s\n'.encode())
   try:
    result=subprocess.run([str(PYTHON),str(BASE/script),*map(str,args)],stdout=log,stderr=subprocess.STDOUT,timeout=timeout,
     env={**os.environ,'PYTHONUNBUFFERED':'1','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1',
          'MUSIC_GAME_CHUNK_SECONDS':os.environ.get('MUSIC_GAME_CHUNK_SECONDS','8')})
   except subprocess.TimeoutExpired as error:
    log.write(f'[{script}] timed out after {timeout}s; partial progress retained\n'.encode())
    raise ValueError(f'出谱步骤 {script} 超过本地处理时限（{timeout}秒）；进度已保存在 pipeline.log，可稍后重试；原歌曲未修改') from error
  if result.returncode:raise ValueError(f'出谱步骤 {script} 未完成，请查看本地日志；原歌曲未修改')
 try:
  if state['stage']=='ready':return
  stage('queued',pid=os.getpid(),attempt=state.get('attempt',0)+1,error=None,finished_at=None)
  with (JOBS/'.engine.lock').open('a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX);source=Path(state['data_dir']);context,lyrics=source_context(source)
   if any(state[k]!=v for k,v in context.items()):raise ValueError('原始人声或歌词已改变，请重新生成')
   duration=float(json.loads((source/'preparation.json').read_text())['duration_seconds']);step_timeout('game_onnx.py',duration)
   vocal_path=source/lead_vocal_source(source)['file']
   if hashlib.sha256(vocal_path.read_bytes()).hexdigest()!=state['vocal_sha256']:raise ValueError('当前人声文件校验失败')
   # Reuse already measured analysis only if BOTH the audio and original text match.
   cache=None;reused=False
   if not state.get('force_recompute'):
    for candidate in sorted((BASE/'output').glob('*/score.json'),key=lambda p:p.stat().st_mtime,reverse=True):
     try:cached=json.loads(candidate.read_text())
     except (OSError,ValueError):continue
     if isinstance(cached,dict) and all(cached.get(k)==v for k,v in context.items()):cache=candidate;reused=True;break
   if reused:
    stage('engraving',reused_analysis=True)
    names=['score.json','vocal-score.musicxml','vocal-melody.mid','staff-score.pdf','numbered-score.pdf','numbered-score.svg','score-melody.wav','original-vocal.wav']
    names += [p.name for p in cache.parent.glob('staff-page-*.png')]
    if not all((cache.parent/name).exists() for name in names):raise ValueError('预先验证的谱面文件不完整')
    for name in names:shutil.copy2(cache.parent/name,directory/name)
   else:
    analysis=directory/'analysis'
    # A failed attempt may contain incomplete model output. Preserve it for
    # diagnosis, then rebuild the source-bound analysis under the same job ID.
    if analysis.exists() or analysis.is_symlink():
     previous=directory/f'analysis-attempt-{state["attempt"]-1}-{uuid.uuid4().hex[:8]}'
     analysis.rename(previous);stage(state['stage'],previous_analysis_directory=previous.name)
    if state.get('analysis_source_job_id'):
     previous=manager.read(state['analysis_source_job_id'])
     if any(previous.get(k)!=v for k,v in context.items() if k!='corrections_sha256'):raise ValueError('复用分析的来源已改变')
     shutil.copytree(JOBS/previous['id']/'analysis',analysis,symlinks=True)
     measured=json.loads((analysis/'rain-vocal-notes.json').read_text())
     if measured['source_sha256']!=state['vocal_sha256']:raise ValueError('已有音符分析与当前人声不匹配')
    else:
     analysis.mkdir();inputs=analysis/'alignment-inputs';inputs.mkdir();(inputs/'rain-vocals.wav').symlink_to(vocal_path)
     (inputs/'rain-vocals.txt').write_text('\n'.join(line for line in lyrics.splitlines() if not line.startswith('[')))
     transcription=None if state.get('force_recompute') else cached_transcription(context,duration,identifier)
     if transcription:
      shutil.copy2(transcription['path'],analysis/'rain-vocal-notes.json')
      stage('transcribing',reused_transcription_job_id=transcription['id'],reused_transcription_sha256=transcription['sha256'])
     else:
      stage('transcribing');run('game_onnx.py',[vocal_path,'--output',analysis/'rain-vocal-notes.json'])
     alignment=None if state.get('force_recompute') else cached_lyric_alignment(context,lyrics,duration)
     if alignment:
      shutil.copytree(alignment['directory'],analysis/'tifa-rain')
      (analysis/'tifa-rain/vocal.TextGrid').rename(analysis/'tifa-rain/rain-vocals.TextGrid')
      stage('aligning',reused_lyric_alignment_job_id=alignment['id'],reused_lyric_alignment_sha256=alignment['grid_sha256'])
     else:
      stage('aligning');run('run_tifa.py',[inputs/'rain-vocals.wav','--output-dir',analysis/'tifa-rain'])
    stage('refining')
    measured=json.loads((analysis/'rain-vocal-notes.json').read_text())
    if not measured.get('phrase_review_version'):run('refine_lyrics.py',['--data-dir',source,'--analysis-dir',analysis])
    run('phrase_review.py',['--data-dir',source,'--analysis-dir',analysis])
    run('review_candidates.py',['--data-dir',source,'--analysis-dir',analysis])
    run('apply_pitch_review.py',['--data-dir',source,'--analysis-dir',analysis])
    stage('checking');run('check_pitch_grid.py',['--data-dir',source,'--analysis-dir',analysis])
    stage('engraving');run('build_review_score.py',['--data-dir',source,'--analysis-dir',analysis,'--output-dir',directory,'--engrave'])
   final_context,_=source_context(source)
   if final_context!=context:raise ValueError('出谱期间主唱或歌词已改变，请对当前版本重新出谱')
   score=json.loads((directory/'score.json').read_text())
   allowed={'score.json','vocal-score.musicxml','vocal-melody.mid','staff-score.pdf','numbered-score.pdf','numbered-score.svg','score-melody.wav','original-vocal.wav'}
   allowed.update(p.name for p in directory.glob('staff-page-*.png'))
   files={name:hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in sorted(allowed)}
   stage('ready',finished_at=time.time(),files=files,summary=score['summary'],reused_analysis=reused)
 except Exception as e:stage('error',error=str(e)[:240],finished_at=time.time());raise
 finally:worker_lock.close()

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--run-job',required=True);work(parser.parse_args().run_job)
