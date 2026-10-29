"""Re-sing an existing, reviewed lead melody with an installed DiffSinger bank.
No weights modified, no TTS, no paid request, no edit to the source project.
"""
from pathlib import Path
import argparse,json,time,hashlib,resource
import numpy as np, soundfile as sf, onnxruntime as ort, textgrid
ROOT=Path(__file__).resolve().parent;BANK=ROOT.parent/'vocal-qixuan/models/qixuan/Qixuan_v2.7.0_DiffSinger_OpenUtau';VOCODER=ROOT.parent/'vocal-qixuan/models/vocoder'
SR=44100;HOP=512;FRAME=HOP/SR

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def prepare(score,grid,audio,start,end):
 total=int(np.ceil(len(audio)/HOP));centers=np.arange(total)*FRAME
 voiced=[n for n in score['notes'] if n['voiced']]
 pitch=np.full(total,voiced[0]['midi'],np.float32)
 # Nearest melody segment supplies a pitch in consonants and short rests.
 cursor=0
 for n in voiced:
  a,b=round(n['start_seconds']/FRAME),round(n['end_seconds']/FRAME)
  if a>cursor:pitch[cursor:a]=n['midi']
  pitch[a:b]=n['midi'];cursor=b
 pitch[cursor:]=voiced[-1]['midi']
 # Read the actual vocal pitch near the reviewed notes; retains source vibrato.
 # This constrained tracker is a synthesis input, NOT an independent accuracy test.
 mono=audio.mean(axis=1);window=round(.06*SR);half=window//2;matched=0
 for i,t in enumerate(centers):
  if not start<=t<end:continue
  center=round(t*SR);seg=mono[max(0,center-half):min(len(mono),center+half)]
  if len(seg)<window or np.sqrt(np.mean(seg**2))<.003:continue
  seg=(seg-seg.mean())*np.hanning(len(seg));ac=np.fft.irfft(np.abs(np.fft.rfft(seg,n=8192))**2,n=8192)
  freq=440*2**((pitch[i]-69)/12);lo=max(2,int(SR/(freq*2**(2/12))));hi=min(window-2,int(SR/(freq/2**(2/12))))
  peaks=[j for j in range(lo+1,hi) if ac[j]>=ac[j-1] and ac[j]>ac[j+1]]
  if not peaks or ac[0]<=0:continue
  lag=max(peaks,key=lambda j:ac[j])
  if ac[lag]/ac[0]<.35:continue
  den=ac[lag-1]-2*ac[lag]+ac[lag+1];delta=.5*(ac[lag-1]-ac[lag+1])/den if den else 0
  pitch[i]=69+12*np.log2((SR/(lag+delta))/440);matched+=1
 phones=[];cursor=0
 for interval in next(t for t in grid if t.name=='phones'):
  a=max(cursor,round(interval.minTime/FRAME));b=min(total,round(interval.maxTime/FRAME))
  if a>cursor:phones.append({'start':cursor,'end':a,'phone':'SP'})
  if b>a:phones.append({'start':a,'end':b,'phone':'zh/'+interval.mark if interval.mark else 'SP'})
  cursor=max(cursor,b)
 if cursor<total:phones.append({'start':cursor,'end':total,'phone':'SP'})
 a=max(0,round(start/FRAME));b=min(total,round(end/FRAME));cuts=[a]
 for p in phones:
  if p['phone']=='SP' and p['end']-p['start']>=round(.12/FRAME):
   cut=(p['start']+p['end'])//2
   if a<cut<b and cut-cuts[-1]>=round(2/FRAME):cuts.append(cut)
 cuts.append(b)
 return pitch,phones,list(zip(cuts[:-1],cuts[1:])),matched

