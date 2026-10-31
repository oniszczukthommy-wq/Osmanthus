"""Resumable song creation -> streaming -> separation -> canonical project."""
from __future__ import annotations
import hashlib, importlib.util, json, os, re, shutil, subprocess, sys, threading, time, uuid
import urllib.error, urllib.request
from math import isfinite
from pathlib import Path
from project import ROOT, save_json

spec=importlib.util.spec_from_file_location('workbench_song_stream',ROOT.parent/'yinchao-streaming-20261024/server.py')
STREAM=importlib.util.module_from_spec(spec);spec.loader.exec_module(STREAM)
STREAM.ROOT=ROOT/'workflow';STREAM.ROOT.mkdir(exist_ok=True)
RUNS=STREAM.ROOT/'runs';RUNS.mkdir(exist_ok=True)
PROJECTS=ROOT/'projects';PROJECTS.mkdir(exist_ok=True)
TERMINAL=('ready','error','awaiting_selection')
TARGET_DURATION=(150,210)
LYRIC_TAGS=['intro','verse','chorus','break','verse','chorus','bridge','chorus','outro']
DEFAULT_VOICE='温暖醇厚的成年男声，主歌轻柔叙述，副歌舒展有力量，普通话自然清楚'
LYRIC_ATTEMPTS=3

def voice_listening_acceptance(job):
    """A listened excerpt cannot silently approve another song or voice request."""
    result={'voice_excerpt_accepted':False}
    file=RUNS/job['id']/'voice-listening-acceptance.json'
    if not file.exists():return result
    try:
        accepted=json.loads(file.read_text());audio=file.parent/'complete.mp3'
        matches=(accepted.get('status')=='user_listening_accepted' and accepted.get('project_id')==job['id'] and
                 accepted.get('scope')=='current_song_listened_excerpt_voice_quality_for_first_prototype' and
                 accepted.get('voice_description')==job.get('voice') and audio.is_file() and
                 hashlib.sha256(audio.read_bytes()).hexdigest()==accepted.get('source_complete_mp3_sha256'))
        if matches:result.update(voice_excerpt_accepted=True,voice_acceptance_scope=accepted['scope'],voice_accepted_excerpt_seconds=accepted['excerpt_range_seconds'])
    except (OSError,ValueError,KeyError,TypeError):pass
    return result

def compile_generation_prompt(arrangement,voice):
    """Keep the user's timbre request verbatim in the actual paid music input."""
    arrangement=str(arrangement).strip();voice=str(voice).strip()
    if not voice or len(voice)>240:raise ValueError('请描述想要的人声音色，不超过240字')
    if not 10<=len(arrangement)<=3000:raise ValueError('歌曲风格说明无效')
    prompt=f'人声音色与唱法要求：{voice.rstrip("。 ")}。\n编曲与结构：{arrangement}\n主唱的声线尽量前后一致，按上述人声要求表现段落情绪。'
    if len(prompt)>3000:raise ValueError('编曲与人声要求合计超过音潮3000字符限制，尚未提交生歌任务')
    return prompt

def compile_lyrics(song):
    """Validate before the paid call; v4.5 accepts 5000 characters, not 350."""
    sections=song['sections']
    if [s['tag'].lower() for s in sections]!=LYRIC_TAGS:
        raise ValueError('歌词段落格式不符合要求，尚未提交付费生歌任务')
    chunks=[]; sung=[]
    for section in sections:
        lines=section['lines']
        if not isinstance(lines,list) or not all(isinstance(x,str) and x.strip() for x in lines):
            raise ValueError('歌词格式无效，尚未提交付费生歌任务')
        tag=section['tag'].lower()
        expected=0 if tag in ('intro','break','outro') else 6 if tag=='bridge' else 8
        if len(lines)!=expected:raise ValueError('歌词行数不符合完整歌曲结构，尚未提交付费生歌任务')
        chunks.extend(['['+tag.upper()+']',*[x.strip() for x in lines],''])
        sung.extend(lines)
    lyrics='\n'.join(chunks).strip()
    characters=len(re.findall(r'[\u3400-\u9fff]', ''.join(sung)))
    # Character counts are a planning hint, not the provider's duration control.
    # Allow natural line lengths; the decoded audio is the duration gate.
    if not 320<=characters<=410 or len(lyrics)>5000:
        raise ValueError(f'完整歌曲歌词需320至410个汉字且不超过接口5000字符；本次为{characters}个汉字、{len(lyrics)}个含标签字符，尚未提交付费生歌任务')
    choruses=[s['lines'] for s in sections if s['tag'].lower()=='chorus']
    if any(c!=choruses[0] for c in choruses[1:]):raise ValueError('副歌歌词需保持一致，尚未提交付费生歌任务')
    return lyrics,characters

