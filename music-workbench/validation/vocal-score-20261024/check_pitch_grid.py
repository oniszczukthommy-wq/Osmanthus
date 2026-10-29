from pathlib import Path
import json,time,argparse,sys
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly,find_peaks
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from vocal_sources import lead_vocal_source
parser=argparse.ArgumentParser();parser.add_argument('--data-dir',type=Path,default=ROOT.parent/'track-edit-e2e-20261024/projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data');parser.add_argument('--analysis-dir',type=Path,default=ROOT);args=parser.parse_args();p=args.data_dir;analysis_dir=args.analysis_dir
y,sr=sf.read(p/'drums.wav',dtype='float32',always_2d=True);mono=np.mean(y,axis=1);step=round(sr/100)
energy=np.sqrt(np.mean(mono[:len(mono)//step*step].reshape(-1,step)**2,axis=1)+1e-10);onset=np.maximum(np.diff(np.log1p(energy*100),prepend=0),0)
fft=np.fft.rfft(onset,n=2**int(np.ceil(np.log2(len(onset)*2))));ac=np.fft.irfft(fft*fft.conj())[:len(onset)]/np.arange(len(onset),0,-1)
notes=[n for n in json.loads((analysis_dir/'rain-vocal-notes.json').read_text())['notes'] if n['voiced']]
times=np.array([n['start_seconds'] for n in notes]);durations=np.array([n['end_seconds']-n['start_seconds'] for n in notes]);weights=np.clip(durations/.2,.3,2)
results=[]
for bpm in np.arange(60,181,.1):
 beat=60/bpm;quantum=beat/4
 phases=np.arange(0,quantum,.002);errors=[]
 for phase in phases:
  delta=(times-phase+quantum/2)%quantum-quantum/2;errors.append(float(np.average(np.minimum(abs(delta),.08)**2,weights=weights)))
 idx=int(np.argmin(errors));phase=float(phases[idx]);grid_error=float(np.sqrt(errors[idx]));drum_ac=float(np.interp(6000/bpm,np.arange(len(ac)),ac))
 results.append({'bpm':round(float(bpm),2),'sixteenth_grid_phase':phase,'grid_rms_error_seconds':grid_error,'drum_ac_score':drum_ac})
peaks=[]
for r in sorted(results,key=lambda x:x['grid_rms_error_seconds']):
 if all(abs(r['bpm']-v['bpm'])>2 for v in peaks):peaks.append(r)
 if len(peaks)>=6:break
print(peaks,flush=True)
# Independent time-domain YIN validation on original vocal samples (not GAME features).
import librosa
v,_=sf.read(p/lead_vocal_source(p)['file'],dtype='float32',always_2d=True);v=resample_poly(v.mean(axis=1),1,2);rate=sr/2
f0=librosa.yin(v,fmin=110,fmax=880,sr=rate,frame_length=1024,hop_length=220);midi=69+12*np.log2(f0/440);t=np.arange(len(midi))*220/rate
comparisons=[]
for i,n in enumerate(notes):
 mask=(t>=n['start_seconds']+.04)&(t<=n['end_seconds']-.04)
 if not mask.any():continue
 values=midi[mask];center=float(np.median(values));error=abs(center-n['midi_float'])*100
 comparisons.append({'note_index':i,'start_seconds':n['start_seconds'],'end_seconds':n['end_seconds'],'game_midi':n['midi_float'],'yin_midi_median':center,'difference_cents':round(error,2),'needs_pitch_review':bool(error>50)})
report={'grid_candidates':peaks,'pitch_comparison':comparisons,'agreement_within_50_cents':sum(not c['needs_pitch_review'] for c in comparisons)/len(comparisons),
 'warning':'Algorithm agreement is not accuracy. Tempo half/double ambiguity and meter/downbeat need listening review. YIN can select subharmonics/overtones.'}
(analysis_dir/'pitch-grid-check.json').write_text(json.dumps(report,indent=2));print({k:v for k,v in report.items() if k!='pitch_comparison'})
