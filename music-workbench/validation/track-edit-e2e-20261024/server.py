"""Loopback-only shared audio project; dialogue and manual edit share one reducer."""
from __future__ import annotations
from runtime_support import media_binary
import errno, hashlib, json, mimetypes, os, re, subprocess, tempfile, threading, time, uuid
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from media_paths import media_file
from paid_usage import paid_call, PaidUsageError
from urllib.parse import unquote, urlparse
import numpy as np
import soundfile as sf
from runtime_support import load_env
load_env(Path(__file__).resolve().parent.parent/'.env.local')
from empty_project import EmptyProject
from project import Project, ROOT, DATA, save_json
os.environ.setdefault('MUSIC_WORKBENCH_ROOT',str(ROOT))
from workflow import Workflow, STREAM, PROJECTS, valid_id
from generation_pairs import GenerationPairs
from generation_drafts import GenerationDrafts
from create_flow import CreationFlow, fields as creation_fields
from mv_bridge import MVHandoffs, proxy_mv
from speech import SpeechInput,MAX_BYTES as MAX_SPEECH_BYTES
from artwork import Artwork
from share import ShareManager
from instruments import Instruments
from arrangements import Arrangements
from scores import Scores
from vocals import Vocals,PRESETS
from voice_library import VoiceLibrary
from lyrics import Lyrics
from inspiration import generate as generate_inspiration
from svc import Conversions
from sections import Sections, resolve_reference
from score_review import ScoreReviews
from candidate_review import CandidateReviews


LOCK=threading.RLock()
PORT=int(os.environ.get('MUSIC_EDITOR_PORT','8603'))
MV_PORT=int(os.environ.get('MUSIC_MV_PORT','8792'))
DATA=Path(os.environ.get('MUSIC_EDITOR_DATA_DIR',str(DATA)))
LEGACY_DATA=DATA
LEGACY_ID=json.loads((LEGACY_DATA/'project.json').read_text())['id'] if (LEGACY_DATA/'project.json').is_file() else None
ACTIVE_FILE=(DATA.parent if os.environ.get('MUSIC_EDITOR_DATA_DIR') else ROOT)/'active-project.json'

def project_directory(identifier):
    if LEGACY_ID and identifier==LEGACY_ID:return LEGACY_DATA
    if not valid_id(identifier):raise ValueError('工程标识无效')
    directory=PROJECTS/identifier/'data'
    if not (directory/'project.json').exists():raise ValueError('该歌曲的工程尚未准备好')
    saved=json.loads((directory/'project.json').read_text())
    if saved.get('id')!=identifier:raise ValueError('工程标识不匹配')
    return directory

if ACTIVE_FILE.exists():
    try:DATA=project_directory(json.loads(ACTIVE_FILE.read_text())['id'])
    except (ValueError,KeyError):DATA=LEGACY_DATA
PROJECT=Project(DATA) if (DATA/'preparation.json').is_file() else EmptyProject(DATA)
ARTWORK=Artwork()
SHARES=ShareManager()
WORKFLOW=Workflow()
WORKFLOW.artwork=ARTWORK
GENERATION_PAIRS=GenerationPairs(WORKFLOW)
GENERATION_DRAFTS=GenerationDrafts(GENERATION_PAIRS)
CREATE_FLOW=CreationFlow(GENERATION_PAIRS,GENERATION_DRAFTS)
SPEECH=SpeechInput()
INSTRUMENTS=Instruments()
ARRANGEMENTS=Arrangements()
SCORES=Scores()
VOCALS=Vocals()
VOICE_LIBRARY=VoiceLibrary()
LYRICS=Lyrics()
CONVERSIONS=Conversions()
SECTIONS=Sections()
SCORE_REVIEWS=ScoreReviews(SCORES)
CANDIDATE_REVIEWS=CandidateReviews()
FFMPEG=media_binary('ffmpeg')
MV_HANDOFFS=MVHandoffs(ROOT,FFMPEG)
EXPORTS=DATA.parent/'exports' if os.environ.get('MUSIC_EDITOR_DATA_DIR') else ROOT/'exports'
EXPORTS.mkdir(exist_ok=True)
AUDITS=ROOT/'audits'; AUDITS.mkdir(exist_ok=True)

def send_file_chunk(connection,data):
    # sendall cannot report its committed prefix after ENOBUFS. Track each
    # successful send so transient local buffer pressure never duplicates data.
    view=memoryview(data);deadline=time.monotonic()+30
    while view:
        try:
            sent=connection.send(view)
            if not sent:return False
            view=view[sent:];deadline=time.monotonic()+30
        except (BrokenPipeError,ConnectionResetError):return False
        except OSError as error:
            if error.errno not in (errno.ENOBUFS,errno.EAGAIN,errno.EWOULDBLOCK,errno.EINTR) or time.monotonic()>deadline:raise
            time.sleep(.01)
    return True

def check_context(body):
    if body.get('project_id')!=PROJECT.state['id']:raise RuntimeError('当前工程已切换，请刷新工程后重试')
    PROJECT.check_revision(body.get('revision'))

