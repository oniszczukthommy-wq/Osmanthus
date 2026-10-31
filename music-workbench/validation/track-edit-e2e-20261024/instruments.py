"""Local background preparation. No provider calls and no project edits here."""
from runtime_support import check_process, venv_python
from pathlib import Path
import json, os, subprocess, threading
from project import ROOT, save_json
from separate_instruments import cached

class Instruments:
    def __init__(self):self.lock=threading.Lock();self.children=[]

    def status(self,directory):
        self.children=[p for p in self.children if p.poll() is None]
        directory=Path(directory)
        report=cached(directory)
        if report:return {'stage':'ready','seconds':report['seconds'],'assets':list(report['assets'])}
        file=directory/'instrument-job.json'
        if not file.exists():return {'stage':'not_prepared'}
        state=json.loads(file.read_text())
        if state['stage']=='separating':
            try:check_process(state['pid'])
            except (ProcessLookupError,KeyError):return {'stage':'interrupted','error':'分离进程已停止，可重试；已有工程不受影响。'}
        elif state['stage']=='ready':return {'stage':'error','error':'分离文件校验失败，请检查本地日志。'}
        return {k:v for k,v in state.items() if k!='pid'}

    def start(self,directory):
        directory=Path(directory)
        with self.lock:
            self.children=[p for p in self.children if p.poll() is None]
            state=self.status(directory)
            if state['stage'] in ('ready','separating'):return state
            # Only one heavy instrument inference at a time, across songs.
            directories=[ROOT/'data',*(ROOT/'projects').glob('*/data')]
            for other in directories:
                if other!=directory and (other/'instrument-job.json').exists() and self.status(other)['stage']=='separating':
                    raise ValueError('另一首歌曲正在准备器乐分轨，请等待完成后重试')
            python=venv_python(ROOT.parent/'audio-separation/.venv', 'OSMANTHUS_SEPARATION_PYTHON', fallback=True)
            with (directory/'instrument-job.log').open('a') as log:
                process=subprocess.Popen([str(python),str(ROOT/'separate_instruments.py'),'--data-dir',str(directory)],
                                         stdout=log,stderr=log,start_new_session=True)
            self.children.append(process)
            save_json(directory/'instrument-job.json',{'stage':'separating','pid':process.pid})
            return {'stage':'separating'}
