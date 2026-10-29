"""Durable local piano jobs; creating a candidate never edits a song project."""
from pathlib import Path
import argparse, fcntl, hashlib, json, math, os, subprocess, threading, time, uuid
from project import ROOT, save_json

JOBS=ROOT/'arrangement-jobs'
CODE_ROOT=Path(__file__).resolve().parent
ENGINE='instrument-evidence-authoring-2'

def valid_uuid(value):
    try:return str(uuid.UUID(value))==value
    except (ValueError,TypeError,AttributeError):return False

class Arrangements:
    def __init__(self):self.lock=threading.Lock();self.children=[];JOBS.mkdir(exist_ok=True)

    def read(self,identifier):
        if not valid_uuid(identifier):raise ValueError('伴奏任务标识无效')
        file=JOBS/identifier/'state.json'
        if not file.exists():raise ValueError('找不到该伴奏任务')
        return json.loads(file.read_text())

    def public(self,state):
        self.children=[p for p in self.children if p.poll() is None]
        stage=state['stage']
        if stage in ('queued','analyzing','rendering'):
            try:
                if state.get('pid'):os.kill(state['pid'],0)
                elif time.time()-state['created_at']>10:stage='interrupted'
            except ProcessLookupError:stage='interrupted'
        result={k:state[k] for k in ('id','project_id','start_seconds','end_seconds','created_at')}
        result.update(stage=stage,elapsed_seconds=round((state.get('finished_at') or time.time())-state['created_at'],2))
        if stage=='ready':result['candidate']=state['result']['track'];result['note_count']=state['result']['note_count']
        if stage in ('error','interrupted'):result['error']=state.get('error') or '本地伴奏进程已停止，可重新生成；原工程未改变'
        result['operation']=state.get('operation','piano')
        result['engine']=state.get('engine','instrument-reorchestration-1')
        if state.get('reused_from'):result['reused_from']=state['reused_from']
        return result

    def latest(self,directory):
        directory=Path(directory).resolve()
        project_id=json.loads((directory/'preparation.json').read_text())['project_id']
        values=[json.loads(p.read_text()) for p in JOBS.glob('*/state.json')]
        values=[v for v in values if v['project_id']==project_id and Path(v.get('data_dir','')).resolve()==directory]
        return self.public(max(values,key=lambda v:v['created_at'])) if values else None

    def catalog(self,directory):
        file=directory/'additional-tracks.json'
        if not file.exists():return []
        manifest=json.loads(file.read_text());meta=json.loads((directory/'preparation.json').read_text())
        if manifest.get('source_sha256')!=meta['source_sha256']:raise ValueError('伴奏候选与当前歌曲不匹配')
        return list(reversed(manifest['tracks']))

    def replay(self,body):
        identifier=body.get('request_id')
        if not valid_uuid(identifier):raise ValueError('请提供有效的伴奏请求标识')
        if not (JOBS/identifier/'state.json').exists():return None
        existing=self.read(identifier)
        if any(existing[key]!=body.get(key) for key in ('project_id','start_seconds','end_seconds')) or existing.get('operation','piano')!=body.get('operation','piano') or existing.get('source_track_id')!=body.get('source_track_id'):
            raise ValueError('同一请求标识不能用于不同歌曲或选区')
        return self.public(existing)

    def start(self,project,body):
        with self.lock:
            replay=self.replay(body)
            if replay:return replay
            start,end=body.get('start_seconds'),body.get('end_seconds')
            if any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in (start,end)):
                raise ValueError('伴奏选区必须是有效秒数')
            if not 0<=start<end<=project.meta['duration_seconds'] or end-start<1:raise ValueError('伴奏选区需在歌曲内，且至少1秒')
            operation=body.get('operation','piano')
            if operation not in ('piano','reorchestrate'):raise ValueError('不支持的编配操作')
            extra={'operation':operation};source_directory=None
            if operation=='reorchestrate':
                from reorchestration import source_job
                meta,source,source_directory=source_job(project,body.get('source_track_id'))
                if not meta['range_seconds'][0]<=start<end<=meta['range_seconds'][1]:raise ValueError('重新编配选区必须位于源钢琴伴奏范围内')
                extra.update(source_track_id=meta['id'],source_track_sha256=meta['sha256'],source_track_state=project.state['tracks'][meta['id']])
            from arrangement_adapter import dependency_key
            extra['dependency_key']=dependency_key(project.directory,start,end,source_directory)
            config={**extra,'engine':ENGINE,'source_sha256':project.state['source_sha256'],'project_id':project.state['id'],
                    'fingerprint':project.fingerprint(),'start_seconds':start,'end_seconds':end}
            key=hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()
            state={**config,'id':body['request_id'],'config_key':key,'data_dir':str(project.directory.resolve()),
                   'source_revision':project.state['revision'],'stage':'queued','created_at':time.time()}
            directory=JOBS/state['id'];directory.mkdir(exist_ok=True)
            for file in JOBS.glob('*/state.json'):
                other=json.loads(file.read_text())
                if other.get('config_key')==key and other['stage']=='ready' and Path(other.get('data_dir','')).resolve()==project.directory.resolve():
                    state.update(stage='ready',finished_at=time.time(),result=other['result'],reused_from=other['id']);save_json(directory/'state.json',state)
                    return self.public(state)
            save_json(directory/'state.json',state)
            try:
                with (directory/'worker.log').open('a') as log:
                    child=subprocess.Popen([str(CODE_ROOT.parent/'audio-separation/.venv/bin/python'),str(CODE_ROOT/'arrangements.py'),
                                            '--run-job',state['id']],stdout=log,stderr=log,start_new_session=True,
                                            env={**os.environ,'MUSIC_WORKBENCH_ROOT':str(ROOT),'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
                self.children.append(child)
            except OSError as exc:
                state.update(stage='error',error=str(exc),finished_at=time.time());save_json(directory/'state.json',state)
            return self.public(state)

def work(identifier):
    manager=Arrangements();state=manager.read(identifier);directory=JOBS/identifier;file=directory/'state.json'
    def stage(name,**extra):
        state.update(stage=name,**extra);save_json(file,state)
    stage('queued',pid=os.getpid())
    try:
        with (JOBS/'.engine.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            source=Path(state['data_dir']);meta=json.loads((source/'preparation.json').read_text())
            if meta['source_sha256']!=state['source_sha256']:raise ValueError('歌曲来源已变化，已停止生成')
            if state.get('engine')==ENGINE:
                from arrangement_adapter import render_piano, render_guitar, dependency_key
                source_directory=None
                if state.get('operation')=='reorchestrate':
                    from project import Project
                    from reorchestration import source_job
                    _,_,source_directory=source_job(Project(source),state.get('source_track_id'))
                if dependency_key(source,state['start_seconds'],state['end_seconds'],source_directory)!=state['dependency_key']:
                    raise ValueError('编配依据已变化，请按当前版本重新生成候选')
                renderer=render_guitar if state.get('operation')=='reorchestrate' else render_piano
                report=renderer(source,state,directory,stage=stage)
            elif state.get('operation')=='reorchestrate':
                from reorchestration import render
                stage('rendering');report=render(source,state,directory)
            else:
                from piano_arrangement import analyze, render
                stage('analyzing');analysis=analyze(source,state['start_seconds'],state['end_seconds']);save_json(directory/'analysis.json',analysis)
                stage('rendering');report=render(source,analysis,directory)
            stage('ready',result=report,finished_at=time.time())
    except Exception as exc:
        stage('error',error=str(exc)[:250],finished_at=time.time());raise

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--run-job',required=True);work(parser.parse_args().run_job)
