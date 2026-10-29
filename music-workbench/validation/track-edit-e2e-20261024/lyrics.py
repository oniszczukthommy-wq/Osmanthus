"""Read-only, durable lyric timing from the actual lead vocal, never mixer gain."""
from pathlib import Path
import argparse, fcntl, hashlib, json, os, shutil, subprocess, threading, time, uuid
from project import ROOT, save_json
from scores import source_context, valid_id, BASE, PYTHON
from vocal_sources import lead_vocal_source

JOBS=ROOT/'lyric-jobs'
ENGINE='tifa-lyric-lines-1'

def reviewed_alignment(context):
    candidates=[]
    for file in (ROOT/'score-jobs').glob('*/state.json'):
        saved=json.loads(file.read_text())
        if saved.get('stage')!='ready' or any(saved.get(k)!=context[k] for k in ('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis')):continue
        score=file.parent/'score.json'
        if not score.exists() or hashlib.sha256(score.read_bytes()).hexdigest()!=saved.get('files',{}).get('score.json'):continue
        if not json.loads(score.read_text()).get('alignment_refinements'):continue
        candidates.append(saved)
    return max(candidates,key=lambda s:s['created_at']) if candidates else None

def context_for(directory):
    context, lyrics=source_context(directory)
    context.pop('corrections_sha256',None)
    context['engine']=ENGINE
    reviewed=reviewed_alignment(context)
    if reviewed:
        context.update(timing_review_score_job_id=reviewed['id'],timing_review_score_sha256=reviewed['files']['score.json'])
    return context,lyrics

def lyric_lines(lyrics):
    return [line.strip() for line in lyrics.splitlines() if line.strip() and not line.strip().startswith('[')]

def timed_lines(lyrics, characters, duration):
    lines=lyric_lines(lyrics)
    flat=''.join(ch for line in lines for ch in line if ch.isalnum())
    if ''.join(c['char'] for c in characters)!=flat:
        raise ValueError('对齐文字与歌词不一致，保留文本并停止同步，避免错行')
    result=[];offset=0;previous=0.
    for index,line in enumerate(lines):
        count=sum(ch.isalnum() for ch in line)
        if not count:continue
        group=characters[offset:offset+count];offset+=count
        for c in group:
            start,end=float(c['start']),float(c['end'])
            if not (0<=start<end<=duration+.05) or start<previous-.02:
                raise ValueError('歌词时间缺失或不连续，保留文本并停止同步')
            previous=end
        intervals=[]
        for char in group:
            if intervals and char['start']-intervals[-1][1]<=.35:intervals[-1][1]=char['end']
            else:intervals.append([char['start'],char['end']])
        result.append({'index':index,'text':line,'start':group[0]['start'],'end':group[-1]['end'],'intervals':intervals})
    if not result:raise ValueError('没有可同步的歌词')
    return result

def characters_from_grid(path):
    import textgrid
    grid=textgrid.TextGrid.fromFile(str(path))
    tier=next(t for t in grid if t.name=='texts')
    return [{'char':ch,'start':item.minTime,'end':item.maxTime}
            for item in tier if item.mark for ch in item.mark if ch.isalnum()]