def lyric_repair_feedback(song,error):
    counts=[]
    sections=song.get('sections',[]) if isinstance(song,dict) else []
    for section in sections if isinstance(sections,list) else []:
        if not isinstance(section,dict):continue
        lines=section.get('lines',[])
        lengths=[len(re.findall(r'[\u3400-\u9fff]',line)) for line in lines if isinstance(line,str)] if isinstance(lines,list) else []
        counts.append({'tag':section.get('tag'),'line_han_characters':lengths})
    actual=sum(sum(row['line_han_characters']) for row in counts)
    measured={'actual_han_characters':actual,'over_maximum':max(0,actual-410),'below_minimum':max(0,320-actual),'sections':counts}
    return ('上一版未通过提交前检查：'+str(error)+'。程序实际计数：'+json.dumps(measured,ensure_ascii=False)+
            '。请重新写完整JSON，保留原创主题、9段结构和三遍相同副歌。共有46句演唱歌词，优先每句8个汉字，46×8=368字；'
            '副歌重复三次均计入总字数。超量时缩短整句表达，不要只改标签或漏算重复副歌。目标350至390字，允许320至410字。')

def valid_id(value):
    try:return str(uuid.UUID(str(value)))==str(value)
    except ValueError:return False

class Workflow:
    def __init__(self):
        self.lock=threading.RLock();self.jobs=STREAM.JOBS;self.running=set();self.artwork=None;self.recovery_issues={}
        for path in RUNS.glob('*/state.json'):
            identifier=path.parent.name
            try:
                job=json.loads(path.read_text(encoding='utf-8'))
                if (not isinstance(job,dict) or not valid_id(identifier) or job.get('id')!=identifier
                    or not isinstance(job.get('created_at'),(int,float)) or isinstance(job.get('created_at'),bool)
                    or not isfinite(job['created_at']) or not isinstance(job.get('events'),list)
                    or not all(isinstance(e,dict) and isinstance(e.get('type'),str) for e in job['events'])
                    or not all(isinstance(job.get(k),str) for k in ('title','status','stage'))
                    or ('submission_started' in job and not isinstance(job['submission_started'],bool))):
                    raise ValueError('invalid saved task')
                task_id=job.get('task_id')
                known_task=isinstance(task_id,str) and bool(task_id.strip())
                if task_id is not None and task_id!='' and not known_task:
                    raise ValueError('invalid saved provider task id')
                audio=path.parent/'complete.mp3'
                complete_audio=job.get('download_ready') is True and audio.is_file() and audio.stat().st_size>0
                provider_events={'submitted','provider_status','poll_connection_retry','stream_url_received','generation_done','download_ready'}
                paid_evidence=(known_task or bool(job.get('pipe_url')) or bool(job.get('audio_url'))
                    or job.get('status') not in ('lyrics','pending','error')
                    or any(event['type'] in provider_events for event in job['events']))
                # Older jobs may predate the explicit False flag. A provider ID
                # or an existing completed file is safe; missing fields alone
                # must never be interpreted as permission to submit again.
                if ('submission_started' not in job and not known_task and not complete_audio
                    or job.get('submission_started') is False and paid_evidence):
                    raise ValueError('saved submission evidence is incomplete or inconsistent')
                self.jobs[identifier]=job
            except (OSError,ValueError,KeyError,TypeError):
                self.jobs.pop(identifier,None)
                self.record_recovery_issue(identifier,'任务记录无法读取或校验失败，已停止恢复，需核对供应商原任务')

    def record_recovery_issue(self,identifier,message):
        if not valid_id(identifier):return
        issue={'id':identifier,'error':message,'detected_at':time.time(),'recovery_blocked':True}
        self.recovery_issues[identifier]=issue
        # Keep the original state file untouched, including its corrupt bytes.
        # A full/read-only disk must not prevent other projects from starting.
        try:
            folder=RUNS/identifier;folder.mkdir(parents=True,exist_ok=True)
            save_json(folder/'recovery-error.json',issue)
        except OSError:pass

    def creation_busy(self):
        # Provider-complete, unselected songs may still be downloading. They
        # incur no new generation and must not prevent the next creation.
        # Active generation, planning, and selected project preparation keep
        # the original admission guard.
        with self.lock:
            return any(identifier not in self.jobs or self.jobs[identifier].get('status')!='done' or
                       self.jobs[identifier].get('selected_for_preparation') for identifier in self.running)

    def public(self,job):
        with STREAM.LOCK:
            result=STREAM.public(job)
            result.update({k:job.get(k) for k in ('stage','brief','style','voice','voice_control','voice_exact_identity','lyrics','prompt','origin','project_id','pipeline_error','preparation_seconds')})
            result.update({k:job.get(k) for k in ('batch_id','candidate_slot','selected_for_preparation','instrumental')})
            result['project_ready']=job.get('stage')=='ready'
            result.update(voice_listening_acceptance(job))
            duration=job.get('duration_seconds')
            result['duration_check']={'target_min_seconds':150,'target_max_seconds':210,
                'actual_seconds':duration,'measurement':job.get('duration_measurement',('decoded_audio_frames' if job.get('stage')=='ready' else 'provider_reported') if duration else None),
                'status':('pass' if 150<=duration<=210 else 'outside_target') if isinstance(duration,(int,float)) and job.get('download_ready') else 'pending'}
            result['ready_seconds']=round(job['finished_at']-job['created_at'],3) if job.get('finished_at') else None
            result['lyrics_seconds']=job.get('lyrics_seconds')
            downloads=[e['at'] for e in job['events'] if e['type']=='download_ready']
            result['complete_file_seconds']=downloads[0] if downloads else None
            separating=[e['at'] for e in job['events'] if e['type']=='workflow_separating']
            ready=[e['at'] for e in job['events'] if e['type']=='workflow_ready']
            result['stem_preparation_seconds']=round(ready[-1]-separating[-1],3) if separating and ready and ready[-1]>=separating[-1] else None
            if job.get('finished_at'):result['elapsed_seconds']=round(job['finished_at']-job['created_at'],1)
            result['can_resume']=job.get('stage')=='error' and (not job.get('submission_started') or bool(job.get('task_id')) or job.get('download_ready'))
            return result

    def stage(self,job,stage,**values):
        with STREAM.LOCK:job.update(stage=stage,**values);STREAM.event(job,'workflow_'+stage)

    def list(self):return [self.public(j) for j in sorted(self.jobs.values(),key=lambda j:j['created_at'],reverse=True)]

    def start(self,body):
        identifier=body.get('request_id')
        if not valid_id(identifier):raise ValueError('缺少有效请求标识，请刷新页面重试')
        with self.lock:
            if identifier in self.jobs:return self.public(self.jobs[identifier])
            if identifier in self.recovery_issues or (RUNS/identifier).exists():
                raise ValueError('原任务记录需要核对，不能使用相同请求重新提交付费生成')
            if self.running:raise ValueError('已有歌曲正在生成或分轨，请等待当前任务完成')
            brief=str(body.get('brief','')).strip();style=str(body.get('style','中文流行')).strip();voice=str(body.get('voice',DEFAULT_VOICE)).strip()
            if not 3<=len(brief)<=2000:raise ValueError('请用3至2000字描述创作要求')
            if len(style)>60:raise ValueError('风格描述过长')
            if not voice or len(voice)>240:raise ValueError('请描述想要的人声音色，不超过240字')
            if not os.environ.get('DEEPSEEK_API_KEY') or not os.environ.get('YINCHAO_API_KEY'):raise ValueError('本机生成服务尚未配置')
            job={'id':identifier,'title':'新歌曲','brief':brief,'style':style,'voice':voice,'model':'v4.5',
                 'voice_control':'text_timbre_prompt','voice_exact_identity':False,
                 'created_at':time.time(),'status':'lyrics','stage':'lyrics','origin':'new_generation',
                 'events':[],'first_stream_seconds':None,'first_play_seconds':None,'done_seconds':None,
                 'download_ready':False,'submission_started':False,'buffering_events':0,'project_id':identifier}
            self.jobs[identifier]=job;STREAM.persist(job);self.launch(job)
            return self.public(job)

    def sources(self):
        result=[]
        old=ROOT.parent/'yinchao-streaming-20261024/runs'
        for path in old.glob('*/state.json'):
            try:
                job=json.loads(path.read_text());audio=path.parent/'complete.mp3'
                if valid_id(job['id']) and audio.exists():result.append({'key':'stream:'+job['id'],'title':job['title'],'path':audio})
            except (ValueError,KeyError):continue
        cases=json.loads((ROOT.parent/'provider-song-comparison-20261024/cases.json').read_text())['cases']
        for case in cases:
            audio=ROOT.parent/'provider-song-comparison-20261024/yinchao'/case['id']/'song.mp3'
            if audio.exists():result.append({'key':'case:'+case['id'],'title':case['title'],'path':audio})
        return result

    def import_existing(self,body):
        identifier=body.get('request_id')
        if not valid_id(identifier):raise ValueError('请求标识无效')
        with self.lock:
            if identifier in self.jobs:return self.public(self.jobs[identifier])
            if self.running:raise ValueError('当前已有任务正在处理')
            source=next((s for s in self.sources() if s['key']==body.get('source_key')),None)
            if not source:raise ValueError('请选择已有的完整歌曲')
            job={'id':identifier,'title':source['title'],'brief':'使用已有成品建立可编辑工程','style':'中文流行',
                 'voice':'原歌曲人声','model':'existing','created_at':time.time(),'status':'done','stage':'separating',
                 'origin':'existing_audio','source_key':source['key'],'events':[],'first_stream_seconds':None,'first_play_seconds':None,
                 'done_seconds':0,'download_ready':True,'buffering_events':0,'project_id':identifier}
            self.jobs[identifier]=job;STREAM.persist(job)
            shutil.copy2(source['path'],RUNS/identifier/'complete.mp3')
            self.launch(job);return self.public(job)

    def launch(self,job):
        with self.lock:
            if job['id'] in self.running:return
            self.running.add(job['id'])
        threading.Thread(target=self.run,args=(job,),daemon=True).start()

    def lyrics(self,job,folder=None,persist_result=True):
        from paid_usage import paid_call
        started=time.monotonic()
        request={'model':os.environ.get('DEEPSEEK_MODEL','deepseek-flash'),'thinking':{'type':'disabled'},
            'response_format':{'type':'json_object'},'temperature':.9,'max_tokens':2800,
            'messages':[{'role':'system','content':
                '你是原创华语歌曲的词作者及编曲规划助手。输出JSON，含title、style_prompt、sections。'
                'sections为9项，tag依次为intro,verse,chorus,break,verse,chorus,bridge,chorus,outro，每项含lines歌词数组。'
                'intro、break、outro的lines必须为空数组，表示器乐段。主歌各8行，副歌各8行，桥段6行，共46句。优先每句8个汉字，46×8=368字，副歌三次歌词逐字相同且重复均计入总字数。'
                '全部演唱歌词汉字350至390字，不要标点、占位音节或抄写已有歌曲。两段主歌内容发展，桥段换视角。'
                'title简短。style_prompt使用中文具体说明风格、速度、配器、前奏、主副歌对比、桥段减薄和自然尾奏，目标150至210秒。'
                'style_prompt不自行指定、替换或另加歌手声线；用户人声要求将由服务端原文加入最终生歌提示词。'
                '优先用户指定语种吐字自然、歌词可唱；人声描述是音色与唱法倾向，不宣称固定歌手身份。'},
                {'role':'user','content':json.dumps({'创作要求':job['brief'],'风格':job['style'],'人声':job['voice']},ensure_ascii=False)}]}
        folder=folder or RUNS/job['id'];folder.mkdir(parents=True,exist_ok=True);save_json(folder/'lyrics-request.json',request)
        key=os.environ['DEEPSEEK_API_KEY'];payload=folder/'lyrics-payload.json';save_json(payload,request)
        # curl receives auth through stdin; never expose it in command arguments.
        for attempt in range(LYRIC_ATTEMPTS):
            save_json(folder/f'lyrics-request-attempt-{attempt+1}.json',request)
            save_json(payload,request)
            with paid_call('text'):
                completed=subprocess.run(['curl','--noproxy','*','--silent','--show-error','--fail-with-body','--connect-timeout','10','--max-time','75',
                    '--header','@-','--data-binary','@'+str(payload),'https://api.deepseek.com/chat/completions'],
                    input=('Authorization: Bearer '+key+'\nContent-Type: application/json\n').encode(),capture_output=True,timeout=80)
            if completed.returncode:raise RuntimeError('写词服务连接失败；尚未提交付费生歌任务，可重试')
            response=json.loads(completed.stdout);save_json(folder/'lyrics-response.json',response)
            save_json(folder/f'lyrics-response-attempt-{attempt+1}.json',response)
            song=None
            try:
                song=json.loads(response['choices'][0]['message']['content'])
                lyrics,characters=compile_lyrics(song)
                arrangement=str(song['style_prompt']).strip()
                prompt=compile_generation_prompt(arrangement,job['voice'])
                break
            except (ValueError,KeyError,TypeError) as error:
                if attempt==LYRIC_ATTEMPTS-1:raise
                request['messages'].extend([{'role':'assistant','content':response['choices'][0]['message']['content']},
                    {'role':'user','content':lyric_repair_feedback(song,error)}])
                if persist_result:STREAM.event(job,'lyrics_repair',attempt=attempt+2)
                else:job['events'].append({'type':'lyrics_repair','attempt':attempt+2})
        with STREAM.LOCK:
            job.update(title=str(song['title'])[:48],prompt=prompt,arrangement_prompt=arrangement,lyrics=lyrics,lyric_usage=response.get('usage'),
                       lyrics_seconds=round(time.monotonic()-started,3),lyric_han_characters=characters,
                       generation_policy='full-song-lyrics-v2',target_duration_seconds=list(TARGET_DURATION))
            if persist_result:STREAM.persist(job)

    def run(self,job):
        try:
            if job.get('origin')=='existing_audio' and not (RUNS/job['id']/'complete.mp3').exists():
                source=next((s for s in self.sources() if s['key']==job.get('source_key')),None)
                if not source:raise ValueError('已有成品文件暂不可用，未提交付费生成')
                shutil.copy2(source['path'],RUNS/job['id']/'complete.mp3')
            if not job.get('download_ready'):
                if not job.get('instrumental') and not job.get('lyrics'):self.stage(job,'lyrics');self.lyrics(job)
                if job.get('submission_started') and not job.get('task_id'):
                    raise RuntimeError('上次提交结果不确定，已停止自动重发以避免重复扣费')
                self.stage(job,'generating',error=None,generation_error=None,pipeline_error=None)
                if self.artwork:
                    try:
                        art=self.artwork.ensure({'project_id':job['id'],'title':job['title'],'lyrics':job.get('lyrics',''),'style':job.get('style','中文流行')[:240],'source_sha256':''})
                        job['artwork_job_id']=art['id'];STREAM.persist(job)
                    except Exception:
                        STREAM.event(job,'artwork_unavailable',message='封面暂未准备好，歌曲生成继续')
                STREAM.worker(job)
                if not job.get('download_ready'):raise RuntimeError(job.get('error') or '完整歌曲尚未取得，可恢复已有任务')
            if self.artwork:
                try:
                    art=self.artwork.ensure({'project_id':job['id'],'title':job['title'],'lyrics':job.get('lyrics',''),'style':job.get('style','中文流行')[:240],
                        'source_sha256':hashlib.sha256((RUNS/job['id']/'complete.mp3').read_bytes()).hexdigest()})
                    job['artwork_job_id']=art['id'];STREAM.persist(job)
                except Exception:
                    STREAM.event(job,'artwork_unavailable',message='封面暂未准备好，歌曲播放和编辑继续可用')
            if job.get('batch_id') and not job.get('selected_for_preparation'):
                self.stage(job,'awaiting_selection',error=None,pipeline_error=None)
                return
            self.stage(job,'separating',error=None,pipeline_error=None)
            directory=PROJECTS/job['id']/'data';directory.mkdir(parents=True,exist_ok=True)
            command=[sys.executable,str(ROOT/'prepare.py'),'--source',str(RUNS/job['id']/'complete.mp3'),
                     '--output',str(directory),'--title',job['title'],'--project-id',job['id']]
            with (RUNS/job['id']/'preparation.log').open('ab') as log:
                result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
            if result.returncode:raise RuntimeError('分轨未完成，完整歌曲已保留；可只重试分轨，不重新生歌')
            meta=json.loads((directory/'preparation.json').read_text())
            if job.get('instrumental'):
                meta['instrumental']=True;save_json(directory/'preparation.json',meta)
            # Instantiate once to persist the canonical job ID as project ID.
            from project import Project
            project=Project(directory)
            if project.state['id']!=job['id']:raise RuntimeError('歌曲与工程标识不一致')
            self.stage(job,'ready',preparation_seconds=meta['separation_seconds'],duration_seconds=meta['duration_seconds'],
                       duration_measurement='decoded_audio_frames',finished_at=time.time(),error=None)
        except Exception as exc:
            self.stage(job,'error',pipeline_error=str(exc)[:700],error=str(exc)[:700])
        finally:
            with self.lock:
                self.running.discard(job['id'])
                # Selection can arrive just as a generation worker enters its
                # final awaiting-selection state. Do not lose that selection.
                if job.get('batch_id') and job.get('selected_for_preparation') and job.get('stage')=='awaiting_selection':
                    self.launch(job)

    def resume(self,identifier):
        with self.lock:
            job=self.jobs.get(identifier)
            if not job:raise ValueError('找不到该任务')
            if job.get('batch_id') and not job.get('selected_for_preparation'):
                raise ValueError('双方案候选请使用该批次的恢复或选择接口')
            if job.get('stage')=='ready':return self.public(job)
            if self.running and identifier not in self.running:raise ValueError('请先等待当前任务完成')
            if job.get('submission_started') and not job.get('task_id') and not job.get('download_ready'):
                raise ValueError('提交状态不确定，不能安全自动重发；已保留原请求记录')
            self.launch(job);return self.public(job)

    def recover(self):
        for job in sorted(self.jobs.values(),key=lambda j:j['created_at']):
            if job.get('batch_id'):continue  # Pair manager owns recovery and selection.
            if job.get('stage') not in TERMINAL:
                if job.get('submission_started') and not job.get('task_id') and not job.get('download_ready'):
                    self.stage(job,'error',pipeline_error='重启前提交结果不确定，未自动重新扣费')
                else:self.launch(job)

    def telemetry(self,identifier,body):
        job=self.jobs.get(identifier)
        if not job:raise ValueError('找不到该任务')
        kind=body.get('event')
        if kind not in ('playing','waiting','stalled','ended','error','pause','timeupdate'):raise ValueError('无效播放事件')
        with STREAM.LOCK:
            if kind=='playing' and job.get('first_play_seconds') is None:
                job['first_play_seconds']=round(time.time()-job['created_at'],3)
                job['first_play_before_done']=job['status'] not in ('done','error','fail','cancelled') and bool(job.get('pipe_url'))
            if kind in ('waiting','stalled') and job.get('first_play_seconds') is not None:job['buffering_events']+=1
        STREAM.event(job,'browser_'+kind,current_time=body.get('current_time'),source=body.get('source'),provider_status=job['status'])
