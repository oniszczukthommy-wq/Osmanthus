"""Prepare a real YinChao song for the shared-project audio edit acceptance."""
from pathlib import Path
import argparse, subprocess, os, fcntl
import hashlib, json, time
import numpy as np
import soundfile as sf
from prepared_cache import prepared_assets_valid

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / 'provider-song-comparison-20261024/yinchao/01-warm-pop-female/song.mp3'
DATA = ROOT / 'data'

def main():
    global SOURCE,DATA
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,default=SOURCE);parser.add_argument('--output',type=Path,default=DATA)
    parser.add_argument('--title',default='末班车的窗');parser.add_argument('--project-id')
    args=parser.parse_args();SOURCE=args.source.resolve();DATA=args.output.resolve()
    DATA.mkdir(parents=True,exist_ok=True)
    # Survives a web-server restart: an orphaned preparation process keeps the
    # lock, while the resumed worker waits and then reuses its completed files.
    guard=(DATA/'.preparation.lock').open('a')
    fcntl.flock(guard,fcntl.LOCK_EX)
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    existing = DATA / 'preparation.json'
    try:prepared=json.loads(existing.read_text()) if existing.exists() else {}
    except ValueError:prepared={}
    if prepared_assets_valid(DATA,prepared,digest):
        print('Prepared song already exists; no repeated separation.', flush=True)
        return
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    torch.set_num_threads(2)
    audio, sr = sf.read(SOURCE, dtype='float32', always_2d=True)
    if sr!=44100 or audio.shape[1]!=2:
        working=DATA/'working-input.wav'
        ffmpeg=ROOT.parent/'audiocraft/conda-env/bin/ffmpeg'
        subprocess.run([str(ffmpeg),'-nostdin','-y','-v','error','-i',str(SOURCE),'-ar','44100','-ac','2',str(working)],check=True,capture_output=True)
        audio,sr=sf.read(working,dtype='float32',always_2d=True)
    model = get_model('htdemucs').eval()
    if sr != model.samplerate: raise ValueError('Unexpected source sample rate')
    device = os.environ.get('MUSIC_SEPARATION_DEVICE','mps' if torch.backends.mps.is_available() else 'cpu')
    if device=='mps':torch.mps.set_per_process_memory_fraction(.8)
    torch.manual_seed(20261024)
    print(json.dumps({'stage':'separating','song':args.title,'seconds':len(audio)/sr,'device':device}), flush=True)
    started = time.perf_counter()
    with torch.no_grad():
        separated = apply_model(model, torch.from_numpy(audio.T.copy()).unsqueeze(0), device=device,
                                shifts=0, split=True, overlap=.25, progress=True, num_workers=0)
    stems = separated.squeeze(0).cpu().numpy().transpose(0, 2, 1)
    sources=list(model.sources)
    # The full-song CPU arrays must survive for export, but the inference
    # model and MPS work buffers are no longer needed. Release them before
    # writing several large WAVs on memory-constrained Macs.
    del separated,model
    if device=='mps':
        import gc
        gc.collect()
        torch.mps.synchronize()
        torch.mps.empty_cache()
    labels = {'vocals':'人声','drums':'鼓组','bass':'贝斯','other':'其他伴奏'}
    colors = {'vocals':'#b6a3ff','drums':'#e8ad69','bass':'#79d2b4','other':'#81b8ee'}
    tracks = []
    for name, stem in zip(sources, stems):
        path = DATA / f'{name}.wav'
        sf.write(path, stem, sr, subtype='FLOAT')
        tracks.append({'id':name,'label':labels[name],'color':colors[name],
                       'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    baseline = stems.sum(axis=0)
    peak = float(np.max(np.abs(baseline)))
    headroom = min(1., .95/max(peak, 1e-9))
    sf.write(DATA/'baseline.wav',baseline*headroom,sr,subtype='FLOAT')
    sf.write(DATA/'original.wav',audio,sr,subtype='FLOAT')
    report = {'song_title':args.title,'source':str(SOURCE),'source_sha256':digest,
              'provider':'yinchao','model':'htdemucs','device':device,'sample_rate':sr,
              'frames':len(audio),'duration_seconds':len(audio)/sr,'tracks':tracks,
              'separation_seconds':round(time.perf_counter()-started,3),
              'master_gain':headroom,'baseline_peak_before_master':peak,
              'baseline_vs_original_rms':float(np.sqrt(np.mean((baseline-audio)**2))),
              'limitations':['Estimated separated stems, not provider-native tracks.',
                             'Other combines piano/guitar/strings; separation quality needs listening.']}
    if args.project_id:report.update(project_id=args.project_id,generation_job_id=args.project_id)
    temporary=existing.with_suffix('.tmp');temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2));temporary.replace(existing)
    print(json.dumps(report,ensure_ascii=False),flush=True)

if __name__ == '__main__': main()
