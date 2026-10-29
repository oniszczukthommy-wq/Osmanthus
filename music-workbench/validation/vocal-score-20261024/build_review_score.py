"""Build one reviewable lead-vocal score from measured singing, never from invented notes."""
from pathlib import Path
import argparse,copy,hashlib,html,json,math,os,subprocess,time,shutil,sys
import numpy as np
import soundfile as sf
import textgrid
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from vocal_sources import lead_vocal_source
from note_listening import confirmed_pitches
from rhythm_notation import selected_rhythm,notation_origin,quantize_span,units as duration_units,beams as duration_beams,dotted,visual_slots,unit_positions


def align_lyrics(raw,textgrid_file,lyrics):
 grid=textgrid.TextGrid.fromFile(str(textgrid_file));tiers={t.name:t for t in grid}
 phones=[x for x in tiers['phones'] if x.mark];initials=set('b p m f d t n l g k h j q x zh ch sh r z c s y w y0'.split())
 chars=[];lines=[''.join(ch for ch in line if ch.isalnum()) for line in lyrics.splitlines() if line.strip() and not line.strip().startswith('[')];flat=''.join(lines);line_starts=np.cumsum([0]+[len(l) for l in lines])
 for interval in tiers['texts']:
  if not interval.mark:continue
  word_phones=[p for p in phones if p.maxTime>interval.minTime+.001 and p.minTime<interval.maxTime-.001]
  vowels=[p for p in word_phones if p.mark not in initials]
  anchor=vowels[0].minTime if vowels else interval.minTime
  for ch in interval.mark:
   if ch.isalnum():chars.append({'char':ch,'start':interval.minTime,'end':interval.maxTime,'anchor':anchor})
 if ''.join(c['char'] for c in chars)!=flat:raise ValueError('对齐文字与原始歌词不一致，停止导出以免漏字')
 for i,c in enumerate(chars):c.update(index=i,line_index=int(np.searchsorted(line_starts,i,side='right')-1))
 # Monotonic sequence alignment. Missing characters stay explicit; no random
 # insertion or selecting the next free note regardless of timing.
 N,M=len(chars),len(raw);cost=np.full((N+1,M+1),np.inf);route=np.zeros((N+1,M+1),np.uint8);cost[0,0]=0
 for i in range(N+1):
  for j in range(M+1):
   if j<M and cost[i,j]+.04<cost[i,j+1]:cost[i,j+1]=cost[i,j]+.04;route[i,j+1]=1
   if i<N and cost[i,j]+2.5<cost[i+1,j]:cost[i+1,j]=cost[i,j]+2.5;route[i+1,j]=2
   if i<N and j<M:
    c,n=chars[i],raw[j];delta=abs(c['anchor']-n['start_seconds']);overlap=min(c['end'],n['end_seconds'])-max(c['start'],n['start_seconds'])
    value=delta/.15+(0 if overlap>0 else 3)
    if cost[i,j]+value<cost[i+1,j+1]:cost[i+1,j+1]=cost[i,j]+value;route[i+1,j+1]=3
 i,j=N,M;mapping={};missing=[]
 while i or j:
  step=route[i,j]
  if step==3:i-=1;j-=1;mapping[j]=chars[i]
  elif step==2:i-=1;missing.append(chars[i])
  elif step==1:j-=1
  else:raise ValueError('词音匹配路径无效')
 return chars,mapping,list(reversed(missing)),lines


