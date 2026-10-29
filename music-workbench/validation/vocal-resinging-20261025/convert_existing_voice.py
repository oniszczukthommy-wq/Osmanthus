"""Private short SVC test using a user-selected, already archived voice reference."""
from pathlib import Path
import sys,os,json,time,hashlib,argparse
BASE=Path(__file__).resolve().parent;REPO=BASE.parent/'seed-vc-20261025';LIB=BASE.parent.parent/'research/minimax-voice-knowledge-20261024'
p=argparse.ArgumentParser();p.add_argument('--voice-id',required=True);p.add_argument('--steps',type=int,default=30);args=p.parse_args()
voice=next(v for v in json.loads((LIB/'knowledge-base.json').read_text())['voices'] if v['web_voice_id']==args.voice_id)
manifest=next(v for v in json.loads((LIB/'preview-manifest.json').read_text())['manifest'] if v['web_voice_id']==args.voice_id)
target=(LIB/voice['local_sample']).resolve();assert hashlib.sha256(target.read_bytes()).hexdigest()==manifest['sha256']
source=BASE/'phrase/original-vocal.wav';out=BASE/('conversion-'+args.voice_id);out.mkdir(exist_ok=True)
os.chdir(REPO);sys.path.insert(0,str(REPO));os.environ['HF_HUB_DISABLE_XET']='1';os.environ['TOKENIZERS_PARALLELISM']='false'
import torch,soundfile as sf
from types import SimpleNamespace
import inference
torch.set_num_threads(2);torch.set_num_interop_threads(1);inference.device=torch.device('cpu')
# The installed torchaudio save path depends on a separate TorchCodec build.
# SoundFile writes the exact returned waveform without any DSP change.
def save(path,samples,sample_rate,**kwargs):sf.write(path,samples.detach().cpu().numpy().T,sample_rate,subtype='FLOAT')
inference.torchaudio.save=save
settings=SimpleNamespace(source=str(source),target=str(target),output=str(out),diffusion_steps=args.steps,length_adjust=1.0,inference_cfg_rate=.7,f0_condition=True,auto_f0_adjust=False,semi_tone_shift=0,fp16=False,checkpoint=None,config=None)
report={'voice_id':args.voice_id,'voice_name':voice.get('short_name',voice['name']),'target_reference_sha256':manifest['sha256'],'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'source_song':'雨后慢行','source_range_seconds':[40,48],'source_performance_retained_goal':True,'f0_condition':True,'auto_f0_adjust':False,'semitone_shift':0,'length_adjust':1.0,'diffusion_steps':args.steps,'device':'cpu','training':False,'cash_rmb':0,'quality_accepted':False,'scope':'Private reference conditioning, not a downloaded MiniMax singer model or an official music Voice ID integration'}
(out/'request.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
started=time.perf_counter();inference.main(settings);report['total_seconds_including_model_load']=time.perf_counter()-started
outputs=list(out.glob('vc_*.wav'));assert len(outputs)==1
wave,sr=sf.read(outputs[0],always_2d=True)
import numpy as np
report.update(status='converted_pending_listening',output=str(outputs[0]),sample_rate=sr,output_seconds=len(wave)/sr,peak=float(np.max(np.abs(wave))),rms=float(np.sqrt(np.mean(wave**2))),finite=bool(np.isfinite(wave).all()),output_sha256=hashlib.sha256(outputs[0].read_bytes()).hexdigest())
(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False),flush=True)
