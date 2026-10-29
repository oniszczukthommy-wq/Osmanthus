import json, subprocess, time, wave
started=time.perf_counter()
from pathlib import Path
import numpy as np, soundfile as sf
import mido
base=Path(__file__).resolve().parent
out=base/'output'; input_wav=out/'bass.wav'
y,sr0=sf.read(input_wav,dtype='float32'); y=y.mean(axis=1) if y.ndim==2 else y
# Downsample by 4 and estimate dominant bass F0 from the isolated bass stem.
y=y[:len(y)//4*4].reshape(-1,4).mean(axis=1); sr=sr0//4
win=2048; hop=110; nfft=4096
frames=np.lib.stride_tricks.sliding_window_view(y,win)[::hop]; window=np.hanning(win).astype(np.float32)
lo=int(sr/220); hi=int(sr/35); q=np.full(len(frames),np.nan); conf=np.zeros(len(frames))
for offset in range(0,len(frames),512):
 x=frames[offset:offset+512].copy(); x-=x.mean(axis=1,keepdims=True); x*=window
 spec=np.fft.rfft(x,n=nfft,axis=1); ac=np.fft.irfft(spec*np.conj(spec),n=nfft,axis=1)[:,:hi+2]; ac/=np.maximum(ac[:,0:1],1e-8)
 sub=ac[:,lo:hi+1]; idx=np.argmax(sub,axis=1)+lo; rows=np.arange(len(x)); c=sub[rows,idx-lo]
 l=ac[rows,idx-1]; z=ac[rows,idx]; r=ac[rows,idx+1]; den=l-2*z+r; delta=np.where(np.abs(den)>1e-8,.5*(l-r)/den,0); hz=sr/(idx+delta)
 good=(c>=.25)&(x.std(axis=1)>=.002)&(hz>=35)&(hz<=220)
 q[offset:offset+len(x)]=np.where(good,np.rint(69+12*np.log2(hz/440)),np.nan); conf[offset:offset+len(x)]=np.where(good,c,0)
# Remove tiny octave/pitch flicker using a local median.
q0=q.copy()
for i in range(2,len(q)-2):
 v=q0[i-2:i+3];v=v[np.isfinite(v)]
 if len(v)>=3:q[i]=round(float(np.median(v)))
notes=[]; i=0; dt=hop/sr
while i<len(q):
 if not np.isfinite(q[i]):i+=1;continue
 j=i+1
 while j<len(q) and q[j]==q[i]:j+=1
 if (j-i)*dt>=.08:
  notes.append((float(i*dt+win/(2*sr)),float(j*dt+win/(2*sr)),int(q[i])))
 i=j
# Create one MIDI bass track. Use estimated event timing and program 39 (GM Synth Bass 1).
midi=mido.MidiFile(ticks_per_beat=480); track=mido.MidiTrack();midi.tracks.append(track);tempo=int(60_000_000/92)
track.append(mido.MetaMessage('set_tempo',tempo=tempo,time=0));track.append(mido.Message('program_change',program=38,channel=0,time=0))
events=[]
for a,b,p in notes:
 if p<28 or p>72: continue
 on=max(0,int(mido.second2tick(a,midi.ticks_per_beat,tempo)))
 off=max(on+1,int(mido.second2tick(b,midi.ticks_per_beat,tempo)))
 events.extend([(on,1,p),(off,0,p)])
events.sort(key=lambda e:(e[0],e[1]))
last=0
for tick,on,p in events:
 track.append(mido.Message('note_on' if on else 'note_off',note=p,velocity=78 if on else 0,channel=0,time=max(0,tick-last)));last=tick
track.append(mido.MetaMessage('end_of_track',time=0))
midi_path=base/'output'/'estimated-bass.mid'; midi.save(midi_path)
# Render alternate synth bass from a locally installed SF2; no network service used.
sf2=Path(__file__).resolve().parents[1]/'instrument-generaluser'/'GeneralUser-GS.sf2'
render=out/'estimated-bass.wav'
cmd=[str(Path(__file__).resolve().parents[1]/'audio-runtime'/'env'/'bin'/'fluidsynth'),'-ni','-g','0.5','-F',str(render),'-r','44100',str(sf2),str(midi_path)]
subprocess.run(cmd,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
alt,sr1=sf.read(render,dtype='float32'); alt=alt.mean(axis=1) if alt.ndim==2 else alt
# Match duration exactly and replace only bass stem; other three remain sample-identical.
tracks={n:sf.read(out/f'{n}.wav',dtype='float32')[0] for n in ['drums','bass','other','vocals']}
if alt.ndim==1:alt=np.repeat(alt[:,None],tracks['bass'].shape[1],axis=1)
fit=np.zeros_like(tracks['bass']); fit[:min(len(fit),len(alt))]=alt[:min(len(fit),len(alt))]
# Match RMS of original bass to avoid judging timbre by loudness alone.
rms=lambda a:float(np.sqrt(np.mean(np.square(a))))
scale=(rms(tracks['bass'])/max(rms(fit),1e-8))*0.8
fit*=scale
before=np.sum([tracks[n] for n in ['drums','bass','other','vocals']],axis=0)
after=np.sum([tracks[n] if n!='bass' else fit for n in ['drums','bass','other','vocals']],axis=0)
sf.write(out/'bass-timbre-swap.wav',after,sr0,subtype='PCM_16')
report={'operation':'replace Demucs bass stem with estimated F0 notes rendered as GeneralUser GS Synth Bass 1','method':'custom autocorrelation on separated bass; GM program 38; FluidSynth','candidate_note_events':len(notes),'candidate_notes_in_midi':len(events)//2,'source_duration_seconds':len(y)*4/sr0,'rendered_bass_duration_seconds':len(alt)/sr1,'source_bass_rms':rms(tracks['bass']),'replacement_bass_rms_after_gain':rms(fit),'bass_gain_to_rms_match':scale,'modified_stem':'bass','unchanged_stems':['drums','other','vocals'],'post_separation_edit_latency_seconds':round(time.perf_counter()-started,3),'limitations':['Bass transcription is estimated and not ground truth.','Demucs bass stem contains separation artifacts; rendered line may have missing/false notes.','A single bass stem test does not isolate guitar, piano or strings from the Other stem.']}
(out/'bass-timbre-swap-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