def canonical(data_dir,analysis_dir):
 meta=json.loads((data_dir/'preparation.json').read_text());job_id=meta['generation_job_id'];workbench=Path(os.environ.get('MUSIC_WORKBENCH_ROOT',str(ROOT.parent/'track-edit-e2e-20261024'))).resolve()
 generation=json.loads((workbench/'workflow/runs'/job_id/'state.json').read_text());generation['lyrics']=generation['lyrics'].strip();raw=json.loads((analysis_dir/'rain-vocal-notes.json').read_text())
 vocal=lead_vocal_source(data_dir)
 if raw['source_sha256']!=hashlib.sha256((data_dir/vocal['file']).read_bytes()).hexdigest():raise ValueError('转谱的人声与当前歌曲不一致')
 notes=[{**copy.deepcopy(n),'source_note_index':i} for i,n in enumerate(n for n in raw['notes'] if n['voiced'])]
 correction_file=data_dir/vocal['corrections_file'];corrections_sha256=hashlib.sha256(correction_file.read_bytes() if correction_file.exists() else b'[]').hexdigest();applied=[];correction_data={}
 if correction_file.exists():
  correction_data=json.loads(correction_file.read_text())
  if correction_data['vocal_sha256']!=raw['source_sha256']:raise ValueError('校订记录与当前人声不匹配')
  for fix in correction_data['corrections']:
   if fix['type']=='set_note_pitch':
    if fix.get('confirmed_by')!='user' or fix not in raw.get('user_pitch_reviews',[]):raise ValueError('音高听辨校订尚未校验')
    applied.append(fix);continue
   if fix['type']=='measured_phrase_candidate':
    if fix.get('confirmed_by')!='acoustic_review' or fix['id'] not in raw.get('measured_review_ids',[]):raise ValueError('声学候选尚未通过来源及证据校验')
    continue
   if fix['type']!='split_repeated_note' or fix['confirmed_by']!='user':raise ValueError('不支持或未经确认的乐谱校订')
   at=fix['at_seconds'];matches=[i for i,n in enumerate(notes) if n['start_seconds']<at<n['end_seconds'] and n['midi']==fix['expected_midi'] and abs(n['start_seconds']-fix['source_range_seconds'][0])<.03 and abs(n['end_seconds']-fix['source_range_seconds'][1])<.03]
   if len(matches)!=1:raise ValueError('校订锚点已改变，未强行覆盖新转谱结果')
   i=matches[0];left=copy.deepcopy(notes[i]);right=copy.deepcopy(notes[i]);left['end_seconds']=at;right['start_seconds']=at;left['human_reference_id']=right['human_reference_id']=fix['id'];notes[i:i+1]=[left,right];applied.append(fix)
 characters,mapping,missing,lines=align_lyrics(notes,analysis_dir/'tifa-rain/rain-vocals.TextGrid',generation['lyrics'])
 cross=json.loads((analysis_dir/'pitch-grid-check.json').read_text());comparisons={c['note_index']:c for c in cross['pitch_comparison']}
 from scores import source_context
 context=source_context(data_dir)[0]
 rhythm=selected_rhythm(data_dir,correction_data,context)
 heard=confirmed_pitches(data_dir,correction_data,context,notes,mapping)
 bpm=rhythm['bpm'] if rhythm else cross['grid_candidates'][0]['bpm'];quantum=.125 if rhythm else .25;origin=notation_origin(rhythm,notes[0]['start_seconds']);previous=0.;review=[]
 for i,n in enumerate(notes):
  n['id']=f'n{i+1:03}';n['lyric']=mapping.get(i,{}).get('char','');n['lyric_index']=mapping.get(i,{}).get('index');n['line_index']=mapping.get(i,{}).get('line_index')
  if rhythm:start,end,step=quantize_span(n['start_seconds'],n['end_seconds'],bpm,origin,previous,quantum)
  else:start=max(previous,round(n['start_seconds']*bpm/60/quantum)*quantum);end=max(start+quantum,round(n['end_seconds']*bpm/60/quantum)*quantum);step=quantum
  n.update(start_beats=start,end_beats=end,quantized_start_seconds=origin+start*60/bpm,quantized_end_seconds=origin+end*60/bpm,notation_quantum_beats=step,review_reasons=[])
  previous=end;compare=comparisons.get(n['source_note_index'])
  n['pitch_listening_accepted']=i in heard or n.get('pitch_origin')=='user_selected_listening_reference'
  if i in heard:n['pitch_listening_confirmation']=heard[i]
  n['diagnostic_reasons']=['音高交叉估计分歧超过半音'] if compare and compare['needs_pitch_review'] else []
  if n['diagnostic_reasons'] and not n['pitch_listening_accepted']:n['review_reasons'].extend(n['diagnostic_reasons'])
  if max(abs(n['quantized_start_seconds']-n['start_seconds']),abs(n['quantized_end_seconds']-n['end_seconds']))>.075:n['review_reasons'].append('节奏量化偏移超过75毫秒')
  if i in mapping and abs(mapping[i]['anchor']-n['start_seconds'])>.12:n['review_reasons'].append('歌词元音与音符起点相差超过120毫秒')
  if min(n['start_seconds']%16,n['end_seconds']%16,16-n['start_seconds']%16,16-n['end_seconds']%16)<.011:n['review_reasons'].append('位于分块边界，需检查是否拆开长音')
  if n.get('local_refinement'):n['review_reasons'].append('音高已按用户选择的试听参考校订，节奏仍待核对' if n.get('pitch_origin')=='user_selected_listening_reference' else '依据局部音符、歌词对齐及独立音高复核，仍待试听确认')
  if n['review_reasons']:review.append({'note_id':n['id'],'at':n['start_seconds'],'lyric':n['lyric'],'measure':int(start//4)+1,'beat':start%4+1,'reasons':n['review_reasons']})
 # Preserve melody groups for one-character/multiple-note notation.
 for i,n in enumerate(notes):
  if n['lyric']:continue
  owner=next((c for c in characters if c['start']<=n['start_seconds']<c['end']),None)
  if owner:n['melisma_lyric_index']=owner['index']
 histogram=np.zeros(12)
 for n in notes:histogram[n['midi']%12]+=n['end_seconds']-n['start_seconds']
 profiles={'major':[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],'minor':[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]}
 key_candidates=sorted([(float(np.corrcoef(histogram,np.roll(profile,pc))[0,1]),pc,mode) for pc in range(12) for mode,profile in profiles.items()],reverse=True)
 key_score,key_pc,key_mode=key_candidates[0];names=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];key_name=names[key_pc];numbered_pc=(key_pc+3)%12 if key_mode=='minor' else key_pc
 duration=meta['duration_seconds'];bars=math.ceil(max((duration-origin)*bpm/60,notes[-1]['end_beats'])/4)
 return {'schema_version':1,'engine':'singing-score-review-2','title':meta['song_title'],'project_id':meta['project_id'],'source_sha256':meta['source_sha256'],'vocal_sha256':raw['source_sha256'],
  'corrections_sha256':corrections_sha256,'applied_corrections':applied,'measured_review_candidates':raw.get('measured_review_candidates',[]),'automated_refinements':raw.get('local_refinements',[]),'alignment_refinements':raw.get('alignment_refinements',[]),'lyrics_sha256':hashlib.sha256(generation['lyrics'].encode()).hexdigest(),'basis':vocal['basis'],'duration_seconds':duration,'bpm':bpm,'meter':'4/4','key':key_name+' '+key_mode,'key_tonic':key_name,'key_mode':key_mode,'key_candidates':key_candidates[:4],'numbered_tonic_pc':numbered_pc,'numbered_tonic_name':names[numbered_pc],
  'pitch_listening_confirmations':list(heard.values()),'tempo_candidates':cross['grid_candidates'],'rhythm_review':rhythm,'notation_origin_seconds':origin,'rhythm_excerpt_accepted':bool(rhythm),'tempo_meter_key_accepted':False,'quarter_grid':quantum,'measure_count':bars,'notes':notes,'lyrics_lines':lines,
  'lyrics_characters':characters,'unmapped_lyrics':missing,'review_points':review,'accuracy_accepted':False,
  'summary':{'note_count':len(notes),'human_confirmed_pitch_notes':sum(n['pitch_listening_accepted'] for n in notes),'human_confirmed_lyric_fixes':sum(f['type']=='split_repeated_note' for f in applied),'human_confirmed_pitch_fixes':sum(f['type']=='set_note_pitch' for f in applied),'lyric_characters':len(characters),'mapped_characters':len(mapping),'unmapped_characters':len(missing),'flagged_notes':len(review),'cross_method_pitch_agreement':cross['agreement_within_50_cents']},
  'limitations':['已有局部人工听辨校订，整首尚未验收；算法一致性不等于准确率。','歌词为强制对齐，不是独立语音识别；模型可能漏唱或重复，仍需对照原唱。',
  '速度与起拍已按选中片段的试听方案设置；整首节奏与调性仍待核对。' if rhythm else '速度存在半速／倍速歧义，4/4小节起点与调性为待确认记谱选择。','保留原始测量与人工校订；谱面量化保留短音细分，节奏细节仍需核对。','原人声含分离误差与和声，主旋律提取可能受影响。']}


def score_musicxml(score,output):
 from music21 import stream,note,meter,key,tempo,clef,metadata,tie,expressions,layout
 s=stream.Score();s.metadata=metadata.Metadata();s.metadata.title=score['title']+'｜演唱谱候选（待校订）';s.metadata.composer='原始演唱旋律转谱 · 未经人工准确性验收'
 p=stream.Part(id='lead-vocal');p.partName='演唱';pieces={i:[] for i in range(1,score['measure_count']+1)}
 tonal_key=key.Key(score['key_tonic'].replace('b','-'),score['key_mode'])
 names=dict(enumerate(['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] if tonal_key.sharps>=0 else ['C','D-','D','E-','E','F','G-','G','A-','A','B-','B']))
 names.update({pitch.pitchClass:pitch.name for pitch in tonal_key.getScale().pitches})
 for n in score['notes']:
  pos=n['start_beats'];end=n['end_beats'];first=True
  while pos<end-1e-6:
   m=int(pos//4)+1;take=min(end-pos,4-pos%4);obj=note.Note(n['midi']);obj.duration.quarterLength=take
   # Spell against this song's key, preserving the measured MIDI pitch.
   obj.pitch.name=names[n['midi']%12]
   obj.pitch.octave=n['midi']//12-1
   # B# and Cb cross the notated octave boundary without changing sound.
   obj.pitch.octave+=round((n['midi']-obj.pitch.midi)/12)
   if first and n['lyric']:obj.addLyric(n['lyric'])
   continued=end>pos+take+1e-6
   if first and continued:obj.tie=tie.Tie('start')
   elif not first:obj.tie=tie.Tie('continue' if continued else 'stop')
   if n['review_reasons']:obj.style.color='#a55b16'
   pieces[m].append((pos%4,obj));pos+=take;first=False
 for i in pieces:
  m=stream.Measure(number=i)
  if i==1:
   m.insert(0,clef.TrebleClef());m.insert(0,key.Key(score['key_tonic'].replace('b','-'),score['key_mode']));m.insert(0,meter.TimeSignature('4/4'));m.insert(0,tempo.MetronomeMark(number=score['bpm']))
   m.insert(0,expressions.TextExpression('候选待校订；棕色音符需试听'+(f'；{len(score["unmapped_lyrics"])}字待定位（见工作台）' if score['unmapped_lyrics'] else '')))
  if (i-1)%(2 if score.get('rhythm_review') else 4)==0:m.insert(0,layout.SystemLayout(isNew=True))
  cursor=0
  for pos,obj in sorted(pieces[i],key=lambda x:x[0]):
   if pos>cursor+1e-6:m.insert(cursor,note.Rest(quarterLength=pos-cursor))
   m.insert(pos,obj);cursor=pos+float(obj.quarterLength)
  if cursor<4-1e-6:m.insert(cursor,note.Rest(quarterLength=4-cursor))
  p.append(m)
 s.insert(0,p);s.write('musicxml',fp=str(output/'vocal-score.musicxml'))
 # Use the same quantized events for the reference melody.
 import mido
 midi=mido.MidiFile(ticks_per_beat=960);track=mido.MidiTrack();midi.tracks.append(track);micro=mido.bpm2tempo(score['bpm'])
 track.extend([mido.MetaMessage('set_tempo',tempo=micro),mido.Message('program_change',program=0)])
 track.append(mido.MetaMessage('marker',text=f'source_audio_seconds_at_score_zero={score.get("notation_origin_seconds",0):.9f}'))
 events=[]
 for n in score['notes']:
  events.extend([(round(n['start_beats']*960),True,n['midi']),(round(n['end_beats']*960),False,n['midi'])])
 last=0
 for tick,on,pitch in sorted(events,key=lambda v:(v[0],v[1])):track.append(mido.Message('note_on' if on else 'note_off',note=pitch,velocity=72 if on else 0,time=tick-last));last=tick
 midi.save(output/'vocal-melody.mid')


def jianpu_tokens(score):
 # Engraving data comes from the same notes as MusicXML; no re-transcription.
 degrees={0:('1',''),1:('1','#'),2:('2',''),3:('3','b'),4:('3',''),5:('4',''),6:('4','#'),7:('5',''),8:('6','b'),9:('6',''),10:('7','b'),11:('7','')}
 bars=[[] for _ in range(score['measure_count'])]
 for n in score['notes']:
  start=n['start_beats'];end=n['end_beats'];first=True
  while start<end-1e-6:
   bar=int(start//4);take=min(end-start,4-start%4);number,acc=degrees[(n['midi']-score['numbered_tonic_pc'])%12]
   octave=(n['midi']-(60+score['numbered_tonic_pc']))//12
   notation_values=[4,3,2,1.5,1,.75,.5,.375,.25,.1875,.125,.09375,.0625]
   take=next(d for d in notation_values if d<=take+1e-6)
   bars[bar].append({'offset':start%4,'duration':take,'number':number,'accidental':acc,'octave':octave,'lyric':n['lyric'] if first else '',
                    'review':bool(n['review_reasons']),'continuation':not first,'continues':end>start+take+1e-6,'note_id':n['id']})
   start+=take;first=False
 def rests(start,end):
  result=[]
  while start<end-1e-6:
   take=next(d for d in [4,3,2,1.5,1,.75,.5,.375,.25,.1875,.125,.09375,.0625] if d<=end-start+1e-6)
   result.append({'offset':start,'duration':take,'number':'0','octave':0,'lyric':'','review':False,'accidental':'','continuation':False,'continues':False});start+=take
  return result
 for i,bar in enumerate(bars):
  cursor=0;complete=[]
  for n in sorted(bar,key=lambda n:n['offset']):
   if n['offset']>cursor:complete.extend(rests(cursor,n['offset']))
   complete.append(n);cursor=n['offset']+n['duration']
  if cursor<4:complete.extend(rests(cursor,4))
  bars[i]=complete
 return bars


def numbered_svg(score,output):
 bars=jianpu_tokens(score);width=1120;cols=1 if score.get('rhythm_review') else 2;barwidth=1008/cols;rows=math.ceil(len(bars)/cols);height=140+rows*100
 body=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="white"/>',
 '<style>text{font-family:Arial,"PingFang SC",sans-serif;fill:#202830}.lyric{font-size:14px}.note{font-size:22px;font-weight:600}</style>',
 f'<text x="56" y="42" font-size="25">{html.escape(score["title"])} · 简谱候选（待校订）</text>',
 f'<text x="56" y="72" font-size="15">1={html.escape(score["numbered_tonic_name"])}　4/4　♩={score["bpm"]:g}　原始完整演唱旋律</text>',
 f'<text x="56" y="100" font-size="13">{"已采用所选节拍与重拍；整首节奏与调性待核对" if score.get("rhythm_review") else "调性、拍号与起拍待确认"}；棕色音符需复核。</text>']
 for i,bar in enumerate(bars):
  x0=56+i%cols*barwidth;y=156+i//cols*100
  body.append(f'<text x="{x0}" y="{y-29}" font-size="11" fill="#778">{i+1}</text><path d="M{x0-8},{y-20}v57 M{x0+barwidth-10},{y-20}v57" stroke="#aab1ba"/>')
  for item,(position,span) in zip(bar,visual_slots(bar,barwidth-25,26)):
   x=x0+position;dur=item['duration'];color='#a55b16' if item['review'] else '#202830';number=item['number']
   # Represent long values as note + extension dashes, preserving fractional tail.
   units=duration_units(dur)
   for k,(unit,position) in enumerate(zip(units,unit_positions(dur,span,26))):
    xx=x+position;symbol=number if k==0 else '−'
    body.append(f'<text x="{xx}" y="{y}" class="note" style="fill:{color}">{html.escape(item["accidental"] if k==0 else "")}{symbol}</text>')
    if k==0 and number!='0':
     for d in range(abs(item['octave'])):body.append(f'<circle cx="{xx+6}" cy="{y-24-d*5 if item["octave"]>0 else y+11+d*5}" r="1.6" fill="{color}"/>')
    lines=duration_beams(unit)
    if dotted(unit):body.append(f'<circle cx="{xx+19}" cy="{y-5}" r="1.5"/>')
    for line in range(lines):body.append(f'<path d="M{xx-1},{y+4+line*4}h17" stroke="{color}" stroke-width="1.4"/>')
   if item['continuation']:body.append(f'<path d="M{x-6},{y-32}q9,-9 18,0" fill="none" stroke="{color}"/>')
   if item['lyric']:body.append(f'<text x="{x}" y="{y+35}" class="lyric">{html.escape(item["lyric"])}</text>')
 body.append('</svg>');(output/'numbered-score.svg').write_text(''.join(body));return bars


def numbered_pdf(score,bars,output):
 from reportlab.pdfgen import canvas
 from reportlab.pdfbase import pdfmetrics
 from reportlab.pdfbase.ttfonts import TTFont
 from reportlab.lib.pagesizes import A4
 pdfmetrics.registerFont(TTFont('ScoreCJK','/System/Library/Fonts/STHeiti Light.ttc',subfontIndex=0));c=canvas.Canvas(str(output/'numbered-score.pdf'),pagesize=A4);width,height=A4;cols=1 if score.get('rhythm_review') else 2;barwidth=(width-80)/cols;rows_per_page=8;page=0
 c.setTitle(score['title']+' · 简谱候选（待校订）')
 for row in range(math.ceil(len(bars)/cols)):
  if row%rows_per_page==0:
   if row:c.showPage()
   page+=1;c.setFont('ScoreCJK',17);c.drawString(40,height-44,score['title']+' · 简谱候选（待校订）');c.setFont('ScoreCJK',10);c.drawString(40,height-65,f'1={score["numbered_tonic_name"]}    4/4    BPM {score["bpm"]:g}    原始完整演唱旋律')
   c.drawString(40,height-83,'已采用所选节拍与重拍；整首节奏与调性待核对。' if score.get('rhythm_review') else '调性、拍号与起拍待确认；棕色标记需重点试听。');c.drawRightString(width-40,25,f'{page}')
   if score['unmapped_lyrics']:c.drawString(40,height-100,f'尚有 {len(score["unmapped_lyrics"])} 个歌词字待定位，详见文末校订清单。')
  y=height-135-(row%rows_per_page)*84
  for col in range(cols):
   i=row*cols+col
   if i>=len(bars):break
   x0=40+col*barwidth;c.setFillColorRGB(.45,.48,.52);c.setFont('Helvetica',7);c.drawString(x0,y+25,str(i+1));c.setStrokeColorRGB(.65,.68,.72);c.line(x0-4,y-28,x0-4,y+19);c.line(x0+barwidth-5,y-28,x0+barwidth-5,y+19)
   for item,(position,span) in zip(bars[i],visual_slots(bars[i],barwidth-12,16)):
    x=x0+position;dur=item['duration'];c.setFillColorRGB(*((.65,.36,.09) if item['review'] else (.12,.16,.2)));c.setStrokeColorRGB(*((.65,.36,.09) if item['review'] else (.12,.16,.2)))
    units=duration_units(dur)
    for k,(unit,position) in enumerate(zip(units,unit_positions(dur,span,16))):
     xx=x+position;c.setFont('Helvetica',13);c.drawString(xx,y,item['number'] if k==0 else '-')
     if k==0:
      if item['accidental']:c.setFont('Helvetica',8);c.drawString(xx-5,y+3,item['accidental'])
      if item['number']!='0':
       for d in range(abs(item['octave'])):c.circle(xx+4,y+15+d*3 if item['octave']>0 else y-7-d*3,1,stroke=0,fill=1)
     lines=duration_beams(unit)
     for line in range(lines):c.line(xx-1,y-2-line*3,xx+10,y-2-line*3)
     if dotted(unit):c.circle(xx+12,y+3,1,stroke=0,fill=1)
    if item['continuation']:c.bezier(x-4,y+19,x,y+25,x+8,y+25,x+12,y+19)
    if item['lyric']:c.setFont('ScoreCJK',9);c.drawString(x,y-24,item['lyric'])
 for index,item in enumerate(score['unmapped_lyrics']):
  if index%24==0:
   c.showPage();page+=1;c.setFillColorRGB(.12,.16,.2);c.setFont('ScoreCJK',17);c.drawString(40,height-44,'歌词校订清单（尚未确认）')
   c.setFont('ScoreCJK',10);c.drawString(40,height-69,'以下文字尚未可靠对应到独立音符，请对照原唱核查。');c.drawRightString(width-40,25,str(page))
  y=height-105-(index%24)*28
  line=score['lyrics_lines'][item['line_index']]
  text=f'{index+1}. {item["start"]:.2f}秒  “{item["char"]}”  ·  {line}'
  font_size=10
  while pdfmetrics.stringWidth(text,'ScoreCJK',font_size)>width-80 and font_size>7:font_size-=.5
  c.setFont('ScoreCJK',font_size);c.drawString(40,y,text)
 c.save()

def pdf_contains_lyrics(path,expected):
 try:
  from pypdf import PdfReader
  import unicodedata
  document=PdfReader(path,strict=True)
  text=unicodedata.normalize('NFKC','\n'.join(page.extract_text(extraction_mode='layout') for page in document.pages))
  # MuseScore's CJK font maps these printed simplified glyphs to radical
  # codepoints. They are glyph-equivalent but not all normalized by NFKC.
  text=text.translate(str.maketrans({'⻋':'车','⻩':'黄','⻛':'风','⻉':'贝'}))
  expected=unicodedata.normalize('NFKC',expected);characters=iter(text)
  return len(document.pages)>0 and bool(expected) and all(any(c==char for c in characters) for char in expected)
 except Exception:return False


def engrave(score,output,data_dir):
 score_musicxml(score,output);bars=numbered_svg(score,output);numbered_pdf(score,bars,output)
 workbench=Path(os.environ.get('MUSIC_WORKBENCH_ROOT',str(ROOT.parent/'track-edit-e2e-20261024'))).resolve();musescore=ROOT.parent/'score/MuseScore 4.app/Contents/MacOS/mscore'
 # Separate CLI processes avoid a native shutdown crash seen with a mixed PDF/SVG batch.
 for extension in ('pdf',):
  logs=[]
  for attempt in range(2):
   target=output/('staff-score.'+extension)
   target.unlink(missing_ok=True)
   process=subprocess.run([str(musescore),'-F','-S',str(ROOT.parent/'score/engraving-style.mss'),'-o',str(target),str(output/'vocal-score.musicxml')],capture_output=True,timeout=90)
   logs.append(f'Attempt {attempt+1}, exit {process.returncode}\n'.encode()+process.stdout+process.stderr)
   if process.returncode==0:break
   if process.returncode>0:break
  (output/('engrave-'+extension+'.log')).write_bytes(b'\n'.join(logs))
  if process.returncode:
   # This specific macOS shutdown failure can occur after a complete PDF is
   # written. Accept the file only after an independent extractor accounts for
   # the entire lyric sequence; every page must still render successfully below.
   known_shutdown=(process.returncode==-6 and b'mutex lock failed: Invalid argument' in logs[-1])
   verified=False
   if known_shutdown and target.exists():
    verified=pdf_contains_lyrics(target,''.join(n['lyric'] for n in score['notes']))
   (output/'engrave-validation.json').write_text(json.dumps({'renderer_exit_code':process.returncode,'known_native_shutdown_failure':known_shutdown,'independent_complete_lyric_sequence_check':verified,'all_page_render_check_follows':True},indent=2))
   if not verified:raise ValueError('五线谱排版未成功，原音频工程不受影响')
 if not (output/'staff-score.pdf').exists():raise ValueError('五线谱导出文件缺失')
 poppler=shutil.which('pdftoppm') or '/Users/zyx/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'
 result=subprocess.run([poppler,'-scale-to','1700','-png',str(output/'staff-score.pdf'),str(output/'staff-page')],capture_output=True,timeout=60)
 if result.returncode or not list(output.glob('staff-page-*.png')):raise ValueError('五线谱预览渲染失败')
 synth=ROOT.parent/'audio-runtime/env/bin/fluidsynth';process=subprocess.run([str(synth),'-ni','-g','.4','-o','synth.reverb.active=0','-o','synth.chorus.active=0','-F',str(output/'melody-synth.wav'),'-r','44100',str(ROOT.parent/'instrument-generaluser/GeneralUser-GS.sf2'),str(output/'vocal-melody.mid')],capture_output=True,timeout=60)
 if process.returncode:raise ValueError('参考旋律渲染失败')
 y,sr=sf.read(output/'melody-synth.wav',dtype='float32',always_2d=True);length=round(score['duration_seconds']*sr);fit=np.zeros((length,2),np.float32);shift=round(score.get('notation_origin_seconds',0)*sr);dst=max(0,shift);src=max(0,-shift);count=min(length-dst,len(y)-src)
 if count>0:fit[dst:dst+count]=y[src:src+count]
 sf.write(output/'score-melody.wav',fit,sr,subtype='PCM_16')
 voice,sr=sf.read(data_dir/lead_vocal_source(data_dir)['file'],dtype='float32',always_2d=True);sf.write(output/'original-vocal.wav',voice,sr,subtype='PCM_16')


def main():
 p=argparse.ArgumentParser();p.add_argument('--data-dir',required=True,type=Path);p.add_argument('--analysis-dir',type=Path,default=ROOT);p.add_argument('--output-dir',required=True,type=Path);p.add_argument('--engrave',action='store_true');args=p.parse_args();output=args.output_dir.resolve();output.mkdir(exist_ok=True,parents=True)
 score=canonical(args.data_dir,args.analysis_dir);(output/'score.json').write_text(json.dumps(score,ensure_ascii=False,indent=2));print(score['summary'],flush=True)
 if args.engrave:engrave(score,output,args.data_dir)
if __name__=='__main__':main()
