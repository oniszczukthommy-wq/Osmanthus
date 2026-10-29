"""Estimate existing piano inside the existing Other stem; never synthesize notes."""
from pathlib import Path
import hashlib, json, time
import numpy as np
import soundfile as sf
import torch
from demucs.pretrained import get_model
from demucs.apply import apply_model

ROOT=Path(__file__).resolve().parent
DATA=ROOT/'data'

def main():
    source=DATA/'other.wav'; digest=hashlib.sha256(source.read_bytes()).hexdigest()
    report_file=DATA/'piano-separation.json'
    if report_file.exists() and json.loads(report_file.read_text()).get('input_sha256')==digest:
        print('Existing piano extraction reused.',flush=True);return
    audio,sr=sf.read(source,dtype='float32',always_2d=True)
    started=time.perf_counter();model=get_model('htdemucs_6s').eval()
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    if sr!=model.samplerate:raise ValueError('Unexpected sample rate')
    torch.manual_seed(20261024)
    print({'stage':'separating existing piano','sources':model.sources,'device':device},flush=True)
    with torch.no_grad():
        result=apply_model(model,torch.from_numpy(audio.T.copy()).unsqueeze(0),device=device,
                           shifts=1,split=True,overlap=.25,progress=True,num_workers=0)
    piano=result[0,model.sources.index('piano')].cpu().numpy().T
    if piano.shape!=audio.shape:raise ValueError('Piano duration/channel mismatch')
    sf.write(DATA/'piano.wav',piano,sr,subtype='FLOAT')
    report={'model':'htdemucs_6s','input':'other.wav','input_sha256':digest,
            'piano_sha256':hashlib.sha256((DATA/'piano.wav').read_bytes()).hexdigest(),
            'duration':len(piano)/sr,'seconds':round(time.perf_counter()-started,3),
            'piano_rms':float(np.sqrt(np.mean(piano**2))),
            'residual_rms':float(np.sqrt(np.mean((audio-piano)**2))),
            'source':'Existing song estimated piano, not newly composed accompaniment',
            'limitations':['Experimental source separation; piano may contain bleed/artifacts.',
                           'Other is compensated by subtracting this estimate when piano track is active.'],
            'official_source':'https://github.com/facebookresearch/demucs'}
    report_file.write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':main()
