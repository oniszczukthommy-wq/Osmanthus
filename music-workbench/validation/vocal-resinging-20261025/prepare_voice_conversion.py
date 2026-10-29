"""Load official Seed-VC SVC model on CPU in an isolated environment; no training."""
from pathlib import Path
import sys,os,time,json
ROOT=Path(__file__).resolve().parent;REPO=ROOT.parent/'seed-vc-20261025';os.chdir(REPO);sys.path.insert(0,str(REPO));os.environ['HF_HUB_DISABLE_XET']='1';os.environ['TOKENIZERS_PARALLELISM']='false'
import torch
from types import SimpleNamespace
import inference
torch.set_num_threads(2);torch.set_num_interop_threads(1);inference.device=torch.device('cpu')
args=SimpleNamespace(fp16=False,f0_condition=True,checkpoint=None,config=None)
started=time.perf_counter();models=inference.load_models(args)
(ROOT/'conversion-model-load.json').write_text(json.dumps({'status':'loaded','device':'cpu','seconds':time.perf_counter()-started,'weights_trained':False},indent=2));print('SVC model stack loaded on CPU',flush=True)
