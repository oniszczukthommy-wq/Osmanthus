"""Current-mix candidate A/B, immutable receipts and guarded application.

Preparation runs on a frozen Project and writes only candidate-reviews/.  It
uses the same Project reducer as real application, so mute/gain/segment edits
are included in both previews.  Signal checks are not musical acceptance.
"""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import math
import re
import tempfile
import threading
import time
import uuid

import numpy as np
import soundfile as sf

from project import ROOT, save_json


def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()


def number(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
        raise ValueError('试听范围必须是有效秒数')
    return float(value)


def valid_id(value):
    try:return str(uuid.UUID(value))==value
    except (ValueError,TypeError,AttributeError):return False


def rms(audio):
    return float(np.sqrt(np.mean(np.square(audio,dtype=np.float64)))) if audio.size else 0.


def seam_metrics(before,after,boundaries,sr):
    """Measure adjacent-sample jumps only; never label music as seamless."""
    result=[]
    for at in boundaries:
        k=round(at*sr)
        if not 0<k<len(before):continue
        old=float(np.max(np.abs(before[k]-before[k-1])))
        new=float(np.max(np.abs(after[k]-after[k-1])))
        lo=max(0,k-round(.05*sr));hi=min(len(after),k+round(.05*sr))
        differences=np.abs(np.diff(after[lo:hi],axis=0))
        ordinary=float(np.percentile(differences,95)) if differences.size else 0.
        result.append({'at_seconds':at,'before_jump':old,'candidate_jump':new,
                       'local_step_p95':ordinary,
                       'needs_listening':bool(new>max(.015,ordinary*4,old*2+.005))})
    return result


def comparison_gain(a,b):
    """RMS matching is a disclosed approximation, not perceived-LUFS parity."""
    ra,rb=rms(a),rms(b)
    gain=1. if min(ra,rb)<1e-7 else float(np.clip(ra/rb,10**(-6/20),10**(6/20)))
    # The actual-balance preview shares this attenuation too. Include its
    # uncompensated peak so a quieter matched B cannot hide clipping there.
    peak=max(float(np.max(np.abs(a))),float(np.max(np.abs(b)))*max(1.,gain),1e-9)
    common=min(1.,.95/peak)
    return {'method':'whole-preview-stereo-RMS','reference_rms':ra,'candidate_rms':rb,
            'candidate_gain':gain,'candidate_gain_db':20*math.log10(gain),'common_peak_gain':common,
            'matching_limited':bool(min(ra,rb)<1e-7 or abs(20*math.log10(gain))>=5.999),
            'preview_only':True,'note':'试听采用 RMS 近似匹配，补偿不写入工程；应用保留候选原始混音音量。'}


class CandidateReviews:
    def __init__(self,root=ROOT):
        self.root=Path(root);self.directory=self.root/'candidate-reviews'
        self.directory.mkdir(parents=True,exist_ok=True)
        self.lock=threading.Lock()

    @staticmethod
    def check_context(project,body):
        if body.get('project_id')!=project.state['id']:raise RuntimeError('歌曲已切换，请重新准备候选对照')
        project.check_revision(body.get('revision'))

    def _candidate(self,project,kind,identifier):
        if kind not in ('arrangement','vocal'):raise ValueError('不支持的候选类型')
        pattern=r'(?:piano_add|guitar_arr)_[a-f0-9]{10}' if kind=='arrangement' else r'vocal_[a-f0-9]{12}'
        if not isinstance(identifier,str) or not re.fullmatch(pattern,identifier):raise ValueError('候选标识无效')
        name='additional-tracks.json' if kind=='arrangement' else 'vocal-variants.json'
        path=project.directory/name
        if not path.exists():raise ValueError('该歌曲还没有此类候选')
        manifest=json.loads(path.read_text())
        if manifest.get('source_sha256')!=project.state['source_sha256']:raise ValueError('候选来源与歌曲不一致')
        entries=manifest.get('tracks' if kind=='arrangement' else 'variants',[])
        asset=next((v for v in entries if v.get('id')==identifier),None)
        if not asset:raise ValueError('候选不存在，请刷新候选列表')
        asset=deepcopy(asset)
        if asset.get('rejected_by_user'):raise ValueError('此候选已被标为听感不合格')
        filename=asset.get('file')
        if not isinstance(filename,str) or Path(filename).name!=filename or filename!=identifier+'.wav':
            raise ValueError('候选文件标识无效')
        file=project.directory/filename
        if not file.exists() or digest(file)!=asset.get('sha256'):raise ValueError('候选音频校验失败')
        audio,rate=sf.read(file,dtype='float32',always_2d=True)
        if rate!=project.sr or audio.shape!=project.audio['vocals'].shape or not np.isfinite(audio).all():
            raise ValueError('候选采样率、声道或时长与当前工程不一致')
        if kind=='arrangement':
            bounds=asset.get('range_seconds',[])
            if len(bounds)!=2:raise ValueError('候选缺少修改范围')
            a,b=map(number,bounds)
            if not 0<=a<b<=project.meta['duration_seconds']:raise ValueError('候选修改范围无效')
            ia,ib=round(a*rate),round(b*rate)
            if np.any(audio[:ia]) or np.any(audio[ib:]):raise ValueError('候选在修改区间外含声音，已停止应用')
            if identifier in project.state['tracks'] and not project.state['tracks'][identifier].get('removed'):
                raise ValueError('此声部已经加入工程')
            operation=asset.get('operation','piano')
            if operation not in ('piano','reorchestrate'):raise ValueError('候选操作类型无效')
            command={'type':'replace_part' if operation=='reorchestrate' else 'add_part','track_id':identifier}
            targets=[identifier]
            if operation=='reorchestrate':targets.append(asset.get('replaces_track_id'))
            scope='重新编配并替换所选声部' if operation=='reorchestrate' else '新增配器声部'
        else:
            if project.state['tracks'].get('vocals',{}).get('voice_variant','original')==identifier:
                raise ValueError('当前主唱已经使用此候选')
            a,b=0.,project.meta['duration_seconds'];targets=['vocals'];scope='替换完整主唱音色／演唱版本'
            command={'type':'vocal_variant','track_id':'vocals','variant_id':identifier}
        return asset,audio,command,targets,[a,b],scope

    @staticmethod
    def _install(project,kind,asset,audio):
        """Refresh immutable in-memory catalog only; never persist mix settings."""
        if kind=='arrangement':
            project.audio=dict(project.audio);project.audio[asset['id']]=audio
            project.meta['tracks']=[m for m in project.meta['tracks'] if m['id']!=asset['id']]+[{**asset,'generated':True}]
        else:
            project.vocal_assets[asset['id']]=deepcopy(asset);project.vocal_cache[asset['id']]=audio

    def prepare(self,project,body):
        # Whole-song signal checks are serialized to avoid multiple large PCM
        # mixes competing for memory; this is not the editor's mutation lock.
        with self.lock:return self._prepare(project,body)

    def _prepare(self,project,body):
        self.check_context(project,body)
        # Clone again so even a caller passing the live Project cannot mutate it.
        before=project.audio_snapshot();after=project.audio_snapshot()
        kind=body.get('kind');identifier=body.get('candidate_id')
        asset,audio,command,targets,bounds,scope=self._candidate(before,kind,identifier)
        start=number(body.get('preview_start_seconds'));end=number(body.get('preview_end_seconds'))
        duration=before.meta['duration_seconds']
        if not 0<=start<end<=duration:raise ValueError('请选择歌曲内有效的试听区间')
        if end-start>60:raise ValueError('对照试听每次最多60秒；应用范围仍以候选为准')
        if end<=bounds[0] or start>=bounds[1]:raise ValueError('试听区间与候选修改范围没有重叠，请先定位到候选区间')
        preview=[max(0.,start-2),min(duration,end+2)]
        # Repeated clicks for the same frozen state reuse validated preview
        # assets. A new revision is deliberately a new review, even after undo.
        metadata_sha=hashlib.sha256(json.dumps(asset,sort_keys=True).encode()).hexdigest()
        for file in self.directory.glob('*/state.json'):
            try:
                previous=json.loads(file.read_text())
                if (previous.get('project_id')==before.state['id'] and previous.get('revision')==before.state['revision'] and
                    previous.get('fingerprint')==before.fingerprint() and previous.get('data_dir')==str(before.directory.resolve()) and
                    previous.get('kind')==kind and previous.get('candidate_id')==identifier and
                    previous.get('candidate_metadata_sha256')==metadata_sha and previous.get('requested_preview_range_seconds')==[start,end]):
                    for name in previous['files']:self.asset(previous['id'],name)
                    return self.public(previous)
            except (OSError,ValueError,TypeError,KeyError):continue
        self._install(after,kind,asset,audio)
        with tempfile.TemporaryDirectory(prefix='candidate-reducer-',dir=self.directory) as temp:
            after.file=Path(temp)/'state.json'
            after.apply(command,'candidate-preview',before.state['revision'],compact=True)
        a=before.mix();b=after.mix()
        if not np.isfinite(a).all() or not np.isfinite(b).all():raise ValueError('候选混音含无效数据')
        x,y=[round(v*before.sr) for v in bounds]
        preserved=[k for k in before.state['tracks'] if k not in targets]
        non_target=all(before.state['tracks'][k]==after.state['tracks'].get(k) and
                       np.array_equal(before.render_track(k),after.render_track(k)) for k in preserved)
        outside=bool(np.array_equal(a[:x],b[:x]) and np.array_equal(a[y:],b[y:]))
        if not non_target or not outside:raise ValueError('候选会修改约定范围之外的声音，已停止应用')
        changed=bool(not np.array_equal(a[x:y],b[x:y]));peak=float(np.max(np.abs(b)))
        # Always inspect both operation joins, even when the audition is in the
        # middle of a long candidate.  A whole-song voice switch has no joins.
        seams=seam_metrics(a,b,bounds,before.sr)
        start_frame,end_frame=[round(v*before.sr) for v in preview]
        a=a[start_frame:end_frame];b=b[start_frame:end_frame]
        matching=comparison_gain(a,b)
        warnings=[]
        if not changed:warnings.append('候选未改变可听混音；目标轨可能已关闭或此段无声，请检查再试听。')
        if peak>1:warnings.append('应用后的混音会超过 0 dBFS；请先调整混音，再重新准备对照。')
        if any(s['needs_listening'] for s in seams):warnings.append('接缝检测发现突变风险，请重点试听前后过渡；本检测不代表听感验收。')
        if matching['matching_limited']:warnings.append('原版或候选过静／响度差较大，RMS 补偿已限制在 ±6 dB。')
        review_id=str(uuid.uuid4());folder=self.directory/review_id;folder.mkdir()
        sf.write(folder/'reference.wav',a*matching['common_peak_gain'],before.sr,subtype='PCM_24')
        sf.write(folder/'candidate.wav',b*matching['candidate_gain']*matching['common_peak_gain'],before.sr,subtype='PCM_24')
        # A no-compensation pair lets users judge the actual post-apply balance.
        sf.write(folder/'candidate-actual.wav',b*matching['common_peak_gain'],before.sr,subtype='PCM_24')
        files={n:digest(folder/n) for n in ('reference.wav','candidate.wav','candidate-actual.wav')}
        labels={m['id']:m.get('label',m['id']) for m in after.meta['tracks']}
        state={'id':review_id,'project_id':before.state['id'],'revision':before.state['revision'],
               'fingerprint':before.fingerprint(),'source_sha256':before.state['source_sha256'],
               'data_dir':str(before.directory.resolve()),'kind':kind,'candidate_id':identifier,
               'candidate_sha256':asset['sha256'],'candidate_metadata_sha256':metadata_sha,
               'label':asset.get('label',identifier),'scope':scope,'command':command,'created_at':time.time(),
               'range_seconds':bounds,'preview_range_seconds':preview,'requested_preview_range_seconds':[start,end],
               'targets':[{'id':k,'label':labels.get(k,k)} for k in targets],
               'preserved_tracks':[{'id':k,'label':labels.get(k,k)} for k in preserved],
               'checks':{'same_timeline':True,'non_target_tracks_unchanged':non_target,'outside_range_sample_identical':outside,
                         'audible_mix_changed':changed,'candidate_mix_peak':peak,'seams':seams,'musical_quality_accepted':False},
               'matching':matching,'warnings':warnings,'can_apply':bool(peak<=1 and changed),'files':files}
        save_json(folder/'state.json',state)
        return self.public(state)

    def read(self,identifier):
        if not valid_id(identifier):raise ValueError('候选对照标识无效')
        file=self.directory/identifier/'state.json'
        if not file.exists():raise ValueError('找不到该候选对照')
        return json.loads(file.read_text())

    @staticmethod
    def public(state):
        result={k:deepcopy(v) for k,v in state.items() if k not in ('data_dir','candidate_metadata_sha256','command')}
        result['files']={n:f'/api/candidate-reviews/{state["id"]}/files/{n}' for n in state['files']}
        return result

    def asset(self,identifier,name):
        state=self.read(identifier)
        if name not in state['files']:raise ValueError('无效对照文件')
        file=self.directory/identifier/name
        if digest(file)!=state['files'][name]:raise ValueError('对照音频校验失败，请重新准备')
        return file

    def validated_command(self,project,identifier,body):
        self.check_context(project,body);state=self.read(identifier)
        if (state['project_id']!=project.state['id'] or state['revision']!=project.state['revision'] or
            state['fingerprint']!=project.fingerprint() or state['source_sha256']!=project.state['source_sha256'] or
            state['data_dir']!=str(project.directory.resolve())):
            raise RuntimeError('工程在试听后已变化，请重新准备候选对照；没有覆盖你的修改')
        if not state['can_apply']:raise ValueError('此对照尚不能应用，请先处理提示并重新试听')
        asset,audio,command,_,_,_=self._candidate(project,state['kind'],state['candidate_id'])
        if (asset['sha256']!=state['candidate_sha256'] or command!=state['command'] or
            hashlib.sha256(json.dumps(asset,sort_keys=True).encode()).hexdigest()!=state['candidate_metadata_sha256']):
            raise RuntimeError('候选在试听后已变化，请重新准备对照')
        self._install(project,state['kind'],asset,audio)
        return command
