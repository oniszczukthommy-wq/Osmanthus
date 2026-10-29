"""Resolve the current full lead vocal independently of mixer gates and gains."""
import json,re,hashlib
from pathlib import Path

def lead_vocal_source(directory):
 directory=Path(directory);meta=json.loads((directory/'preparation.json').read_text())
 state=json.loads((directory/'project.json').read_text()) if (directory/'project.json').exists() else {}
 variant=state.get('tracks',{}).get('vocals',{}).get('voice_variant','original')
 original=next(t for t in meta['tracks'] if t['id']=='vocals')
 if variant=='original':return {'id':'original','file':original['file'],'sha256':original['sha256'],'corrections_file':'vocal-score-corrections.json','basis':'original_complete_lead_vocal'}
 if not re.fullmatch(r'vocal_[a-f0-9]{12}',variant):raise ValueError('主唱版本标识无效')
 manifest=json.loads((directory/'vocal-variants.json').read_text())
 if manifest.get('source_sha256')!=meta['source_sha256']:raise ValueError('歌手候选与歌曲不匹配')
 asset=next((v for v in manifest['variants'] if v['id']==variant),None)
 if not asset or asset['file']!=variant+'.wav':raise ValueError('主唱候选不存在')
 if hashlib.sha256((directory/asset['file']).read_bytes()).hexdigest()!=asset['sha256']:raise ValueError('主唱候选校验失败')
 return {**asset,'corrections_file':'vocal-score-corrections-'+variant+'.json','basis':'resynthesized_complete_lead_vocal'}
