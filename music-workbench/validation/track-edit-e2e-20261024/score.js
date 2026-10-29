const $=id=>document.getElementById(id);
const clock=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${(value%60).toFixed(1).padStart(4,'0')}`;
const noteName=value=>`${['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][value%12]}${Math.floor(value/12)-1}`;
export function describeScoreCorrection(value){
 const at=value.at_seconds??value.source_range_seconds?.[0],position=Number.isFinite(at)?`（${clock(at)}）`:'';
 const kind=value.type==='set_note_pitch'?'音高':value.type==='split_repeated_note'?'同音反复':'音符';
 return `“${value.lyric||''}”字的${kind}${position}`;
}
export function initializeScore({getProject,transport,settle}){
 let projectId=null,sourceSignature=null,job=null,score=null,loading=false,starting=false,mode='staff',error='',loadedJob=null;
 let rangeStart=null,rangeEnd=null,previewType='vocal',previewSerial=0,pendingMetadata=null;
 let review=null,reviewBusy=false,reviewLoading=false,reviewMessage='',selectedNoteId=null,candidateJob=null,candidateScore=null,candidateViewing=false,candidatePolling=false;
 const signature=p=>p?`${p.id}|${p.vocal_variant||'original'}`:null,audio=$('score-audio');
 const isWorking=j=>j&&['queued','transcribing','aligning','refining','checking','engraving'].includes(j.stage),working=()=>isWorking(job);
 const view=()=>candidateViewing&&candidateScore&&candidateJob?.stage==='ready'?{job:candidateJob,score:candidateScore}:{job,score};
 function cancelPendingPreview(){previewSerial++;if(pendingMetadata){audio.removeEventListener('loadedmetadata',pendingMetadata);pendingMetadata=null;}}
 window.pauseScorePreview=()=>{cancelPendingPreview();audio.pause();rangeStart=null;rangeEnd=null;};
 Object.defineProperty(window,'vocalScoreState',{get:()=>({projectId,job,score,mode,previewType,currentTime:audio.currentTime,paused:audio.paused,error,review,reviewBusy,reviewMessage,candidateJob,candidateScore,candidateViewing,selectedNoteId})});
 function pauseOthers(){transport.pause();window.pauseGenerationPreview?.();window.pauseVocalPreview?.();window.pauseVoiceLibraryPreview?.();}
 async function request(path,body){const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();if(!response.ok){const e=Error(data.error||'演唱谱请求未完成');e.status=response.status;throw e;}return data;}
 const panel=document.createElement('section');panel.id='score-self-review';panel.hidden=true;
 panel.innerHTML=`<h3>按音符或歌词校订</h3><p>校订只改变谱面与钢琴参考，原唱和混音保持不变。生成候选后先核听，再保存；逐音确认不等于整谱验收。</p>
 <p id="score-self-review-status" role="status"></p><label>查找音符／歌词／时间 <input id="score-review-find" placeholder="例如：律、n020、00:43"></label>
 <label>校订音符 <select id="score-review-note"></select></label><p id="score-review-lock-state"></p>
 <label>音高 MIDI（0–127） <input id="score-review-pitch" type="number" min="0" max="127" step="1"></label>
 <label>开始／秒 <input id="score-review-start" type="number" min="0" step="0.001"></label><label>结束／秒 <input id="score-review-end" type="number" min="0" step="0.001"></label>
 <label>对应原歌词字（拆分时指定右侧新音符的字） <select id="score-review-lyric"></select></label>
 <div><button id="score-review-hear-vocal" type="button">听原唱这一处</button><button id="score-review-hear-notes" type="button">听当前谱面这一处</button>
 <label>试听速度 <select id="score-review-speed"><option value="1">原速</option><option value="0.75">0.75倍</option><option value="0.5">0.5倍</option></select></label>
 <label><input id="score-review-loop" type="checkbox">循环这一处</label></div>
 <button id="score-review-preview" type="button">生成校订候选</button>
 <label>同音或漏字需拆分时，拆分秒数 <input id="score-review-split-at" type="number" min="0" step="0.001"></label><button id="score-review-split" type="button">在此拆分，生成候选</button>
 <div><button id="score-review-show-candidate" type="button">显示候选谱与参考旋律</button><button id="score-review-show-saved" type="button">返回已保存谱</button><button id="score-review-save" type="button">保存候选</button></div>
 <div><button id="score-review-confirm" type="button">确认选中音符的音高、时值与配字</button><button id="score-review-unconfirm" type="button">解除选中音符的确认</button></div>
 <p>原歌词内容保持原样；这里只选择歌词字与音符的对应。漏唱、滑音或不确定音高请保留待复核，不按文字自动编造音符。PDF会保留算法诊断标记，当前确认记录见本面板。</p>`;
 $('score-pages').before(panel);
 function selected(){return view().score?.notes.find(n=>n.id===selectedNoteId)||null;}
 function paint(){
  const current=view(),s=current.score,j=current.job;
  $('create-vocal-score').disabled=starting||working()||reviewBusy||isWorking(candidateJob)||!getProject()?.generation_job_id;
  $('create-vocal-score').textContent=score?'检查当前已保存演唱谱':working()?'正在制作候选谱…':'生成演唱谱候选';
  const stages={queued:'等待本机出谱',transcribing:'提取实际演唱音符',aligning:'对齐原始歌词',refining:'局部复核未匹配歌词与音符',checking:'检查音高与节拍',engraving:'排版五线谱与简谱'};
  $('vocal-score-status').textContent=error||(starting?'正在提交出谱任务…':working()?`${stages[job.stage]} · ${job.elapsed_seconds}秒`:
   s?`${candidateViewing?'未保存的校订候选 · ':''}${s.summary.note_count} 个音符 · ${s.summary.mapped_characters}/${s.summary.lyric_characters} 字已定位 · ${s.summary.flagged_notes} 个算法诊断标记。${j.accuracy_accepted?'当前已保存版本通过你的整首通听确认。':'整首候选谱尚未通过人工准确性验收。'}`:
   job?.error||'按完整原始演唱出谱；试听静音与音量调整不会删去谱上的音符。');
  $('vocal-score-content').hidden=!s||j?.stage!=='ready';panel.hidden=!s||j?.stage!=='ready';
  if(!s||j?.stage!=='ready')return;
  const validationNote=$('score-validation-note');if(validationNote)validationNote.textContent=j.accuracy_accepted?'本版已通过这首歌的整首通听；棕色保留算法诊断记录。对照试听会暂停歌曲混音。':'对照试听会暂停歌曲混音。棕色保留算法诊断记录；逐音确认与整谱准确性验收分别保存。';
  const rhythm=s.rhythm_review;
  $('score-key-tempo').textContent=`${s.key}${s.tempo_meter_key_accepted?'':'（调性候选）'} · ${s.meter} · ♩=${s.bpm}（${rhythm?`采用 ${rhythm.selected_label} 版节拍与重拍`:'速度、调号、拍号与起拍待确认'}）`;
  for(const [id,value] of [['score-mode-staff','staff'],['score-mode-numbered','numbered']])$(id).setAttribute('aria-pressed',String(mode===value));
  $('score-export-pdf').href=j.files[mode==='staff'?'staff-score.pdf':'numbered-score.pdf'];$('score-export-pdf').download=`${s.title}-${mode==='staff'?'五线谱':'简谱'}-${candidateViewing?'校订候选':'候选'}.pdf`;
  paintReviewControls();
 }
 function showPages(){const current=view(),s=current.score,j=current.job;if(!s)return;const names=mode==='staff'?Object.keys(j.files).filter(n=>/^staff-page-\d+\.png$/.test(n)).sort((a,b)=>parseInt(a.match(/\d+/)[0])-parseInt(b.match(/\d+/)[0])):['numbered-score.svg'];
  $('score-pages').replaceChildren(...names.map((name,i)=>{const img=document.createElement('img');img.src=j.files[name];img.alt=`${s.title}${mode==='staff'?'五线谱':'简谱'}候选，第${i+1}页`;img.loading='lazy';return img;}));paint();}
 function prepareAudio(type,at=0,autoplay=false){const current=view(),s=current.score,j=current.job;if(!s||getProject()?.id!==projectId)return;
  cancelPendingPreview();const serial=previewSerial,id=projectId,jobId=j.id;audio.pause();previewType=type;error='';
  const valid=()=>serial===previewSerial&&getProject()?.id===id&&view().job?.id===jobId;
  const url=j.files[type==='vocal'?'original-vocal.wav':'score-melody.wav'];if(audio.getAttribute('src')!==url){audio.src=url;audio.load();}
  const seekPlay=()=>{pendingMetadata=null;if(!valid())return;audio.currentTime=Math.max(0,Math.min(at,s.duration_seconds));
   if(autoplay)audio.play().catch(e=>{if(!valid()||(e.name==='AbortError'&&audio.paused))return;error=e.message;paint();});};
  if(audio.readyState>=1)seekPlay();else{pendingMetadata=seekPlay;audio.addEventListener('loadedmetadata',seekPlay,{once:true});}
  $('score-preview-type').value=type;audio.playbackRate=Number($('score-review-speed').value);paint();
 }
 function renderReview(){const s=view().score;if(!s)return;const list=$('score-review-list');list.replaceChildren();
  const timingReviews=(s.alignment_refinements||[]).map(r=>({at:r.range_seconds[0],lyric:'局部歌词对齐复核',reasons:['已根据实际人声重新对齐，仍待试听确认']}));
  for(const point of [...s.unmapped_lyrics.map(v=>({at:v.start,lyric:v.char,reasons:['歌词尚未匹配到独立音符']})),...timingReviews,...s.review_points]){
   const button=document.createElement('button');button.type='button';button.textContent=`${clock(point.at)} ${point.lyric||'延音／过渡'}${point.measure?` · 第${point.measure}小节`:''}：${point.reasons.join('；')}`;
   button.onclick=()=>{const note=s.notes.find(n=>n.id===point.note_id)||s.notes.find(n=>n.start_seconds<=point.at&&n.end_seconds>=point.at)||s.notes.reduce((best,n)=>!best||Math.abs(n.start_seconds-point.at)<Math.abs(best.start_seconds-point.at)?n:best,null);
    if(note){selectedNoteId=note.id;$('score-review-find').value='';populateNotes();fillNote();}
    rangeStart=Math.max(0,point.at-.5);rangeEnd=Math.min(s.duration_seconds,point.at+2);pauseOthers();prepareAudio('vocal',rangeStart,true);};list.append(button);
  }
  const fixed=s.applied_corrections||[],heard=s.pitch_listening_confirmations||[];
  const confirmations=heard.length?`已有 ${heard.length} 处局部音高听辨记录。`:'';
  $('score-human-fixes').hidden=!fixed.length&&!heard.length;$('score-human-fixes').textContent=(fixed.length?`已根据听辨校订：${fixed.map(describeScoreCorrection).join('、')}。`:'')+confirmations;
  const missed=s.unmapped_lyrics.map(v=>`“${v.char}”（${clock(v.start)}）`).join('、');$('score-missing-warning').hidden=!missed;$('score-missing-warning').textContent=missed?`尚未定位的歌词：${missed}。请核对原唱；未把这些字强行贴到其他音符上。`:'';
 }
 function populateNotes(){const s=view().score;if(!s)return;const query=$('score-review-find').value.trim().toLowerCase(),list=$('score-review-note');
  const notes=s.notes.filter(n=>`${n.id} ${n.lyric||''} ${clock(n.start_seconds)} ${s.lyrics_lines[n.line_index]||''}`.toLowerCase().includes(query));
  if(!notes.some(n=>n.id===selectedNoteId))selectedNoteId=notes[0]?.id||null;
  list.replaceChildren(...(notes.length?notes.map(n=>new Option(`${n.id} · ${clock(n.start_seconds)} · ${n.lyric||'延音'} · ${noteName(n.midi)}${n.line_index!=null?' · 第'+(n.line_index+1)+'句':''}`,n.id)):[new Option('没有匹配音符','')]));list.value=selectedNoteId||'';
 }
 function fillNote(){const n=selected(),s=view().score;if(!n||!s){paintReviewControls();return;}
  $('score-review-pitch').value=n.midi;$('score-review-start').value=String(n.start_seconds);$('score-review-end').value=String(n.end_seconds);$('score-review-split-at').value=((n.start_seconds+n.end_seconds)/2).toFixed(3);
  $('score-review-lyric').replaceChildren(new Option('延音／不分配新歌词字',''),...s.lyrics_characters.map(c=>new Option(`${c.index+1}：“${c.char}” · 第${c.line_index+1}句 ${s.lyrics_lines[c.line_index]||''}`,String(c.index))));$('score-review-lyric').value=n.lyric_index==null?'':String(n.lyric_index);paintReviewControls();
 }
 function paintReviewControls(){const n=selected(),locked=n&&review?.confirmed_notes?.[n.id],pending=isWorking(candidateJob),canEdit=!!n&&!!review&&review.active_score_job_id===job?.id&&!reviewBusy&&!pending&&!candidateViewing&&!locked;
  for(const id of ['score-review-pitch','score-review-start','score-review-end','score-review-lyric','score-review-split-at','score-review-preview','score-review-split'])$(id).disabled=!canEdit;
  $('score-review-confirm').disabled=!n||!review||reviewBusy||pending||!!locked;
  $('score-review-unconfirm').disabled=!locked||reviewBusy||pending||candidateViewing;
  $('score-review-show-candidate').disabled=candidateJob?.stage!=='ready'||!candidateScore||reviewBusy;
  $('score-review-save').disabled=candidateJob?.stage!=='ready'||!candidateScore||reviewBusy;
  $('score-review-show-saved').disabled=!candidateViewing||reviewBusy;
  $('score-review-lock-state').textContent=locked?`此音符已确认并保护（${locked.fields.join('、')}）；需先解除确认才可修改。`:candidateViewing?'当前显示未保存候选，先核听并保存，或返回已保存谱继续修改。':n?`当前 ${noteName(n.midi)}；修改后只重排谱和参考旋律。`:'';
  const processing=pending?`校订候选：${candidateJob.stage==='engraving'?'正在排版五线谱／简谱与参考旋律':'等待排版'}；原谱保留。`:'';
  $('score-self-review-status').textContent=processing||reviewMessage||(review?`校订版本 ${review.review_revision} · ${review.confirmed_note_ids.length} 个音符已确认保护。${review.other_source_reviews_exist?'该项目存在其他原唱版本的校订，未自动套用。':''}`:'正在载入校订版本…');
 }
 async function loadReview(){if(!projectId)return;reviewLoading=true;const id=projectId,expected=sourceSignature;
  try{const next=await request(`/api/score-review/project/${id}`);if(signature(getProject())!==expected||sourceSignature!==expected)return;review=next;paintReviewControls();}
  catch(e){if(signature(getProject())===expected){reviewMessage=e.message;paintReviewControls();}}finally{reviewLoading=false;}
 }
 async function refresh(force=false){const project=getProject();if(!project||loading)return;
  if(sourceSignature!==signature(project)){window.pauseScorePreview();audio.removeAttribute('src');audio.load();projectId=project.id;sourceSignature=signature(project);job=null;score=null;loadedJob=null;review=null;candidateJob=null;candidateScore=null;candidateViewing=false;selectedNoteId=null;reviewMessage='';error='';paint();force=true;}
  if(!force&&(!job||!working()))return;loading=true;const id=projectId,expected=sourceSignature;
  try{const data=await request(`/api/scores/project/${id}`);if(signature(getProject())!==expected)return;const previousAcceptance=job?.accuracy_accepted;job=data.job;error='';
   if(job?.stage==='ready'&&loadedJob!==job.id){const next=await request(job.files['score.json']);if(signature(getProject())!==expected)return;
    if(next.project_id!==id||next.source_sha256!==getProject().source_sha256)throw Error('乐谱与当前歌曲不匹配');
    candidateViewing=false;score=next;loadedJob=job.id;renderReview();showPages();populateNotes();fillNote();prepareAudio('vocal');await loadReview();}
   else if(score&&job?.stage==='ready'&&previousAcceptance!==job.accuracy_accepted)renderReview();
   paint();
  }catch(e){if(signature(getProject())===expected){error=e.message;paint();}}finally{loading=false;}
 }
 async function beginReview(operations){if(reviewBusy||isWorking(candidateJob)||!review)return;reviewBusy=true;reviewMessage='';paint();const id=projectId,expected=sourceSignature;
  try{if(!await settle())return;if(signature(getProject())!==expected)throw Error('原唱版本已切换，请在当前版本校订');
   const result=await request('/api/score-review/candidates',{request_id:crypto.randomUUID(),project_id:id,revision:getProject().revision,review_revision:review.review_revision,score_job_id:job.id,score_sha256:review.active_score_sha256,operations});
   if(signature(getProject())!==expected)return;candidateJob=result;candidateScore=null;candidateViewing=false;reviewMessage='已提交校订参考；不会重新推理原唱。';await pollCandidate();
  }catch(e){if(signature(getProject())===expected){reviewMessage=e.message;if(e.status===409)await loadReview();}}finally{reviewBusy=false;paint();}
 }
 async function pollCandidate(){if(!candidateJob||!isWorking(candidateJob)||candidatePolling)return;candidatePolling=true;const id=projectId,jobId=candidateJob.id,expected=sourceSignature;
  try{const result=await request(`/api/scores/jobs/${jobId}`);if(signature(getProject())!==expected||candidateJob?.id!==jobId)return;candidateJob=result;
   if(result.stage==='ready'){candidateScore=await request(result.files['score.json']);if(signature(getProject())!==expected||candidateJob?.id!==jobId)return;
    candidateViewing=true;reviewMessage='校订候选已就绪，原唱与混音未改。请核听参考旋律后保存；本候选尚未成为已保存版本。';renderReview();showPages();populateNotes();fillNote();prepareAudio('vocal');}
   else if(['error','interrupted'].includes(result.stage))reviewMessage=result.error||'排版中断，原谱与原唱保留。';paint();
  }catch(e){if(signature(getProject())===expected)reviewMessage=e.message;}finally{candidatePolling=false;paintReviewControls();}
 }
 async function saveReview({candidate=false,confirm=false,unconfirm=false}={}){if(reviewBusy||!review||isWorking(candidateJob))return;const n=selected(),target=candidate?candidateJob:job;if(!target||target.stage!=='ready')return;
  reviewBusy=true;reviewMessage='';paint();const id=projectId,expected=sourceSignature;
  try{if(!await settle())return;if(signature(getProject())!==expected)throw Error('原唱版本已切换，请在当前版本校订');
   const result=await request('/api/score-review/save',{request_id:crypto.randomUUID(),project_id:id,revision:getProject().revision,review_revision:review.review_revision,score_job_id:target.id,score_sha256:candidate?target.score_sha256:review.active_score_sha256,confirm_note_ids:confirm&&n?[n.id]:[],unconfirm_note_ids:unconfirm&&n?[n.id]:[]});
   if(signature(getProject())!==expected)return;window.pauseScorePreview();review=result.review;job=result.job;candidateViewing=false;candidateJob=null;candidateScore=null;loadedJob=null;
   reviewMessage=unconfirm?'已解除此音符确认；其他确认保持。':confirm?'已保存此音符的音高、时值与配字确认；不是整谱验收。':'校订候选已保存为当前谱面，原始谱面任务与原唱完整保留。';await refresh(true);
  }catch(e){if(signature(getProject())===expected){reviewMessage=e.message;if(e.status===409)await loadReview();}}finally{reviewBusy=false;paint();}
 }
 function listenSelected(type){const n=selected(),s=view().score;if(!n||!s)return;rangeStart=Math.max(0,n.start_seconds-.3);rangeEnd=Math.min(s.duration_seconds,n.end_seconds+.3);pauseOthers();prepareAudio(type,rangeStart,true);}
 $('score-review-find').oninput=()=>{populateNotes();fillNote();};$('score-review-note').onchange=e=>{selectedNoteId=e.target.value;fillNote();};
 $('score-review-preview').onclick=()=>{const n=selected();if(!n)return;const lyric=$('score-review-lyric').value,operation={type:'update_note',note_id:n.id};
  const fields={midi:Number($('score-review-pitch').value),start_seconds:Number($('score-review-start').value),end_seconds:Number($('score-review-end').value),lyric_index:lyric===''?null:Number(lyric)};
  for(const [key,value] of Object.entries(fields))if(value!==(n[key]??null))operation[key]=value;
  if(Object.keys(operation).length===2){reviewMessage='音高、时间与配字没有改变；可直接试听并确认。';paintReviewControls();return;}beginReview([operation]);};
 $('score-review-split').onclick=()=>{const n=selected();if(!n)return;const lyric=$('score-review-lyric').value;beginReview([{type:'split_note',note_id:n.id,at_seconds:Number($('score-review-split-at').value),midi:Number($('score-review-pitch').value),lyric_index:lyric===''?null:Number(lyric)}]);};
 $('score-review-hear-vocal').onclick=()=>listenSelected('vocal');$('score-review-hear-notes').onclick=()=>listenSelected('melody');
 $('score-review-speed').onchange=()=>{audio.playbackRate=Number($('score-review-speed').value);};
 $('score-review-show-candidate').onclick=()=>{if(!candidateScore)return;window.pauseScorePreview();candidateViewing=true;renderReview();showPages();populateNotes();fillNote();prepareAudio('vocal');};
 $('score-review-show-saved').onclick=()=>{window.pauseScorePreview();candidateViewing=false;renderReview();showPages();populateNotes();fillNote();prepareAudio('vocal');};
 $('score-review-save').onclick=()=>saveReview({candidate:true});$('score-review-confirm').onclick=()=>saveReview({candidate:candidateViewing,confirm:true});$('score-review-unconfirm').onclick=()=>saveReview({unconfirm:true});
 $('create-vocal-score').onclick=async()=>{if(starting||working())return;starting=true;error='';paint();const id=getProject().id;
  try{if(!await settle())return;if(getProject().id!==id)throw Error('歌曲已切换，请在当前歌曲重新出谱');
   const p=getProject(),refine=job?.stage==='ready'&&job.summary?.unmapped_characters>0?{force_recompute:true,analysis_source_job_id:job.id}:{};
   const result=await request('/api/scores/jobs',{request_id:crypto.randomUUID(),project_id:id,revision:p.revision,...refine});if(getProject().id!==id)return;job=result;if(result.review_preserved)reviewMessage='已保留当前人工校订与确认结果；新改动请生成校订候选。';await refresh(true);await loadReview();
  }catch(e){if(getProject()?.id===id){error=e.message;paint();}}finally{starting=false;paint();}};
 $('score-mode-staff').onclick=()=>{mode='staff';showPages();};$('score-mode-numbered').onclick=()=>{mode='numbered';showPages();};
 $('score-preview-type').onchange=e=>{rangeStart=null;rangeEnd=null;prepareAudio(e.target.value,audio.currentTime,!audio.paused);};
 audio.onplay=pauseOthers;audio.ontimeupdate=()=>{if(rangeEnd!==null&&audio.currentTime>=rangeEnd){if($('score-review-loop').checked&&rangeStart!==null)audio.currentTime=rangeStart;else{audio.pause();rangeStart=null;rangeEnd=null;}}};
 $('score-export-pdf').onclick=()=>{if(!view().score)return false;};window.refreshVocalScore=()=>refresh(true);
 setInterval(()=>{refresh();pollCandidate();},1000);refresh(true);
}
