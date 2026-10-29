import hashlib,json
from pathlib import Path
import numpy as np
import soundfile as sf
root=Path(__file__).resolve().parent
src=root/'output'; out=root/'output'
source_names=['drums','bass','other','vocals']
tracks={n:sf.read(src/f'{n}.wav',dtype='float32')[0] for n in source_names}
sr=sf.info(src/'bass.wav').samplerate
base=np.sum([tracks[n] for n in source_names],axis=0)
changed={k:v.copy() for k,v in tracks.items()}
changed['bass']*=10**(-6/20)
after=np.sum([changed[n] for n in source_names],axis=0)
sf.write(out/'reconstructed-before.wav',base,sr,subtype='PCM_16')
sf.write(out/'bass-minus-6db.wav',changed['bass'],sr,subtype='PCM_16')
sf.write(out/'reconstructed-after.wav',after,sr,subtype='PCM_16')
# Measure the edit invariant: after-before equals only the requested bass change.
expected=changed['bass']-tracks['bass']; actual=after-base
report={'operation':'single-track bass gain -6 dB','track_count':4,'duration_seconds':len(base)/sr,'sample_rate':sr,'only_modified_track':'bass','gain_linear':10**(-6/20),'other_stems_unchanged':all(np.array_equal(changed[n],tracks[n]) for n in source_names if n!='bass'),'max_abs_edit_invariant_error':float(np.max(np.abs(actual-expected))),'edit_difference_rms':float(np.sqrt(np.mean(actual**2))),'reconstructed_baseline_rms':float(np.sqrt(np.mean(base**2))),'reconstructed_after_rms':float(np.sqrt(np.mean(after**2))),'source_hashes':{n:hashlib.sha256((src/f'{n}.wav').read_bytes()).hexdigest() for n in source_names}}
(out/'single-track-edit-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
