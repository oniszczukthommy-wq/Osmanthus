from pathlib import Path
import json,hashlib,sys,unicodedata
import numpy as np
from music21 import converter,stream
from pypdf import PdfReader
from build_review_score import jianpu_tokens
ROOT=Path(__file__).resolve().parent;out=ROOT/'output/review-v2';score=json.loads((out/'score.json').read_text());checks={}
s=converter.parse(out/'vocal-score.musicxml');part=s.parts[0];flat=part.stripTies().flatten();parsed=[{'midi':int(n.pitch.midi),'start':float(n.offset),'duration':float(n.quarterLength),'lyric':n.lyric or ''} for n in flat.notes]
expected=[{'midi':n['midi'],'start':n['start_beats'],'duration':n['end_beats']-n['start_beats'],'lyric':n['lyric']} for n in score['notes']]
checks['musicxml_preserves_all_pitch_timing_and_lyric_events']=parsed==expected
checks['full_measure_count_matches']=len(part.getElementsByClass(stream.Measure))==score['measure_count']
checks['all_bars_filled_to_four_beats']=all(abs(float(m.highestTime)-4)<1e-7 for m in part.getElementsByClass(stream.Measure))
parts={};degree_values={'1':0,'2':2,'3':4,'4':5,'5':7,'6':9,'7':11};recovered=[]
for bar in jianpu_tokens(score):
 checks['jianpu_bars_fill_four_beats']=checks.get('jianpu_bars_fill_four_beats',True) and abs(sum(n['duration'] for n in bar)-4)<1e-8
 for n in bar:
  if n['number']=='0':continue
  value=60+score['numbered_tonic_pc']+12*n['octave']+degree_values[n['number']]+({'':0,'#':1,'b':-1}[n['accidental']])
  if n['note_id'] not in parts:parts[n['note_id']]={'midi':value,'duration':0}
  assert parts[n['note_id']]['midi']==value
  parts[n['note_id']]['duration']+=n['duration']
checks['jianpu_same_pitches_and_durations_as_staff']=all(parts[n['id']]=={'midi':n['midi'],'duration':n['end_beats']-n['start_beats']} for n in score['notes'])
checks['unmatched_lyric_is_reported_not_hidden']=len(score['unmapped_lyrics'])==score['summary']['unmapped_characters']==0
checks['actual_singing_accuracy_not_falsely_accepted']=score['accuracy_accepted'] is False and not score['tempo_meter_key_accepted']
checks['known_singing_control_pitches_match']=json.loads((ROOT/'control-acceptance.json').read_text())['all_integer_pitches_match']
checks['original_vocal_hash_matches_song']=hashlib.sha256((ROOT.parent/'track-edit-e2e-20261024/projects'/score['project_id']/'data/vocals.wav').read_bytes()).hexdigest()==score['vocal_sha256']
import soundfile as sf
for name in ('original-vocal','score-melody'):
 x=sf.info(out/(name+'.wav'));checks[name+'_full_song_duration']=abs(x.duration-score['duration_seconds'])<1e-5
for name in ('staff-score','numbered-score'):
 reader=PdfReader(out/(name+'.pdf'));text=unicodedata.normalize('NFKC',''.join(p.extract_text() for p in reader.pages));checks[name+'_has_chinese_title_and_warning']='雨后慢行' in text and '候选' in text
fix=[n for n in score['notes'] if n.get('human_reference_id')=='confirmed-an-44s'];checks['confirmed_word_is_split_as_same_pitch']=len(fix)==2 and [n['midi'] for n in fix]==[65,65] and [n['lyric'] for n in fix]==['这','安'] and abs(fix[0]['end_seconds']-fix[1]['start_seconds'])<1e-7
original=json.loads((ROOT/'output/review/score.json').read_text());groups={}
for n in score['notes']:groups.setdefault(n['source_note_index'],[]).append(n)
checks['no_other_raw_pitch_or_timing_changed']=len(groups)==len(original['notes']) and all((min(v['start_seconds'] for v in groups[i]),max(v['end_seconds'] for v in groups[i]),set(v['midi'] for v in groups[i]))==(n['start_seconds'],n['end_seconds'],{n['midi']}) for i,n in enumerate(original['notes']))
checks['mixer_muting_does_not_remove_sung_notes']=score['basis']=='original_complete_lead_vocal' and any(30<n['start_seconds']<45 for n in score['notes'])
report={'status':'passed' if all(checks.values()) else 'failed','checks':{k:bool(v) for k,v in checks.items()},'summary':score['summary'],'staff_pages':len(PdfReader(out/'staff-score.pdf').pages),'numbered_pages':len(PdfReader(out/'numbered-score.pdf').pages),'human_accuracy_accepted':False}
(ROOT/'score-format-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2));assert all(checks.values())
