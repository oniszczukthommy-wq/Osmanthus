"""Softly suppress reference-coherent bleed where another stem dominates piano."""
from pathlib import Path
import hashlib, json, shutil
import numpy as np
import soundfile as sf
import torch
from torch.nn.functional import avg_pool2d

ROOT=Path(__file__).resolve().parent;DATA=ROOT/'data'

def main():
    report_path=DATA/'piano-cleanup.json';report=json.loads(report_path.read_text())
    if report.get('reference_refinement'):print('Reference refinement already prepared.');return
    torch.set_num_threads(2)
    piano,sr=sf.read(DATA/'piano.wav',dtype='float32',always_2d=True)
    other,_=sf.read(DATA/'other.wav',dtype='float32',always_2d=True)
    refs=[other-piano]
    for name in ('vocals','drums'):
        audio,_=sf.read(DATA/f'{name}.wav',dtype='float32',always_2d=True);refs.append(audio)
    window=torch.hann_window(4096);hop=1024;block=12*sr;overlap=sr
    outputs={name:np.zeros_like(piano) for name in ('gentle','strong')};weight_sum=np.zeros(len(piano),dtype='float32')
    def smooth(x):return avg_pool2d(x[:,None],kernel_size=(3,9),stride=1,padding=(1,4))[:,0]
    def spec(audio,a,b):return torch.stft(torch.from_numpy(audio[a:b].T.copy()),4096,hop_length=hop,window=window,return_complex=True)
    for a in range(0,len(piano),block-overlap):
        b=min(len(piano),a+block);p=spec(piano,a,b);p_energy=smooth(p.abs().square());suspect=torch.zeros_like(p.real)
        for ref in refs:
            r=spec(ref,a,b);r_energy=smooth(r.abs().square())
            cross=p*r.conj();cross_abs=smooth(cross.real).square()+smooth(cross.imag).square()
            coherence=(cross_abs/(p_energy*r_energy).clamp_min(1e-12)).clamp(0,1)
            ratio=r_energy/(p_energy+1e-10)
            dominance=((ratio-4)/(ratio+4)).clamp(0,1)
            suspect=torch.maximum(suspect,((coherence-.5)/.5).clamp(0,1)*dominance)
        suspect=smooth(suspect).clamp(0,1)
        weights=np.ones(b-a,dtype='float32')
        if a:weights[:overlap]=np.linspace(0,1,overlap)
        if b<len(piano):weights[-overlap:]=np.linspace(1,0,overlap)
        weight_sum[a:b]+=weights
        for name,amount in [('gentle',.45),('strong',.7)]:
            clean=torch.istft(p*(1-amount*suspect),4096,hop_length=hop,window=window,length=b-a).numpy().T
            outputs[name][a:b]+=clean*weights[:,None]
    rms=float(np.sqrt(np.mean(piano**2)))
    for name,audio in outputs.items():
        audio/=weight_sum.clip(1e-8)[:,None]
        gain=min(10**(3/20),rms/max(float(np.sqrt(np.mean(audio**2))),1e-9));audio*=gain
        peak=float(np.max(np.abs(audio)))
        if peak>.98:audio*=.98/peak
        path=DATA/f'piano-{name}.wav'
        shutil.copy2(path,DATA/f'piano-{name}-model-only.wav')
        sf.write(path,audio,sr,subtype='FLOAT')
        report['variants'][name]={'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'rms':float(np.sqrt(np.mean(audio**2))),'makeup_gain_db':float(20*np.log10(gain)),
            'peak':float(np.max(np.abs(audio))),'difference_rms':float(np.sqrt(np.mean((audio-piano)**2))),
            'frames':len(audio),'sample_rate':sr}
    report['reference_refinement']={'references':['Other minus piano','vocals','drums'],
        'method':'Locally coherent components only where reference energy exceeds piano by >6 dB; bounded soft mask; no hard gate',
        'quality_status':'Alternative to near-identity second-pass mask; user listening still required.'}
    report['model_comparison_seconds']=report.pop('elapsed_seconds',None)
    report['method']='Reference-coherent soft masking of original piano where another source dominates; <=3 dB level matching; model-only comparisons retained separately'
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report['variants'],indent=2))

if __name__=='__main__':main()
