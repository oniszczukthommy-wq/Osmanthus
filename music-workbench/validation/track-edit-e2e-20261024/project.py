"""Canonical project state and sample-accurate, non-destructive segment edits."""
from __future__ import annotations
from copy import copy,deepcopy
import hashlib, json, math, os, re, time, uuid
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(os.environ.get('MUSIC_WORKBENCH_ROOT', str(Path(__file__).resolve().parent))).resolve()
DATA = ROOT/'data'

def save_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)

def finite(value):
    if isinstance(value, bool): raise ValueError('参数必须是数字')
    result = float(value)
    if not math.isfinite(result): raise ValueError('参数必须是有限数字')
    return result

class Project:
    def __init__(self, directory=DATA):
        self.directory = Path(directory)
        self._preview_cache = {}
        self.meta = json.loads((self.directory/'preparation.json').read_text())
        self.sr = self.meta['sample_rate']
        self.audio = {t['id']:sf.read(self.directory/t['file'],dtype='float32',always_2d=True)[0] for t in self.meta['tracks']}
        if (self.directory/'piano.wav').exists() and 'piano' not in self.audio:
            path=self.directory/'piano.wav'
            piano,piano_sr=sf.read(path,dtype='float32',always_2d=True)
            if piano_sr!=self.sr or piano.shape!=self.audio['other'].shape:raise ValueError('钢琴音轨与工程时长不匹配')
            self.audio['piano']=piano
            self.meta['tracks'].append({'id':'piano','label':'钢琴','color':'#e7a3c4','file':'piano.wav',
                                       'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'estimated':True})
        report_file=self.directory/'instrument-separation.json'
        if report_file.exists():
            from separate_instruments import cached
            report=cached(self.directory)
            if not report:raise ValueError('器乐分轨校验失败，请重新准备')
            path=self.directory/'guitar.wav'
            guitar,rate=sf.read(path,dtype='float32',always_2d=True)
            if rate!=self.sr or guitar.shape!=self.audio['other'].shape:raise ValueError('吉他音轨与工程时长不匹配')
            self.audio['guitar']=guitar
            self.meta['tracks'].append({'id':'guitar','label':'吉他','color':'#a6b7ff','file':'guitar.wav',
                                       'sha256':report['assets']['guitar']['sha256'],'estimated':True})
        optional={'piano','guitar'}
        extras=self.directory/'additional-tracks.json'
        if extras.exists():
            manifest=json.loads(extras.read_text())
            if manifest.get('source_sha256')!=self.meta['source_sha256']:raise ValueError('新增声部与歌曲来源不匹配')
            for meta in manifest['tracks']:
                name=meta['id'];filename=meta['file']
                if not re.fullmatch(r'(?:piano_add|guitar_arr)_[a-f0-9]{10}',name) or Path(filename).name!=filename or filename!=name+'.wav':raise ValueError('新增声部文件标识无效')
                if name in self.audio:raise ValueError('新增声部标识重复')
                path=self.directory/filename
                if hashlib.sha256(path.read_bytes()).hexdigest()!=meta['sha256']:raise ValueError('新增声部音频校验失败')
                audio,rate=sf.read(path,dtype='float32',always_2d=True)
                if rate!=self.sr or audio.shape!=self.audio['other'].shape:raise ValueError('新增声部与工程时长不匹配')
                self.audio[name]=audio;optional.add(name);self.meta['tracks'].append({**meta,'generated':True})
        self.piano_variants={};self.piano_hashes={}
        if 'piano' in self.audio:
            self.piano_variants['original']=self.audio['piano']
            self.piano_hashes['original']=hashlib.sha256((self.directory/'piano.wav').read_bytes()).hexdigest()
            cleanup_report=self.directory/'piano-cleanup.json'
            cleanup_meta=json.loads(cleanup_report.read_text()) if cleanup_report.exists() else {}
            for level in ('gentle','strong'):
                path=self.directory/f'piano-{level}.wav'
                if path.exists() and cleanup_meta.get('input_sha256')==self.piano_hashes['original']:
                    audio,audio_sr=sf.read(path,dtype='float32',always_2d=True)
                    if audio_sr!=self.sr or audio.shape!=self.audio['piano'].shape:raise ValueError('钢琴净化版本与工程时长不匹配')
                    digest=hashlib.sha256(path.read_bytes()).hexdigest()
                    if digest!=cleanup_meta.get('variants',{}).get(level,{}).get('sha256'):raise ValueError('钢琴净化音频校验失败')
                    self.piano_variants[level]=audio;self.piano_hashes[level]=digest
        self.file = self.directory/'project.json'
        self.vocal_assets={};self.vocal_cache={'original':self.audio['vocals']}
        variants_file=self.directory/'vocal-variants.json'
        if variants_file.exists():
            manifest=json.loads(variants_file.read_text())
            if manifest.get('source_sha256')!=self.meta['source_sha256']:raise ValueError('主唱候选来源不匹配')
            for asset in manifest['variants']:
                if not re.fullmatch(r'vocal_[a-f0-9]{12}',asset['id']) or asset['file']!=asset['id']+'.wav':raise ValueError('主唱候选文件标识无效')
                self.vocal_assets[asset['id']]=asset
        if self.file.exists(): self.state = json.loads(self.file.read_text())
        else:
            self.state = {'id':self.meta.get('project_id') or str(uuid.uuid4()),'revision':0,'title':self.meta['song_title'],
                          'source_sha256':self.meta['source_sha256'],'cursor':0,'history':[],'track_switches_version':1,
                          'tracks':{k:{'segments':[],'gain_db':0,'muted':False,'solo':False} for k in self.audio if k not in optional}}
            save_json(self.file,self.state)
        if self.state['source_sha256'] != self.meta['source_sha256']: raise ValueError('工程与音源不匹配')
        if not self.state.get('track_switches_version'):
            # The user requested an all-on default for the new interaction.
            # Preserve the complete old state before this one-time transition.
            backup=self.directory/f'project-before-track-switches-r{self.state["revision"]}.json'
            if not backup.exists():save_json(backup,self.state)
            changed=any(t['muted'] or t['solo'] for t in self.state['tracks'].values())
            for t in self.state['tracks'].values():t.update(muted=False,solo=False)
            self.state['track_switches_version']=1
            if changed:self.state['revision']+=1
            save_json(self.file,self.state)
        # Legacy projects could have mute and solo simultaneously set. Prefer
        # solo (audible) and retain an exact pre-migration backup for recovery.
        normalized=self.exclusive(self.state['tracks'])
        if normalized!=self.state['tracks']:
            backup=self.directory/f'project-before-exclusive-r{self.state["revision"]}.json'
            if not backup.exists():save_json(backup,self.state)
            self.state['tracks']=normalized;self.state['revision']+=1
            save_json(self.file,self.state)

    @staticmethod
    def exclusive(tracks):
        tracks=deepcopy(tracks)
        for t in tracks.values():
            if t['solo']:t['muted']=False
        return tracks

    def fingerprint(self):
        value={'source_sha256':self.state['source_sha256'],'tracks':self.state['tracks']}
        if 'piano' in self.state['tracks']:value['piano_asset_sha256']=self.piano_hashes[self.piano_level()]
        if 'guitar' in self.state['tracks']:value['guitar_asset_sha256']=next(t['sha256'] for t in self.meta['tracks'] if t['id']=='guitar')
        generated={t['id']:t['sha256'] for t in self.meta['tracks'] if t.get('generated') and t['id'] in self.state['tracks']}
        if generated:value['generated_assets_sha256']=generated
        variant=self.state['tracks'].get('vocals',{}).get('voice_variant','original')
        if variant!='original':value['vocal_asset_sha256']=self.vocal_assets[variant]['sha256']
        return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

    def track_digest(self, name):
        value={'segments':self.state['tracks'][name]['segments'],
               'piano_split':name=='other' and 'piano' in self.state['tracks']}
        value['source_sha256']=next(t['sha256'] for t in self.meta['tracks'] if t['id']==name)
        if name=='vocals':
            variant=self.state['tracks'][name].get('voice_variant','original')
            if variant!='original':value['vocal_asset_sha256']=self.vocal_assets[variant]['sha256']
        if name in ('piano','other') and 'piano' in self.state['tracks']:
            value['piano_source_sha256']=self.piano_hashes[self.piano_level()]
        if name=='other' and 'guitar' in self.state['tracks']:
            value['guitar_source_sha256']=next(t['sha256'] for t in self.meta['tracks'] if t['id']=='guitar')
        raw = json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        return hashlib.sha256(raw).hexdigest()[:16]

    def envelope(self, name):
        count = self.meta['frames']; env = np.ones(count,dtype='float32')
        for edit in self.state['tracks'][name]['segments']:
            a,b,g = edit['start_frame'],edit['end_frame'],edit['gain']
            left,right=float(env[a]),float(env[b-1])
            env[a:b] = g
            # Fades live strictly INSIDE the edited interval. Outside samples stay unchanged.
            fade = min(round(.005*self.sr), (b-a)//2)
            if fade:
                ramp = np.linspace(0,1,fade,dtype='float32')
                env[a:a+fade] = left+(g-left)*ramp
                env[b-fade:b] = g+(right-g)*ramp
        return env

    def render_track(self, name):
        source=self.audio[name]
        if name=='vocals':source=self.vocal_source(self.state['tracks'][name].get('voice_variant','original'))
        if name=='piano':source=self.piano_variants[self.piano_level()]
        if name=='other' and 'piano' in self.state['tracks']:
            source=source-self.piano_variants[self.piano_level()]
        if name=='other' and 'guitar' in self.state['tracks']:source=source-self.audio['guitar']
        return source*self.envelope(name)[:,None]

    def vocal_source(self,variant):
        if variant in self.vocal_cache:return self.vocal_cache[variant]
        asset=self.vocal_assets.get(variant)
        if not asset:raise ValueError('该主唱候选尚未准备完成')
        file=self.directory/asset['file']
        if hashlib.sha256(file.read_bytes()).hexdigest()!=asset['sha256']:raise ValueError('主唱候选文件校验失败')
        audio,rate=sf.read(file,dtype='float32',always_2d=True)
        if rate!=self.sr or audio.shape!=self.audio['vocals'].shape:raise ValueError('主唱候选与歌曲时间线不匹配')
        self.vocal_cache[variant]=audio
        return audio

    def piano_level(self):
        level=self.state['tracks'].get('piano',{}).get('cleanup','original')
        if level not in self.piano_variants:raise ValueError('钢琴净化音频尚未准备完成')
        return level

    def mix(self):
        mix = np.zeros_like(next(iter(self.audio.values())))
        solo = any(t['solo'] for t in self.state['tracks'].values() if not t.get('removed'))
        for name,t in self.state['tracks'].items():
            if t.get('removed') or t['muted'] or (solo and not t['solo']): continue
            mix += self.render_track(name)*10**(t['gain_db']/20)
        return mix*self.meta['master_gain']

    def audio_snapshot(self):
        """Freeze settings for a render while sharing immutable source samples."""
        frozen=copy(self)
        frozen.state=deepcopy(self.state);frozen.meta=deepcopy(self.meta)
        frozen.vocal_assets=deepcopy(self.vocal_assets);frozen.vocal_cache=dict(self.vocal_cache)
        frozen._preview_cache={}
        return frozen

    def available_parts(self):
        file=self.directory/'additional-tracks.json'
        if not file.exists():return []
        manifest=json.loads(file.read_text())
        if manifest.get('source_sha256')!=self.meta['source_sha256']:raise ValueError('新增声部来源不匹配')
        return [deepcopy(t) for t in reversed(manifest['tracks']) if t['id'] not in self.state['tracks'] or self.state['tracks'][t['id']].get('removed')]

    def track_preview(self,name):
        """Reuse unchanged preview audio and peaks, including after reopening."""
        key=self.track_digest(name);file=self.directory/f'{name}-{key}.wav'
        sidecar=file.with_suffix('.peaks.json')
        def token():
            try:
                stat=file.stat();return [stat.st_size,stat.st_mtime_ns]
            except FileNotFoundError:return None
        current=token();cached=self._preview_cache.get(name)
        if cached and cached['audio_key']==key and current and cached['audio_stat']==current:
            return key,file,list(cached['peaks'])
        try:
            saved=json.loads(sidecar.read_text())
            if (saved.get('schema_version')==1 and saved.get('audio_key')==key and current and
                saved.get('audio_stat')==current and saved.get('frames')==self.meta['frames'] and
                saved.get('sample_rate')==self.sr and len(saved.get('peaks',[]))==1000 and
                all(isinstance(v,(int,float)) and math.isfinite(v) and v>=0 for v in saved['peaks'])):
                self._preview_cache[name]=saved;return key,file,list(saved['peaks'])
        except (ValueError,OSError,TypeError):pass
        audio=self.render_track(name)
        temporary=file.with_name('.'+file.stem+'.'+uuid.uuid4().hex[:8]+'.tmp.wav')
        try:
            sf.write(temporary,audio,self.sr,subtype='FLOAT');os.replace(temporary,file)
        finally:temporary.unlink(missing_ok=True)
        mono=np.max(np.abs(audio),axis=1);indices=np.linspace(0,len(mono),1001,dtype=int)
        peaks=[float(np.max(mono[a:b])) if b>a else 0 for a,b in zip(indices[:-1],indices[1:])]
        cached={'schema_version':1,'audio_key':key,'audio_stat':token(),'frames':self.meta['frames'],'sample_rate':self.sr,'peaks':peaks}
        save_json(sidecar,cached);self._preview_cache[name]=cached
        return key,file,list(peaks)

    def view(self):
        tracks=[]
        for meta in self.meta['tracks']:
            name=meta['id']
            if name not in self.state['tracks'] or self.state['tracks'][name].get('removed'):continue
            key,file,peaks=self.track_preview(name)
            tracks.append({**meta,**deepcopy(self.state['tracks'][name]),'audio_url':f'/audio/{self.state["id"]}/'+file.name,
                           'audio_key':key,'peaks':peaks})
        history=self.state['history']
        return {'id':self.state['id'],'revision':self.state['revision'],'title':self.state['title'],
                'fingerprint':self.fingerprint(),'duration':self.meta['duration_seconds'],'sample_rate':self.sr,
                'frames':self.meta['frames'],'master_gain':self.meta['master_gain'],'tracks':tracks,
                'can_undo':self.state['cursor']>0,'can_redo':self.state['cursor']<len(history),
                'history':[{'id':h['id'],'label':h['label'],'origin':h['origin'],'applied':i<self.state['cursor']}
                           for i,h in enumerate(history)],'preparation_seconds':self.meta['separation_seconds'],
                'piano_available':'piano' in self.audio,'piano_added':'piano' in self.state['tracks'] and not self.state['tracks']['piano'].get('removed'),
                'guitar_available':'guitar' in self.audio,'guitar_added':'guitar' in self.state['tracks'] and not self.state['tracks']['guitar'].get('removed'),
                'piano_cleanup_levels':list(self.piano_variants),
                'instrument_routing':[name for name in ('piano','guitar') if name in self.state['tracks']],
                'instrument_presence':{name:{'status':'unverified','reason':'固定目标声部分离不是乐器存在检测'} for name in ('piano','guitar')},
                'removed_track_ids':[name for name,t in self.state['tracks'].items() if t.get('removed')],
                'vocal_variant':self.state['tracks'].get('vocals',{}).get('voice_variant','original'),
                'vocal_candidates':list(reversed(list(self.vocal_assets.values()))),
                'available_parts':self.available_parts(),
                'original_audio_url':f'/audio/{self.state["id"]}/original.wav',
                'source_sha256':self.state['source_sha256'],'generation_job_id':self.meta.get('generation_job_id')}

    def check_revision(self, revision):
        if revision != self.state['revision']: raise RuntimeError('工程已变化，请刷新状态后重试')

    def controls_view(self):
        """Mix-only acknowledgement: do not render audio or rescan waveforms."""
        return {'id':self.state['id'],'revision':self.state['revision'],'fingerprint':self.fingerprint(),
                'tracks':{k:deepcopy(v) for k,v in self.state['tracks'].items() if not v.get('removed')},'can_undo':self.state['cursor']>0,
                'can_redo':self.state['cursor']<len(self.state['history']),
                'history':[{'id':h['id'],'label':h['label'],'origin':h['origin'],'applied':i<self.state['cursor']}
                           for i,h in enumerate(self.state['history'])]}

    def apply(self, command, origin, expected_revision, compact=False):
        self.check_revision(expected_revision)
        name=command.get('track_id')
        if command.get('type')=='add_piano':name='piano'
        adding=command.get('type') in ('add_piano','add_instrument','add_part','replace_part')
        new_part=command.get('type') in ('add_part','replace_part')
        if new_part and not any(t['id']==name and t.get('generated') for t in self.meta['tracks']):raise ValueError('新增声部尚未准备完成')
        if adding and not new_part and name not in ('piano','guitar'):raise ValueError('本轮可分离钢琴和吉他')
        if name not in self.audio: raise ValueError('该轨道尚未完成分离')
        if not adding and name not in self.state['tracks']:raise ValueError('请先加入该轨道')
        if not adding and self.state['tracks'][name].get('removed') and command.get('type')!='remove_track':raise ValueError('该轨道已移除，可撤销恢复后再修改')
        before=deepcopy(self.state['tracks']); after=deepcopy(before)
        t=after.get(name); label=''
        if adding and t and t.get('removed'):
            meta=next(m for m in self.meta['tracks'] if m['id']==name)
            if meta.get('operation')=='reorchestrate':
                if command.get('type')!='replace_part':
                    raise ValueError('重新编配候选须使用替换操作，防止与源声部叠加')
                source=meta['replaces_track_id']
                source_meta=next((m for m in self.meta['tracks'] if m['id']==source),{})
                expected=deepcopy(meta['source_track_state'])
                a,b=meta['range_seconds']
                expected['segments'].append({'start_frame':round(a*self.sr),'end_frame':round(b*self.sr),'gain':0.})
                if before.get(source)!=expected or source_meta.get('sha256')!=meta['source_track_sha256']:
                    raise ValueError('源声部在移除候选后已变化，请重新生成编配候选；没有覆盖你的修改')
            t.pop('removed');label='恢复声部：'+next(m['label'] for m in self.meta['tracks'] if m['id']==name)
        elif adding:
            meta=next(m for m in self.meta['tracks'] if m['id']==name)
            if meta.get('operation')=='reorchestrate':
                if command.get('type')!='replace_part':raise ValueError('重新编配候选须使用替换操作，防止与源声部叠加')
                source=meta['replaces_track_id']
                if name in after:raise ValueError('该重新编配已应用，可撤销后再试')
                source_meta=next((m for m in self.meta['tracks'] if m['id']==source),{})
                if before.get(source)!=meta['source_track_state'] or source_meta.get('sha256')!=meta['source_track_sha256']:
                    raise ValueError('源声部已修改，请重新生成编配候选；没有覆盖你的修改')
            elif command.get('type')=='replace_part':raise ValueError('此候选不是重新编配替换候选')
            if name in after:return self.view()
            # Inherit the Other track's edits and mix state, preventing a
            # split from unexpectedly changing the existing mix balance.
            if new_part:
                after[name]={'segments':[],'gain_db':0,'muted':False,'solo':any(t['solo'] for t in after.values() if not t.get('removed'))}
                meta=next(m for m in self.meta['tracks'] if m['id']==name)
                a,b=meta['range_seconds'];label=f'加入新编钢琴伴奏（{a:g}–{b:g}秒候选）'
                if meta.get('operation')=='reorchestrate':
                    source=meta['replaces_track_id'];after[name]=deepcopy(before[source])
                    after[source]['segments'].append({'start_frame':round(a*self.sr),'end_frame':round(b*self.sr),'gain':0.})
                    label=f'{source} {a:g}–{b:g}秒重新编配为木吉他（替换源声部）'
            else:
                after[name]=deepcopy(after['other'])
                after[name].pop('removed',None)
                label='加入'+{'piano':'钢琴','guitar':'吉他'}[name]+'分离候选（存在性待确认）'
        elif command.get('type')=='remove_track':
            if not t.get('removed'):
                if sum(not x.get('removed') for x in after.values())<=1:raise ValueError('请至少保留一条轨道')
                # Keep routing membership: deleting a separated Piano/Guitar
                # must not silently put its samples back into Other.
                t['removed']=True
            label='移除声部：'+next(m['label'] for m in self.meta['tracks'] if m['id']==name)
        elif command.get('type')=='vocal_variant':
            if name!='vocals':raise ValueError('歌手切换只用于主唱轨道')
            variant=command.get('variant_id')
            if self.vocal_assets.get(variant,{}).get('rejected_by_user'):raise ValueError('该主唱候选已被标记为听感不合格，不能应用')
            self.vocal_source(variant)
            if variant=='original':t.pop('voice_variant',None);label='恢复原始演唱主唱'
            else:t['voice_variant']=variant;label='切换主唱：'+self.vocal_assets[variant]['label']
        elif command.get('type')=='piano_cleanup':
            if name!='piano':raise ValueError('净化仅用于钢琴轨道')
            level=command.get('level')
            if level not in self.piano_variants:raise ValueError('该净化版本尚未准备完成')
            t['cleanup']=level
            label='钢琴净化：'+{'original':'原始分离','gentle':'轻度','strong':'较强'}[level]
        elif command.get('type')=='segment_gain':
            start,end=finite(command['start_seconds']),finite(command['end_seconds'])
            if not 0<=start<end<=self.meta['duration_seconds']: raise ValueError('选区必须在歌曲时长内，且开始早于结束')
            if end-start<.01: raise ValueError('选区至少为0.01秒')
            mode=command.get('mode')
            if mode not in ('mute','gain','restore'): raise ValueError('不支持的片段操作')
            db=finite(command.get('gain_db',0))
            if not -60<=db<=6: raise ValueError('片段音量范围为-60至+6dB')
            gain=0. if mode=='mute' else (1. if mode=='restore' else 10**(db/20))
            a,b=round(start*self.sr),round(end*self.sr)
            # Ordered absolute overrides keep a later edit strictly within its
            # interval, including overlapping edits and edge fades. Rebuilding
            # disjoint ranges with fresh fades would change outside samples.
            t['segments'].append({'start_frame':a,'end_frame':b,'gain':gain})
            if mode=='restore':
                t['muted']=False
                # A solo on another track would mask the restored part. Add
                # this track to the solo set without changing any other track.
                if any(x['solo'] for k,x in after.items() if k!=name and not x.get('removed')):t['solo']=True
            action='静音' if mode=='mute' else ('恢复原音量' if mode=='restore' else f'设为 {db:g} dB')
            label=f'{name} {start:g}–{end:g}秒 {action}'
        elif command.get('type')=='track_enabled':
            enabled=command.get('enabled')
            if not isinstance(enabled,bool):raise ValueError('轨道发声开关必须是布尔值')
            # Translate any legacy solo state without unexpectedly enabling
            # previously inaudible tracks. The new UI has independent switches.
            has_solo=any(x['solo'] for x in after.values() if not x.get('removed'))
            for x in after.values():
                if x.get('removed'):continue
                if has_solo:x['muted']=x['muted'] or not x['solo']
                x['solo']=False
            t['muted']=not enabled
            label=f'{name} '+('开启发声' if enabled else '关闭发声')
        elif command.get('type')=='track_mix':
            if 'gain_db' in command:
                db=finite(command['gain_db'])
                if not -60<=db<=6: raise ValueError('轨道音量范围为-60至+6dB')
                t['gain_db']=db
            for key in ('muted','solo'):
                if key in command:
                    if not isinstance(command[key],bool): raise ValueError('轨道开关参数错误')
                    t[key]=command[key]
            if command.get('muted') is True:
                if command.get('solo') is True:raise ValueError('静音和独奏不能同时开启')
                t['solo']=False
            elif command.get('solo') is True:t['muted']=False
            label=f'{name} 整轨混音设置'
        else: raise ValueError('本轮支持片段音量/静音、整轨混音及原歌曲钢琴/吉他分离')
        if before==after: return self.controls_view() if compact else self.view()
        history=self.state['history'][:self.state['cursor']]
        history.append({'id':str(uuid.uuid4()),'label':label,'origin':origin,'command':deepcopy(command),
                        'before':before,'after':after,'timestamp':time.time()})
        self.state.update(tracks=after,history=history,cursor=len(history),revision=self.state['revision']+1)
        save_json(self.file,self.state)
        return self.controls_view() if compact else self.view()

    def move_history(self, direction, expected_revision):
        self.check_revision(expected_revision)
        c=self.state['cursor']; h=self.state['history']
        if direction=='undo' and c>0: tracks=h[c-1]['before']; c-=1
        elif direction=='redo' and c<len(h): tracks=h[c]['after']; c+=1
        else: raise ValueError('没有可撤销或重做的操作')
        self.state.update(tracks=self.exclusive(tracks),cursor=c,revision=self.state['revision']+1)
        save_json(self.file,self.state)
        return self.view()

    def restore_history(self,cursor,expected_revision):
        self.check_revision(expected_revision)
        history=self.state['history']
        if isinstance(cursor,bool) or not isinstance(cursor,int) or not 0<=cursor<=len(history):raise ValueError('版本记录不存在')
        if cursor==self.state['cursor']:return self.view()
        tracks=history[cursor-1]['after'] if cursor else history[0]['before']
        self.state.update(tracks=self.exclusive(tracks),cursor=cursor,revision=self.state['revision']+1)
        save_json(self.file,self.state)
        return self.view()
