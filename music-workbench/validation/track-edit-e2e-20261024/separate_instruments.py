"""Fixed-target separation estimates; their output does not prove presence."""
from pathlib import Path
import argparse, fcntl, hashlib, json, os, time
import numpy as np
import soundfile as sf
from project import save_json

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def cached(directory):
    path=directory/'instrument-separation.json'
    if not path.exists():return None
    report=json.loads(path.read_text())
    if report.get('input_sha256')!=sha(directory/'other.wav'):return None
    if all((directory/f'{name}.wav').exists() and sha(directory/f'{name}.wav')==asset['sha256']
           for name,asset in report.get('assets',{}).items()) and set(report.get('assets',{}))=={'piano','guitar'}:
        return report

def run(directory):
    directory=Path(directory).resolve()
    status=directory/'instrument-job.json'
    with (directory/'.instrument-separation.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if cached(directory):
            save_json(status,{'stage':'ready','pid':os.getpid()});return
        save_json(status,{'stage':'separating','pid':os.getpid(),'started_at':time.time()})
        try:
            import torch
            from demucs.pretrained import get_model
            from demucs.apply import apply_model
            source=directory/'other.wav';digest=sha(source)
            audio,sr=sf.read(source,dtype='float32',always_2d=True)
            started=time.perf_counter();torch.set_num_threads(2);torch.manual_seed(20261024)
            device='mps' if torch.backends.mps.is_available() else 'cpu'
            if device=='mps':torch.mps.set_per_process_memory_fraction(.8)
            model=get_model('htdemucs_6s').eval()
            if sr!=model.samplerate:raise ValueError('音轨采样率与模型不匹配')
            print(json.dumps({'stage':'separating','device':device,'sources':model.sources}),flush=True)
            with torch.no_grad():
                result=apply_model(model,torch.from_numpy(audio.T.copy()).unsqueeze(0),device=device,
                                   shifts=0,split=True,overlap=.25,progress=True,num_workers=0)
            assets={}
            receipts_file=directory/'instrument-assets.json'
            receipts=json.loads(receipts_file.read_text()) if receipts_file.exists() else {}
            for name in ('piano','guitar'):
                output=directory/f'{name}.wav'
                if output.exists():
                    # Keep earlier piano estimates and cleanup variants intact.
                    old=directory/'piano-separation.json'
                    prior=json.loads(old.read_text()) if name=='piano' and old.exists() else {}
                    previous=receipts.get(name,{})
                    proven=(prior.get('input_sha256')==digest and prior.get('piano_sha256')==sha(output)) or (
                        previous.get('input_sha256')==digest and previous.get('sha256')==sha(output))
                    if not proven:
                        raise ValueError(f'{name} 已有文件来源未确认，未覆盖')
                    estimate,rate=sf.read(output,dtype='float32',always_2d=True)
                    if rate!=sr or estimate.shape!=audio.shape:raise ValueError('已有音轨时长不匹配')
                else:
                    estimate=result[0,model.sources.index(name)].cpu().numpy().T
                    if estimate.shape!=audio.shape or not np.isfinite(estimate).all():raise ValueError('分离音频不完整')
                    temp=directory/f'{name}.preparing.wav'
                    sf.write(temp,estimate,sr,subtype='FLOAT');os.replace(temp,output)
                assets[name]={'sha256':sha(output),'rms':float(np.sqrt(np.mean(estimate**2)))}
                receipts[name]={'input_sha256':digest,'sha256':assets[name]['sha256']}
                save_json(receipts_file,receipts)
            report={'model':'htdemucs_6s','input_sha256':digest,'assets':assets,'sample_rate':sr,
                    'frames':len(audio),'seconds':round(time.perf_counter()-started,3),
                    'instrument_presence':{name:'unverified' for name in ('piano','guitar')},
                    'limitations':['Fixed output targets do not prove the corresponding instruments are present.',
                                   'Bleed/artifacts need listening review.',
                                   'Not newly composed parts; remaining Other is a compensated residual.']}
            save_json(directory/'instrument-separation.json',report)
            save_json(status,{'stage':'ready','pid':os.getpid(),'seconds':report['seconds']})
            print(json.dumps(report),flush=True)
        except Exception as exc:
            save_json(status,{'stage':'error','error':str(exc)[:240],'pid':os.getpid()});raise

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--data-dir',required=True)
    run(parser.parse_args().data_dir)
