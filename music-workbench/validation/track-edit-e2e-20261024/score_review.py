"""Immutable, source-bound score edits; never writes vocal or mixer assets.

Analysis and human correction are separate: a candidate is rendered from an
existing score and becomes active only after an optimistic, durable save.
"""
from __future__ import annotations
from runtime_support import file_lock as fcntl
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import argparse, hashlib, json, math, os, subprocess, sys, threading, time, uuid

SOURCE_FIELDS=('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis','corrections_sha256')
LOCK_FIELDS=('midi','start_seconds','end_seconds','lyric_index','start_beats','end_beats')
FILES={'score.json','vocal-score.musicxml','vocal-melody.mid','staff-score.pdf',
       'numbered-score.pdf','numbered-score.svg','score-melody.wav','original-vocal.wav'}

def module():
 import scores
 return scores

def digest(path):return module().file_sha256(path)
def canonical(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def signature(context):return hashlib.sha256(canonical({k:context[k] for k in SOURCE_FIELDS}).encode()).hexdigest()
def snapshot(note,fields=LOCK_FIELDS):return {key:note.get(key) for key in fields}

def number(value,name):
 if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):raise ValueError(name+'必须是有限数字')
 return float(value)

def integer(value,name,minimum=0,maximum=None):
 if isinstance(value,bool) or not isinstance(value,int) or value<minimum or maximum is not None and value>maximum:raise ValueError(name+'无效')
 return value

def checked_score(score,context,lyrics):
 if any(score.get(k)!=context[k] for k in SOURCE_FIELDS if k!='corrections_sha256'):raise RuntimeError('演唱谱与当前原唱或歌词不一致，请刷新')
 chars=score.get('lyrics_characters',[])
 text=''.join(c for line in lyrics.splitlines() if line.strip() and not line.strip().startswith('[') for c in line if c.isalnum())
 if ''.join(c.get('char','') for c in chars)!=text:raise ValueError('谱面原歌词不完整，不能校订此版本')
 if [c.get('index') for c in chars]!=list(range(len(chars))):raise ValueError('歌词索引不完整')
 validate_notes(score)
 return score

def validate_notes(score):
 duration=number(score.get('duration_seconds'),'歌曲时长');seen=set();used=set();previous_seconds=previous_beats=0.;previous_lyric=-1
 notes=score.get('notes')
 if not isinstance(notes,list) or not notes or len(notes)>20000:raise ValueError('音符列表无效')
 for note in notes:
  identifier=note.get('id')
  if not isinstance(identifier,str) or not identifier or len(identifier)>100 or identifier in seen:raise ValueError('音符标识无效或重复')
  seen.add(identifier);integer(note.get('midi'),'MIDI音高',0,127)
  start,end=number(note.get('start_seconds'),'音符开始'),number(note.get('end_seconds'),'音符结束')
  left,right=number(note.get('start_beats'),'记谱开始'),number(note.get('end_beats'),'记谱结束')
  if not 0<=start<end<=duration+.000001 or start<previous_seconds-1e-6:raise ValueError('音符时间超出歌曲或互相重叠，请调整边界')
  if left<0 or right<=left or left<previous_beats-1e-6:raise ValueError('记谱时值互相重叠，请调整边界')
  previous_seconds=end;previous_beats=right
  index=note.get('lyric_index')
  if index is not None:
   integer(index,'歌词位置',0,len(score['lyrics_characters'])-1)
   if index in used:raise ValueError('同一歌词字不能重复分配到两个音符；延音请不分配新字')
   if index<=previous_lyric:raise ValueError('配字应保持原歌词先后顺序；请先解除旧配字，再重新对应')
   used.add(index);previous_lyric=index

