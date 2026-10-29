"""Private, previously archived voice references. No invented singing API mapping."""
from pathlib import Path
import json,re,hashlib
from project import ROOT,save_json
from voice_presets import PRESETS
LIB=ROOT.parent.parent/'research/minimax-voice-knowledge-20261024'
class VoiceLibrary:
 def __init__(self,directory=None):
  self.directory=Path(directory) if directory is not None else LIB
  def optional_json(name):
   try:return json.loads((self.directory/name).read_text())
   except FileNotFoundError:return {}
  data=optional_json('knowledge-base.json');self.voices={v['web_voice_id']:v for v in data.get('voices',[]) if v.get('sample_status')=='downloaded'};self.checked=set()
  manifest=optional_json('preview-manifest.json');self.hashes={v['web_voice_id']:v['sha256'] for v in manifest.get('manifest',[]) if v.get('status')=='downloaded'}
 def catalog(self,directory):
  file=directory/'voice-reference-selection.json';selection=json.loads(file.read_text()) if file.exists() else None
  voices=[]
  for p in PRESETS:
   v=self.voices.get(p['reference_voice_id'])
   if not v:continue
   try:self.asset(p['reference_voice_id'])
   except (ValueError,OSError):continue
   voices.append({'id':v['web_voice_id'],'preset_id':p['id'],'name':p['name'],'gender':v.get('gender',[]),'languages':v.get('languages',[]),'tags':v.get('timbre_tags',[]),
     'preview_url':'/api/voice-library/samples/'+v['web_voice_id'],'singing_status':p['singing_validation']})
  if selection and not any(v['id']==selection['voice_id'] for v in voices):selection=None
  return {'voices':voices,'count':len(voices),'selected':selection,'scope':'本机音色参考试听；不提供歌手权重' if voices else '本机未配置可用音色试听，可用文字描述生成歌曲的声音'}
 def asset(self,identifier):
  if not isinstance(identifier,str) or not re.fullmatch(r'\d+',identifier):raise ValueError('没有该音色试听')
  v=self.voices.get(identifier)
  if not v or identifier not in self.hashes or not v.get('local_sample'):raise ValueError('本机未配置该音色试听')
  file=(self.directory/v['local_sample']).resolve()
  if file.parent!= (self.directory/'samples').resolve():raise ValueError('音色试听路径无效')
  if not file.is_file():raise ValueError('本机未配置该音色试听')
  if identifier not in self.checked:
   if hashlib.sha256(file.read_bytes()).hexdigest()!=self.hashes[identifier]:raise ValueError('音色试听文件校验失败')
   self.checked.add(identifier)
  return file
 def select(self,project,identifier):
  if identifier not in [p['reference_voice_id'] for p in PRESETS]:raise ValueError('首版仅开放三个预设音色')
  self.asset(identifier);v=self.voices[identifier]
  selection={'voice_id':identifier,'name':v.get('short_name',v['name']),'source':'MiniMax existing local reference library','status':'reference_selected_pending_singing_conversion'}
  save_json(project.directory/'voice-reference-selection.json',selection);return selection
