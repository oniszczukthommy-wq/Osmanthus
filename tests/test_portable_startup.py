"""Real local service/encoding smoke test; no keys, paid APIs or model weights."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
CODE=ROOT/'music-workbench/validation/track-edit-e2e-20261024'
sys.path.insert(0,str(CODE))
from runtime_support import file_lock,check_process


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


def call(base,route,body=None):
    req=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type':'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=30) as response:
        data=response.read()
        return json.loads(data) if 'json' in response.headers.get('Content-Type','') else data


class PortableTests(unittest.TestCase):
    def test_lock_and_process_check_across_processes(self):
        with tempfile.TemporaryDirectory(prefix='osmanthus lock ') as folder:
            lock=Path(folder)/'worker.lock'
            program="from runtime_support import file_lock; import sys,time; f=open(sys.argv[1],'a'); file_lock.flock(f,file_lock.LOCK_EX); print('locked',flush=True); time.sleep(30)"
            child=subprocess.Popen([sys.executable,'-X','utf8','-c',program,str(lock)],cwd=CODE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'locked')
                check_process(child.pid)
                self.assertIsNone(child.poll(),'Process checks must never terminate a Windows worker')
                with lock.open('a') as handle:
                    with self.assertRaises(BlockingIOError):file_lock.flock(handle,file_lock.LOCK_EX|file_lock.LOCK_NB)
            finally:
                child.terminate();child.communicate(timeout=10)
            with lock.open('a') as handle:
                file_lock.flock(handle,file_lock.LOCK_EX|file_lock.LOCK_NB)
                file_lock.flock(handle,file_lock.LOCK_UN)

    def test_fresh_checkout_start_edit_export_and_stop(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory(prefix='Osmanthus 中文 workspace ') as folder:
            workspace=Path(folder)
            ignore=shutil.ignore_patterns('.venv','__pycache__','.local','data','projects','workflow','exports','*-jobs','audits','.env','.env.local','active-project.json')
            for name in ['music-workbench','mv-studio']:
                shutil.copytree(ROOT/name,workspace/name,ignore=ignore)
            music=workspace/'music-workbench/validation/track-edit-e2e-20261024'
            launcher=workspace/'music-workbench/tools/osmanthus_web.py'
            music_port,mv_port=port(),port()
            while music_port==mv_port:mv_port=port()
            env={k:v for k,v in os.environ.items() if not any(word in k for word in ['API_KEY','ENV_FILE','DATA_DIR','WORKBENCH_ROOT','WORKSPACE_ID'])}
            env.update(OSMANTHUS_PYTHON=sys.executable,MUSIC_EDITOR_PORT=str(music_port),MUSIC_MV_PORT=str(mv_port),
                       MV_DISABLE_MODELS='1',PYTHONUTF8='1',PYTHONIOENCODING='utf-8')
            base=f'http://127.0.0.1:{music_port}'
            command=[sys.executable,'-X','utf8',str(launcher)]
            state=workspace/'music-workbench/.local/osmanthus-web/services.json'
            try:
                started=subprocess.run(command+['start'],cwd=workspace,env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
                if started.returncode:
                    logs='\n'.join(f.read_text(encoding='utf-8',errors='replace')[-5000:] for f in state.parent.glob('*.log'))
                    self.fail(started.stdout+started.stderr+logs)
                empty=call(base,'/api/project')
                self.assertTrue(empty['empty']);self.assertEqual(empty['tracks'],[])
                self.assertFalse((music/'data/project.json').exists(),'Empty startup must not invent or overwrite a song')
                self.assertEqual(call(base,'/api/generation/jobs')['jobs'],[])
                self.assertIn(b'Osmanthus',call(base,'/'))
                self.assertIn(b'osmanthus-theme.css',call(base,'/mv/'))
                capabilities=call(base,'/mv/api/capabilities')
                self.assertTrue(capabilities['freeRender']);self.assertFalse(capabilities['deepseek'])
                self.assertFalse(capabilities['canvas']['imageVideo']['available'])
                # A tiny, explicitly synthetic fixture verifies actual editing/export.
                identifier=str(uuid.uuid4());data=music/'projects'/identifier/'data';data.mkdir(parents=True)
                rate=44100;frames=rate*2;at=np.arange(frames)/rate
                tracks=[];mix=np.zeros((frames,2),dtype='float32')
                for i,name in enumerate(['vocals','bass','drums','other']):
                    wave=np.repeat((.025*np.sin(2*np.pi*(220+i*110)*at))[:,None],2,axis=1).astype('float32')
                    mix+=wave;file=data/(name+'.wav');sf.write(file,wave,rate,subtype='FLOAT')
                    tracks.append({'id':name,'label':name,'color':'#aabbcc','file':file.name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
                sf.write(data/'original.wav',mix,rate,subtype='FLOAT');sf.write(data/'baseline.wav',mix,rate,subtype='FLOAT')
                digest=hashlib.sha256((data/'original.wav').read_bytes()).hexdigest()
                metadata={'project_id':identifier,'song_title':'中文测试音频','source_sha256':digest,'sample_rate':rate,'frames':frames,
                    'duration_seconds':2,'master_gain':1,'separation_seconds':0,'tracks':tracks,'provider':'synthetic-test'}
                project={'id':identifier,'revision':0,'title':'中文测试音频','source_sha256':digest,'history':[],'cursor':0,'track_switches_version':1,
                    'tracks':{t['id']:{'segments':[],'gain_db':0,'muted':False,'solo':False} for t in tracks}}
                for name,value in [('preparation.json',metadata),('project.json',project)]:
                    (data/name).write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
                active=call(base,'/api/projects/activate',{'target_id':identifier,'project_id':empty['id'],'revision':0})['project']
                self.assertEqual(active['title'],'中文测试音频');self.assertEqual(len(active['tracks']),4)
                edited=call(base,'/api/edit',{'project_id':identifier,'revision':0,'command':{'type':'track_mix','track_id':'bass','muted':True}})
                self.assertTrue(next(t for t in edited['project']['tracks'] if t['id']=='bass')['muted'])
                revision=edited['project']['revision']
                for format in ['wav','mp3']:
                    exported=call(base,'/api/export',{'project_id':identifier,'revision':revision,'format':format})
                    content=call(base,exported['url'])
                    self.assertGreater(len(content),10000)
                    self.assertEqual(hashlib.sha256(content).hexdigest(),exported['sha256'])
                # Restart keeps the same real project and edits.
                stopped=subprocess.run(command+['stop'],cwd=workspace,env=env,capture_output=True,text=True,encoding='utf-8',timeout=20)
                self.assertEqual(stopped.returncode,0,stopped.stdout+stopped.stderr)
                restarted=subprocess.run(command+['start'],cwd=workspace,env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
                self.assertEqual(restarted.returncode,0,restarted.stdout+restarted.stderr)
                self.assertEqual(call(base,'/api/project')['revision'],revision)
            finally:
                stopped=subprocess.run(command+['stop'],cwd=workspace,env=env,capture_output=True,text=True,encoding='utf-8',timeout=25)
                if stopped.returncode:print('STOP FAILURE:',stopped.stdout,stopped.stderr)
            self.assertEqual(json.loads(state.read_text(encoding='utf-8')),{},'Service records must be cleared after verified stop')


if __name__=='__main__':unittest.main(verbosity=2)