class Engine:
 def __init__(self,threads=2):
  opt=ort.SessionOptions();opt.intra_op_num_threads=threads;opt.inter_op_num_threads=1;opt.log_severity_level=3
  for name in ['session.intra_op.allow_spinning','session.inter_op.allow_spinning']:opt.add_session_config_entry(name,'0')
  paths={'linguistic':next((BANK/'dsvariance').glob('*.linguistic.onnx')),'variance':next((BANK/'dsvariance').glob('*.variance.onnx')),'acoustic':next(BANK.glob('*.onnx')),'vocoder':next(VOCODER.glob('*.onnx'))}
  self.paths=paths;self.sessions={k:ort.InferenceSession(str(v),sess_options=opt,providers=['CPUExecutionProvider']) for k,v in paths.items()}
  self.acoustic_table=json.loads(next(BANK.glob('*.phonemes.json')).read_text());self.variance_table=json.loads(next((BANK/'dsvariance').glob('*.phonemes.json')).read_text())
 def synth(self,phones,durations,pitch,steps=20):
  langs=np.asarray([[3 if p.startswith('zh/') else 0 for p in phones]],np.int64);dur=np.asarray([durations],np.int64);pitch=pitch[None,:].astype(np.float32);f0=(440*2**((pitch-69)/12)).astype(np.float32)
  enc,_=self.sessions['linguistic'].run(None,{'tokens':np.asarray([[self.variance_table[p] for p in phones]],np.int64),'languages':langs,'ph_dur':dur})
  breath,voicing=self.sessions['variance'].run(None,{'encoder_out':enc,'ph_dur':dur,'pitch':pitch,'breathiness':np.zeros_like(pitch),'voicing':np.zeros_like(pitch),'retake':np.ones((*pitch.shape,2),bool),'steps':np.asarray(10,np.int64)})
  mel=self.sessions['acoustic'].run(None,{'tokens':np.asarray([[self.acoustic_table[p] for p in phones]],np.int64),'languages':langs,'durations':dur,'f0':f0,'breathiness':breath,'voicing':voicing,'gender':np.zeros_like(pitch),'velocity':np.ones_like(pitch),'depth':np.asarray(.6,np.float32),'steps':np.asarray(steps,np.int64)})[0]
  return self.sessions['vocoder'].run(None,{'mel':mel,'f0':f0})[0].flatten()

def main():
 p=argparse.ArgumentParser();p.add_argument('--score',type=Path,required=True);p.add_argument('--textgrid',type=Path,required=True);p.add_argument('--vocal',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--start',type=float,default=0);p.add_argument('--end',type=float);args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True);started=time.perf_counter()
 score=json.loads(args.score.read_text());audio,sr=sf.read(args.vocal,dtype='float32',always_2d=True);assert sr==SR;assert digest(args.vocal)==score['vocal_sha256'];end=min(args.end or len(audio)/sr,len(audio)/sr)
 pitch,phones,chunks,matched=prepare(score,textgrid.TextGrid.fromFile(str(args.textgrid)),audio,args.start,end)
 report={'voicebank':'绮萱 Qixuan 2.7.0','preset_id':'qixuan-2.7.0','source_score_sha256':digest(args.score),'source_vocal_sha256':digest(args.vocal),'source_project_id':score['project_id'],'start_seconds':args.start,'end_seconds':end,'attribution':'AI 合成；绮萱；DiffSinger；声码器 OpenVPI Team','cash_rmb':0,'weights_modified':False,'pitch_source':'reviewed melody plus source-vocal autocorrelation within ±2 semitones; not independent verification','tracked_frames':matched,'quality_accepted':False,'chunks':[]}
 engine=Engine();report['model_hashes']={k:digest(v) for k,v in engine.paths.items()};report['model_load_and_frontend_seconds']=time.perf_counter()-started
 output=np.zeros(len(audio),np.float32);pad=round(.3/FRAME)
 for i,(a,b) in enumerate(chunks):
  began=time.perf_counter();parts=[v for v in phones if v['end']>a and v['start']<b];names=['SP']+[v['phone'] for v in parts]+['SP'];durations=[pad]+[min(b,v['end'])-max(a,v['start']) for v in parts]+[pad]
  curve=np.pad(pitch[a:b],(pad,pad),mode='edge');assert sum(durations)==len(curve)
  data=engine.synth(names,durations,curve);data=data[pad*HOP:(pad+b-a)*HOP];n=min(len(data),len(output)-a*HOP);output[a*HOP:a*HOP+n]=data[:n]
  report['chunks'].append({'index':i,'start_seconds':a*FRAME,'end_seconds':b*FRAME,'seconds':time.perf_counter()-began,'phonemes':names,'phoneme_frames':durations,'peak':float(np.max(np.abs(data)))})
  (args.output/'progress.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:report['chunks'][-1][k] for k in ['index','start_seconds','end_seconds','seconds','peak']}),flush=True)
 a,b=round(args.start*SR),round(end*SR);part=output[a:b];assert np.isfinite(part).all() and np.sqrt(np.mean(part**2))>.001
 sf.write(args.output/'qixuan-vocal.wav',part,SR,subtype='FLOAT');sf.write(args.output/'original-vocal.wav',audio[a:b],SR,subtype='FLOAT')
 np.save(args.output/'input-pitch-midi.npy',pitch)
 report.update(status='synthesized_pending_listening',elapsed_seconds=time.perf_counter()-started,sample_rate=SR,samples=len(part),peak=float(np.max(np.abs(part))),clipped_samples=int(np.count_nonzero(np.abs(part)>=1)),max_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,output_sha256=digest(args.output/'qixuan-vocal.wav'))
 (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:report[k] for k in ['status','elapsed_seconds','samples','peak','clipped_samples']}),flush=True)
if __name__=='__main__':main()
