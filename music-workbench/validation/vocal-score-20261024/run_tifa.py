"""CPU adapter around unmodified official TIFA inference classes."""
from pathlib import Path
import argparse,sys,json,time,os
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'TIFA'))
os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.matplotlib'))

def main():
 p=argparse.ArgumentParser();p.add_argument('audio',type=Path,nargs='+');p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--threads',type=int,default=1);args=p.parse_args();started=time.perf_counter()
 if len({a.stem for a in args.audio})!=len(args.audio):raise ValueError('批量对齐的音频名称必须唯一')
 import torch,lightning as pl
 from torch.utils.data import DataLoader
 from inference.api import load_inference_model
 from lib.config.schema import ConfigurationScope
 from inference.data import AudioTextDataset
 from inference.callbacks import StatisticsCallback,SaveTextGridCallback
 from inference.module import ForcedAlignmentInferenceModule
 from g2pflow import G2PPipelineConfig
 torch.set_num_threads(args.threads);torch.set_num_interop_threads(1)
 model=ROOT/'models/TIFA-1.0';backend,vocabulary,config=load_inference_model(model/'model.pt',scope=ConfigurationScope.FA)
 g2p=G2PPipelineConfig.model_validate({'preprocessors':[{'id':'filter-punctuation'},{'id':'strip-whitespace'},{'id':'lowercase'}],
  'converters':[{'id':'chinese-pinyin','kwargs':{'dict_path':str(model/'dictionaries/ds-zh-pinyin-lite.txt')}},{'id':'dictionary','language':'zh','kwargs':{'dict_path':str(model/'dictionaries/ds-zh-pinyin-lite.txt')}}]})
 dataset=AudioTextDataset(filemap={a.stem:Path(os.path.abspath(a)) for a in args.audio},g2p_config=g2p,g2p_root=model,vocabulary=vocabulary,audio_sample_rate=backend.sample_rate,language=['zh'],oov_handling='raise')
 args.output_dir.mkdir(exist_ok=True,parents=True)
 module=ForcedAlignmentInferenceModule(backend,score_unit='levenshtein',skip_penalty=.5)
 callbacks=[SaveTextGridCallback(output_dir=args.output_dir.resolve(),language='zh',timestep=backend.timestep,skip_handling="preserve",save_pfml=False),StatisticsCallback(save_dir=args.output_dir.resolve()/'statistics')]
 trainer=pl.Trainer(accelerator='cpu',devices=1,precision='32-true',logger=False,enable_checkpointing=False,callbacks=callbacks)
 data=DataLoader(dataset,batch_size=1,num_workers=0,shuffle=False,collate_fn=dataset.collate)
 trainer.predict(module,data)
 if not all((args.output_dir/(a.stem+".TextGrid")).exists() for a in args.audio):raise RuntimeError("Alignment emitted no TextGrid; no successful alignment is claimed")
 (args.output_dir/'run-report.json').write_text(json.dumps({'engine':'TIFA-1.0 official PyTorch, CPU','seconds':time.perf_counter()-started,'sample_rate':backend.sample_rate,'timestep':backend.timestep,'source':str(args.audio[0].resolve()),'sources':[str(a.resolve()) for a in args.audio],'accuracy_accepted':False},indent=2))
if __name__=='__main__':main()
