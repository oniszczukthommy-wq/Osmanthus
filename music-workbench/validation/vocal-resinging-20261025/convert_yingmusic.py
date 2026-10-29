"""Compare newer singing-specific SVC with the same selected archived reference."""
from pathlib import Path
import os,sys,time,json,hashlib,argparse
parser=argparse.ArgumentParser();parser.add_argument('--device',choices=['cpu','mps'],default='cpu');parser.add_argument('--context',action='store_true');parser.add_argument('--hybrid',action='store_true');parser.add_argument('--source-override',type=Path);parser.add_argument('--label');parser.add_argument('--voice-id',default='226869000163476');parser.add_argument('--full',action='store_true');parser.add_argument('--progress',type=Path);parser.add_argument('--seed',type=int,default=20261025);run_args=parser.parse_args()
if run_args.source_override:run_args.source_override=run_args.source_override.resolve()
if run_args.progress:run_args.progress=run_args.progress.resolve()
BASE=Path(__file__).resolve().parent;REPO=BASE.parent/'yingmusic-svc-20261025';LIB=BASE.parent.parent/'research/minimax-voice-knowledge-20261024';os.chdir(REPO);sys.path.insert(0,str(REPO));os.environ['HF_HUB_DISABLE_XET']='1';os.environ['TOKENIZERS_PARALLELISM']='false';os.environ['PYTORCH_ENABLE_MPS_FALLBACK']='1'
from huggingface_hub import hf_hub_download
from types import SimpleNamespace
import torch,soundfile as sf,numpy as np
torch.manual_seed(run_args.seed);np.random.seed(run_args.seed);torch.set_num_threads(2);torch.set_num_interop_threads(1);device=torch.device(run_args.device)
if run_args.device=='mps':
 assert torch.backends.mps.is_available();torch.mps.set_per_process_memory_fraction(.6)
import my_inference as inference
from modules.diffusion_transformer import DiT
original_cache=DiT.setup_caches
def setup_cache(self,max_batch_size,max_seq_length):return original_cache(self,max_batch_size,min(max_seq_length,3072))
DiT.setup_caches=setup_cache
# Cache extent only: all official inference windows are <=30s / 2580 frames.
# No weight conversion, fine tuning, transposition, or new speech generation.
def save(path,samples,sample_rate,**kwargs):sf.write(path,samples.detach().cpu().numpy().T,sample_rate,subtype='FLOAT')
inference.torchaudio.save=save
id=run_args.voice_id;voice=next(v for v in json.loads((LIB/'knowledge-base.json').read_text())['voices'] if v['web_voice_id']==id);target=(LIB/voice['local_sample']).resolve();source=BASE/'phrase/original-vocal.wav';out=BASE/(run_args.label or ('yingmusic-context38-52-'+run_args.device+('-hybrid' if run_args.hybrid else '') if run_args.context else 'yingmusic-226869000163476'));out.mkdir(exist_ok=True)
if run_args.context:
 raw=BASE.parent/'track-edit-e2e-20261024/projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data/vocals.wav';audio,rate=sf.read(raw,start=38*44100,stop=52*44100,always_2d=True,dtype='float32');source=out/'context-source.wav';sf.write(source,audio,rate,subtype='FLOAT')
if run_args.source_override:source=run_args.source_override.resolve()
started=time.perf_counter();checkpoint=hf_hub_download('GiantAILab/YingMusic-SVC','YingMusic-SVC-full.pt',cache_dir='./checkpoints')
settings=SimpleNamespace(checkpoint=checkpoint,config=str(REPO/'configs/YingMusic-SVC.yml'),fp16=False,source=str(source),target=str(target),diffusion_steps=50,length_adjust=1.,inference_cfg_rate=.7,f0_condition=True,semi_tone_shift=0,output=str(out),expname='take-50steps',uuid='fixed-source-voice')
request={'model':'YingMusic-SVC-full','checkpoint_sha256':hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest(),'voice_id':id,'voice_name':voice.get('short_name',voice['name']),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'target_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'source_range_seconds':[0,sf.info(source).duration] if run_args.full else ([38,52] if run_args.context else [40,48]),'seed':run_args.seed,'diffusion_steps':50,'cfg':.7,'semi_tone_shift':0,'length_adjust':1.,'cache_frames':3072,'device':run_args.device,'quality_accepted':False,'weights_modified':False,'source_preprocessing':'MDX Reverb_HQ_By_FoxJoy' if run_args.source_override and not run_args.full else None,'new_paid_song_requests':0,'model_license':'CC-BY-NC-4.0; current personal noncommercial prototype'}
(out/'request.json').write_text(json.dumps(request,ensure_ascii=False,indent=2));models=inference.load_models_api(settings,device=torch.device('cpu') if run_args.hybrid else device)
if run_args.device=='mps':
 bundle=list(models);raw_f0=bundle[2]
 def f0_fp32(*args,**kwargs):return np.asarray(raw_f0(*args,**kwargs),dtype=np.float32)
 bundle[2]=f0_fp32;models=tuple(bundle)
if run_args.hybrid:
 bundle=list(models);flow,semantic,f0,vocoder,style_encoder,mel,args_mel=bundle
 for network in flow.values():network.to(device)
 def semantic_gpu(waves):return semantic(waves.cpu()).to(device)
 def f0_cpu(waves,**kwargs):return np.asarray(raw_f0(waves.cpu(),**kwargs),dtype=np.float32)
 def style_gpu(features):return style_encoder(features.cpu()).to(device)
 def stage_vocoder(mels):
  for network in flow.values():network.to('cpu')
  torch.mps.empty_cache();vocoder.to(device)
  result=vocoder(mels.to(device)).cpu();vocoder.to('cpu');torch.mps.empty_cache()
  for network in flow.values():network.to(device)
  return result
 models=(flow,semantic_gpu,f0_cpu,stage_vocoder,style_gpu,mel,args_mel)
 request['execution_strategy']='CPU feature extractors; MPS flow; offload flow during MPS vocoder; no concurrent large GPU models'
loaded=time.perf_counter();print('YingMusic model ready',flush=True)
if run_args.progress:
 progress={'stage':'converting','chunks_started':0,'chunks_finished':0,'created_at':time.time(),'source_seconds':sf.info(source).duration}
 def write_progress():
  temporary=run_args.progress.with_suffix('.tmp');temporary.write_text(json.dumps(progress));os.replace(temporary,run_args.progress)
 raw_flow=models[0].cfm.inference
 def measured_flow(*args,**kwargs):
  progress.update(chunks_started=progress['chunks_started']+1,updated_at=time.time());write_progress()
  result=raw_flow(*args,**kwargs)
  progress.update(chunks_finished=progress['chunks_finished']+1,updated_at=time.time());write_progress()
  return result
 models[0].cfm.inference=measured_flow
 write_progress()

output=inference.run_inference(settings,models,device=device);wave,sr=sf.read(output,always_2d=True)
request.update(status='converted_pending_listening',output=output,total_seconds_including_download=time.perf_counter()-started,model_prepare_seconds=loaded-started,inference_seconds=time.perf_counter()-loaded,sample_rate=sr,duration_seconds=len(wave)/sr,finite=bool(np.isfinite(wave).all()),peak=float(np.max(np.abs(wave))),rms=float(np.sqrt(np.mean(wave**2))))
(out/'report.json').write_text(json.dumps(request,ensure_ascii=False,indent=2));print(json.dumps(request,ensure_ascii=False),flush=True)

if run_args.progress:
 progress.update(stage='converted',updated_at=time.time());write_progress()