def artwork_reference(identifier):
    if not valid_id(identifier):raise ValueError('歌曲标识无效')
    job=WORKFLOW.jobs.get(identifier)
    if job and job.get('download_ready'):
        file=STREAM.ROOT/'runs'/identifier/'complete.mp3'
        if not file.is_file():raise ValueError('歌曲完整音频尚未准备好')
        return {'project_id':identifier,'title':job['title'],'lyrics':job.get('lyrics',''),'style':job.get('style','中文流行'),
                'source_sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
    directory=project_directory(identifier);meta=json.loads((directory/'preparation.json').read_text());state=json.loads((directory/'project.json').read_text())
    source=WORKFLOW.jobs.get(meta.get('generation_job_id'),{})
    return {'project_id':identifier,'title':state['title'],'lyrics':source.get('lyrics',''),'style':source.get('style','中文流行'),'source_sha256':meta['source_sha256']}

def song_lyrics(identifier,start=False):
    job=WORKFLOW.jobs.get(identifier)
    if not job:raise ValueError('找不到该歌曲')
    if job.get('instrumental'):return {'lyrics':'','job':None,'instrumental':True,'can_align':False}
    try:directory=project_directory(identifier)
    except ValueError:directory=None
    if directory:return LYRICS.start(directory) if start else {**LYRICS.latest(directory),'can_align':True}
    audio=STREAM.ROOT/'runs'/identifier/'complete.mp3'
    if not job.get('download_ready') or not audio.is_file():
        if start:raise ValueError('完整音频就绪后才能同步歌词')
        return {'lyrics':job.get('lyrics',''),'job':None,'can_align':False}
    return LYRICS.start_generated(job,audio) if start else {**LYRICS.latest_generated(job,audio),'can_align':True}

def share_artwork(identifier,source_sha256):
    job=ARTWORK.latest(identifier)
    if not job or job['stage']!='ready' or job.get('source_sha256')!=source_sha256:return None
    file=ARTWORK.asset(job['id'],'cover.png')
    result={'project_id':identifier,'source_sha256':source_sha256,'cover':{'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}}
    accepted=ROOT.parent.parent/'docs/product/cover-poster-test-20261028/xiang-hai-poster-v2.png'
    if identifier=='7f5dc507-ebff-4095-b35c-a0f31c718f66' and accepted.is_file():
        result['poster']={'path':str(accepted),'sha256':hashlib.sha256(accepted.read_bytes()).hexdigest()}
    return result

def export_directory(identifier):
    directory=project_directory(identifier)
    result=(ROOT if directory==LEGACY_DATA and not os.environ.get('MUSIC_EDITOR_DATA_DIR') else directory.parent)/'exports'
    result.mkdir(exist_ok=True);return result

def export_audio(body,started):
    kind=body.get('format','wav')
    if kind not in ('wav','mp3'):raise ValueError('请选择WAV或MP3')
    with LOCK:
        check_context(body)
        snapshot=PROJECT.audio_snapshot()
        directory=export_directory(snapshot.state['id'])
    if body.get('scope','mix')!='mix':
        from export_parts import export_parts
        return export_parts(snapshot,body,directory,FFMPEG)
    # Expensive rendering and encoding use frozen settings outside the edit lock.
    mix=snapshot.mix();revision=snapshot.state['revision'];fingerprint=snapshot.fingerprint()
    peak=float(np.max(np.abs(mix)))
    if peak>1:raise ValueError('当前混音峰值超过0dBFS，请降低轨道音量后导出，避免削波')
    stem=f'song-r{revision}-{fingerprint[:10]}'
    wav=directory/(stem+'.wav');temporary=directory/(stem+'.'+uuid.uuid4().hex[:8]+'.tmp.wav')
    try:sf.write(temporary,mix,snapshot.sr,subtype='PCM_24');os.replace(temporary,wav)
    finally:temporary.unlink(missing_ok=True)
    output=wav
    if kind=='mp3':
        output=directory/(stem+'.mp3');temporary=directory/(stem+'.'+uuid.uuid4().hex[:8]+'.tmp.mp3')
        try:
            result=subprocess.run([str(FFMPEG),'-nostdin','-y','-v','error','-i',str(wav),'-codec:a','libmp3lame','-b:a','256k',str(temporary)],capture_output=True,timeout=60)
            if result.returncode:raise ValueError('MP3编码失败；WAV已保留')
            os.replace(temporary,output)
        finally:temporary.unlink(missing_ok=True)
    report={'revision':revision,'fingerprint':fingerprint,'format':kind,'filename':output.name,
            'url':f'/exports/{snapshot.state["id"]}/'+output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
            'bytes':output.stat().st_size,'duration':len(mix)/snapshot.sr,'peak':peak,'elapsed_seconds':round(time.perf_counter()-started,3),
            'tracks':snapshot.state['tracks'],'project_id':snapshot.state['id'],'generation_job_id':snapshot.meta.get('generation_job_id')}
    report_file=directory/(stem+'-'+kind+'.json');temp_report=report_file.with_name('.'+report_file.name+'.'+uuid.uuid4().hex[:8]+'.tmp')
    try:temp_report.write_text(json.dumps(report,ensure_ascii=False,indent=2));os.replace(temp_report,report_file)
    finally:temp_report.unlink(missing_ok=True)
    return report

def mv_source(identifier,expected=None,freeze=False):
    if not valid_id(identifier):raise ValueError('歌曲标识无效')
    with LOCK:
        try:directory=project_directory(identifier)
        except ValueError:directory=None
        reference=artwork_reference(identifier)
        if directory:
            source=PROJECT if PROJECT.state['id']==identifier else Project(directory)
            info={'project_id':identifier,'title':source.state['title'],'source_kind':'current_mix','revision':source.state['revision'],'fingerprint':source.fingerprint(),'duration':source.meta['duration_seconds']}
            if expected and any(expected.get(k)!=info[k] for k in ('source_kind','revision','fingerprint')):raise RuntimeError('歌曲混音已变化，请重新点击创作MV')
            if freeze:info['snapshot']=source.audio_snapshot()
        else:
            job=WORKFLOW.jobs.get(identifier)
            if not job or not job.get('download_ready'):raise ValueError('歌曲完整音频尚未准备好')
            info={'project_id':identifier,'title':job['title'],'source_kind':'generated_original','revision':None,'fingerprint':reference['source_sha256'],'duration':job.get('duration_seconds')}
            if expected and any(expected.get(k)!=info[k] for k in ('source_kind','revision','fingerprint')):raise RuntimeError('歌曲来源已变化，请重新点击创作MV')
            if freeze:info['audio_file']=STREAM.ROOT/'runs'/identifier/'complete.mp3'
        info['lyrics']=reference.get('lyrics','');info['style']=reference.get('style','中文流行');info['timed_lyrics']=[]
        art=ARTWORK.latest(identifier);info['cover_url']=art.get('cover_url') if art and art.get('stage')=='ready' else None
        if directory:
            try:
                timing=LYRICS.latest(directory).get('job')
                if timing and timing.get('stage')=='ready':
                    for line in timing.get('lines',[]):
                        start=line.get('start_seconds',line.get('start'));end=line.get('end_seconds',line.get('end'))
                        if isinstance(start,(int,float)) and isinstance(end,(int,float)) and 0<=start<end<=info['duration']+.15:info['timed_lyrics'].append({'start':start,'end':end,'text':line.get('text','')})
            except (ValueError,RuntimeError,OSError):pass
        return info

def assistant(body):
    global PROJECT
    text=str(body.get('message','')).strip()
    if not text or len(text)>4000: raise ValueError('请输入不超过4000字的修改要求')
    with LOCK:
        check_context(body)
        context={'duration_seconds':PROJECT.meta['duration_seconds'],
                 'tracks':[{'id':t['id'],'label':t['label'],'range_seconds':t.get('range_seconds'),**PROJECT.state['tracks'][t['id']]}
                           for t in PROJECT.meta['tracks'] if t['id'] in PROJECT.state['tracks'] and not PROJECT.state['tracks'][t['id']].get('removed')],
                 'selection':body.get('selection'), 'revision':PROJECT.state['revision']}
        manifest=PROJECT.directory/'vocal-variants.json'
        voice_candidates=list(reversed(json.loads(manifest.read_text())['variants'])) if manifest.exists() else []
        context['vocal_candidates']=[{k:v[k] for k in ('id','label','preset_id')} for v in voice_candidates if not v.get('rejected_by_user')]
        context['current_vocal_variant']=PROJECT.state['tracks'].get('vocals',{}).get('voice_variant','original')
        active_ids=[name for name,t in PROJECT.state['tracks'].items() if not t.get('removed')]
        context['instrument_presence']={'piano':'unverified','guitar':'unverified'}
        navigation=SECTIONS.get(PROJECT.directory)
        musical_reference=resolve_reference(text,navigation)
        if musical_reference.get('status') in ('ambiguous','unavailable'):
            return {'project':PROJECT.view(),'applied':False,'message':musical_reference.get('message') or '这段音乐位置还不能唯一确定，请先在乐段或歌词导航中选择区间。','musical_reference':musical_reference}
        if musical_reference.get('status')=='resolved':
            context['selection']={**(context.get('selection') or {}),
                                  'start_seconds':musical_reference['start_seconds'],
                                  'end_seconds':musical_reference['end_seconds']}
            context['resolved_musical_reference']=musical_reference
        context['musical_sections']=[{k:s.get(k) for k in ('id','label','start_seconds','end_seconds','confirmed')} for s in navigation.get('sections',[])]
    def check_navigation():
        if PROJECT.state['id']!=body.get('project_id'):raise RuntimeError('歌曲已切换，请重新提出修改要求')
        if musical_reference.get('status')!='resolved':return
        current=SECTIONS.get(PROJECT.directory)
        if any(current.get(k)!=navigation.get(k) for k in ('source_fingerprint','sections_revision')):
            raise RuntimeError('乐段或歌词定位已更新，请按当前定位重新提出修改要求')
    tool={'type':'function','function':{'name':'edit_track_segment',
          'description':'对已有音轨的一个时间区间静音或设置相对原始轨道的音量。',
          'parameters':{'type':'object','properties':{
              'track_id':{'type':'string','enum':active_ids},
              'start_seconds':{'type':'number'},'end_seconds':{'type':'number'},
              'mode':{'type':'string','enum':['mute','gain','restore']},
              'gain_db':{'type':'number','minimum':-60,'maximum':6}},
              'required':['track_id','start_seconds','end_seconds','mode','gain_db'],
              'additionalProperties':False}}}
    piano_tool={'type':'function','function':{'name':'create_piano_accompaniment',
                'description':'根据原歌曲为一个时间区间新编钢琴伴奏候选，异步生成；完成后需加入工程才能听见。不是恢复已有钢琴，也不是分离原曲钢琴。',
                'parameters':{'type':'object','properties':{'start_seconds':{'type':'number'},'end_seconds':{'type':'number'}},
                              'required':['start_seconds','end_seconds'],'additionalProperties':False}}}
    reorchestrate_tool={'type':'function','function':{'name':'reorchestrate_as_guitar',
        'description':'把已加入的新编钢琴声部按木吉他六弦指法和扫弦重新编配为候选；完成后用户应用替换。只支持piano_add_开头的符号钢琴，不能用于原曲分离的piano。',
        'parameters':{'type':'object','properties':{'source_track_id':{'type':'string'},'start_seconds':{'type':'number'},'end_seconds':{'type':'number'}},
                      'required':['source_track_id','start_seconds','end_seconds'],'additionalProperties':False}}}
    vocal_tool={'type':'function','function':{'name':'create_vocal_take',
        'description':'按同一首歌固定旋律和歌词生成整曲绮萱主唱候选，不改伴奏、不自动应用。重新演唱一版时force_new=true；只准备首个候选时false。',
        'parameters':{'type':'object','properties':{'preset_id':{'type':'string','enum':['qixuan-2.7.0']},'force_new':{'type':'boolean'}},'required':['preset_id','force_new'],'additionalProperties':False}}}
    select_vocal_tool={'type':'function','function':{'name':'select_vocal_take',
        'description':'将当前歌曲已有的重唱候选应用为主唱，或original恢复原始演唱；保留伴奏和混音修改，可撤销。',
        'parameters':{'type':'object','properties':{'variant_id':{'type':'string','enum':['original',*[v['id'] for v in voice_candidates if not v.get('rejected_by_user')]]}},'required':['variant_id'],'additionalProperties':False}}}
    conversion_tool={'type':'function','function':{'name':'create_singing_conversion',
        'description':'使用已有抒情男声音色参考，保留原曲旋律、歌词和节奏，生成完整换声候选；异步、不自动应用，已有同来源候选会复用。',
        'parameters':{'type':'object','properties':{'voice_id':{'type':'string','enum':['226869000163476']}},'required':['voice_id'],'additionalProperties':False}}}
    remove_tool={'type':'function','function':{'name':'remove_project_track',
        'description':'仅在用户明确要求从工程移除整条轨道时使用，可撤销恢复。某个时间段去掉声音或静音属于片段编辑，不能调用此工具。',
        'parameters':{'type':'object','properties':{'track_id':{'type':'string','enum':active_ids}},'required':['track_id'],'additionalProperties':False}}}
    request={'model':os.environ.get('DEEPSEEK_MODEL','deepseek-flash'),
             'thinking':{'type':'disabled'},'temperature':0,'max_tokens':600,
             'messages':[{'role':'system','content':
                '你是音乐工作台操作助手。仅在用户明确要求时调用edit_track_segment。秒数以歌曲开始为零点；'
                '“这段/这里”使用selection；用户明确给出的轨道或秒数优先。'
                '静音mode=mute,gain_db=0；恢复原音量mode=restore,gain_db=0；降低6dB用mode=gain,gain_db=-6。'
                '“把已有贝斯加上/加回来”“不用去掉”“不要静音”“取消静音”都表示mode=restore，不能因为句子出现“去掉”二字就误判为mute。'
                '例如“30~45秒的时候把贝斯加上，不用去掉”必须恢复bass的30至45秒。'
                '恢复已有音轨不属于新增乐器。mode=restore会取消该轨整轨静音，并在其他轨独奏时让该轨也可听。'
                '音量是相对原始轨道的绝对设定，会覆盖选区内之前的静音/音量。'
                '起止或轨道不明确时先用中文询问，不能擅自猜测。'
                '可调用create_piano_accompaniment新编钢琴伴奏候选；整首为0到duration_seconds，明确区间优先，其次使用selection。'
                '新加钢琴与恢复已有钢琴不同；“加回来/恢复”用edit_track_segment的restore，不要误建新声部。'
                '新编仅支持钢琴；已加入的piano_add_钢琴可用reorchestrate_as_guitar重新编配木吉他候选。不要把此工具用于分离原曲piano、guitar或其他乐器。'
                '用户要把新编钢琴换成吉他/改成吉他扫弦时用reorchestrate_as_guitar；按指定区间，未指定则用selection与该轨range_seconds的交集；要求整条则用该轨range_seconds。'
                '生成候选不会自动替换；界面需点击应用替换。其他乐器、原曲音频重新编配、只换音色仍不支持，不可冒充完成。'
                '钢琴、吉他如已存在，可按piano、guitar轨道调整；未加入时提示准备器乐分轨并加入对应轨道，不能将other冒充独立乐器。'
                '如同时有“钢琴”和“新增钢琴”，按用户指定的标签选择；只说钢琴而有多条候选时先询问，不要猜。'
                '一次最多调用一个工具。工程信息：'+json.dumps(context,ensure_ascii=False)},
               {'role':'user','content':text}], 'tools':[tool,piano_tool,reorchestrate_tool,select_vocal_tool,conversion_tool,remove_tool]+([vocal_tool] if any(p.get('enabled') for p in PRESETS) else []),'tool_choice':'auto','stream':False}
    request['messages'][0]['content']+='明确要求“从工程删除整条轨道/移除轨道”才可用remove_project_track；按秒数或选区“去掉/静音”仍用edit_track_segment，不能删除整条轨道。'
    request['messages'][0]['content']+='原曲器乐存在性尚未可靠识别。不能从生成提示词、轨道名称、或分离模型输出了piano/guitar文件，就断言原曲确有对应乐器。被问到原曲有哪些乐器时如实说明尚未确认。用户明确要求新增伴奏才可新编钢琴；识别、分离、恢复或修改原曲乐器的请求不能用新编伴奏冒充完成。已加入的估计轨仍可按用户明确要求编辑，但不要宣称其乐器存在性已通过验收。'
    request['messages'][0]['content']+='歌手换声：目前支持已有音色库的抒情男声（voice_id=226869000163476），用create_singing_conversion准备完整歌曲候选，保留旋律歌词节奏，不自动应用。用户明确要求应用当前歌曲已有候选时直接用select_vocal_take，不重新生成候选；恢复原唱时variant_id=original。绮萱已被用户拒绝，不能生成或应用。其他声音尚未验证，不能冒充已支持。换声不等于改变旋律、歌词或演唱表现的新一遍演唱；这些新表现目前未开放，也不支持局部重唱。不要用调音量、移调或另造一首歌冒充换歌手。'
    request['messages'][0]['content']+='如果已有resolved_musical_reference，其start_seconds和end_seconds是本次音乐位置解析结果，片段修改必须原样使用，不可扩大范围或另猜秒数。没有已确认拍点时不能从小节推算秒数。仅要求定位/试听时不要调用修改工具。'
    key=os.environ.get('DEEPSEEK_API_KEY','')
    if not key: raise ValueError('本机未配置对话模型密钥')
    req=urllib.request.Request('https://api.deepseek.com/chat/completions',
        data=json.dumps(request).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    started=time.perf_counter()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with paid_call('text'):
            with opener.open(req,timeout=20) as resp: response=json.load(resp)
    except urllib.error.HTTPError as exc: raise ValueError(f'对话服务返回HTTP {exc.code}，本次没有修改工程') from None
    except (OSError,ValueError) as exc:
        # The local proxy/DNS occasionally drops Python TLS connections. Retry
        # this interpretation request once via curl, without proxy or exposing
        # auth in process arguments. No project edit occurs before a response.
        with (AUDITS/'connection-failures.jsonl').open('a') as log:
            log.write(json.dumps({'time':time.time(),'error_type':type(exc).__name__,
                                 'error':str(exc).replace(key,'<redacted>')[:200]})+'\n')
        with tempfile.NamedTemporaryFile(suffix='.json') as payload:
            payload.write(json.dumps(request).encode());payload.flush()
            with paid_call('text'):
                result=subprocess.run(['curl','--noproxy','*','--silent','--show-error','--fail-with-body',
                '--connect-timeout','8','--max-time','35','--header','@-',
                '--data-binary','@'+payload.name,'https://api.deepseek.com/chat/completions'],
                input=('Authorization: Bearer '+key+'\nContent-Type: application/json\n').encode(),
                capture_output=True,timeout=40)
        if result.returncode:
            raise ValueError('对话服务连接失败，本次没有修改工程；可重试或使用手动控件') from None
        try:response=json.loads(result.stdout)
        except ValueError:raise ValueError('对话服务返回不完整，本次没有修改工程') from None
    audit_id=str(uuid.uuid4())
    save_json(AUDITS/f'{audit_id}.json',{'request':request,'response':response,'elapsed_seconds':time.perf_counter()-started})
    message=response['choices'][0]['message']; calls=message.get('tool_calls',[])
    if not calls:
        with LOCK: check_context(body);check_navigation();view=PROJECT.view()
        return {'project':view,'message':message.get('content') or '请明确要修改的轨道和时间范围。','applied':False,'audit_id':audit_id,
                'resolved_selection':context['selection'] if musical_reference.get('status')=='resolved' else None}
    if len(calls)!=1 or calls[0]['function']['name'] not in ('edit_track_segment','create_piano_accompaniment','reorchestrate_as_guitar','create_vocal_take','select_vocal_take','create_singing_conversion','remove_project_track'): raise ValueError('模型操作不受支持，未修改工程')
    args=json.loads(calls[0]['function']['arguments'])
    function_name=calls[0]['function']['name']
    if musical_reference.get('status')=='resolved':
        ranged=function_name in ('edit_track_segment','create_piano_accompaniment','reorchestrate_as_guitar')
        if not ranged and musical_reference.get('kind')!='song':
            raise ValueError('该操作目前只能作用于整条轨道，不能按这段位置执行；没有修改工程')
        for key in (('start_seconds','end_seconds') if ranged else ()):
            value=args.get(key)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not np.isfinite(value) or abs(value-musical_reference[key])>.001:
                raise ValueError('模型返回的区间与所指乐段不一致，已停止修改；请在导航中选择这段后重试')
    if calls[0]['function']['name']=='remove_project_track':
        with LOCK:
            check_context(body);check_navigation();command={'type':'remove_track','track_id':args['track_id']};view=PROJECT.apply(command,'dialogue',body['revision'])
        return {'project':view,'applied':True,'command':command,'audit_id':audit_id,'message':'已从当前工程移除整条轨道，可撤销恢复。'}
    if calls[0]['function']['name']=='create_singing_conversion':
        with LOCK:
            check_context(body);check_navigation();job=CONVERSIONS.start(PROJECT,{'request_id':audit_id,**args});view=PROJECT.view()
        return {'project':view,'applied':False,'voice_conversion_job':job,'audit_id':audit_id,'message':'已准备抒情男声整曲换声候选任务，可在“整曲换声验证”试听并应用；原工程未改变。'}
    if calls[0]['function']['name']=='create_vocal_take':
        with LOCK:
            check_context(body);check_navigation();job=VOCALS.start(PROJECT,{'request_id':audit_id,**args});view=PROJECT.view()
        return {'project':view,'applied':False,'vocal_job':job,'audit_id':audit_id,'message':'已准备整曲绮萱重唱候选任务，完成后可在“歌手与重新演唱”试听并应用；伴奏与当前修改保持。'}
    if calls[0]['function']['name']=='select_vocal_take':
        with LOCK:
            check_context(body);check_navigation()
            if args['variant_id']!='original':
                return {'project':PROJECT.view(),'applied':False,'candidate_review':{'kind':'vocal','candidate_id':args['variant_id']},
                        'audit_id':audit_id,'message':'已选中换声候选，请在当前混音对照中试听，再确认应用。'}
            PROJECT=Project(PROJECT.directory)
            command={'type':'vocal_variant','track_id':'vocals',**args};view=PROJECT.apply(command,'dialogue',body['revision'])
        return {'project':view,'applied':True,'command':command,'audit_id':audit_id,'message':'主唱已切换，伴奏与混音修改保留。演唱谱会按当前演唱版本重新匹配。'}
    if calls[0]['function']['name'] in ('create_piano_accompaniment','reorchestrate_as_guitar'):
        rearrange=calls[0]['function']['name']=='reorchestrate_as_guitar'
        if rearrange:args['operation']='reorchestrate'
        with LOCK:
            if PROJECT.state['id']!=body.get('project_id'):raise RuntimeError('歌曲已切换，请在当前歌曲重新提出编配要求')
            check_navigation()
            job=ARRANGEMENTS.start(PROJECT,{'request_id':audit_id,'project_id':PROJECT.state['id'],**args})
            view=PROJECT.view()
        return {'project':view,'applied':False,'arrangement_job':job,'audit_id':audit_id,'resolved_selection':context['selection'] if musical_reference.get('status')=='resolved' else None,
                'message':('已准备好 ' if job['stage']=='ready' else '已开始为 ')+f'{job["start_seconds"]:g}–{job["end_seconds"]:g} 秒'+('重新编配木吉他候选，完成后可应用替换试听。' if rearrange else '新编钢琴伴奏候选，完成后可选择加入试听。')}
    with LOCK:
        check_context(body);check_navigation()
        view=PROJECT.apply({**args,'type':'segment_gain'},'dialogue',body.get('revision'))
    return {'project':view,'message':'已应用：'+view['history'][-1]['label'],
            'applied':True,'command':args,'audit_id':audit_id,
            'model_seconds':round(time.perf_counter()-started,3),'usage':response.get('usage')}

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'

    def log_message(self, fmt, *args): print('[track-editor] '+fmt%args,flush=True)

    def json(self,status,value):
        data=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store')
        self.end_headers();self.wfile.write(data)

    def serve(self,path):
        if not path.is_file(): return self.json(404,{'error':'文件不存在'})
        with path.open('rb') as f:
            size=os.fstat(f.fileno()).st_size;start=0;end=size-1;status=200
            range_header=self.headers.get('Range')
            if range_header:
                m=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header)
                if not m or not any(m.groups()): return self.json(416,{'error':'无效Range'})
                if m[1]:
                    start=int(m[1]);end=min(int(m[2]),end) if m[2] else end
                else:start=max(0,size-int(m[2]))
                if start>end or start>=size:return self.json(416,{'error':'Range超出文件'})
                status=206
            self.send_response(status)
            self.send_header('Content-Type',mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length',str(end-start+1));self.send_header('Accept-Ranges','bytes')
            self.send_header('Cache-Control','no-cache')
            if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            if path.parent.name=='exports' or (path.parent.parent.name=='score-jobs' and path.suffix in ('.pdf','.mid','.musicxml')):self.send_header('Content-Disposition',f'attachment; filename="{path.name}"')
            self.end_headers()
            f.seek(start);remaining=end-start+1
            while remaining:
                chunk=f.read(min(65536,remaining))
                if not chunk:break
                if not send_file_chunk(self.connection,chunk):self.close_connection=True;break
                remaining-=len(chunk)

    def do_GET(self):
        path=unquote(urlparse(self.path).path)
        if path=='/mv':
            self.send_response(302);self.send_header('Location','/mv/');self.send_header('Content-Length','0');self.end_headers();return
        if path.startswith('/mv/'):return proxy_mv(self,MV_PORT)
        match=re.fullmatch(r'/api/mv/source/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,mv_source(match[1]))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/mv/handoffs/([a-f0-9-]+)(/audio.mp3)?',path)
        if match:
            try:return self.serve(MV_HANDOFFS.audio(match[1])) if match[2] else self.json(200,MV_HANDOFFS.public(MV_HANDOFFS.read(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
            except RuntimeError as exc:return self.json(409,{'error':str(exc)})
        if path=='/api/creation/jobs':return self.json(200,{'requests':CREATE_FLOW.list()})
        match=re.fullmatch(r'/api/creation/jobs/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,CREATE_FLOW.public(CREATE_FLOW.read(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
            except RuntimeError as exc:return self.json(409,{'error':str(exc)})
        if path=='/api/artwork/jobs':return self.json(200,{'jobs':ARTWORK.list()})
        match=re.fullmatch(r'/api/artwork/(jobs|project)/([a-f0-9-]+)(?:/(cover\.png))?',path)
        if match:
            try:
                if match[3]:return self.serve(ARTWORK.asset(match[2],match[3]))
                return self.json(200,ARTWORK.latest(match[2]) if match[1]=='project' else ARTWORK.public(ARTWORK.read(match[2])))
            except (ValueError,RuntimeError) as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/shares/([a-f0-9-]+)(?:/files/([A-Za-z0-9_.-]+))?',path)
        if match:
            try:return self.serve(SHARES.asset(match[1],match[2])) if match[2] else self.json(200,SHARES.public(SHARES.read(match[1])))
            except (ValueError,RuntimeError) as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/share/([a-f0-9-]+)',path)
        if match:
            try:SHARES.read(match[1]);return self.serve(ROOT/'share-view.html')
            except (ValueError,RuntimeError) as exc:return self.json(404,{'error':str(exc)})
        if path in ('/share-view.css','/share-view.js'):return self.serve(ROOT/path[1:])
        if path=='/api/generation/drafts':return self.json(200,{'drafts':GENERATION_DRAFTS.list()})
        match=re.fullmatch(r'/api/generation/drafts/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,GENERATION_DRAFTS.public(GENERATION_DRAFTS.read(match[1])))
            except (ValueError,RuntimeError) as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/speech/jobs/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,SPEECH.public(SPEECH.read(match[1])))
            except (ValueError,RuntimeError) as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/sections/project/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,SECTIONS.get(project_directory(match[1])))
            except (ValueError,RuntimeError) as exc:return self.json(422,{'error':str(exc)})
        match=re.fullmatch(r'/api/score-review/project/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,SCORE_REVIEWS.get(project_directory(match[1])))
            except (ValueError,RuntimeError) as exc:return self.json(422,{'error':str(exc)})
        match=re.fullmatch(r'/api/candidate-reviews/([a-f0-9-]+)(?:/files/([A-Za-z0-9_.-]+))?',path)
        if match:
            try:return self.serve(CANDIDATE_REVIEWS.asset(match[1],match[2])) if match[2] else self.json(200,CANDIDATE_REVIEWS.public(CANDIDATE_REVIEWS.read(match[1])))
            except (ValueError,RuntimeError) as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/svc/project/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,CONVERSIONS.latest(project_directory(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/svc/jobs/([a-f0-9-]+)(?:/files/([A-Za-z0-9_.-]+))?',path)
        if match:
            try:return self.serve(CONVERSIONS.asset(match[1],match[2])) if match[2] else self.json(200,CONVERSIONS.public(CONVERSIONS.read(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/lyrics/song/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,song_lyrics(match[1]))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/lyrics/project/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,LYRICS.latest(project_directory(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        if path=='/api/project':
            with LOCK:return self.json(200,PROJECT.view())
        if path=='/api/voice-library':
            from urllib.parse import parse_qs
            try:
                identifier=parse_qs(urlparse(self.path).query).get('project_id',[''])[0]
                return self.json(200,VOICE_LIBRARY.catalog(project_directory(identifier)))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/voice-library/samples/(\d+)',path)
        if match:
            try:return self.serve(VOICE_LIBRARY.asset(match[1]))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/vocals/project/([a-f0-9-]+)',path)
        if match:
            try:
                directory=project_directory(match[1]);file=directory/'vocal-variants.json'
                candidates=list(reversed(json.loads(file.read_text())['variants'])) if file.exists() else []
                return self.json(200,{'job':VOCALS.latest(match[1]),'candidates':candidates,'presets':PRESETS})
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/vocals/jobs/([a-f0-9-]+)(?:/files/([A-Za-z0-9_.-]+))?',path)
        if match:
            try:return self.serve(VOCALS.asset(match[1],match[2])) if match[2] else self.json(200,VOCALS.public(VOCALS.read(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/scores/project/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,{'job':SCORES.latest(project_directory(match[1]))})
            except ValueError as exc:return self.json(400,{'error':str(exc)})
        match=re.fullmatch(r'/api/scores/jobs/([a-f0-9-]+)/files/([A-Za-z0-9_.-]+)',path)
        if match:
            try:return self.serve(SCORES.asset(match[1],match[2]))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/scores/jobs/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,SCORES.public(SCORES.read(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/arrangements/(jobs|project)/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,ARRANGEMENTS.public(ARRANGEMENTS.read(match[2])) if match[1]=='jobs' else
                                 {'job':ARRANGEMENTS.latest(project_directory(match[2])),'candidates':ARRANGEMENTS.catalog(project_directory(match[2]))})
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        match=re.fullmatch(r'/api/instruments/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,INSTRUMENTS.status(project_directory(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        if path=='/api/generation/batches':return self.json(200,{'batches':GENERATION_PAIRS.list()})
        match=re.fullmatch(r'/api/generation/batches/([a-f0-9-]+)',path)
        if match:
            try:return self.json(200,GENERATION_PAIRS.public(GENERATION_PAIRS.read(match[1])))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        if path=='/api/generation/jobs':return self.json(200,{'jobs':WORKFLOW.list(),'legacy_project_id':LEGACY_ID})
        if path=='/api/generation/sources':return self.json(200,{'sources':[{k:s[k] for k in ('key','title')} for s in WORKFLOW.sources()]})
        match=re.fullmatch(r'/api/generation/jobs/([a-f0-9-]+)',path)
        if match:
            job=WORKFLOW.jobs.get(match[1]);return self.json(200 if job else 404,WORKFLOW.public(job) if job else {'error':'找不到该任务'})
        match=re.fullmatch(r'/api/generation/media/([a-f0-9-]+)/(stream|complete|preview-complete)',path)
        if match:
            job=WORKFLOW.jobs.get(match[1])
            if not job:return self.json(404,{'error':'找不到该任务'})
            return STREAM.Handler.send_stream(self,job,kind='preview_complete') if match[2]=='preview-complete' else STREAM.Handler.send_stream(self,job) if match[2]=='stream' else STREAM.Handler.send_complete(self,job)
        if path in ('/','/studio','/studio/'):
            return self.serve(ROOT/'studio.html')
        if path in ('/legacy','/legacy/'):
            return self.serve(ROOT/'index.html')
        if path=='/assets/brand/osmanthus-logo.png':
            return self.serve(ROOT/'assets/brand/osmanthus-logo.png')
        if path in ('/studio.js','/studio.css','/studio-design.css','/studio-icons.js','/studio-speech.js','/studio-player.js','/studio-idea.js','/studio-inspiration.js','/studio-generation-autoplay.js','/studio-create.js','/studio-creation-request.js'):
            return self.serve(ROOT/path[1:])
        if path in ('/','/app.js','/seek-control.js','/score.js','/vocals.js','/svc.js','/voice-library.js','/lyrics.js','/generation.js','/generation.css','/style.css','/interactions.css','/sections.js','/candidate_review.js'):
            return self.serve(ROOT/('index.html' if path=='/' else path[1:]))
        match=re.fullmatch(r'/(audio|exports)/([a-f0-9-]+)/([^/]+)',path)
        if match:
            try:
                kind,identifier,name=match.groups()
                directory=project_directory(identifier) if kind=='audio' else export_directory(identifier)
                return self.serve(media_file(directory,name,('.wav','.mp3','.zip') if kind=='exports' else ('.wav','.mp3')))
            except ValueError as exc:return self.json(404,{'error':str(exc)})
        for prefix,directory in [('/audio/',LEGACY_DATA),('/exports/',ROOT/'exports')]:
            if path.startswith(prefix):
                name=path[len(prefix):]
                try:return self.serve(media_file(directory,name,('.wav','.mp3')))
                except ValueError as exc:return self.json(404,{'error':str(exc)})
        return self.json(404,{'error':'接口不存在'})

    def do_HEAD(self):
        if urlparse(self.path).path.startswith('/mv/'):return proxy_mv(self,MV_PORT)
        self.send_response(405);self.send_header('Content-Length','0');self.end_headers()

    def do_PUT(self):
        origin=self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}'):return self.json(403,{'error':'仅接受本机页面请求'})
        if urlparse(self.path).path.startswith('/mv/'):return proxy_mv(self,MV_PORT)
        return self.json(405,{'error':'接口不支持PUT'})

    def do_DELETE(self):
        origin=self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}'):return self.json(403,{'error':'仅接受本机页面请求'})
        if urlparse(self.path).path.startswith('/mv/'):return proxy_mv(self,MV_PORT)
        return self.json(405,{'error':'接口不支持DELETE'})

    def do_POST(self):
        global PROJECT
        origin=self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}'):
            return self.json(403,{'error':'仅接受本机编辑页面请求'})
        if urlparse(self.path).path.startswith('/mv/'):return proxy_mv(self,MV_PORT)
        try:
            length=int(self.headers.get('Content-Length',0))
            if urlparse(self.path).path=='/api/speech/jobs':
                if not 0<length<=MAX_SPEECH_BYTES:raise ValueError('录音需大于0且不超过8MB')
                payload=self.rfile.read(length)
                revision=int(self.headers.get('X-Project-Revision','-1'))
                project_id=self.headers.get('X-Project-Id')
                with LOCK:
                    check_context({'project_id':project_id,'revision':revision})
                    return self.json(202,SPEECH.start(payload,self.headers.get('X-Request-Id'),project_id,revision,self.headers.get('Content-Type')))
            if not 0<length<=64000: raise ValueError('请求大小不正确')
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict):raise ValueError('请求必须是JSON对象')
            path=urlparse(self.path).path; started=time.perf_counter()
            if path=='/api/mv/handoffs':return self.json(201,MV_HANDOFFS.create(body,lambda intent:mv_source(intent['project_id'],intent,True)))
            if path=='/api/artwork/jobs':return self.json(202,ARTWORK.ensure(artwork_reference(body.get('project_id'))))
            match=re.fullmatch(r'/api/artwork/jobs/([a-f0-9-]+)/(resume|retry)',path)
            if match:return self.json(202,ARTWORK.resume(match[1]) if match[2]=='resume' else ARTWORK.retry(match[1],body.get('request_id')))
            if path=='/api/shares':
                with LOCK:
                    check_context(body);snapshot=PROJECT.audio_snapshot()
                return self.json(200,SHARES.create(snapshot,body,share_artwork(snapshot.state['id'],snapshot.state['source_sha256'])))
            if path=='/api/shares/generated':
                identifier=body.get('candidate_id');job=WORKFLOW.jobs.get(identifier)
                if not valid_id(identifier) or not job or not job.get('download_ready'):raise ValueError('完整歌曲尚未准备好，暂不能分享')
                source=STREAM.ROOT/'runs'/identifier/'complete.mp3'
                reference=artwork_reference(identifier)
                return self.json(200,SHARES.create_original(dict(job),source,body,share_artwork(identifier,reference['source_sha256'])))
            if path=='/api/candidate-reviews':
                with LOCK:
                    check_context(body)
                    snapshot=PROJECT.audio_snapshot()
                return self.json(200,CANDIDATE_REVIEWS.prepare(snapshot,body))
            match=re.fullmatch(r'/api/candidate-reviews/([a-f0-9-]+)/apply',path)
            if match:
                with LOCK:
                    check_context(body)
                    command=CANDIDATE_REVIEWS.validated_command(PROJECT,match[1],body)
                    view=PROJECT.apply(command,'candidate-review',body['revision'])
                    return self.json(200,{'project':view,'command':command,'message':'已应用试听候选；可以撤销恢复原版本。'})
            if path=='/api/sections/boundary':
                with LOCK:
                    check_context(body)
                    return self.json(200,SECTIONS.update(PROJECT.directory,body))
            if path=='/api/score-review/candidates':
                with LOCK:
                    check_context(body)
                    return self.json(202,SCORE_REVIEWS.start_candidate(PROJECT,body))
            if path=='/api/score-review/save':
                with LOCK:
                    check_context(body)
                    return self.json(200,SCORE_REVIEWS.save(PROJECT,body))
            if path=='/api/svc/jobs':
                with LOCK:
                    check_context(body)
                    return self.json(202,CONVERSIONS.start(PROJECT,body))
            match=re.fullmatch(r'/api/lyrics/song/([a-f0-9-]+)',path)
            if match:return self.json(202,song_lyrics(match[1],True))
            if path=='/api/lyrics/jobs':return self.json(202,LYRICS.start(project_directory(body.get('project_id'))))
            if path=='/api/creation/jobs':
                if body.get('instrumental') is not True and body.get('request_id') not in CREATE_FLOW.requests:raise ValueError('请先展示并确认歌词，再生成歌曲；请刷新页面使用新的创作流程')
                return self.json(202,CREATE_FLOW.start(body))
            if path=='/api/creation/inspiration':return self.json(200,generate_inspiration(body))
            if path=='/api/creation/lyrics':return self.json(202,CREATE_FLOW.write_lyrics(body))
            match=re.fullmatch(r'/api/creation/jobs/([a-f0-9-]+)/resume',path)
            if match:return self.json(202,CREATE_FLOW.resume(match[1]))
            match=re.fullmatch(r'/api/creation/jobs/([a-f0-9-]+)/cancel',path)
            if match:return self.json(200,CREATE_FLOW.cancel_unaccepted(match[1]))
            if path=='/api/generation/drafts':
                payload=creation_fields(body)[1] if 'mode' in body else body
                return self.json(202,GENERATION_DRAFTS.start(payload))
            match=re.fullmatch(r'/api/generation/drafts/([a-f0-9-]+)/(save|confirm|resume)',path)
            if match:
                identifier,action=match.groups()
                if action=='save':return self.json(200,GENERATION_DRAFTS.update(identifier,body))
                if action=='confirm':return self.json(202,GENERATION_DRAFTS.confirm(identifier,body))
                return self.json(202,GENERATION_DRAFTS.resume(identifier))
            if path=='/api/generation/batches':
                if body.get('request_id') not in GENERATION_PAIRS.batches:raise ValueError('请先展示并确认歌词，再生成歌曲')
                return self.json(202,GENERATION_PAIRS.start(body))
            match=re.fullmatch(r'/api/generation/batches/([a-f0-9-]+)/(select|resume)',path)
            if match:
                result=GENERATION_PAIRS.select(match[1],body.get('candidate_id')) if match[2]=='select' else GENERATION_PAIRS.resume(match[1])
                return self.json(202,result)
            match=re.fullmatch(r'/api/generation/batches/([a-f0-9-]+)/candidates/([a-f0-9-]+)/retry',path)
            if match:return self.json(202,GENERATION_PAIRS.retry(match[1],match[2],body.get('request_id')))
            if path=='/api/generation/jobs':
                if body.get('generation_mode')=='dual':
                    if body.get('request_id') not in GENERATION_PAIRS.batches:raise ValueError('请先展示并确认歌词，再生成歌曲')
                    return self.json(202,GENERATION_PAIRS.start(body))
                if body.get('request_id') not in WORKFLOW.jobs:raise ValueError('请在新版工作台展示并确认歌词，再生成歌曲')
                return self.json(202,WORKFLOW.start(body))
            if path=='/api/generation/import':return self.json(202,WORKFLOW.import_existing(body))
            match=re.fullmatch(r'/api/generation/jobs/([a-f0-9-]+)/(resume|telemetry)',path)
            if match:
                if match[2]=='resume':return self.json(202,WORKFLOW.resume(match[1]))
                WORKFLOW.telemetry(match[1],body);return self.json(200,{'ok':True})
            if path=='/api/assistant':return self.json(200,assistant(body))
            if path=='/api/export':return self.json(200,export_audio(body,started))
            if path=='/api/voice-library/select':
                with LOCK:
                    check_context(body)
                    return self.json(200,{'selected':VOICE_LIBRARY.select(PROJECT,body.get('voice_id'))})
            if path=='/api/vocals/jobs':
                with LOCK:
                    check_context(body)
                    return self.json(202,VOCALS.start(PROJECT,body))
            if path=='/api/scores/jobs':
                with LOCK:
                    check_context(body)
                    return self.json(202,SCORES.start(PROJECT,body))
            if path=='/api/arrangements/jobs':
                replay=ARRANGEMENTS.replay(body)
                if replay:return self.json(202,replay)
                with LOCK:
                    check_context(body)
                    return self.json(202,ARRANGEMENTS.start(PROJECT,body))
            with LOCK:
                if path=='/api/projects/activate':
                    check_context(body)
                    directory=project_directory(body.get('target_id'))
                    if PROJECT.state['id']!=body['target_id']:PROJECT=Project(directory)
                    save_json(ACTIVE_FILE,{'id':PROJECT.state['id']})
                    return self.json(200,{'project':PROJECT.view()})
                check_context(body)
                if path=='/api/track-switch':
                    controls=PROJECT.apply({'type':'track_enabled','track_id':body.get('track_id'),
                                            'enabled':body.get('enabled')},'manual',body.get('revision'),compact=True)
                    return self.json(200,{'controls':controls})
                if path=='/api/instruments/prepare':return self.json(202,INSTRUMENTS.start(PROJECT.directory))
                if path=='/api/instruments/load':
                    if INSTRUMENTS.status(PROJECT.directory)['stage']!='ready':raise ValueError('器乐分轨尚未准备完成')
                    PROJECT=Project(PROJECT.directory)
                    return self.json(200,{'project':PROJECT.view()})
                if path=='/api/edit':
                    if body.get('command',{}).get('type') in ('add_part','replace_part','vocal_variant'):PROJECT=Project(PROJECT.directory)
                    view=PROJECT.apply(body.get('command',{}),'manual',body.get('revision'))
                    return self.json(200,{'project':view,'elapsed_seconds':time.perf_counter()-started})
                if path in ('/api/undo','/api/redo'):
                    view=PROJECT.move_history(path.rsplit('/',1)[1],body.get('revision'))
                    return self.json(200,{'project':view})
                if path=='/api/history/restore':
                    return self.json(200,{'project':PROJECT.restore_history(body.get('cursor'),body.get('revision'))})
            self.json(404,{'error':'接口不存在'})
        except PaidUsageError as exc:self.json(exc.status,{'error':str(exc),'code':exc.code})
        except RuntimeError as exc:self.json(409,{'error':str(exc)})
        except (ValueError,KeyError,TypeError) as exc:self.json(422,{'error':str(exc)})
        except Exception as exc:
            print(type(exc).__name__,str(exc)[:200],flush=True)
            self.json(500,{'error':'处理失败，未返回成功结果；请检查本机服务日志'})

if __name__=='__main__':
    WORKFLOW.recover()
    GENERATION_PAIRS.recover()
    GENERATION_DRAFTS.recover()
    CREATE_FLOW.recover()
    ARTWORK.recover()
    print(f'Shared project editor: http://127.0.0.1:{PORT}/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
