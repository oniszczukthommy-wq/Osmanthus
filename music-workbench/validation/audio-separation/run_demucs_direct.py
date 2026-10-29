import json, time, wave
from pathlib import Path
import numpy as np
import torch
import soundfile as sf
from demucs.pretrained import get_model
from demucs.apply import apply_model

root=Path(__file__).resolve().parent.parent
inp=root/'audio-separation/output/sample-input.wav'
out=root/'audio-separation/output'
with wave.open(str(inp),'rb') as w:
    channels=w.getnchannels(); sr=w.getframerate(); width=w.getsampwidth(); frames=w.getnframes(); raw=w.readframes(frames)
if width != 2: raise ValueError(f'expected PCM16, got {width*8}-bit')
a=np.frombuffer(raw,dtype='<i2').reshape(-1,channels).astype(np.float32)/32768
mix=torch.from_numpy(a.T.copy()).unsqueeze(0)
model=get_model('htdemucs')
model.eval()
device='mps' if torch.backends.mps.is_available() else 'cpu'
if sr != model.samplerate: raise ValueError(f'sample rate mismatch {sr} != {model.samplerate}')
start=time.perf_counter()
with torch.no_grad():
    separated=apply_model(model,mix,device=device,shifts=1,split=True,overlap=0.25,progress=True,num_workers=0)
seconds=time.perf_counter()-start
separated=separated.squeeze(0).cpu().numpy()
print('sources',model.sources,'shape',separated.shape,'device',device,'seconds',round(seconds,3))
for name, audio in zip(model.sources,separated):
    sf.write(out/f'{name}.wav',audio.T,sr,subtype='PCM_16')
vocal=separated[model.sources.index('vocals')]
inst=np.sum([s for i,s in enumerate(separated) if i!=model.sources.index('vocals')],axis=0)
sf.write(out/'vocals.wav',vocal.T,sr,subtype='PCM_16')
sf.write(out/'accompaniment.wav',inst.T,sr,subtype='PCM_16')
report={'model':'htdemucs','device':device,'input':str(inp),'input_duration_seconds':frames/sr,'sample_rate':sr,'source_names':model.sources,'inference_seconds':seconds,'outputs':{}}
for n in [*model.sources,'vocals','accompaniment']:
 p=out/f'{n}.wav'; report['outputs'][n]={'path':str(p),'bytes':p.stat().st_size,'duration_seconds':sf.info(p).duration}
(out/'separation-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2,ensure_ascii=False))
