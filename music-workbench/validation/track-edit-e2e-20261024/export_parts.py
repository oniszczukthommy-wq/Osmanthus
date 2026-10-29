"""Export a frozen selection or routed stems, retaining precise source metadata."""
import hashlib,json,math,os,re,subprocess,tempfile,time,uuid,zipfile
from pathlib import Path
import numpy as np
import soundfile as sf

def selection(body,project):
    values=[body.get('start_seconds'),body.get('end_seconds')]
    if any(isinstance(v,bool) or not isinstance(v,(float,int)) or not math.isfinite(v) for v in values):
        raise ValueError('导出选区需要有效的开始和结束秒数')
    start,end=values
    if not 0<=start<end<=project.meta['duration_seconds']:raise ValueError('导出选区超出歌曲范围')
    a,b=round(start*project.sr),round(end*project.sr)
    if a>=b:raise ValueError('导出选区过短')
    return a,b

def export_parts(project,body,directory,ffmpeg):
    started=time.perf_counter();scope=body.get('scope');kind=body.get('format','wav')
    if scope not in ('range','stems') or kind not in ('wav','mp3'):raise ValueError('请选择片段或声部，以及 WAV 或 MP3')
    frames=selection(body,project) if scope=='range' else (0,project.meta['frames'])
    a,b=frames;identifier=project.state['id'];revision=project.state['revision']
    fingerprint=project.fingerprint();token=hashlib.sha256(json.dumps([fingerprint,scope,kind,a,b]).encode()).hexdigest()[:12]
    name=f'{scope}-r{revision}-{token}'+('.zip' if scope=='stems' else '.'+kind)
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);target=directory/name
    records=[]
    with tempfile.TemporaryDirectory(dir=directory,prefix='.export-') as temporary:
        work=Path(temporary)
        def encode(label,audio):
            peak=float(np.max(np.abs(audio))) if len(audio) else 0.
            if not np.isfinite(audio).all() or peak>1:raise ValueError('导出音频峰值超过0dBFS，请降低轨道音量后导出')
            wave=work/(label+'.wav');sf.write(wave,audio,project.sr,subtype='PCM_24');output=wave
            if kind=='mp3':
                output=work/(label+'.mp3')
                result=subprocess.run([str(ffmpeg),'-nostdin','-y','-v','error','-i',str(wave),'-codec:a','libmp3lame','-b:a','256k',str(output)],capture_output=True,timeout=120)
                if result.returncode:raise ValueError('音频编码失败，未生成导出文件')
            return output,peak
        if scope=='range':
            output,peak=encode('selection',project.mix()[a:b]);os.replace(output,target)
        else:
            solo=any(t.get('solo') for t in project.state['tracks'].values() if not t.get('removed'))
            for index,(track,settings) in enumerate(project.state['tracks'].items()):
                if settings.get('removed'):continue
                audible=not settings.get('muted') and (not solo or settings.get('solo'))
                gain=10**(settings.get('gain_db',0)/20)*project.meta['master_gain'] if audible else 0
                audio=project.render_track(track)*gain
                safe=re.sub('[^a-zA-Z0-9_-]','_',track)
                output,track_peak=encode(f'{index+1:02d}-{safe}',audio)
                records.append({'track_id':track,'file':output.name,'audible':bool(audible),'peak':track_peak,'gain':gain,'settings':settings})
            manifest={'project_id':identifier,'revision':revision,'fingerprint':fingerprint,'generation_job_id':project.meta.get('generation_job_id'),'source_sha256':project.meta['source_sha256'],'sample_rate':project.sr,'frames':b-a,'format':kind,'tracks':records,'routing':'current-mix; muted/non-solo stems export silence; segment edits and master gain included'}
            (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
            archive=work/'result.zip'
            # Fixed member metadata makes an unchanged snapshot byte-stable.
            # Concurrent identical exports may replace the same target safely
            # without invalidating another request's recorded download hash.
            with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
                for filename in ['manifest.json',*[r['file'] for r in records]]:
                    member=zipfile.ZipInfo(filename,date_time=(1980,1,1,0,0,0))
                    member.compress_type=zipfile.ZIP_DEFLATED
                    member.external_attr=0o100644<<16
                    with (work/filename).open('rb') as source,z.open(member,'w') as output:
                        for block in iter(lambda:source.read(1024*1024),b''):output.write(block)
            peak=max((r['peak'] for r in records),default=0);os.replace(archive,target)
    report={'project_id':identifier,'generation_job_id':project.meta.get('generation_job_id'),'revision':revision,'fingerprint':fingerprint,'scope':scope,'format':kind,'range_seconds':[a/project.sr,b/project.sr],'duration':(b-a)/project.sr,'frames':b-a,'peak':peak,'filename':name,'url':f'/exports/{identifier}/{name}','bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'elapsed_seconds':round(time.perf_counter()-started,3),'tracks':records}
    temp=target.with_name('.'+name+'.'+uuid.uuid4().hex+'.json')
    temp.write_text(json.dumps(report,ensure_ascii=False,indent=2));os.replace(temp,target.with_suffix(target.suffix+'.json'))
    return report
