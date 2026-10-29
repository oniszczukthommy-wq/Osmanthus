from pathlib import Path
import json,hashlib,argparse
import numpy as np,soundfile as sf,librosa
ROOT=Path(__file__).resolve().parent;parser=argparse.ArgumentParser();parser.add_argument('--folder',default='conversion-226869000163476');parser.add_argument('--eval-end',type=float,default=48);args=parser.parse_args();folder=ROOT/args.folder;r=json.loads((folder/'report.json').read_text());raw,sr=sf.read(r['output'],dtype='float32',always_2d=True);DATA=ROOT.parent/'track-edit-e2e-20261024/projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data';source,_=sf.read(DATA/'vocals.wav',start=40*sr,stop=round(args.eval_end*sr),dtype='float32',always_2d=True)
generated_full_seconds=len(raw)/sr;crop_offset=round(max(0,40-r.get('source_range_seconds',[40])[0])*sr)
if crop_offset:raw=raw[crop_offset:crop_offset+len(source)]
converted=np.zeros_like(source);n=min(len(raw),len(source));converted[:n]=np.repeat(raw[:n],2,axis=1)
gain=min(float(np.sqrt(np.mean(source**2))/max(np.sqrt(np.mean(converted**2)),1e-9)),.9/max(float(np.max(np.abs(converted))),1e-9));converted*=gain
DATA=ROOT.parent/'track-edit-e2e-20261024/projects/c6f722c8-c2da-4fad-879f-e0bde53d80ca/data';meta=json.loads((DATA/'preparation.json').read_text());a,b=40*sr,round(args.eval_end*sr)
backing=sum(sf.read(DATA/t['file'],dtype='float32',always_2d=True,start=a,stop=b)[0] for t in meta['tracks'] if t['id']!='vocals');A=backing+source;B=backing+converted;master=min(1.,.95/max(float(np.max(np.abs(A))),float(np.max(np.abs(B))),1e-9))
for name,wave in [('converted-vocal-aligned.wav',converted),('original-vocal-aligned.wav',source),('original-mix.wav',A*master),('converted-mix.wav',B*master)]:sf.write(folder/name,wave,sr,subtype='PCM_24')
# Independent waveform pitch comparison, not speaker identity or human quality.
pitches=[]
for wave in [source,converted]:
 y=librosa.resample(wave.mean(axis=1),orig_sr=sr,target_sr=22050);f0=librosa.yin(y,fmin=100,fmax=700,sr=22050,frame_length=1024,hop_length=220);pitches.append(69+12*np.log2(f0/440))
times=np.arange(len(pitches[0]))*220/22050;score=json.loads((ROOT.parent/'vocal-score-20261024/output/review-v2/score.json').read_text());comparisons=[]
for note in score['notes']:
 lo=max(40,note['start_seconds'])+.04;hi=min(args.eval_end,note['end_seconds'])-.04
 mask=(times>=lo-40)&(times<=hi-40)
 if hi<=lo or not mask.any() or not note['voiced']:continue
 x,y=[float(np.median(p[mask])) for p in pitches];comparisons.append({'note_id':note['id'],'lyric':note['lyric'],'source_midi':x,'converted_midi':y,'difference_cents':round((y-x)*100,2)})
report={'status':'short_conversion_measured_pending_listening','voice_name':'抒情男声','voice_id':r['voice_id'],'evaluation_range_seconds':[40,args.eval_end],'source_seconds':len(source)/sr,'generated_full_seconds':generated_full_seconds,'evaluation_crop_offset_samples':crop_offset,'raw_conversion_seconds':len(raw)/sr,'alignment_samples_added_at_end':len(source)-len(raw),'output_gain':gain,'same_backing_samples':True,'common_comparison_master_gain':master,'raw_saturated_samples':int(np.count_nonzero(np.abs(raw)>=1)),'raw_sample_count':raw.size,'mixed_peak':float(np.max(np.abs(B*master))),
 'independent_pitch_comparison':comparisons,'median_absolute_pitch_difference_cents':float(np.median([abs(x['difference_cents']) for x in comparisons])),'within_50_cents_fraction':sum(abs(x['difference_cents'])<=50 for x in comparisons)/len(comparisons),'quality_accepted':False,'warnings':['YIN can make octave/subharmonic errors; this is algorithm comparison, not exact melody ground truth.','Reference is a speech sample; similarity and natural singing require user listening.','Current CPU latency is not acceptable as a fast full-song voice-switch promise.']}
(folder/'audio-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print({k:v for k,v in report.items() if k!='independent_pitch_comparison'})
