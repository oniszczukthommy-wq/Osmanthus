"""Local streaming-song validation. API keys stay in the server process."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent
SHARED=ROOT.parent/'provider-song-comparison-20261024'
sys.path.insert(0,str(SHARED))
from run_comparison import load_env,request_json,download

PORT=int(os.environ.get('YINCHAO_STREAM_PORT','8602'))
LOCK=threading.RLock()
JOBS:dict[str,dict]={}
load_env()
EXAMPLE=json.loads((SHARED/'cases.json').read_text(encoding='utf-8'))['cases'][0]


def persist(job:dict)->None:
    folder=ROOT/'runs'/job['id']
    folder.mkdir(parents=True,exist_ok=True)
    temporary=folder/'state.tmp'
    temporary.write_text(json.dumps(job,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    temporary.replace(folder/'state.json')


def event(job:dict,kind:str,**fields)->None:
    with LOCK:
        job['events'].append({'at':round(time.time()-job['created_at'],3),'type':kind,**fields})
        persist(job)


def public(job:dict)->dict:
    with LOCK:
        fields=('id','model','title','status','error','created_at','first_stream_seconds','done_seconds','duration_seconds','download_ready','first_play_seconds','first_play_before_done','buffering_events','stream_proxy_bytes','stream_proxy_first_byte_seconds','stream_error','generation_error')
        result={key:job.get(key) for key in fields}
        result.update({'stream_available':bool(job.get('pipe_url')),'complete_url_available':bool(job.get('audio_url')),'elapsed_seconds':round(time.time()-job['created_at'],1),'events':job['events'][-35:]})
        return result


def worker(job:dict)->None:
    key=os.environ.get('YINCHAO_API_KEY','')
    folder=ROOT/'runs'/job['id']
    try:
        if not job.get('task_id'):
            body={'model':job['model'],'task_type':'normal','prompt':job['prompt'],'lyric':job['lyrics'],'n':1}
            (folder/'request.json').write_text(json.dumps(body,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            # Persist intent before posting. Restart never silently resubmits.
            with LOCK:job['submission_started']=True;persist(job)
            response=request_json('https://open.yinchaoyongxian.com/api/v1/song/generate',key,body)
            task_id=response.get('id') or response.get('task_id')
            if not task_id:raise RuntimeError('Provider returned no task ID')
            with LOCK:job['task_id']=task_id;job['status']='pending'
            event(job,'submitted',task_id=task_id)
        deadline=time.monotonic()+600
        network_failures=0
        while time.monotonic()<deadline:
            try:
                response=request_json('https://open.yinchaoyongxian.com/api/v1/task/query?'+urllib.parse.urlencode({'task_id':job['task_id']}),key)
                network_failures=0
            except (urllib.error.URLError,TimeoutError,OSError) as error:
                network_failures+=1
                event(job,'poll_connection_retry',attempt=network_failures)
                if network_failures>=10:raise
                time.sleep(2)
                continue
            # Retain every polling observation, not only the final response.
            with (folder/'observations.jsonl').open('a',encoding='utf-8') as out:
                out.write(json.dumps({'at':time.time()-job['created_at'],'response':response},ensure_ascii=False)+'\n')
            songs=response.get('choices',[])
            if songs:
                song=songs[0]
                status=song.get('status','pending')
                with LOCK:
                    previous=job['status']
                    job['status']=status
                    if song.get('pipe_url'):
                        job['pipe_url']=song['pipe_url']
                        if job.get('first_stream_seconds') is None:
                            job['first_stream_seconds']=round(time.time()-job['created_at'],3)
                            event(job,'stream_url_received',provider_status=status)
                    if previous!=status:event(job,'provider_status',status=status)
                    if song.get('audio_url'):job['audio_url']=song['audio_url']
                    persist(job)
                if status=='done':
                    with LOCK:
                        job['done_seconds']=round(time.time()-job['created_at'],3)
                        job['duration_seconds']=song.get('duration')
                        job['documented_song_price_cny']=0.22
                    event(job,'generation_done',stream_received=bool(job.get('pipe_url')))
                    if not job.get('audio_url'):raise RuntimeError('Done status without final audio URL')
                    finish_download(job)
                    return
                if status in ('fail','cancelled'):
                    raise RuntimeError('Provider generation failed: '+str(song.get('error','unknown'))[:500])
            time.sleep(2)
        raise TimeoutError('Polling timed out; task ID retained, no automatic new paid submission')
    except Exception as error:
        message=str(error).replace(key,'<redacted>') if key else str(error)
        with LOCK:
            job['error']=message
            if job['status']=='done':job['download_error']=message
            else:job['status']='error';job['generation_error']=message
        event(job,'error',message=message)


def media_curl(url:str,resolve_media:bool=False):
    host=urllib.parse.urlparse(url).hostname
    if urllib.parse.urlparse(url).scheme not in ('https','http') or not host:raise ValueError('Invalid provider media URL')
    args=['curl','--noproxy','*','--no-buffer','--location','--fail','--silent','--show-error','--connect-timeout','10','--max-time','600',
          '--speed-time','20','--speed-limit','512']
    # Prefer current system DNS. A previously saved CDN IP can stop responding;
    # only retry with freshly resolved DNS after the normal transfer fails.
    if host=='api-cdn.yinchaoyongxian.com' and resolve_media:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        resolver='https://dns.alidns.com/resolve?'+urllib.parse.urlencode({'name':host,'type':'A'})
        with opener.open(resolver,timeout=8) as response:answer=json.loads(response.read())
        ips=[item['data'] for item in answer.get('Answer',[]) if item.get('type')==1]
        if ips:args+=['--resolve',f'{host}:443:{ips[0]}']
    # Stream URLs on the official API host require Bearer authentication.
    # Forward it only from the server, via stdin rather than process arguments.
    auth=host=='open.yinchaoyongxian.com'
    if auth:args+=['--header','@-']
    process=subprocess.Popen(args+[url],stdin=subprocess.PIPE if auth else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if auth:
        process.stdin.write(('Authorization: Bearer '+os.environ['YINCHAO_API_KEY']+'\n').encode())
        process.stdin.close()
    return process


def finish_download(job:dict)->None:
    for attempt in range(3):
        process=None
        try:
            process=media_curl(job['audio_url'],resolve_media=attempt>0)
            data=process.stdout.read()
            diagnostic=process.stderr.read(500).decode('utf-8','replace').replace(job['audio_url'],'<media-url>')
            if process.wait(timeout=10)!=0 or len(data)<10000:raise RuntimeError(diagnostic or 'Final audio download incomplete')
            (ROOT/'runs'/job['id']/'complete.mp3').write_bytes(data)
            with LOCK:job['download_ready']=True;job['error']=None;job['download_error']=None
            event(job,'download_ready')
            return
        except Exception as error:
            event(job,'download_connection_retry',attempt=attempt+1)
            if attempt==2:
                with LOCK:job['download_error']=str(error);job['error']=str(error)
                event(job,'download_failed',message=str(error)[:300])
            else:time.sleep(1)
        finally:
            if process and process.poll() is None:process.terminate()


class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'

    def log_message(self,fmt,*args):
        # Request paths contain local IDs only, never remote URLs or API keys.
        print('[stream-validation]',fmt%args,flush=True)

    def json(self,status:int,value:dict)->None:
        data=json.dumps(value,ensure_ascii=False).encode('utf-8')
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)

    def do_GET(self):
        path=urllib.parse.urlparse(self.path).path
        if path=='/':
            data=(ROOT/'index.html').read_bytes();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
        if path=='/api/example':self.json(200,{'title':EXAMPLE['title'],'prompt':EXAMPLE['style_prompt'],'lyrics':EXAMPLE['lyrics']});return
        if path=='/api/jobs':self.json(200,{'jobs':[public(job) for job in JOBS.values()]});return
        match=re.fullmatch(r'/api/jobs/([a-f0-9-]+)',path)
        if match:
            job=JOBS.get(match[1]);self.json(200 if job else 404,public(job) if job else {'error':'Unknown task'});return
        match=re.fullmatch(r'/api/media/([a-f0-9-]+)/(stream|complete)',path)
        if not match:self.json(404,{'error':'Not found'});return
        job=JOBS.get(match[1])
        if not job:self.json(404,{'error':'Unknown task'});return
        if match[2]=='complete':self.send_complete(job);return
        self.send_stream(job)

    def send_complete(self,job):
        path=ROOT/'runs'/job['id']/'complete.mp3'
        if not path.exists():self.json(409,{'error':'Final audio not downloaded yet'});return
        size=path.stat().st_size;start=0;end=size-1;status=200
        requested=self.headers.get('Range','')
        if requested:
            match=re.fullmatch(r'bytes=(\d+)-(\d*)',requested)
            if not match:self.send_error(416);return
            start=int(match[1]);end=min(int(match[2]) if match[2] else size-1,size-1);status=206
            if start>=size or end<start:self.send_error(416);return
        self.send_response(status);self.send_header('Content-Type','audio/mpeg');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
        if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        try:
            with path.open('rb') as source:
                source.seek(start);remaining=end-start+1
                while remaining:
                    data=source.read(min(65536,remaining));self.wfile.write(data);remaining-=len(data)
        except (BrokenPipeError,ConnectionResetError):pass

    def send_stream(self,job):
        if not job.get('pipe_url'):self.json(409,{'error':'Provider has not returned a stream URL'});return
        process=None
        try:
            first=b''
            diagnostic='Stream returned no audio bytes'
            # Retry connection setup only. Never restart a stream after audio
            # bytes have reached the browser, which would duplicate playback.
            for attempt in range(5):
                process=media_curl(job['pipe_url'])
                first=process.stdout.read1(4096)
                if first:break
                diagnostic=process.stderr.read(500).decode('utf-8','replace').replace(job['pipe_url'],'<media-url>')
                process.wait(timeout=5)
                event(job,'stream_connection_retry',attempt=attempt+1)
                time.sleep(.3)
            if not first:raise RuntimeError(diagnostic)
            if first.lstrip().startswith(b'#EXTM3U'):
                raise RuntimeError('Provider returned an HLS playlist; progressive MP3 player does not support this format yet')
            if first.lstrip().startswith((b'<html',b'<!DOCTYPE',b'{"')):raise RuntimeError('Stream did not return audio data')
            with LOCK:
                job['stream_error']=None
                if job.get('stream_proxy_first_byte_seconds') is None:job['stream_proxy_first_byte_seconds']=round(time.time()-job['created_at'],3)
            event(job,'stream_proxy_first_byte',provider_status=job['status'])
            self.send_response(200);self.send_header('Content-Type','audio/mpeg');self.send_header('Transfer-Encoding','chunked');self.send_header('Cache-Control','no-store');self.send_header('Accept-Ranges','none');self.end_headers()
            chunk=first
            while chunk:
                self.wfile.write(f'{len(chunk):X}\r\n'.encode('ascii')+chunk+b'\r\n');self.wfile.flush()
                with LOCK:job['stream_proxy_bytes']=job.get('stream_proxy_bytes',0)+len(chunk)
                chunk=process.stdout.read1(16384)
            self.wfile.write(b'0\r\n\r\n');self.wfile.flush()
            if process.wait(timeout=5)!=0:raise RuntimeError('Provider stream ended with a transport error')
            event(job,'stream_proxy_end',bytes=job['stream_proxy_bytes'])
        except (BrokenPipeError,ConnectionResetError):event(job,'stream_client_disconnected')
        except Exception as error:
            with LOCK:job['stream_error']=str(error)[:700]
            event(job,'stream_proxy_error',message=str(error)[:700])
            if not job.get('stream_proxy_first_byte_seconds'):self.json(502,{'error':str(error)[:500]})
        finally:
            if process and process.poll() is None:process.terminate()

    def do_POST(self):
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://127.0.0.1:{PORT}':self.json(403,{'error':'Local origin required'});return
        if not self.headers.get('Content-Type','').startswith('application/json'):self.json(415,{'error':'JSON required'});return
        length=int(self.headers.get('Content-Length','0'))
        if length>20000:self.json(413,{'error':'Request too large'});return
        try:body=json.loads(self.rfile.read(length))
        except Exception:self.json(400,{'error':'Invalid JSON'});return
        if self.path=='/api/jobs':
            model=body.get('model','v4.5')
            if model not in ('v4.5','v3.5'):self.json(400,{'error':'Unsupported model'});return
            if not os.environ.get('YINCHAO_API_KEY'):self.json(409,{'error':'API key not configured on server'});return
            with LOCK:
                if any(job['status'] not in ('done','error','fail','cancelled') for job in JOBS.values()):self.json(409,{'error':'A generation is already running'});return
                job={'id':str(uuid.uuid4()),'model':model,'title':EXAMPLE['title']+' · 流式验证','prompt':EXAMPLE['style_prompt'],'lyrics':EXAMPLE['lyrics'],'created_at':time.time(),'status':'submitting','events':[],'first_stream_seconds':None,'first_play_seconds':None,'done_seconds':None,'download_ready':False,'buffering_events':0}
                JOBS[job['id']]=job;persist(job)
                threading.Thread(target=worker,args=(job,),daemon=True).start()
            self.json(202,public(job));return
        match=re.fullmatch(r'/api/jobs/([a-f0-9-]+)/telemetry',self.path)
        if not match or match[1] not in JOBS:self.json(404,{'error':'Unknown task'});return
        job=JOBS[match[1]];kind=body.get('event')
        if kind not in ('playing','waiting','stalled','ended','error','pause','timeupdate'):self.json(400,{'error':'Unknown telemetry event'});return
        with LOCK:
            if kind=='playing' and job.get('first_play_seconds') is None:
                job['first_play_seconds']=round(time.time()-job['created_at'],3)
                job['first_play_before_done']=job['status'] not in ('done','error','fail','cancelled') and bool(job.get('pipe_url'))
            if kind in ('waiting','stalled') and job.get('first_play_seconds') is not None:job['buffering_events']+=1
        event(job,'browser_'+kind,current_time=body.get('current_time'),source=body.get('source'),provider_status=job['status'])
        self.json(200,{'ok':True})


def resume_jobs():
    for path in (ROOT/'runs').glob('*/state.json'):
        job=json.loads(path.read_text(encoding='utf-8'));JOBS[job['id']]=job
        recoverable=job['status']=='error' and job.get('task_id') and 'urlopen error' in str(job.get('generation_error',''))
        if recoverable:
            job['status']='pending';job['error']=None;job['generation_error']=None
            event(job,'resumed_existing_task')
        if job['status'] not in ('done','fail','cancelled','error'):
            if job.get('task_id'):threading.Thread(target=worker,args=(job,),daemon=True).start()
            else:
                job['status']='error';job['error']='Submission outcome unknown after server restart; no automatic paid resubmission';persist(job)
        elif job['status']=='done' and not job.get('download_ready') and job.get('audio_url'):
            threading.Thread(target=finish_download,args=(job,),daemon=True).start()


if __name__=='__main__':
    resume_jobs()
    print(f'Stream validation: http://127.0.0.1:{PORT}/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
