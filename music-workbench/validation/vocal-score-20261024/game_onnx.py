"""CPU singing-to-note adapter for official GAME ONNX v1.0.3.

Host pipeline follows GAME/ONNX.md and OpenVPI dataset-tools GameModel.cpp.
Predicted notes and V/UV are candidates, not calibrated accuracy/confidence.
"""
from pathlib import Path
import argparse,hashlib,json,os,time
import numpy as np
import soundfile as sf
import onnxruntime as ort
ROOT=Path(__file__).resolve().parent
MODELS=ROOT/'models/GAME-1.0.3-medium-onnx'

class Game:
 def __init__(self,models=MODELS,threads=1,seed=20261025):
  self.seed=seed;ort.set_seed(seed)
  self.models=Path(models);self.config=json.loads((self.models/'config.json').read_text());options=ort.SessionOptions();options.intra_op_num_threads=threads;options.inter_op_num_threads=1
  options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
  self.sessions={name:ort.InferenceSession(str(self.models/(name+'.onnx')),options,providers=['CPUExecutionProvider']) for name in ('encoder','segmenter','bd2dur','estimator')}
 def call(self,name,args):
  sess=self.sessions[name];feed={i.name:args[i.name] for i in sess.get_inputs()}
  return dict(zip([o.name for o in sess.get_outputs()],sess.run(None,feed)))
 def extract(self,audio,sr,offset=0.,steps=8,known_boundary_seconds=None):
  if sr!=self.config['samplerate']:raise ValueError('GAME waveform must match model sample rate')
  y=audio.mean(axis=1) if audio.ndim==2 else audio
  y=np.ascontiguousarray(y,dtype=np.float32);duration=len(y)/sr;started=time.perf_counter()
  enc=self.call('encoder',{'waveform':y[None,:],'duration':np.array([duration],np.float32)})
  mask=enc['maskT'];known=np.zeros_like(mask)
  for at in known_boundary_seconds or []:
   if not np.isfinite(at) or not offset<at<offset+duration:raise ValueError('已知边界必须位于当前音频区间内')
   frame=round((at-offset)/self.config['timestep'])
   if frame<known.shape[1] and mask[0,frame]:known[0,frame]=True
  prev=known.copy()
  for i in range(steps):
   prev=self.call('segmenter',{'x_seg':enc['x_seg'],'maskT':mask,'known_boundaries':known,'prev_boundaries':prev,
    'language':np.array([self.config['languages']['zh']],np.int64),'t':np.array([i/steps],np.float32),'threshold':np.array(.2,np.float32),'radius':np.array(2,np.int64)})['boundaries']
  durations=self.call('bd2dur',{'boundaries':prev,'maskT':mask})
  pitches=self.call('estimator',{'x_est':enc['x_est'],'boundaries':prev,'maskT':mask,'maskN':durations['maskN'],'threshold':np.array(.2,np.float32)})
  notes=[];cursor=0
  for i,(length,valid) in enumerate(zip(durations['durations'][0],durations['maskN'][0])):
   if not valid:continue
   start=cursor;cursor+=float(length);end=min(cursor,duration)
   if end<=start:continue
   present=bool(pitches['presence'][0,i]);midi=float(pitches['scores'][0,i])
   notes.append({'start_seconds':round(offset+start,6),'end_seconds':round(offset+end,6),'voiced':present,
    'midi_float':midi if present else None,'midi':int(round(midi)) if present else None,
    'cents_from_equal_temperament':round((midi-round(midi))*100,2) if present else None})
  return {'notes':notes,'duration':duration,'seconds':round(time.perf_counter()-started,3),'frames':int(mask.sum()),'steps':steps,'threshold':.2,'boundary_radius_frames':2,'segmentation_seed':self.seed,'known_boundary_seconds':known_boundary_seconds or []}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('audio',type=Path);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--start',type=float,default=0);parser.add_argument('--end',type=float);parser.add_argument('--chunk',type=float,default=float(os.environ.get('MUSIC_GAME_CHUNK_SECONDS','16')))
 args=parser.parse_args();info=sf.info(args.audio);end=args.end if args.end is not None else info.duration
 if not np.isfinite(args.chunk) or not 1<=args.chunk<=30:parser.error('chunk seconds must be between 1 and 30')
 started=time.perf_counter();model=Game();result=[];parts=[];at=args.start
 while at<end-.0001:
  stop=min(end,at+args.chunk);y,sr=sf.read(args.audio,start=round(at*info.samplerate),stop=round(stop*info.samplerate),dtype='float32',always_2d=True)
  chunk=model.extract(y,sr,offset=at);result.extend(chunk['notes']);parts.append({k:v for k,v in chunk.items() if k!='notes'});print('chunk',at,stop,parts[-1],flush=True);at=stop
 report={'engine':'GAME-1.0.3-medium-onnx','device':'CPUExecutionProvider','memory_policy':'CPU arenas and memory patterns disabled','chunk_seconds':args.chunk,'source':str(args.audio.resolve()),'source_sha256':hashlib.sha256(args.audio.read_bytes()).hexdigest(),'range_seconds':[args.start,end],
  'notes':result,'chunks':parts,'total_seconds':round(time.perf_counter()-started,3),'accuracy_accepted':False,
  'limitations':['Singing model output is a candidate; original song has no human-annotated reference yet.','Binary presence is not calibrated confidence.','Chunk boundaries can split held notes; not a musical bar/lyric segmentation.','Floating MIDI pitch is rounded only for notation; raw estimate is retained.']}
 args.output.parent.mkdir(exist_ok=True,parents=True);args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2));print('saved',args.output,'voiced',sum(n['voiced'] for n in result),flush=True)
if __name__=='__main__':main()
