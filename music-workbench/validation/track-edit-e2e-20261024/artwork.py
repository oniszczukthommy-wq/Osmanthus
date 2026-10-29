"""Independent AI album-art jobs; one saved request, no automatic paid retries.

Uses the user's configured DashScope account through the official native image
API.  Built-in image_gen artwork is only imported when explicitly matched to a
real song; the web server never pretends to invoke the desktop image tool.
"""
from __future__ import annotations
import copy,hashlib,json,os,re,shutil,subprocess,threading,time,uuid
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image
from project import ROOT

MODEL='qwen-image-2.0'
PRICE_CNY=.2
TERMINAL=('ready','error','interrupted')

def save_json(path,value):
    path=Path(path);temporary=path.with_name('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temporary,path)

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def valid_id(value):
    try:return isinstance(value,str) and str(uuid.UUID(value))==value
    except (ValueError,TypeError,AttributeError):return False

def reference_fields(reference):
    if not isinstance(reference,dict) or not valid_id(reference.get('project_id')):raise ValueError('封面需要真实歌曲标识')
    values={'project_id':reference['project_id']}
    for name,limit,default in [('title',120,''),('lyrics',5000,''),('style',240,''),('source_sha256',64,'')]:
        value=reference.get(name,default)
        if value is None:value=default
        if not isinstance(value,str) or len(value)>limit:raise ValueError('封面歌曲信息格式无效')
        values[name]=value.strip()
    if not values['title']:raise ValueError('请先确认歌名，再生成封面')
    if values['source_sha256'] and not re.fullmatch('[a-f0-9]{64}',values['source_sha256']):raise ValueError('歌曲音频指纹无效')
    return values

def content_hash(reference):
    # Audio SHA may arrive after generation.  Completing it must not charge for
    # another cover; the immutable song ID plus confirmed text identifies art.
    value={k:reference[k] for k in ('project_id','title','lyrics','style')}
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()

def make_prompt(reference):
    # Do not supply literal lyrics to the image model: it tends to typeset them
    # despite a negative instruction.  Titles remain accessible HTML next to the
    # cover.  Only visual concepts derived from the real song reach the model.
    text=reference['title']
    scenes=[
        ('雨后慢步','a takeaway cup of hot tea on a small cafe windowsill after rain, distant fresh green trees and delicate reflections on the glass, soft morning light'),
        ('列车|火车|车站|铁轨','a quiet railway winding through green countryside in soft golden dawn haze, seen from a moving train window'),
        ('末班|闹钟|凌晨','a solitary late-night bus window, rain-speckled glass, distant warm city lights, soft reflections and deep midnight blue'),
        ('海|沙滩|浪|帆','an expansive turquoise sea, a small sunlit coastline and delicate waves, warm peach light on the horizon'),
        ('灯|窗|归途|回家','one small warmly illuminated apartment window above an empty dusk street, intimate amber light against indigo shadows'),
        ('雨|伞|水洼','a quiet street after rain, delicate reflected pale sky and wet pavement, a single subtle green leaf, gentle morning light'),
        ('春|花|树|风','soft wind through delicate green branches, one small sunlit flower, an uncluttered airy landscape'),
    ]
    # Prefer the title's strongest image over incidental imagery in the lyrics.
    scene=next((scene for pattern,scene in scenes if re.search(pattern,reference['title'])),None)
    if scene is None:scene=next((scene for pattern,scene in scenes if re.search(pattern,text)),None)
    if scene is None:scene='an evocative intimate landscape with one clear focal subject, natural light and subtle cinematic atmosphere'
    variation=int(hashlib.sha256(reference['project_id'].encode()).hexdigest()[:8],16)%4
    framing=['wide negative space with a tiny focal subject','an intimate off-centre composition','a layered cinematic composition with a soft foreground','a clean editorial composition with subtle grain'][variation]
    genre=reference['style'].lower()
    mood=('earthy organic colours, warm acoustic intimacy' if any(x in genre for x in ('民谣','folk')) else
          'rich midnight colours and sophisticated soulful atmosphere' if any(x in genre for x in ('r&b','rnb','爵士','jazz','蓝调','blues')) else
          'high-contrast dramatic energy and tactile grain' if any(x in genre for x in ('摇滚','rock')) else
          'gentle cinematic colours and emotional warmth')
    return ('Create an exceptional square album artwork image for an independent original song. '
            f'Visual subject: {scene}. Composition: {framing}. '
            f'Musical atmosphere: {mood}. '
            'Fine-art analog photography, subtle 35mm film grain, beautiful restrained complementary colours, organic texture, tactile light, rich tonal depth. '
            'One coherent scene, sophisticated and memorable when viewed as a small album thumbnail. Full bleed 1:1 image. '
            'IMAGE ONLY. Absolutely no text, letters, Chinese characters, numbers, typography, lyrics, logos, watermarks, QR codes, decorative frames, mockups, records or music-note icons. '
            'Do not design a poster or book jacket. No recognizable celebrities or real singers.')

def config():
    key=os.environ.get('ARTWORK_API_KEY') or os.environ.get('DASHSCOPE_API_KEY','')
    workspace=os.environ.get('DASHSCOPE_WORKSPACE_ID','')
    override=os.environ.get('ARTWORK_API_BASE_URL','').rstrip('/')
    if override:
        parsed=urlparse(override)
        if parsed.scheme!='https' or not parsed.hostname or not parsed.hostname.endswith('.aliyuncs.com'):raise ValueError('绘图接口配置无效')
        base=override
    elif workspace and re.fullmatch('[A-Za-z0-9-]+',workspace):base=f'https://{workspace}.cn-beijing.maas.aliyuncs.com'
    else:base='https://dashscope.aliyuncs.com'
    return {'key':key,'workspace':workspace,'base':base,'model':os.environ.get('ARTWORK_MODEL',MODEL)}

def call_image(body,output_file):
    settings=config();key=settings['key']
    if not key:raise ValueError('尚未配置可用的绘图服务凭证')
    # Authentication is supplied through stdin, never argv or a request file.
    headers='Authorization: Bearer '+key+'\nContent-Type: application/json\n'
    if settings['workspace']:headers+='X-DashScope-WorkSpace: '+settings['workspace']+'\n'
    path=Path(output_file).parent/'request.json';save_json(path,body)
    command=['curl','--noproxy','*','--silent','--show-error','--fail-with-body','--connect-timeout','12','--max-time','180','--header','@-',
             '--data-binary','@'+str(path),settings['base']+'/api/v1/services/aigc/multimodal-generation/generation']
    response=subprocess.run(command,input=headers.encode(),capture_output=True,timeout=190)
    try:data=json.loads(response.stdout)
    except (ValueError,UnicodeDecodeError):raise RuntimeError('绘图服务连接未确认，未自动重复提交，请核对后再试')
    # Save successful or failed provider receipt immediately.  It permits a
    # media download retry without creating a second paid generation.
    save_json(output_file,data)
    if response.returncode or data.get('code'):
        code=str(data.get('code','connection_error'))[:80]
        message=str(data.get('message','绘图服务暂未完成')).replace(key,'<redacted>')[:180]
        raise RuntimeError(f'封面生成未完成：{code} · {message}')
    return data

def image_url(response):
    for choice in response.get('output',{}).get('choices',[]):
        for part in choice.get('message',{}).get('content',[]):
            if isinstance(part.get('image'),str):return part['image']
    raise ValueError('绘图服务没有返回图片，未用占位图冒充完成')

def download_image(url,target):
    parsed=urlparse(url);host=(parsed.hostname or '').lower()
    if parsed.scheme!='https' or not any(host==s or host.endswith('.'+s) for s in ('aliyuncs.com','alicdn.com')):
        raise ValueError('绘图图片地址不在服务商媒体域名中')
    temporary=Path(target).with_name('.incoming-'+uuid.uuid4().hex+'.png')
    try:
        result=subprocess.run(['curl','--noproxy','*','--silent','--show-error','--fail','--location','--max-redirs','3',
            '--proto','=https','--proto-redir','=https','--connect-timeout','12','--max-time','90','--max-filesize','20971520','--output',str(temporary),url],capture_output=True,timeout=100)
        if result.returncode:raise RuntimeError('封面图片下载未完成，可恢复下载，无需重新生图')
        if not 1000<=temporary.stat().st_size<=20*1024*1024:raise ValueError('封面图片大小异常')
        with Image.open(temporary) as picture:
            picture.verify()
        with Image.open(temporary) as picture:
            width,height=picture.size
            if picture.format!='PNG' or width!=height or not 512<=width<=4096:raise ValueError('封面不是有效的方形PNG图像')
        os.replace(temporary,target)
        return {'sha256':digest(target),'width':width,'height':height,'bytes':Path(target).stat().st_size}
    finally:temporary.unlink(missing_ok=True)

class Artwork:
    def __init__(self,root=ROOT):
        self.root=Path(root);self.directory=self.root/'artwork';self.directory.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock();self.jobs={};self.running=None
        for file in self.directory.glob('*/state.json'):
            try:
                job=json.loads(file.read_text())
                if valid_id(job['id']):self.jobs[job['id']]=job
            except (ValueError,KeyError):continue

    def read(self,identifier):
        with self.lock:
            if not valid_id(identifier) or identifier not in self.jobs:raise ValueError('找不到封面任务')
            return self.jobs[identifier]

    def save(self,job):
        folder=self.directory/job['id'];folder.mkdir(exist_ok=True);save_json(folder/'state.json',job)

    def public(self,job):
        with self.lock:
            value={k:copy.deepcopy(job.get(k)) for k in ('id','project_id','title','stage','created_at','finished_at','provider','model','error','image','source_sha256','content_hash','retry_of')}
            value['cover_url']=f'/api/artwork/jobs/{job["id"]}/cover.png' if job['stage']=='ready' else None
            value['can_resume_download']=job['stage'] in ('error','interrupted') and (self.directory/job['id']/'response.json').is_file() and bool(job.get('image_returned'))
            value['can_retry']=job['stage'] in ('error','interrupted')
            value['generation_independent_of_playback']=True
            return value

    def list(self):
        with self.lock:return [self.public(j) for j in sorted(self.jobs.values(),key=lambda j:j['created_at'],reverse=True)]

    def latest(self,project_id):
        if not valid_id(project_id):raise ValueError('歌曲标识无效')
        with self.lock:
            jobs=[j for j in self.jobs.values() if j['project_id']==project_id]
            return self.public(max(jobs,key=lambda j:j['created_at'])) if jobs else None

    def ensure(self,reference,*,force_new=False,request_id=None):
        fields=reference_fields(reference);fingerprint=content_hash(fields)
        if force_new and not valid_id(request_id):raise ValueError('重新生图需要独立请求ID')
        base_id=str(uuid.uuid5(uuid.UUID(fields['project_id']),'artwork:'+fingerprint))
        identifier=str(uuid.uuid5(uuid.UUID(fields['project_id']),'artwork-retry:'+request_id)) if force_new else base_id
        with self.lock:
            # Explicit regenerated attempts supersede the original cache entry.
            # Refreshing the page must find that same attempt, not pay again or
            # silently revert to the earlier failed image.
            if not force_new:
                attempts=[j for j in self.jobs.values() if j.get('base_job_id',j['id'])==base_id and j['content_hash']==fingerprint]
                if attempts:identifier=max(attempts,key=lambda j:j['created_at'])['id']
            if identifier in self.jobs:
                job=self.jobs[identifier]
                if job['content_hash']!=fingerprint:raise RuntimeError('同一封面请求不能改为其他歌曲内容')
                if fields['source_sha256'] and not job.get('source_sha256'):job['source_sha256']=fields['source_sha256'];self.save(job)
                return self.public(job)
            settings=config()
            job={**fields,'id':identifier,'base_job_id':base_id,'content_hash':fingerprint,'created_at':time.time(),'stage':'queued','provider':'dashscope-qwen-image',
                 'model':settings['model'],'documented_price_cny':PRICE_CNY if settings['model']==MODEL else None,'error':None,
                 'prompt':make_prompt(fields),'submission_started':False,'image_returned':False}
            self.jobs[identifier]=job;self.save(job);self.launch_next();return self.public(job)

    def launch_next(self):
        if self.running:return
        queued=sorted((j for j in self.jobs.values() if j['stage']=='queued'),key=lambda j:j['created_at'])
        if not queued:return
        self.running=queued[0]['id'];threading.Thread(target=self.run,args=(queued[0],),daemon=True).start()

    def run(self,job):
        folder=self.directory/job['id'];response_file=folder/'response.json'
        try:
            if response_file.exists():
                response=json.loads(response_file.read_text());url=image_url(response)
            else:
                if job.get('submission_started'):raise RuntimeError('上次绘图提交结果不明，未自动重复扣费，请核对后再试')
                settings=config()
                if not settings['key']:raise ValueError('尚未配置可用的绘图服务凭证')
                body={'model':job['model'],'input':{'messages':[{'role':'user','content':[{'text':job['prompt']}]}]},
                      'parameters':{'size':'1024*1024','n':1,'prompt_extend':False,'watermark':False,
                                    'seed':int(uuid.UUID(job['id']))%2147483648}}
                with self.lock:job.update(stage='generating',submission_started=True);self.save(job)
                response=call_image(body,response_file);url=image_url(response)
            with self.lock:job.update(stage='downloading',image_returned=True,provider_request_id=response.get('request_id'));self.save(job)
            image=download_image(url,folder/'cover.png')
            with self.lock:job.update(stage='ready',image=image,finished_at=time.time(),error=None);self.save(job)
        except Exception as error:
            key=os.environ.get('ARTWORK_API_KEY') or os.environ.get('DASHSCOPE_API_KEY','')
            message=str(error).replace(key,'<redacted>') if key else str(error)
            with self.lock:job.update(stage='error',error=message[:500],finished_at=time.time());self.save(job)
        finally:
            with self.lock:self.running=None;self.launch_next()

    def asset(self,identifier,name='cover.png'):
        with self.lock:
            job=self.read(identifier)
            if name!='cover.png' or job['stage']!='ready':raise ValueError('封面尚未准备好')
            file=self.directory/identifier/name
            if not file.is_file() or digest(file)!=job['image']['sha256']:raise ValueError('封面文件校验失败')
            return file

    def resume(self,identifier):
        with self.lock:
            job=self.read(identifier)
            if job['stage']=='ready':return self.public(job)
            if job['stage'] not in ('error','interrupted'):return self.public(job)
            response=self.directory/identifier/'response.json'
            if not response.is_file():raise RuntimeError('绘图结果不明，不能安全重发；请核对后选择重新生成')
            image_url(json.loads(response.read_text()))
            job.update(stage='queued',error=None);self.save(job);self.launch_next();return self.public(job)

    def retry(self,identifier,request_id):
        with self.lock:
            job=self.read(identifier)
            if job['stage'] not in ('error','interrupted'):raise RuntimeError('当前封面任务无需重试')
            result=self.ensure({k:job[k] for k in ('project_id','title','lyrics','style','source_sha256')},force_new=True,request_id=request_id)
            attempt=self.jobs[result['id']];attempt['retry_of']=identifier;self.save(attempt);return self.public(attempt)

    def seed_approved(self,reference,image_path,*,note):
        fields=reference_fields(reference);fingerprint=content_hash(fields);identifier=str(uuid.uuid5(uuid.UUID(fields['project_id']),'artwork:'+fingerprint))
        with self.lock:
            if identifier in self.jobs:return self.public(self.jobs[identifier])
            source=Path(image_path)
            with Image.open(source) as image:
                image.verify()
            with Image.open(source) as image:
                width,height=image.size
                if image.format!='PNG' or width!=height:raise ValueError('认可封面必须是方形PNG')
            folder=self.directory/identifier;folder.mkdir(exist_ok=True);shutil.copy2(source,folder/'cover.png')
            job={**fields,'id':identifier,'content_hash':fingerprint,'stage':'ready','created_at':time.time(),'finished_at':time.time(),
                 'provider':'built-in-imagegen-user-approved','model':'previous-approved-workflow','error':None,
                 'image':{'sha256':digest(folder/'cover.png'),'width':width,'height':height,'bytes':source.stat().st_size},
                 'approval_note':note,'submission_started':False,'image_returned':True}
            self.jobs[identifier]=job;self.save(job);return self.public(job)

    def recover(self):
        with self.lock:
            for job in self.jobs.values():
                if job['id']==self.running:continue
                if job['stage'] in ('generating','downloading'):
                    if (self.directory/job['id']/'response.json').is_file():job.update(stage='queued',error=None)
                    else:job.update(stage='interrupted',error='服务重启前绘图提交结果不明，未自动重复扣费')
                    self.save(job)
            self.launch_next()
