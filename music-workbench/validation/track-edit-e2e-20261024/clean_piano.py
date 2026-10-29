"""Conservative, reversible piano bleed suppression, without synthesizing notes."""
from pathlib import Path
import hashlib, json, os, time
import numpy as np
import soundfile as sf
import torch
from torch.nn.functional import avg_pool2d
from demucs.pretrained import get_model
from demucs.apply import apply_model

ROOT=Path(__file__).resolve().parent
DATA=ROOT/'data'

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    source=DATA/'piano.wav';digest=sha(source);report_file=DATA/'piano-cleanup.json'
    if report_file.exists() and json.loads(report_file.read_text()).get('input_sha256')==digest:
        print('Piano cleanup variants already prepared.',flush=True);return
    audio,sr=sf.read(source,dtype='float32',always_2d=True)
    torch.set_num_threads(2)
    started=time.perf_counter();model=get_model('htdemucs_6s').eval()
    device=os.environ.get('PIANO_CLEANUP_DEVICE','cpu')
    if device=='mps':torch.mps.set_per_process_memory_fraction(.8)
    torch.manual_seed(20261024)
    print({'stage':'second-pass source confidence','device':device},flush=True)
    with torch.no_grad():
        separated=apply_model(model,torch.from_numpy(audio.T.copy()).unsqueeze(0),device=device,
                              shifts=0,split=True,segment=7.8,overlap=.25,progress=True,num_workers=0)
    separated=separated[0].cpu();piano_index=model.sources.index('piano')
    del model
    if device=='mps':torch.mps.empty_cache()
    torch.set_num_threads(2)
    # Use the second pass only as a confidence estimator. Keep the original
    # piano's phase and transients rather than replacing it with a full second
    # separation, which can remove real notes and long decays.
    original=torch.from_numpy(audio.T.copy())
    variants={k:np.zeros_like(audio) for k in ('gentle','strong')}
    weights=np.zeros(len(audio),dtype='float32')
    block=12*sr;overlap=sr;nfft=4096;hop=1024;window=torch.hann_window(nfft)
    stats=[]
    for start in range(0,len(audio),block-overlap):
        end=min(len(audio),start+block)
        mix_spec=torch.stft(original[:,start:end],nfft,hop_length=hop,window=window,return_complex=True)
        source_mag=torch.stack([torch.stft(s[:,start:end],nfft,hop_length=hop,window=window,return_complex=True).abs() for s in separated])
        ratio=source_mag[piano_index]/source_mag.sum(dim=0).clamp_min(1e-8)
        ratio=avg_pool2d(ratio[:,None],kernel_size=(3,5),stride=1,padding=(1,2))[:,0]
        confidence=((ratio-.05)/.7).clamp(0,1).sqrt()
        weight=np.ones(end-start,dtype='float32')
        if start:weight[:overlap]=np.linspace(0,1,overlap)
        if end<len(audio):weight[-overlap:]=np.linspace(1,0,overlap)
        weights[start:end]+=weight
        for name,floor in [('gentle',.6),('strong',.3)]:
            mask=floor+(1-floor)*confidence
            clean=torch.istft(mix_spec*mask,nfft,hop_length=hop,window=window,length=end-start).numpy().T
            variants[name][start:end]+=clean*weight[:,None]
        stats.append(float(ratio.mean()))
    baseline_rms=float(np.sqrt(np.mean(audio**2)));reports={}
    for name,result in variants.items():
        result/=weights.clip(1e-8)[:,None]
        rms=float(np.sqrt(np.mean(result**2)))
        gain=min(10**(3/20),baseline_rms/max(rms,1e-9))
        result*=gain
        peak=float(np.max(np.abs(result)))
        if peak>.98:result*=.98/peak
        output=DATA/f'piano-{name}.wav';sf.write(output,result,sr,subtype='FLOAT')
        reports[name]={'file':output.name,'sha256':sha(output),'rms':float(np.sqrt(np.mean(result**2))),
                       'makeup_gain_db':float(20*np.log10(gain)),'peak':float(np.max(np.abs(result))),
                       'difference_rms':float(np.sqrt(np.mean((result-audio)**2))),
                       'frames':len(result),'sample_rate':sr}
    report={'input_sha256':digest,'model':'htdemucs_6s','device':device,'shifts':0,'overlap':.25,'segment_seconds':7.8,
            'source':'Existing piano stem only; no added or transcribed notes',
            'elapsed_seconds':round(time.perf_counter()-started,3),'original_rms':baseline_rms,
            'method':'Second-pass source confidence, bounded soft spectral masking of original phase, block crossfades, <=3 dB level matching',
            'variants':reports,'estimated_piano_confidence_mean':float(np.mean(stats)),
            'quality_status':'Candidate reduction only; no isolated ground truth, needs listening A/B.',
            'limitations':['May soften piano overtones or decays; original remains available.',
                           'Second-pass source confidence is not measured real-world bleed accuracy.']}
    report_file.write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':main()