def refresh_metadata(score,changed=()):
 chars=score['lyrics_characters'];used=set();review=[];changed=set(changed)
 for note in score['notes']:
  index=note.get('lyric_index');note['lyric']=chars[index]['char'] if index is not None else ''
  note['line_index']=chars[index]['line_index'] if index is not None else None
  if index is not None:used.add(index)
  if note['id'] in changed:
   note['manual_review_proposed']=True
   note['review_reasons']=list(dict.fromkeys([*note.get('review_reasons',[]),'用户校订候选，仍需核听确认']))
   note['pitch_listening_accepted']=False
  if note.get('review_reasons'):review.append({'note_id':note['id'],'at':note['start_seconds'],'lyric':note['lyric'],
    'measure':int(note['start_beats']//4)+1,'beat':note['start_beats']%4+1,'reasons':note['review_reasons']})
 score['unmapped_lyrics']=[deepcopy(c) for c in chars if c['index'] not in used]
 score['review_points']=review;score['accuracy_accepted']=False
 score['measure_count']=max(score.get('measure_count',1),math.ceil(max(n['end_beats'] for n in score['notes'])/4))
 score['summary'].update(note_count=len(score['notes']),lyric_characters=len(chars),mapped_characters=len(used),
   unmapped_characters=len(score['unmapped_lyrics']),flagged_notes=len(review))
 score['manual_review_note']='人工校订只改变符号谱与参考旋律，不改变实际原唱或混音；逐音确认不代表整谱验收。'
 return score

def quantize_note(score,note):
 bpm=number(score['bpm'],'速度');origin=number(score.get('notation_origin_seconds',0),'记谱起点')
 quantum=number(note.get('notation_quantum_beats',score.get('quarter_grid',.25)),'最小记谱单位')
 if bpm<=0 or quantum<=0:raise ValueError('记谱网格无效')
 start=max(0,round((note['start_seconds']-origin)*bpm/60/quantum)*quantum)
 end=max(start+quantum,round((note['end_seconds']-origin)*bpm/60/quantum)*quantum)
 note.update(start_beats=start,end_beats=end,quantized_start_seconds=origin+start*60/bpm,quantized_end_seconds=origin+end*60/bpm)

def apply_operations(base,operations,confirmed,request_id):
 if not isinstance(operations,list) or not 1<=len(operations)<=100:raise ValueError('请提供1至100项明确的谱面校订')
 score=deepcopy(base);changed=set()
 for ordinal,operation in enumerate(operations):
  if not isinstance(operation,dict):raise ValueError('谱面校订格式无效')
  kind=operation.get('type');identifier=operation.get('note_id');notes=score['notes']
  target=next((n for n in notes if n['id']==identifier),None)
  if kind!='add_note' and target is None:raise ValueError('找不到选中的音符，请重新定位')
  if kind=='update_note':
   if not set(operation)<={'type','note_id','midi','start_seconds','end_seconds','lyric_index'}:raise ValueError('不支持此谱面修改字段')
   if len(operation)<=2:raise ValueError('没有需要改变的音符字段')
   for key in ('midi','start_seconds','end_seconds','lyric_index'):
    if key in operation:target[key]=operation[key]
   if 'midi' in operation:target.update(midi_float=operation['midi'],cents_from_equal_temperament=0.,pitch_origin='user_score_review')
   if 'start_seconds' in operation or 'end_seconds' in operation:quantize_note(score,target)
   changed.add(identifier)
  elif kind=='split_note':
   if not set(operation)<={'type','note_id','at_seconds','midi','lyric_index'}:raise ValueError('不支持此拆分字段')
   at=number(operation.get('at_seconds'),'拆分位置')
   if not target['start_seconds']+.025<=at<=target['end_seconds']-.025:raise ValueError('拆分点应位于音符内部且两侧至少25毫秒')
   right=deepcopy(target);right['id']=identifier+'-s'+request_id.replace('-','')[:10]+str(ordinal)
   right.update(start_seconds=at,lyric_index=operation.get('lyric_index'))
   if 'midi' in operation:right.update(midi=operation['midi'],midi_float=operation['midi'],cents_from_equal_temperament=0.,pitch_origin='user_score_review')
   target['end_seconds']=at;quantize_note(score,target);quantize_note(score,right)
   notes.insert(notes.index(target)+1,right);changed.update((identifier,right['id']))
  elif kind=='add_note':
   if not set(operation)<={'type','start_seconds','end_seconds','midi','lyric_index'}:raise ValueError('不支持此新增音符字段')
   new={'id':'manual-'+request_id.replace('-','')[:12]+str(ordinal),'midi':operation.get('midi'),
    'midi_float':operation.get('midi'),'start_seconds':operation.get('start_seconds'),'end_seconds':operation.get('end_seconds'),
    'lyric_index':operation.get('lyric_index'),'review_reasons':[],'source_note_index':None,'voiced':True,
    'pitch_origin':'user_score_review','cents_from_equal_temperament':0.}
   number(new['start_seconds'],'开始秒');number(new['end_seconds'],'结束秒');quantize_note(score,new);notes.append(new);changed.add(new['id'])
  elif kind=='remove_note':
   if set(operation)!={'type','note_id'}:raise ValueError('删除音符参数无效')
   notes.remove(target);changed.add(identifier)
  else:raise ValueError('不支持的谱面校订操作')
 score['notes'].sort(key=lambda n:(n['start_seconds'],n['end_seconds']))
 validate_notes(score)
 for identifier,record in confirmed.items():
  note=next((n for n in score['notes'] if n['id']==identifier),None)
  if note is None or snapshot(note,record['fields'])!=record['note']:raise RuntimeError('该音符已有听辨确认；请先明确解除确认，再提交修改')
 refresh_metadata(score,changed)
 return score,sorted(changed)

class ScoreReviews:
 def __init__(self,scores_manager=None):
  self.scores=scores_manager or module().Scores();self.children=[];self.thread_lock=threading.Lock()
 def _folder(self,context):return module().ROOT/'score-reviews'/context['project_id']/signature(context)
 def _context(self,directory,verify_audio=False):
  context,lyrics=module().source_context(Path(directory))
  if not module().valid_id(context.get('project_id')):raise ValueError('歌曲工程标识无效')
  if verify_audio:
   from vocal_sources import lead_vocal_source
   vocal=lead_vocal_source(directory);path=(Path(directory)/vocal['file']).resolve()
   if not path.is_relative_to(Path(directory).resolve()) or digest(path)!=context['vocal_sha256']:raise RuntimeError('原唱文件校验失败，未保存校订')
  return context,lyrics
 def _score(self,identifier,context,lyrics,expected_sha=None):
  state=self.scores.read(identifier)
  if state.get('stage')!='ready' or any(state.get(k)!=context[k] for k in SOURCE_FIELDS):raise RuntimeError('谱面来源或版本已变化，请刷新后重新校订')
  path=self.scores.asset(identifier,'score.json');actual=digest(path)
  if expected_sha is not None and actual!=expected_sha:raise RuntimeError('谱面文件版本已变化，请重新载入')
  score=checked_score(json.loads(path.read_text()),context,lyrics)
  return state,score,actual
 def _default(self,directory,context,lyrics):
  candidates=[]
  for _,state,_ in module().cached_states(module().JOBS):
   if state.get('kind')=='manual_review_candidate' or state.get('stage')!='ready':continue
   if all(state.get(k)==context[k] for k in SOURCE_FIELDS):candidates.append(state)
  original=max(candidates,key=lambda s:s['created_at']) if candidates else None
  state={'schema_version':1,'source':{k:context[k] for k in SOURCE_FIELDS},'review_revision':0,
   'base_score_job_id':original['id'] if original else None,'active_score_job_id':original['id'] if original else None,
   'active_score_sha256':None,'confirmed_notes':{},'history':[],'requests':{},'updated_at':None}
  if original:
   _,score,sha=self._score(original['id'],context,lyrics);state['active_score_sha256']=sha
   whole=self.scores.public(original).get('accuracy_accepted',False)
   for note in score['notes']:
    fields=LOCK_FIELDS if whole else ('midi',) if note.get('pitch_listening_accepted') else ()
    if fields:state['confirmed_notes'][note['id']]={'fields':list(fields),'note':snapshot(note,fields),
      'confirmation_scope':'legacy_whole_score' if whole else 'legacy_pitch_only','confirmed_at':None,'score_job_id':original['id']}
  return state
 def _load(self,directory,context,lyrics):
  path=self._folder(context)/'state.json'
  if not path.exists():return self._default(directory,context,lyrics)
  try:state=json.loads(path.read_text())
  except (OSError,ValueError) as exc:raise RuntimeError('校订记录读取失败，未回退覆盖已确认内容') from exc
  if state.get('source')!={k:context[k] for k in SOURCE_FIELDS}:raise RuntimeError('校订来源不匹配，请重新核对')
  # A candidate snapshot is not a committed human version. Before the first
  # save, a later valid automatic score may become the fresh editing base.
  if state.get('review_revision',0)==0 and not state.get('confirmed_notes'):return self._default(directory,context,lyrics)
  return state
 @contextmanager
 def _locked(self,context):
  folder=self._folder(context);folder.mkdir(parents=True,exist_ok=True)
  with self.thread_lock,(folder/'.lock').open('a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX);yield folder
 def _public(self,state):
  prior=(module().ROOT/'score-reviews'/state['source']['project_id'])
  old_sources=any(p.parent!=self._folder(state['source']) for p in prior.glob('*/state.json')) if prior.exists() else False
  return {'project_id':state['source']['project_id'],'source':state['source'],'review_revision':state['review_revision'],
    'base_score_job_id':state['base_score_job_id'],'active_score_job_id':state['active_score_job_id'],
    'active_score_sha256':state['active_score_sha256'],'confirmed_note_ids':list(state['confirmed_notes']),
    'confirmed_notes':state['confirmed_notes'],'history_count':len(state['history']),'updated_at':state['updated_at'],
    'other_source_reviews_exist':old_sources,'whole_score_accuracy_accepted':False}
 def get(self,directory):
  context,lyrics=self._context(directory);return self._public(self._load(directory,context,lyrics))
 def _request(self,body,context,state):
  if body.get('project_id')!=context['project_id']:raise RuntimeError('歌曲已切换，请刷新当前工程')
  identifier=body.get('request_id')
  if not module().valid_id(identifier):raise ValueError('缺少有效的校订请求标识')
  revision=integer(body.get('review_revision'),'校订版本')
  if revision!=state['review_revision']:raise RuntimeError('校订版本已变化，请刷新后重试；未覆盖另一处保存')
  if body.get('score_job_id')!=state['active_score_job_id']:raise RuntimeError('当前谱面已变化，请在已保存版本上重新校订')
  return identifier
 def start_candidate(self,project,body):
  directory=project.directory;context,lyrics=self._context(directory,True)
  if project.state['id']!=context['project_id'] or body.get('project_id')!=context['project_id']:raise RuntimeError('谱面与工程不匹配')
  with self._locked(context) as folder:
   state=self._load(directory,context,lyrics);identifier=body.get('request_id')
   existing=module().JOBS/str(identifier)/'state.json'
   payload=hashlib.sha256(canonical(body).encode()).hexdigest()
   if existing.exists():
    old=self.scores.read(identifier)
    if (old.get('kind')!='manual_review_candidate' or old.get('request_sha256')!=payload or
        any(old.get(k)!=context[k] for k in SOURCE_FIELDS)):raise ValueError('同一校订请求不能用于不同操作或来源')
    return self.scores.public(old)
   self._request(body,context,state)
   original,score,sha=self._score(state['active_score_job_id'],context,lyrics,body.get('score_sha256'))
   if not isinstance(body.get('score_sha256'),str):raise ValueError('缺少谱面文件校验值')
   candidate,changed=apply_operations(score,body.get('operations'),state['confirmed_notes'],identifier)
   candidate['manual_score_review']={'source_score_job_id':original['id'],'base_review_revision':state['review_revision'],
     'changed_note_ids':changed,'saved':False,'operations':deepcopy(body['operations'])}
   job={**context,'id':identifier,'data_dir':str(Path(directory).resolve()),'created_at':time.time(),'stage':'queued',
    'kind':'manual_review_candidate','base_review_revision':state['review_revision'],'base_score_job_id':original['id'],
    'base_score_sha256':sha,'request_sha256':payload,'changed_note_ids':changed,'reused_analysis':True}
   target=module().JOBS/identifier;target.mkdir()
   module().save_json(target/'review-input.json',candidate);module().save_json(target/'state.json',job)
   # Only metadata is locked. MuseScore/FluidSynth run in an independent process.
   if not (folder/'state.json').exists():module().save_json(folder/'state.json',state)
  try:
   with (target/'worker.log').open('ab') as log:
    process=subprocess.Popen([str(module().PYTHON),str(Path(__file__).resolve()),'--run-job',identifier],stdout=log,stderr=log,
      start_new_session=True,env={**os.environ,'MUSIC_WORKBENCH_ROOT':str(module().ROOT),'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
    self.children=[p for p in self.children if p.poll() is None];self.children.append(process)
  except OSError as exc:
   job.update(stage='error',finished_at=time.time(),error='校订参考排版未启动，原谱与原唱保留：'+str(exc)[:120]);module().save_json(target/'state.json',job)
  return self.scores.public(job)
 def save(self,project,body):
  directory=project.directory;context,lyrics=self._context(directory,True)
  if project.state['id']!=context['project_id'] or body.get('project_id')!=context['project_id']:raise RuntimeError('歌曲已切换，请刷新')
  identifier=body.get('request_id')
  if not module().valid_id(identifier):raise ValueError('缺少有效的保存请求标识')
  request_hash=hashlib.sha256(canonical(body).encode()).hexdigest()
  with self._locked(context) as folder:
   state=self._load(directory,context,lyrics)
   if identifier in state['requests']:
    if state['requests'][identifier]!=request_hash:raise ValueError('同一保存请求不能用于不同内容')
    return {'review':self._public(state),'job':self.scores.public(self.scores.read(state['active_score_job_id'])),'replayed':True}
   if integer(body.get('review_revision'),'校订版本')!=state['review_revision']:raise RuntimeError('校订版本已变化，请刷新；未覆盖其他保存')
   score_id=body.get('score_job_id')
   job,score,sha=self._score(score_id,context,lyrics,body.get('score_sha256'))
   if not isinstance(body.get('score_sha256'),str):raise ValueError('缺少谱面文件校验值')
   if score_id!=state['active_score_job_id']:
    if (job.get('kind')!='manual_review_candidate' or job.get('base_review_revision')!=state['review_revision'] or
        job.get('base_score_job_id')!=state['active_score_job_id'] or job.get('base_score_sha256')!=state['active_score_sha256']):
     raise RuntimeError('候选基于旧的校订版本，请重新生成候选')
   confirm=body.get('confirm_note_ids',[]);unconfirm=body.get('unconfirm_note_ids',[])
   for value in (confirm,unconfirm):
    if not isinstance(value,list) or len(value)>20000 or any(not isinstance(v,str) for v in value) or len(set(value))!=len(value):raise ValueError('确认音符列表无效')
   if set(confirm)&set(unconfirm):raise ValueError('不能同时确认和解除同一音符')
   notes={n['id']:n for n in score['notes']}
   if any(v not in notes for v in confirm) or any(v not in state['confirmed_notes'] for v in unconfirm):raise ValueError('确认目标已变化，请重新选择')
   for key,record in state['confirmed_notes'].items():
    if key not in unconfirm and (key not in notes or snapshot(notes[key],record['fields'])!=record['note']):raise RuntimeError('候选改动了已确认内容，未保存')
   now=time.time()
   for key in unconfirm:state['confirmed_notes'].pop(key)
   for key in confirm:state['confirmed_notes'][key]={'fields':list(LOCK_FIELDS),'note':snapshot(notes[key]),
     'confirmation_scope':'selected_note_pitch_timing_lyric_only','confirmed_at':now,'score_job_id':score_id}
   old=state['active_score_job_id'];state.update(active_score_job_id=score_id,active_score_sha256=sha,
     review_revision=state['review_revision']+1,updated_at=now)
   state['history'].append({'revision':state['review_revision'],'previous_score_job_id':old,'score_job_id':score_id,
     'confirmed_note_ids':confirm,'unconfirmed_note_ids':unconfirm,'at':now})
   state['requests'][identifier]=request_hash
   while len(state['requests'])>100:state['requests'].pop(next(iter(state['requests'])))
   module().save_json(folder/'state.json',state)
   return {'review':self._public(state),'job':self.scores.public(job)}

def active_saved_score(directory,context):
 """Return a saved user version before automatic analysis can replace it."""
 path=module().ROOT/'score-reviews'/context['project_id']/signature(context)/'state.json'
 if not path.exists():
  context_now,lyrics=module().source_context(Path(directory))
  state=ScoreReviews()._default(directory,context_now,lyrics)
  if not state['confirmed_notes']:return None
 else:
  try:state=json.loads(path.read_text())
  except (OSError,ValueError) as exc:raise RuntimeError('已保存校订记录无法读取，未回退覆盖') from exc
 if state.get('review_revision',0)<1 and not state.get('confirmed_notes'):return None
 # User-listening records already present before this UI remain protected.
 if state.get('source')!={k:context[k] for k in SOURCE_FIELDS}:raise RuntimeError('已保存校订来源不匹配，未自动覆盖')
 manager=module().Scores();job=manager.read(state['active_score_job_id'])
 if job.get('stage')!='ready' or any(job.get(k)!=context[k] for k in SOURCE_FIELDS):raise RuntimeError('已保存校订版本不可用，原记录保留')
 if job['files'].get('score.json')!=state['active_score_sha256'] or digest(manager.asset(job['id'],'score.json'))!=state['active_score_sha256']:raise RuntimeError('已保存谱面校验失败，未自动覆盖')
 result=manager.public(job);result.update(review_revision=state['review_revision'],review_preserved=True,confirmed_note_count=len(state['confirmed_notes']))
 return result

def render_job(identifier,renderer=None):
 manager=module().Scores();state=manager.read(identifier);folder=module().JOBS/identifier
 if state.get('kind')!='manual_review_candidate':raise ValueError('不是人工校订候选')
 def stage(value,**fields):state.update(stage=value,**fields);module().save_json(folder/'state.json',state)
 try:
  stage('engraving',pid=os.getpid())
  with (module().JOBS/'.engine.lock').open('a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   directory=Path(state['data_dir']);review=ScoreReviews(manager);context,lyrics=review._context(directory,True)
   if any(state.get(k)!=context[k] for k in SOURCE_FIELDS):raise RuntimeError('排版期间原唱或歌词已变化，请重新校订')
   score=checked_score(json.loads((folder/'review-input.json').read_text()),context,lyrics)
   if renderer is None:
    sys.path.insert(0,str(module().BASE));from build_review_score import engrave
    renderer=engrave
   renderer(score,folder,directory)
   # All public artifacts come from this one proposed score; no analysis rerun.
   module().save_json(folder/'score.json',score)
   final,_=review._context(directory,True)
   if any(final[k]!=context[k] for k in SOURCE_FIELDS):raise RuntimeError('原唱或歌词已变化，未发布校订候选')
   pages={p.name for p in folder.glob('staff-page-*.png')}
   if not pages:raise ValueError('五线谱预览文件缺失，原谱保留')
   allowed=FILES|pages
   if not all((folder/name).is_file() for name in allowed):raise ValueError('校订排版产物不完整，原谱保留')
   stage('ready',files={name:digest(folder/name) for name in sorted(allowed)},summary=score['summary'],finished_at=time.time(),reused_analysis=True)
 except Exception as exc:
  stage('error',error=str(exc)[:240],finished_at=time.time());raise

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--run-job',required=True);args=parser.parse_args();render_job(args.run_job)
