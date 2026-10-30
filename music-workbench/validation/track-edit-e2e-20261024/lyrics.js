const el=id=>document.getElementById(id);
export function lyricSource(current,generation,state,preview){
  if(generation&&!generation.project_ready&&generation.stage!=='error'&&(!state.playing||!preview.paused)){
    return {key:'generation:'+generation.id,kind:'generation',id:generation.id,title:generation.title,lyrics:generation.lyrics||'',...(generation.instrumental?{instrumental:true}:{}),time:preview.currentTime||0};}
  return current?{key:`project:${current.id}:${current.vocal_variant||'original'}:${current.source_sha256}`,kind:'project',id:current.id,title:current.title,...(current.instrumental?{instrumental:true}:{}),time:state.currentTime}:null;
}
export function lineAt(lines,time){
  // Leave instrumental gaps unhighlighted. Repeated choruses retain distinct indices.
  let lo=0,hi=lines.length-1,found=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(lines[mid].start<=time){found=mid;lo=mid+1;}else hi=mid-1;}
  if(found<0||time>=lines[found].end)return -1;
  return !lines[found].intervals||lines[found].intervals.some(([start,end])=>start<=time&&time<end)?found:-1;
}

export function initializeLyrics({getProject,transport}){
  const box=el('lyric-lines'),preview=el('generation-audio');
  let sourceKey='',textKey='',lines=[],rows=[],active=-1,follow=true,job=null,pollAt=0,fetching=false,serial=0,lastTick=0;
  let failed=false,source=null,previousLine=-1;
  const clock=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}`;
  function status(text){if(el('lyric-status').textContent!==text)el('lyric-status').textContent=text;}
  function setFollow(value){follow=value;el('lyric-follow').setAttribute('aria-pressed',String(value));el('lyric-follow').textContent=value?'跟随演唱：开':'跟随演唱：关';if(value)center(active>=0?active:previousLine);}
  function center(index){const row=rows[index];if(row)box.scrollTo({top:Math.max(0,row.offsetTop-box.clientHeight/2+row.clientHeight/2),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
  function showText(text){if(text===textKey)return;textKey=text;active=-1;previousLine=-1;
    const plain=text.split('\n').map(x=>x.trim()).filter(x=>x&&!x.startsWith('['));
    rows=plain.map((text,index)=>{const row=document.createElement('button');row.type='button';row.className='lyric-line';row.textContent=text;row.disabled=true;
      row.onclick=async()=>{const at=lines[index]?.start;if(!Number.isFinite(at)||!source)return;try{
        if(source.kind==='project'){await transport.seek(source.id,at);}else preview.currentTime=at;
      }catch(e){status(e.message);}};return row;});
    box.replaceChildren(...rows);box.scrollTop=0;
    if(!rows.length){const p=document.createElement('p');p.textContent='正在生成歌词…';box.append(p);}
  }
  function setTiming(timing){lines=timing?.stage==='ready'?timing.lines:[];
    rows.forEach((row,index)=>{row.disabled=!lines[index];row.title=lines[index]?`定位到 ${clock(lines[index].start)}`:'';});
    el('lyric-retry').hidden=!failed;
  }
  async function load(expected,token){fetching=true;
    try{
      const r=await fetch('/api/lyrics/project/'+expected.id,{signal:AbortSignal.timeout(12000)});const value=await r.json();if(!r.ok)throw Error(value.error||'暂时无法读取歌词');
      if(token!==serial)return;
      showText(value.lyrics);job=value.job;
      if(!job){const result=await fetch('/api/lyrics/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:expected.id}),signal:AbortSignal.timeout(12000)});
        const created=await result.json();if(!result.ok)throw Error(created.error||'歌词同步暂未启动');if(token!==serial)return;job=created;}
      failed=['error','interrupted'].includes(job.stage);setTiming(job);
      status(job.stage==='ready'?(job.timing_review_score_job_id?'已采用乐句复核后的歌词时间 · 点击可定位；仍需听辨核对':'演唱同步已准备好 · 点击歌词可定位；算法对齐，漏唱或重复处仍需听辨核对'):failed?job.error:'歌词已生成 · 正在对齐实际演唱，完成后自动跟随');
      pollAt=performance.now()+(job.stage==='ready'||failed?30000:2000);
    }catch(e){if(token!==serial)return;failed=true;el('lyric-retry').hidden=false;status(e.name==='TimeoutError'?'歌词同步连接超时，可重试；播放不受影响':e.message);pollAt=performance.now()+15000;}
    finally{if(token===serial)fetching=false;}
  }
  function choose(){const playback=window.osmanthusPlaybackState;if(playback?.kind==='preview'&&playback.song?.instrumental)return {key:'preview:'+playback.id,kind:'generation',id:playback.id,title:playback.song.title,instrumental:true,time:playback.time||0};const current=getProject(),generation=window.generationWorkflowState?.job,state=transport.state();
    // The preview has its own clock until handoff; never highlight another song with it.
    return lyricSource(current,generation,state,preview);
  }
  function paint(now){requestAnimationFrame(paint);if(now-lastTick<80)return;lastTick=now;
    const selected=choose();if(!selected)return;source=selected;
    if(selected.key!==sourceKey){sourceKey=selected.key;serial++;fetching=false;failed=false;job=null;lines=[];pollAt=0;
      if(rows[active]){rows[active].classList.remove('singing');rows[active].removeAttribute('aria-current');}active=-1;previousLine=-1;
      showText(selected.lyrics||'');setTiming(null);setFollow(true);el('lyric-title').textContent=selected.title;status(selected.kind==='project'?'正在读取这首歌的歌词…':'正在生成歌词…');}
    el('lyric-follow').disabled=!!selected.instrumental;
    if(selected.instrumental){if(box.dataset.instrumental!=='true'){box.dataset.instrumental='true';box.replaceChildren();const p=document.createElement('p');p.textContent='纯音乐 · 不含演唱与歌词';box.append(p);}status('纯音乐，无需加载歌词');el('lyric-retry').hidden=true;el('lyric-clock').textContent=clock(selected.time);return;}delete box.dataset.instrumental;
    if(selected.kind==='generation'){showText(selected.lyrics);status('歌词随歌曲一并生成 · 演唱同步将在整曲分轨完成后准备');}
    else if(!fetching&&now>=pollAt)void load(selected,serial);
    const index=lineAt(lines,selected.time);
    if(index!==active){if(rows[active]){rows[active].classList.remove('singing');rows[active].removeAttribute('aria-current');}
      active=index;if(rows[index]){rows[index].classList.add('singing');rows[index].setAttribute('aria-current','true');previousLine=index;if(follow)center(index);}}
    el('lyric-clock').textContent=clock(selected.time);
  }
  el('lyric-follow').onclick=()=>setFollow(!follow);
  for(const event of ['wheel','touchstart','pointerdown'])box.addEventListener(event,()=>setFollow(false),{passive:true});
  box.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(e.key))setFollow(false);});
  el('lyric-retry').onclick=async()=>{if(source?.kind!=='project')return;const expected=source,token=serial;fetching=true;
    try{const r=await fetch('/api/lyrics/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:expected.id}),signal:AbortSignal.timeout(12000)});const value=await r.json();if(!r.ok)throw Error(value.error||'重试失败');if(token!==serial)return;job=value;failed=false;setTiming(job);pollAt=0;status('正在准备演唱同步…');}
    catch(e){if(token===serial)status(e.message);}finally{if(token===serial)fetching=false;}};
  Object.defineProperty(window,'lyricPlaybackState',{get:()=>({sourceKey,projectId:source?.kind==='project'?source.id:null,jobId:job?.id,stage:job?.stage,activeLine:active,currentLine:rows[active]?.textContent||null,follow,lineCount:rows.length,timedLineCount:lines.length,currentTime:source?.time,lines})});
  requestAnimationFrame(paint);
}