class Lyrics:
    def __init__(self):
        JOBS.mkdir(exist_ok=True);self.lock=threading.Lock();self.children=[]

    def read(self,identifier):
        if not valid_id(identifier):raise ValueError('歌词任务标识无效')
        file=JOBS/identifier/'state.json'
        if not file.exists():raise ValueError('找不到歌词任务')
        return json.loads(file.read_text())

    def public(self,state):
        self.children=[p for p in self.children if p.poll() is None]
        stage=state['stage']
        if stage in ('queued','aligning'):
            try:
                if state.get('pid'):os.kill(state['pid'],0)
                elif time.time()-state['created_at']>15:stage='interrupted'
            except ProcessLookupError:stage='interrupted'
        result={k:state[k] for k in ('id','project_id','lyrics','basis','vocal_sha256','lyrics_sha256')}
        result.update(stage=stage,engine=ENGINE,accuracy_accepted=False)
        if stage=='ready':
            file=JOBS/state['id']/'timing.json'
            if not file.exists() or hashlib.sha256(file.read_bytes()).hexdigest()!=state['timing_sha256']:
                result.update(stage='error',error='歌词时间文件校验失败，可重新对齐')
            else:result.update(json.loads(file.read_text()))
        if stage in ('error','interrupted'):result['error']=state.get('error','歌词同步已中断，可重试；歌词文本可继续查看')
        return result

    def latest(self,directory):
        context,lyrics=context_for(directory)
        values=[json.loads(p.read_text()) for p in JOBS.glob('*/state.json')]
        values=[s for s in values if all(s.get(k)==v for k,v in context.items())]
        return {'job':self.public(max(values,key=lambda s:s['created_at'])) if values else None,'lyrics':lyrics,**context}

    def start(self,directory):
        with self.lock:
            current=self.latest(directory)
            if current['job'] and current['job']['stage'] not in ('error','interrupted'):return current['job']
            context,lyrics=context_for(directory);identifier=str(uuid.uuid4())
            state={**context,'lyrics':lyrics,'id':identifier,'data_dir':str(directory.resolve()),'stage':'queued','created_at':time.time()}
            folder=JOBS/identifier;folder.mkdir();save_json(folder/'state.json',state)
            with (folder/'worker.log').open('a') as log:
                try:
                    child=subprocess.Popen([str(PYTHON),str(ROOT/'lyrics.py'),'--run-job',identifier],stdout=log,stderr=log,start_new_session=True,
                        env={**os.environ,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
                    self.children.append(child)
                except OSError:
                    state.update(stage='error',error='无法启动本地歌词同步任务');save_json(folder/'state.json',state)
            return self.public(state)

def work(identifier):
    manager=Lyrics();state=manager.read(identifier);folder=JOBS/identifier;directory=Path(state['data_dir'])
    def stage(name,**values):
        state.update(stage=name,**values);save_json(folder/'state.json',state)
    stage('queued',pid=os.getpid())
    try:
        # Share the score pipeline lock so local inference does not compete for memory.
        (ROOT/'score-jobs').mkdir(exist_ok=True)
        with (ROOT/'score-jobs/.engine.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            context,lyrics=context_for(directory)
            if any(state[k]!=v for k,v in context.items()):raise ValueError('人声或歌词已改变，请重新对齐')
            audio=directory/lead_vocal_source(directory)['file']
            if hashlib.sha256(audio.read_bytes()).hexdigest()!=state['vocal_sha256']:raise ValueError('人声音频校验失败')
            characters=None;reused=False
            score_files=([ROOT/'score-jobs'/state['timing_review_score_job_id']/'score.json'] if state.get('timing_review_score_job_id') else (ROOT/'score-jobs').glob('*/score.json'))
            for file in score_files:
                manifest=file.parent/'state.json'
                if not manifest.exists():continue
                saved=json.loads(manifest.read_text())
                if saved.get('stage')!='ready' or saved.get('files',{}).get('score.json')!=hashlib.sha256(file.read_bytes()).hexdigest():continue
                score=json.loads(file.read_text())
                if state.get('timing_review_score_sha256') and hashlib.sha256(file.read_bytes()).hexdigest()!=state['timing_review_score_sha256']:raise ValueError('乐句复核的时间轴已改变，未复用')
                if all(score.get(k)==state[k] for k in ('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis')) and score.get('lyrics_characters'):
                    characters=score['lyrics_characters'];reused=True;break
            if characters is None:
                stage('aligning');inputs=folder/'input';inputs.mkdir(exist_ok=True)
                target=inputs/'vocal.wav';shutil.copyfile(audio,target)
                (inputs/'vocal.txt').write_text('\n'.join(lyric_lines(lyrics)))
                with (folder/'alignment.log').open('a') as log:
                    result=subprocess.run([str(PYTHON),str(BASE/'run_tifa.py'),str(target),'--output-dir',str(folder/'alignment'),'--threads','1'],stdout=log,stderr=log,timeout=600)
                if result.returncode:raise ValueError('本地人声对齐未完成，歌词文本仍可查看，可重试同步')
                characters=characters_from_grid(folder/'alignment/vocal.TextGrid')
            meta=json.loads((directory/'preparation.json').read_text())
            lines=timed_lines(lyrics,characters,meta['duration_seconds'])
            final,_=context_for(directory)
            if final!=context:raise ValueError('人声或歌词已改变，未应用旧的时间轴')
            timing={'lines':lines,'duration':meta['duration_seconds'],'method':'actual_vocal_forced_alignment','reused_score_alignment':reused}
            if state.get('timing_review_score_job_id'):timing.update(timing_review_score_job_id=state['timing_review_score_job_id'],timing_review_score_sha256=state['timing_review_score_sha256'],method='phrase_reviewed_actual_vocal_forced_alignment')
            save_json(folder/'timing.json',timing)
            stage('ready',timing_sha256=hashlib.sha256((folder/'timing.json').read_bytes()).hexdigest(),finished_at=time.time())
    except Exception as exc:stage('error',error=str(exc)[:200],finished_at=time.time())

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--run-job',required=True);work(parser.parse_args().run_job)
