"""A completed preparation may be reused only while all required assets are intact."""
from pathlib import Path
import hashlib,math
import soundfile as sf

def prepared_assets_valid(directory,metadata,source_sha256):
    try:
        if metadata.get('source_sha256')!=source_sha256:return False
        frames=metadata['frames'];rate=metadata['sample_rate'];tracks=metadata['tracks']
        if not isinstance(frames,int) or frames<=0 or rate!=44100 or len(tracks)!=4:return False
        if {t['id'] for t in tracks}!={'vocals','drums','bass','other'}:return False
        for track in tracks:
            if track['file']!=track['id']+'.wav':return False
            path=directory/track['file']
            if hashlib.sha256(path.read_bytes()).hexdigest()!=track['sha256']:return False
        for name in [t['file'] for t in tracks]+['original.wav','baseline.wav']:
            info=sf.info(directory/name)
            if info.frames!=frames or info.samplerate!=rate or info.channels!=2:return False
        return math.isfinite(metadata['duration_seconds']) and abs(metadata['duration_seconds']-frames/rate)<1/rate
    except (OSError,ValueError,KeyError,TypeError,RuntimeError):return False
