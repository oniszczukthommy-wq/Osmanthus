import {localUrl,musicUrl} from './integration.js';
import {selectMusicRange,timedLyrics,affectedShots,DIRECTOR_RATIOS} from './mv-director-domain.js';
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=n=>`${Math.floor(n/60)}:${(n%60).toFixed(1).padStart(4,'0')}`;
const api=async(route,body)=>{const res=await fetch(localUrl(route),body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await res.json();if(!res.ok)throw Error(result.error||'操作未完成');return result;};
let session=null,step='range',selection={mode:'full'},idea='',ratio='16:9',references=[],currentJob=null,poll=null,submitting=false,previewEnd=null,editTarget=null,subtitles=false;
const audio=$('music');const done=new Set(['ready','failed','uncertain']);
const project=()=>({source:session.source,lyrics:session.lyrics});
const busy=()=>submitting||(currentJob&&!done.has(currentJob.status));
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('notice').hidden=true,7000);}
function range(){return selectMusicRange(project(),selection);}
function chosen(){try{return range();}catch{return null;}}
function heading(){return `<div class="steps">${[['range','1 选择音乐与想法'],['plan','2 查看与修改方案'],['result','3 预览与导出']].map(([key,label])=>`<button data-step="${key}" aria-current="${step===key?'step':'false'}" ${busy()||key!=='range'&&!session.plan?'disabled':''}>${label}</button>`).join('')}</div>`;}
function renderProgress(){const host=$('progress');if(!host)return;host.hidden=!currentJob||currentJob.status==='ready';host.innerHTML=currentJob?`<p class="${['failed','uncertain'].includes(currentJob.status)?'error':''}">${esc(currentJob.message)}</p>${!done.has(currentJob.status)?`<progress max="100" value="${currentJob.progress||0}"></progress><small>可以离开页面，回来后继续查看。</small>`:currentJob.status==='failed'&&['preview','render'].includes(currentJob.kind)?'<button data-action="recover">恢复已有任务</button>':''}`:'';}
function render(){
  if(!session)return;const disabled=busy()?'disabled':'';
  $('advanced').hidden=false;$('advanced').disabled=!!busy();$('song-bar').hidden=false;$('song-title').textContent=session.title;$('song-info').textContent=`${time(session.source.duration)} · 已选歌曲版本`;
  let content='';
  if(step==='range'){
    const lines=timedLyrics(project()),r=chosen();
    content=`<h1>让这首歌拥有画面</h1><p>选好音乐，写下画面想法。角色、场景与镜头会一起出现在方案里。</p><div class="split"><section class="panel"><h2>想制作哪一段？</h2><div class="choices">${[['full','整首歌曲'],['lyrics','选歌词'],['range','选时间']].map(([mode,label])=>`<button data-mode="${mode}" aria-pressed="${selection.mode===mode}" ${disabled||mode==='lyrics'&&!lines.length?'disabled':''}>${label}</button>`).join('')}</div>
    ${selection.mode==='lyrics'?`<div class="lyrics">${lines.map((line,i)=>`<label class="lyric ${i>=selection.from&&i<=selection.to?'selected':''}" data-line="${i}"><input type="checkbox" data-lyric="${i}" ${i>=selection.from&&i<=selection.to?'checked':''} ${disabled}><span>${esc(line.text)}</span><small>${time(line.start)}</small></label>`).join('')}</div>`:selection.mode==='full'?'<p>包含歌曲的前奏、间奏和尾奏。</p>':''}
    ${!lines.length?'<p class="hint">这首歌还没有可用的歌词时间轴，可以按时间选段，或制作整首。</p>':''}
    ${selection.mode!=='full'?`<div class="range-fields"><label>开始（秒）<input name="start" type="number" step="0.1" min="0" value="${r?.start??selection.start??0}" ${disabled}></label><label>结束（秒）<input name="end" type="number" step="0.1" max="${session.source.duration}" value="${r?.end??selection.end??Math.min(15,session.source.duration)}" ${disabled}></label></div>`:''}
    <div class="actions"><button data-action="listen-range" ${!r?'disabled':''}>试听选段</button><span id="range-summary">${r?`${time(r.start)}—${time(r.end)} · ${r.duration.toFixed(1)} 秒`:'请选择连续歌词或有效时间范围'}</span></div></section>
    <section class="panel"><h2>画面想法</h2><label>你想看到怎样的 MV？<textarea name="idea" maxlength="3000" rows="5" placeholder="例如：雨夜重逢的故事，电影感，温暖的结尾。也可以留空，让 AI 自由发挥。" ${disabled}>${esc(idea)}</textarea></label><div class="range-fields"><label>画面比例<select name="ratio" ${disabled}>${DIRECTOR_RATIOS.map(r=>`<option ${r===ratio?'selected':''}>${r}</option>`).join('')}</select></label><label>参考图片（可选，最多 3 张）<input id="reference-upload" type="file" accept="image/png,image/jpeg,image/webp" multiple ${disabled}></label></div><div class="references">${references.map((r,i)=>`<div><img src="${esc(localUrl(r.url))}" alt="参考图 ${i+1}"><button data-remove-reference="${i}" ${disabled}>移除</button></div>`).join('')}</div><div class="actions"><button class="primary" data-action="prepare" ${disabled||!r?'disabled':''}>设计 MV 方案</button></div><p class="hint">先设计方案，再确认图片与视频的制作消耗。</p></section></div>`;
  }else if(step==='plan'&&session.plan){
    const plan=session.plan,all=[...plan.characters,...plan.scenes,...plan.shots],missing=all.filter(x=>!session.previews[x.id]).length;
    const card=item=>`<article class="card" id="card-${item.id}">${session.previews[item.id]?`<img src="${esc(localUrl(session.previews[item.id].url))}" alt="${esc(item.name)}">`:'<div class="placeholder">等待制作预览图</div>'}<div class="body"><h3>${esc(item.name)}</h3>${item.start!==undefined?`<small>${time(item.start)}—${time(item.end)}</small><p>${esc(item.lyrics.map(l=>l.text).join(' / ')||'前奏、间奏或无歌词片段')}</p>`:''}<p>${esc(item.description)}</p><div class="actions">${item.start!==undefined?`<button data-listen="${item.id}">试听对应音乐</button>`:''}<button data-edit="${item.id}" ${disabled}>修改</button></div></div></article>`;
    content=`<h1>这首歌的画面方案</h1><section class="panel"><p>${esc(plan.summary)}</p><p class="hint">${esc(plan.style)}</p><p>${time(session.range.start)}—${time(session.range.end)} · ${plan.shots.length} 个镜头 · ${esc(session.ratio)}</p><div class="actions"><button data-edit="all" ${disabled}>修改整体方向</button><button data-action="previews" class="${missing?'primary':''}" ${disabled||!missing?'disabled':''}>${missing?`制作 ${missing} 张预览图`:'预览图已齐全'}</button></div></section>
    ${plan.characters.length?`<div class="section-head"><h2>角色</h2></div><div class="cards">${plan.characters.map(card).join('')}</div>`:'<p>这份方案以场景和视觉表达为主，无需人物。</p>'}
    <div class="section-head"><h2>场景</h2></div><div class="cards">${plan.scenes.map(card).join('')}</div><div class="section-head"><h2>分镜与音乐</h2></div><div class="cards shot-cards">${plan.shots.map(card).join('')}</div>
    <section class="panel"><label class="check"><input type="checkbox" name="subtitles" ${subtitles?'checked':''} ${!session.lyrics.length||busy()?'disabled':''}>加入歌词字幕</label><div class="actions"><button data-action="generate" class="primary" ${disabled||missing?'disabled':''}>确认方案，生成 MV</button><span>${missing?'请先查看全部预览图，再生成视频':'仅重新制作有变化的镜头'}</span></div></section>`;
  }else{
    const output=session.generated;
    content=`<h1>${output?'你的 MV':'成片与历史版本'}</h1>${output?`<video class="output-video" id="result-video" controls playsinline preload="metadata" src="${esc(localUrl(output.url))}"></video><div class="actions"><a class="primary" style="padding:12px 18px;border-radius:10px" href="${esc(localUrl(output.url))}" download="${esc(session.title)}-MV.mp4">下载 MP4</a><button data-action="share">分享 MV</button><button data-step="plan" ${disabled}>修改画面</button><span>${time(output.duration)} · ${esc(session.ratio)}</span></div>`:'<p>确认方案后即可制作。已完成的旧版本会继续保留。</p>'}<div class="history">${[...session.outputs].reverse().map((x,i)=>`<a href="${esc(localUrl(x.url))}" download="${esc(session.title)}-MV-${i+1}.mp4">下载历史版本 · ${esc(new Date(x.createdAt).toLocaleString())}</a>`).join('')}</div>`;
  }
  $('app').innerHTML=heading()+'<section id="progress" class="progress" aria-live="polite" hidden></section>'+content;renderProgress();
}
async function ask(title,body){$('confirm-title').textContent=title;$('confirm-body').innerHTML=body;$('confirm').showModal();return await new Promise(resolve=>$('confirm').addEventListener('close',()=>resolve($('confirm').returnValue==='ok'),{once:true}));}
async function receive(job){const previousProgress=currentJob?.progress;currentJob=job;if(!done.has(job.status)&&job.kind==='preview'&&previousProgress!==job.progress){session=(await api('/api/mv-director/'+session.id)).session;render();}renderProgress();if(done.has(job.status)){session=(await api('/api/mv-director/'+session.id)).session;if(job.status==='ready'){if(['prepare','revise','preview'].includes(job.kind))step='plan';if(job.kind==='render')step='result';}render();return;}clearTimeout(poll);poll=setTimeout(async()=>{try{await receive((await api('/api/mv-director/jobs/'+job.id)).job);}catch(e){notice(e.message);poll=setTimeout(()=>receive(job),4000);}},2000);}
async function submit(kind,input){
  if(busy())return;submitting=true;audio.pause();render();
  const signature=JSON.stringify([session.id,session.revision,kind,input]),storage='osmanthus-mv-request:'+signature;let request_id=sessionStorage.getItem(storage);if(!request_id){request_id=crypto.randomUUID();sessionStorage.setItem(storage,request_id);}
  try{const result=await api('/api/mv-director/jobs',{session_id:session.id,revision:session.revision,kind,input,request_id});currentJob=result.job;session.activeJob=result.job.id;}finally{submitting=false;render();}
  if(currentJob&&!done.has(currentJob.status))$('progress').scrollIntoView({behavior:'smooth',block:'start'});await receive(currentJob);
}
async function listen(start,end){$('result-video')?.pause();previewEnd=end;audio.currentTime=start;await audio.play();}
audio.addEventListener('timeupdate',()=>{if(previewEnd!==null&&audio.currentTime>=previewEnd){audio.pause();previewEnd=null;}const lines=session?timedLyrics(project()):[],active=lines.find(l=>audio.currentTime>=l.start&&audio.currentTime<l.end);$('playing-lyric').textContent=active?.text||'';document.querySelectorAll('[data-line]').forEach(el=>{const l=lines[Number(el.dataset.line)];el.classList.toggle('playing',l===active);});});
audio.addEventListener('play',()=>$('result-video')?.pause());
document.addEventListener('play',event=>{if(event.target.id==='result-video')audio.pause();},true);
audio.addEventListener('seeking',()=>{if(previewEnd!==null&&audio.currentTime>previewEnd)previewEnd=null;});
$('app').addEventListener('input',event=>{const target=event.target;if(target.name==='idea')idea=target.value;});
$('app').addEventListener('change',async event=>{
  const t=event.target;try{
    if(t.name==='ratio')ratio=t.value;
    if(t.name==='subtitles')subtitles=t.checked;
    if(t.name==='start'||t.name==='end'){selection={...selection,[t.name]:Number(t.value)};const r=chosen();$('range-summary').textContent=r?`${time(r.start)}—${time(r.end)} · ${r.duration.toFixed(1)} 秒`:'选段范围无效';$('app').querySelector('[data-action=prepare]').disabled=!r;}
    if(t.dataset.lyric!==undefined){const i=Number(t.dataset.lyric);selection=selection.from===undefined?{mode:'lyrics',from:i,to:i}:t.checked?{mode:'lyrics',from:Math.min(selection.from,i),to:Math.max(selection.to,i)}:i===selection.from?{mode:'lyrics',...(i<selection.to?{from:i+1,to:selection.to}:{})}:i===selection.to?{mode:'lyrics',from:selection.from,to:i-1}:{mode:'lyrics',from:i,to:i};render();}
    if(t.id==='reference-upload'){
      submitting=true;const files=Array.from(t.files);if(files.length+references.length>3)throw Error('最多选择 3 张参考图');
      for(const f of files){if(f.size>10e6)throw Error('每张参考图需小于10MB');const res=await fetch(localUrl('/api/materials'),{method:'POST',headers:{'X-Filename':encodeURIComponent(f.name)},body:f});const r=await res.json();if(!res.ok)throw Error(r.error||'参考图上传失败');references.push(r.material);}
    }
  }catch(e){notice(e.message);}finally{if(t.id==='reference-upload'){submitting=false;render();}}
});
$('app').addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||b.disabled)return;
  try{
    if(b.dataset.step){audio.pause();step=b.dataset.step;render();return;}
    if(b.dataset.mode){selection=b.dataset.mode==='range'?{mode:'range',start:0,end:Math.min(15,session.source.duration)}:{mode:b.dataset.mode};render();return;}
    if(b.dataset.removeReference!==undefined){references.splice(Number(b.dataset.removeReference),1);render();return;}
    if(b.dataset.listen){const shot=session.plan.shots.find(s=>s.id===b.dataset.listen);return await listen(shot.start,shot.end);}
    if(b.dataset.edit){editTarget=b.dataset.edit;const ids=affectedShots(session.plan,editTarget);$('edit-title').textContent=editTarget==='all'?'修改整体方向':'修改这部分画面';$('edit-impact').textContent=`将影响 ${ids.length} 个镜头：${session.plan.shots.filter(s=>ids.includes(s.id)).map(s=>s.name).join('、')}。歌曲与选段保持原样。`;$('edit-instruction').value='';$('edit').showModal();return;}
    const action=b.dataset.action;
    if(action==='recover'){currentJob=(await api('/api/mv-director/recover',{job_id:currentJob.id})).job;render();return await receive(currentJob);}
    if(action==='listen-range'){const r=range();return await listen(r.start,r.end);}
    if(action==='prepare')return await submit('prepare',{selection,idea,ratio,references:references.map(r=>r.id)});
    if(action==='previews'||action==='generate'){
      const kind=action==='previews'?'preview':'render',q=(await api(`/api/mv-director/${session.id}/quote?kind=${kind}`)).estimate;
      if(await ask(kind==='preview'?'制作方案预览图':'确认生成 MV',`<p>${kind==='preview'?`需要制作 ${q.images} 张图片`:`本次音乐 ${q.duration.toFixed(1)} 秒，需要生成 ${q.shots} 个镜头；其余镜头复用`}。</p><p>预计消耗 <strong>¥${q.total.toFixed(2)}</strong>，以实际服务账单为准。</p>`))await submit(kind,{confirmed:true,...(kind==='render'?{subtitles}:{})});
    }
    if(action==='share'){
      const url=new URL(localUrl(session.generated.url),location.origin).href;
      $('share-url').value=url;$('share-system').hidden=typeof navigator.share!=='function';$('share-dialog').showModal();
    }
  }catch(e){notice(e.message);}
});
$('edit-cancel').onclick=()=>$('edit').close();$('edit-form').onsubmit=async event=>{event.preventDefault();const instruction=$('edit-instruction').value.trim();if(!instruction)return;$('edit').close();try{await submit('revise',{target:editTarget,instruction});}catch(e){notice(e.message);}};
$('advanced').onclick=async()=>{try{if(!session){location.href=localUrl('/index.html#canvas');return;}if(busy())return;const r=await api('/api/mv-director/canvas',{session_id:session.id});location.href=localUrl(r.url);}catch(e){notice(e.message);}};
$('share-close').onclick=()=>$('share-dialog').close();
$('share-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('share-url').value);notice('MV链接已复制');}catch{$('share-url').select();notice('请复制选中的链接');}};
$('share-system').onclick=async()=>{try{await navigator.share({title:session.title+' · Osmanthus MV',url:$('share-url').value});}catch(e){if(e.name!=='AbortError')notice('系统分享未完成，可以复制链接。');}};
$('music-back').href=$('music-home').href=musicUrl();
try{
  const params=new URLSearchParams(location.search);
  if(params.get('session'))session=(await api('/api/mv-director/'+params.get('session'))).session;
  else if(params.get('music')){const imported=await api('/api/music-import',{handoff_id:params.get('music')});session=(await api('/api/mv-director/open',{project_id:imported.project.id})).session;}
  else if(params.get('project'))session=(await api('/api/mv-director/open',{project_id:params.get('project')})).session;
  if(session){
    history.replaceState(null,'',localUrl('/director.html')+'?session='+session.id);audio.src=localUrl(session.source.url);selection=session.range||selection;idea=session.idea||'';ratio=session.ratio||ratio;
    if(session.references?.length){const library=(await api('/api/materials')).materials;references=library.filter(r=>session.references.includes(r.id));}
    subtitles=session.subtitles??session.generated?.subtitles??session.outputs.at(-1)?.subtitles??false;step=session.generated?'result':session.plan?'plan':'range';render();if(session.activeJob||session.lastJob)await receive((await api('/api/mv-director/jobs/'+(session.activeJob||session.lastJob))).job);
  }else{$('advanced').hidden=false;const library=(await api('/api/mv-director')).sessions;$('app').innerHTML=`<h1>我的 MV</h1><p>从音乐作品点击「创作 MV」，歌曲和歌词会自动带入。</p><a class="primary" style="display:inline-block;padding:12px 18px;border-radius:10px;margin-bottom:24px" href="${esc(musicUrl())}">选择一首歌曲</a><div class="library">${library.map(s=>`<a href="${esc(localUrl('/director.html'))}?session=${s.id}"><strong>${esc(s.title)}</strong><span>${s.generated?'已有成片':s.plan?'方案已保存':'待选择音乐范围'}</span></a>`).join('')}</div>`;}
}catch(e){$('app').innerHTML=`<h1>暂时无法打开这首歌</h1><p>${esc(e.message)}</p><a href="${esc(musicUrl())}">返回音乐工作台</a>`;}
window.APP_READY=true;
