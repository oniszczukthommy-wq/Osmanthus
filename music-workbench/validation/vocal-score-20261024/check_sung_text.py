"""Independent greedy CTC decoding. No supplied lyrics are given to the model.
Speech-trained model is a weak cross-check for singing, never a lyric truth.
"""
from pathlib import Path
import os,json,time,hashlib
ROOT=Path(__file__).resolve().parent
os.environ.setdefault('HF_HUB_OFFLINE','1')
import numpy as np,soundfile as sf,torch
from scipy.signal import resample_poly
from transformers import AutoProcessor,AutoModelForCTC
torch.set_num_threads(1);torch.set_num_interop_threads(1)
model_dir=ROOT.parent/'alignment/models/chinese-ctc';source=ROOT.parent/'track-edit-e2e-20261024/projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data/vocals.wav'
started=time.perf_counter();processor=AutoProcessor.from_pretrained(model_dir,local_files_only=True);model=AutoModelForCTC.from_pretrained(model_dir,local_files_only=True).eval();out=[]
for a,b in [(0,12),(40,49),(84,94.7722449)]:
 y,sr=sf.read(source,start=round(a*44100),stop=round(b*44100),dtype='float32',always_2d=True);y=resample_poly(y.mean(axis=1),160,441)
 inputs=processor(y,sampling_rate=16000,return_tensors='pt',padding=True)
 with torch.inference_mode():logits=model(**inputs).logits
 text=processor.batch_decode(logits.argmax(-1))[0]
 out.append({'start':a,'end':b,'recognized_without_supplied_text':text});print(out[-1],flush=True)
(ROOT/'independent-ctc-text-check.json').write_text(json.dumps({'scope':'No-lyrics greedy decoding with cached speech-trained Chinese CTC; not validated singing ASR. Do not replace supplied lyrics or declare accuracy from this.','seconds':time.perf_counter()-started,'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'segments':out},ensure_ascii=False,indent=2))
