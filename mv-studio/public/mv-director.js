import {localUrl,musicUrl} from './integration.js';
import {selectMusicRange,timedLyrics,affectedShots,DIRECTOR_RATIOS} from './mv-director-domain.js';
import {icon,hydrateIcons} from './icons.js';
import {mountDirectorPlayer} from './mv-director-player.js';
import {startPromptSuggestions} from './prompt-suggestions.js';
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=n=>`${Math.floor(n/60)}:${(n%60).toFixed(1).padStart(4,'0')}`;
const api=async(route,body)=>{const res=await fetch(localUrl(route),body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await res.json();if(!res.ok)throw Error(result.error||'操作未完成');return result;};
let session=null,step='range',selection={mode:'full'},idea='',ratio='16:9',references=[],currentJob=null,jobChain=[],jobChainError='',poll=null,submitting=false,quoting=false,previewEnd=null,editTarget=null,subtitles=false;
let cost=null,costKey='',costLoadingKey='',costError='';
let ideaSuggestions=null;
const audio=$('music');const done=new Set(['ready','failed','uncertain']);
const player=mountDirectorPlayer(audio,{onError:message=>notice(message)});
hydrateIcons();
const project=()=>({source:session.source,lyrics:session.lyrics});
const busy=()=>submitting||quoting||(currentJob&&!done.has(currentJob.status));
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('notice').hidden=true,7000);}
function range(){return selectMusicRange(project(),selection);}
function chosen(){try{return range();}catch{return null;}}
const sessionStamp=()=>session?session.id+':'+session.updatedAt:'';
const money=n=>Number.isFinite(n)?'¥'+n.toFixed(2):'未设置';
function renderCost(){
  const host=$('cost-overview');if(!host)return;
  const known=cost&&costKey===sessionStamp(),working=busy();
  const shortfall=known?Object.values(cost.budgets).some(b=>b.shortfallCny>0):false;
  host.innerHTML=working?'<p>制作进行中，完成后更新剩余费用。</p>':known?`<h2>完成当前方案的预计费用</h2><div class="cost-grid"><div><span>图片 · ${cost.images} 张待制作</span><strong>${money(cost.imageCost)}</strong></div><div><span>视频 · ${cost.shots} 个镜头待制作</span><strong>${money(cost.videoCost)}</strong></div><div><span>合计</span><strong>${money(cost.total)}</strong></div></div><p class="hint">已完成且未修改的 ${cost.reusedImages} 张图片、${cost.reusedShots} 个镜头可复用。少量方案文字费用另计，以实际服务账单为准。</p><p class="hint">当前制作额度：图片 ${money(cost.budgets.image.remainingCny)}，视频 ${money(cost.budgets.video.remainingCny)}。这不是账号余额。</p>${!cost.canComplete?`<p class="error">${shortfall?'当前制作额度不足。方案已保存，可以缩短音乐范围后重新规划。':'生成服务暂不可用，方案已保存。'}</p>`:''}<button data-action="refresh-cost">刷新费用</button>`:`<p>${costError?'暂时无法核对费用：'+esc(costError):'正在核对制作费用…'}</p>${costError?'<button data-action="refresh-cost">重新核对</button>':''}`;
  const previews=$('app').querySelector('[data-action=previews]'),generate=$('app').querySelector('[data-action=generate]');
  const missing=session.plan&&[...session.plan.characters,...session.plan.scenes,...session.plan.shots].some(x=>!session.previews[x.id]);
  if(previews)previews.disabled=!!(working||!missing||!known||!cost.canComplete);
  if(generate)generate.disabled=!!(working||missing||!known||!cost.canComplete);
}
async function refreshCost(force=false){
  if(!session?.plan||step!=='plan'||busy()){renderCost();return;}
  const key=sessionStamp();
  if(!force&&costKey===key){renderCost();return;}
  if(costLoadingKey===key)return;
  costLoadingKey=key;cost=null;costKey='';costError='';renderCost();
  try{const result=await api(`/api/mv-director/${session.id}/quote?kind=complete`);if(sessionStamp()===key){cost=result.estimate;costKey=key;}}
  catch(e){if(sessionStamp()===key)costError=e.message;}
  finally{if(costLoadingKey===key)costLoadingKey='';renderCost();}
}
function heading(){return `<nav class="steps" aria-label="MV 创作步骤">${[['range','音乐与想法'],['plan','画面方案'],['result','预览与导出']].map(([key,label],index)=>`<button data-step="${key}" aria-current="${step===key?'step':'false'}" ${busy()||key!=='range'&&!session.plan?'disabled':''}><span class="step-number">${index+1}</span><span class="step-label">${label}</span></button>`).join('')}</nav>`;}
const SHOT_STATE={queued:'等待中',submitting:'提交中',pending:'等待处理',running:'生成中',processing:'生成中',downloading:'下载中',ready:'已完成',failed:'失败',uncertain:'待核对',unknown:'状态未知',canceled:'已取消',download_failed:'恢复下载'};
let shotRetryEnabled=false;
const IDEA_PRESETS={direction:[['叙事','创意方向：围绕人物经历和故事发展组织镜头。'],['概念','创意方向：围绕歌曲情绪和视觉意象组织镜头。']],style:[['电影感','视觉风格：电影质感、自然光影和细腻构图。'],['动画感','视觉风格：精致动画质感、柔和色彩和连贯场景。'],['复古','视觉风格：复古胶片质感、温暖色调和柔和颗粒。']]};
function presetButtons(type){const lines=new Set(idea.split(/\r?\n/));return IDEA_PRESETS[type].map(([label,value],i)=>`<button type="button" data-preset="${type}" data-preset-index="${i}" aria-pressed="${lines.has(value)}">${esc(label)}</button>`).join('');}
function syncIdeaPresets(){$('app').querySelectorAll('[data-preset]').forEach(button=>{const preset=IDEA_PRESETS[button.dataset.preset]?.[Number(button.dataset.presetIndex)];button.setAttribute('aria-pressed',String(!!preset&&idea.split(/\r?\n/).includes(preset[1])));});}
function applyIdeaPreset(type,index){
  const options=IDEA_PRESETS[type],choice=options?.[index];if(!choice)return;
  const field=$('app').querySelector('textarea[name=idea]');if(!field)return;
  const choices=new Set(options.map(([,value])=>value));
  const base=field.value.split(/\r?\n/).filter(line=>!choices.has(line)).join('\n');
  const next=base+(base&&!base.endsWith('\n')?'\n':'')+choice[1];
  if(next.length>3000){notice('创意内容已接近长度上限，请先精简后再使用快捷选项。');return;}
  idea=next;field.value=next;field.dispatchEvent(new Event('input',{bubbles:true}));
  syncIdeaPresets();
}
function elapsedLabel(from){const started=Date.parse(from||'');if(!Number.isFinite(started))return '';const seconds=Math.max(0,Math.round((Date.now()-started)/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function renderProgress(){
  const host=$('progress');if(!host)return;
  if(!currentJob){host.hidden=true;host.innerHTML='';return;}
  host.hidden=currentJob.status==='ready';
  const failed=['failed','uncertain'].includes(currentJob.status);
  const elapsed=elapsedLabel(currentJob.createdAt);
  const shots=Array.isArray(currentJob.shots)&&currentJob.shots.length
    ?`<div class="shot-states">${currentJob.shots.map((shot,index)=>`<span class="${esc(shot.status||'queued')}">镜头 ${index+1} · ${esc(SHOT_STATE[shot.status]||shot.status||'等待中')}</span>`).join('')}</div>`
    :'';
  const bar=done.has(currentJob.status)?'':`<progress max="100" value="${currentJob.progress||0}"></progress>`;
  const wait=elapsed?`<small>${currentJob.status==='running'?'已等待':'耗时'} ${elapsed}。可以离开页面，回来后继续查看。</small>`:'';
  const recover=currentJob.status==='failed'&&['preview','render'].includes(currentJob.kind)?'<button data-action="recover">恢复已有任务</button>':'';
  const hint=currentJob.status==='running'?'视频生成由服务商排队处理，通常需要数分钟到二十分钟不等。':'';
  host.innerHTML=`<p class="${failed?'error':''}">${esc(currentJob.message)}</p><small>当前任务：${esc(currentJob.id)} · 状态：${esc(currentJob.status)}</small>${shots}${bar}${wait}${hint?`<small>${esc(hint)}</small>`:''}${recover}`;
  document.querySelectorAll('[data-director-shot-status]').forEach(node=>{
    const shot=(currentJob.shots||[]).find(item=>item.id===node.dataset.directorShotStatus);
    if(!shot)return;
    node.textContent=SHOT_STATE[shot.status]||shot.status||'等待中';
    node.dataset.status=shot.status||'queued';
    const ref=node.closest('.director-card')?.querySelector('[data-director-shot-ref]');if(ref)ref.textContent=`任务 ${currentJob.id} · 状态 ${shot.status||'queued'}`;
    if(shot.status==='ready'&&/^[a-f0-9-]{36}$/i.test(shot.taskId||'')){
      const visual=node.closest('.director-card')?.querySelector('.card-visual');
      if(visual&&!visual.querySelector('video')){
        visual.querySelector('img,.placeholder')?.remove();
        const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='metadata';
        video.src=localUrl('/files/aliyun-video/'+shot.taskId+'/video.mp4');video.setAttribute('aria-label','镜头视频预览');visual.prepend(video);
      }
    }
  });
}
function render(){
  if(!session)return;const disabled=busy()?'disabled':'';
  document.body.classList.add('has-song');$('nav-current-mv').hidden=false;$('nav-current-mv').href=localUrl('/director.html')+'?session='+session.id+'#app';$('nav-current-mv').setAttribute('aria-current','page');$('nav-mv-library').removeAttribute('aria-current');$('view-title').textContent='创作 MV';
  $('advanced').hidden=false;$('advanced').disabled=!!busy();$('song-bar').hidden=false;$('song-title').textContent=session.title;$('song-info').textContent=`${time(session.source.duration)} · MV 配乐`;player.setDuration(session.source.duration);
  let content='';
  if(step==='range'){
    const lines=timedLyrics(project()),r=chosen();
    content=`<div class="page-intro"><h1>让这首歌，拥有画面</h1><p>选好音乐，写下画面想法。角色、场景与镜头会一起出现在方案里。</p></div><div class="split"><section class="panel"><h2>想制作哪一段？</h2><div class="choices">${[['full','整首歌曲'],['lyrics','选歌词'],['range','选时间']].map(([mode,label])=>`<button data-mode="${mode}" aria-pressed="${selection.mode===mode}" ${disabled}>${label}</button>`).join('')}</div>
    ${selection.mode==='lyrics'?(lines.length?`<div class="lyrics">${lines.map((line,i)=>`<label class="lyric ${i>=selection.from&&i<=selection.to?'selected':''}" data-line="${i}"><input type="checkbox" data-lyric="${i}" ${i>=selection.from&&i<=selection.to?'checked':''} ${disabled}><span>${esc(line.text)}</span><small>${time(line.start)}</small></label>`).join('')}</div>`:`<div class="manual-lyrics"><label>歌词（每行一句）<textarea name="manual-lyrics" rows="6" maxlength="12000" placeholder="把歌词按行粘贴进来，例如：&#10;雨夜慢慢走回家&#10;风把委屈都吹散" ${disabled}></textarea></label><div class="range-fields"><label>起始（秒）<input name="manual-start" type="number" step="0.1" min="0" value="0" ${disabled}></label><label>覆盖总时长（秒）<input name="manual-span" type="number" step="0.1" min="1" value="${Math.min(30,session.source.duration).toFixed(1)}" ${disabled}></label></div><div class="actions"><button data-action="apply-lyrics" ${disabled}>应用歌词时间轴</button></div><p class="hint">这台机器没有歌词对齐引擎，所以先按你给的起止范围把每行歌词平均铺开，之后就能按歌词选段。</p></div>`):selection.mode==='full'?'<p>包含歌曲的前奏、间奏和尾奏。</p>':''}
    ${!lines.length&&selection.mode!=='lyrics'?'<p class="hint">这首歌还没有可用的歌词时间轴，可以手动填入，或按时间选段。</p>':''}
    ${selection.mode!=='full'?`<div class="range-fields"><label>开始（秒）<input name="start" type="number" step="0.1" min="0" value="${r?.start??selection.start??0}" ${disabled}></label><label>结束（秒）<input name="end" type="number" step="0.1" max="${session.source.duration}" value="${r?.end??selection.end??Math.min(15,session.source.duration)}" ${disabled}></label></div>`:''}
    <div class="actions"><button data-action="listen-range" ${!r?'disabled':''}>${icon('play')}试听选段</button><span id="range-summary">${r?`${time(r.start)}—${time(r.end)} · ${r.duration.toFixed(1)} 秒`:'请选择连续歌词或有效时间范围'}</span></div></section>
    <section class="panel"><h2>画面想法</h2><div class="idea-presets"><span>创意方向</span><div role="group" aria-label="创意方向快捷选项">${presetButtons('direction')}</div><span>视觉风格</span><div role="group" aria-label="视觉风格快捷选项">${presetButtons('style')}</div></div><label>你想看到怎样的 MV？<textarea name="idea" maxlength="3000" rows="5" placeholder="例如：雨夜重逢的故事，电影感，温暖的结尾。也可以留空，让 AI 自由发挥。" ${disabled}>${esc(idea)}</textarea></label><div class="range-fields"><label>画面比例<select name="ratio" ${disabled}>${DIRECTOR_RATIOS.map(r=>`<option ${r===ratio?'selected':''}>${r}</option>`).join('')}</select></label><label>参考图片（可选，最多 3 张）<input id="reference-upload" type="file" accept="image/png,image/jpeg,image/webp" multiple ${disabled}></label></div><div class="references">${references.map((r,i)=>`<div><img src="${esc(localUrl(r.url))}" alt="参考图 ${i+1}"><button data-remove-reference="${i}" ${disabled}>移除</button></div>`).join('')}</div><div class="actions"><button class="primary" data-action="prepare" ${disabled||!r?'disabled':''}>设计 MV 方案</button></div><p class="hint">先设计方案，再确认图片与视频的制作消耗。</p></section></div>`;
  }else if(step==='plan'&&session.plan){
    const plan=session.plan,all=[...plan.characters,...plan.scenes,...plan.shots],missing=all.filter(x=>!session.previews[x.id]).length;
    const byId=(list,id)=>list.find(item=>item.id===id)?.name||'';
    const shotRecord=shot=>{for(const job of jobChain){if(!['render','retry-shot'].includes(job.kind)||job.session_id!==session.id||job.revision!==session.revision)continue;const task=(job.shots||[]).find(item=>item.id===shot.id);if(task)return{job,task};}return null;};
    const renderJob=jobChain.find(job=>job.kind==='render'&&job.session_id===session.id&&job.revision===session.revision);
    const card=item=>{
      const isShot=item.start!==undefined, record=isShot?shotRecord(item):null,task=record?.task;
      const readyVideo=task?.status==='ready'&&/^[a-f0-9-]{36}$/i.test(task.taskId||'');
      const visual=readyVideo?`<video controls playsinline preload="metadata" src="${esc(localUrl('/files/aliyun-video/'+task.taskId+'/video.mp4'))}" aria-label="${esc(item.name)}的视频预览"></video>`:session.previews[item.id]?`<img loading="lazy" src="${esc(localUrl(session.previews[item.id].url))}" alt="${esc(item.name)}">`:`<div class="placeholder">${icon('film')}<span>等待制作预览图</span></div>`;
      const state=task?(SHOT_STATE[task.status]||task.status||'等待中'):(session.previews[item.id]?'预览图已准备':'待制作预览图');
      const associations=isShot?[byId(plan.scenes,item.sceneId),...(item.characterIds||[]).map(id=>byId(plan.characters,id))].filter(Boolean).join(' · '):'';
      const retry=shotRetryEnabled&&isShot&&record?.job.status==='failed'&&task?.status==='failed'&&!busy()?`<button data-retry-shot="${esc(item.id)}" data-failed-job="${esc(record.job.id)}">核对费用并重试</button>`:'';
      const taskRef=isShot&&record?`<small class="director-task-ref" data-director-shot-ref>任务 ${esc(record.job.id)} · 状态 ${esc(task.status||'queued')}</small>`:'';
      return `<article class="card director-card ${isShot?'director-shot':''}" id="card-${esc(item.id)}"><div class="card-visual">${visual}${isShot?`<span class="shot-index">镜头 ${String(plan.shots.indexOf(item)+1).padStart(2,'0')}</span>`:''}</div><div class="body"><div class="director-card-heading"><h3>${esc(item.name)}</h3><span class="director-status" ${isShot?`data-director-shot-status="${esc(item.id)}" data-status="${esc(task?.status||'queued')}"`:''}>${esc(state)}</span></div>${isShot?`<small>${time(item.start)}—${time(item.end)}${associations?' · '+esc(associations):''}</small><p class="director-lyric">${esc((item.lyrics||[]).map(l=>l.text).join(' / ')||'前奏、间奏或无歌词片段')}</p>${taskRef}`:''}<p>${esc(item.description)}</p><div class="actions">${isShot?`<button data-listen="${esc(item.id)}">${icon('play')}试听对应音乐</button>`:''}<button data-edit="${esc(item.id)}" ${disabled}>${icon('edit')}修改</button>${retry}</div></div></article>`;
    };
    const scriptRows=plan.shots.map((shot,i)=>`<tr><th scope="row"><span class="director-number">${String(i+1).padStart(2,'0')}</span><br>${time(shot.start)}—${time(shot.end)}</th><td>${esc((shot.lyrics||[]).map(line=>line.text).join(' / ')||'前奏、间奏或无歌词片段')}</td><td><strong>${esc(shot.name)}</strong><p>${esc(shot.description)}</p><button data-edit="${esc(shot.id)}" ${disabled}>${icon('edit')}修改镜头</button></td><td>${esc(byId(plan.scenes,shot.sceneId)||'—')}</td><td>${esc((shot.characterIds||[]).map(id=>byId(plan.characters,id)).filter(Boolean).join('、')||'—')}</td></tr>`).join('');
    content=`<div class="director-flow"><div class="page-intro director-intro"><span class="director-kicker">OSMANTHUS · MV WORKSPACE</span><h1>让音乐，变成看得见的故事</h1><p>从音乐到画面，一步一步完成你的 MV。</p></div>
    <section class="director-stage panel" id="director-blueprint"><div class="director-stage-heading"><div><span class="director-kicker">01 · 音乐与创意</span><h2>你的 MV 创意蓝图</h2></div><span class="director-stage-badge">方案已准备</span></div><p class="director-summary">${esc(plan.summary)}</p><div class="director-blueprint-meta"><span>${time(session.range.start)}—${time(session.range.end)}</span><span>${plan.shots.length} 个镜头</span><span>${esc(session.ratio)}</span><span>${esc(plan.style)}</span></div><div class="actions"><button data-edit="all" ${disabled}>${icon('edit')}修改整体方向</button><button data-step="range" ${disabled}>调整音乐选段</button></div></section>
    <section class="director-stage panel" id="director-script"><div class="director-stage-heading"><div><span class="director-kicker">02 · 创意脚本</span><h2>让每一句歌词都有画面</h2></div><span class="director-stage-badge">${plan.shots.length} 个镜头</span></div><p class="hint">时间以原歌曲为准；修改角色、场景或镜头会保留其他部分。</p><div class="director-table-wrap"><table class="director-table"><thead><tr><th>时间</th><th>歌词</th><th>画面与镜头</th><th>场景</th><th>角色</th></tr></thead><tbody>${scriptRows}</tbody></table></div></section>
    <section class="director-stage panel" id="director-assets"><div class="director-stage-heading"><div><span class="director-kicker">03 · 视觉素材</span><h2>角色与场景</h2></div><span class="director-stage-badge">${missing?`还有 ${missing} 张预览待制作`:'预览图已准备'}</span></div><p class="hint">角色和场景作为分镜参考，保持画面之间的关联。</p>${plan.characters.length?`<div class="section-head"><h3>角色</h3></div><div class="cards">${plan.characters.map(card).join('')}</div>`:'<p class="hint">这份方案以场景和视觉表达为主，无需人物。</p>'}<div class="section-head"><h3>场景</h3></div><div class="cards">${plan.scenes.map(card).join('')}</div><div class="actions"><button data-action="previews" class="${missing?'primary':''}" ${disabled||!missing?'disabled':''}>${missing?`制作 ${missing} 张预览图`:'预览图已齐全'}</button></div></section>
    <section class="director-stage panel" id="director-storyboard"><div class="director-stage-heading"><div><span class="director-kicker">04 · 故事板</span><h2>分镜与音乐</h2></div><span class="director-stage-badge">${plan.shots.length} 个镜头</span></div><p class="hint">逐镜查看画面与对应音乐，确认预览图后制作视频。</p><div class="cards shot-cards">${plan.shots.map(card).join('')}</div></section>
    <section id="cost-overview" class="director-stage panel" aria-live="polite"></section>
    <section class="director-stage panel director-finish"><div class="director-stage-heading"><div><span class="director-kicker">05 · 生成与成片</span><h2>准备制作你的 MV</h2></div></div><label class="check"><input type="checkbox" name="subtitles" ${subtitles?'checked':''} ${!session.lyrics.length||busy()?'disabled':''}>加入歌词字幕</label><div class="actions"><button data-action="generate" class="primary" ${disabled||missing?'disabled':''}>确认方案，生成 MV</button><span>${missing?'请先查看全部预览图，再生成视频':'仅重新制作有变化的镜头'}</span></div>${shotRetryEnabled&&currentJob?.kind==='retry-shot'&&currentJob.status==='ready'&&renderJob?.status==='failed'?`<div class="director-recovery"><p>单镜重试已完成，原视频任务 ${esc(renderJob.id)} · 状态 ${esc(renderJob.status)}。继续原任务可能生成尚未完成的镜头并合成成片。</p><button data-action="continue-render" data-render-job="${esc(renderJob.id)}" ${disabled}>核对剩余费用并继续原任务</button></div>`:jobChainError?`<p class="error">${esc(jobChainError)}</p>`:''}<p class="hint">制作前会再次确认预计费用。已完成的旧成片会保留。</p></section></div>`;
  }else{
    const output=session.generated;
    content=`<div class="page-intro"><h1>${output?'你的 MV':'成片与历史版本'}</h1><p>${esc(session.title)}</p></div>${output?`<video class="output-video" id="result-video" controls playsinline preload="metadata" src="${esc(localUrl(output.url))}"></video><div class="actions result-actions"><a class="button-link primary" href="${esc(localUrl(output.url))}" download="${esc(session.title)}-MV.mp4">${icon('download')}下载 MP4</a><button data-action="share">${icon('link')}分享 MV</button><button data-step="plan" ${disabled}>${icon('edit')}修改画面</button><span>${time(output.duration)} · ${esc(session.ratio)}</span></div>`:'<p>确认方案后即可制作。已完成的旧版本会继续保留。</p>'}${session.outputs.length?`<div class="history"><h2>历史版本</h2>${[...session.outputs].reverse().map((x,i)=>`<a href="${esc(localUrl(x.url))}" download="${esc(session.title)}-MV-${i+1}.mp4">${icon('history')}<span>版本 ${session.outputs.length-i} · ${esc(new Date(x.createdAt).toLocaleString())}</span><small>MP4</small>${icon('download')}</a>`).join('')}</div>`:''}`;
  }
  ideaSuggestions?.destroy();$('app').innerHTML=heading()+'<section id="progress" class="progress" aria-live="polite" hidden></section>'+content;ideaSuggestions=startPromptSuggestions($('app').querySelector('textarea[name=idea]'),['雨夜里一个人走回家，最后在窗边看到温暖的灯光','两个人在海边重逢，用电影感镜头记录他们的故事','跟随音乐穿过城市夜景，从孤独走向希望']);renderProgress();renderCost();void refreshCost();
}
async function detectShotRetry(){
  try{
    const capabilities=await api('/api/capabilities');shotRetryEnabled=capabilities.mvDirectorShotRetry===true;
    if(shotRetryEnabled&&session?.plan&&step==='plan'&&!busy()&&!$('confirm').open&&!$('edit').open&&jobChain.some(job=>['render','retry-shot'].includes(job.kind)))render();
  }catch{shotRetryEnabled=false;}
}
async function ask(title,body){$('confirm-title').textContent=title;$('confirm-body').innerHTML=body;$('confirm').showModal();return await new Promise(resolve=>$('confirm').addEventListener('close',()=>resolve($('confirm').returnValue==='ok'),{once:true}));}
async function syncJobChain(job){
  jobChainError='';
  if(job.kind!=='retry-shot'){jobChain=[job];return;}
  if(jobChain[0]?.id===job.id&&jobChain.length>1){jobChain=[job,...jobChain.slice(1)];return;}
  const result=[job],seen=new Set([job.id]);let current=job;
  try{
    while(current.kind==='retry-shot'){
      const id=current.input?.failed_job_id;
      if(!/^[a-f0-9-]{36}$/i.test(id||'')||seen.has(id)||result.length>=100)throw Error('无法追溯原任务');
      const previous=(await api('/api/mv-director/jobs/'+id)).job;
      if(!previous||previous.session_id!==session.id||previous.revision!==session.revision||!['render','retry-shot'].includes(previous.kind))throw Error('原任务与当前方案不一致');
      result.push(previous);seen.add(id);current=previous;
    }
    if(current.kind!=='render')throw Error('无法找到原视频任务');
    jobChain=result;
  }catch(e){jobChain=[job];jobChainError='无法读取原视频任务，请刷新后再继续。';}
}
async function receive(job){const previousProgress=currentJob?.progress;currentJob=job;await syncJobChain(job);if(!done.has(job.status)&&job.kind==='preview'&&previousProgress!==job.progress){session=(await api('/api/mv-director/'+session.id)).session;render();}renderProgress();if(done.has(job.status)){session=(await api('/api/mv-director/'+session.id)).session;if(job.kind==='retry-shot'||job.kind==='render'&&job.status!=='ready')step='plan';if(job.status==='ready'){if(['prepare','revise','preview'].includes(job.kind))step='plan';if(job.kind==='render')step='result';}render();return;}clearTimeout(poll);poll=setTimeout(async()=>{try{await receive((await api('/api/mv-director/jobs/'+job.id)).job);}catch(e){notice(e.message);poll=setTimeout(()=>receive(job),4000);}},2000);}
async function submit(kind,input){
  if(busy())return;submitting=true;audio.pause();render();
  const signature=JSON.stringify([session.id,session.revision,kind,input]),storage='osmanthus-mv-request:'+signature;let request_id=sessionStorage.getItem(storage);if(!request_id){request_id=crypto.randomUUID();sessionStorage.setItem(storage,request_id);}
  try{const result=await api('/api/mv-director/jobs',{session_id:session.id,revision:session.revision,kind,input,request_id});currentJob=result.job;session.activeJob=result.job.id;}finally{submitting=false;render();}
  if(currentJob&&!done.has(currentJob.status))$('progress').scrollIntoView({behavior:'smooth',block:'start'});await receive(currentJob);
}
async function listen(start,end){document.querySelectorAll('video').forEach(video=>video.pause());previewEnd=end;audio.currentTime=start;await audio.play();}
audio.addEventListener('timeupdate',()=>{if(previewEnd!==null&&audio.currentTime>=previewEnd){audio.pause();previewEnd=null;}const lines=session?timedLyrics(project()):[],active=lines.find(l=>audio.currentTime>=l.start&&audio.currentTime<l.end);$('playing-lyric').textContent=active?.text||'';document.querySelectorAll('[data-line]').forEach(el=>{const l=lines[Number(el.dataset.line)];el.classList.toggle('playing',l===active);});});
audio.addEventListener('play',()=>{if(!audio.paused)document.querySelectorAll('video').forEach(video=>video.pause());});
document.addEventListener('play',event=>{if(event.target instanceof HTMLVideoElement&&!event.target.paused){audio.pause();document.querySelectorAll('video').forEach(video=>{if(video!==event.target)video.pause();});}},true);
audio.addEventListener('seeking',()=>{if(previewEnd!==null&&audio.currentTime>previewEnd)previewEnd=null;});
$('app').addEventListener('input',event=>{const target=event.target;if(target.name==='idea'){idea=target.value;syncIdeaPresets();}});
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
    if(b.dataset.preset){applyIdeaPreset(b.dataset.preset,Number(b.dataset.presetIndex));return;}
    if(b.dataset.step){audio.pause();step=b.dataset.step;render();$('workspace-scroll').scrollTop=0;return;}
    if(b.dataset.mode){selection=b.dataset.mode==='range'?{mode:'range',start:0,end:Math.min(15,session.source.duration)}:{mode:b.dataset.mode};render();return;}
    if(b.dataset.removeReference!==undefined){references.splice(Number(b.dataset.removeReference),1);render();return;}
    if(b.dataset.listen){const shot=session.plan.shots.find(s=>s.id===b.dataset.listen);return await listen(shot.start,shot.end);}
    if(b.dataset.edit){editTarget=b.dataset.edit;const ids=affectedShots(session.plan,editTarget);$('edit-title').textContent=editTarget==='all'?'修改整体方向':'修改这部分画面';$('edit-impact').textContent=`将影响 ${ids.length} 个镜头：${session.plan.shots.filter(s=>ids.includes(s.id)).map(s=>s.name).join('、')}。歌曲与选段保持原样。`;$('edit-instruction').value='';$('edit').showModal();return;}
    if(b.dataset.retryShot){
      if(!shotRetryEnabled)return notice('单镜重试暂不可用。');
      if(busy())return;
      const shotId=b.dataset.retryShot,failedId=b.dataset.failedJob;
      const failedJob=jobChain.find(j=>j.id===failedId&&j.session_id===session.id&&j.revision===session.revision&&j.status==='failed');
      const failedShot=failedJob?.shots?.find(shot=>shot.id===shotId&&shot.status==='failed');
      if(!failedShot)return notice('此镜头的失败状态已变化，请刷新后核对。');
      quoting=true;render();
      try{
        const query=new URLSearchParams({job_id:failedId,shot_id:shotId});
        const q=(await api(`/api/mv-director/${session.id}/shot-retry-quote?${query}`)).estimate;
        if(!q?.canRetry)return notice(!q?.available?'视频生成服务暂不可用。':'当前视频额度不足，未提交重试。');
        const confirmed=await ask('确认重试此镜头',`<p>原失败任务：${esc(failedId)}。本次只重新制作该镜头，不会自动合成或重做其他镜头。</p><p>预计消耗 <strong>${money(q.total)}</strong>；当前视频制作额度 ${money(q.remainingCny)}。实际费用以服务商账单为准。</p>`);
        if(confirmed){quoting=false;await submit('retry-shot',{failed_job_id:failedId,shot_id:shotId,confirmed:true});}
      }finally{quoting=false;render();}
      return;
    }
    const action=b.dataset.action;
    if(action==='refresh-cost')return await refreshCost(true);
    if(action==='recover'){currentJob=(await api('/api/mv-director/recover',{job_id:currentJob.id})).job;render();return await receive(currentJob);}
    if(action==='continue-render'){
      if(!shotRetryEnabled)return notice('单镜重试暂不可用。');
      if(busy())return;
      const id=b.dataset.renderJob,original=jobChain.find(j=>j.id===id&&j.kind==='render'&&j.status==='failed'&&j.session_id===session.id&&j.revision===session.revision);
      if(!original)return notice('原视频任务状态已变化，请刷新后核对。');
      quoting=true;render();
      try{
        const fresh=(await api('/api/mv-director/jobs/'+id)).job;
        if(!fresh||fresh.status!=='failed'||fresh.kind!=='render'||fresh.session_id!==session.id||fresh.revision!==session.revision)throw Error('原视频任务状态已变化，请刷新后核对。');
        const complete=(await api(`/api/mv-director/${session.id}/quote?kind=complete`)).estimate;
        if(!complete?.canComplete)return notice('当前制作额度不足或服务暂不可用，原任务已保留。');
        const q=(await api(`/api/mv-director/${session.id}/quote?kind=render`)).estimate;
        const confirmed=await ask('确认继续原视频任务',`<p>原任务：${esc(id)}。将继续制作未完成的 ${esc(q.shots)} 个镜头，完成后合成 MV，并沿用原任务字幕设置。</p><p>剩余预计消耗 <strong>${money(q.total)}</strong>，已完成的镜头将复用。实际费用以服务商账单为准。</p>`);
        if(confirmed){quoting=false;currentJob=(await api('/api/mv-director/recover',{job_id:id,confirmed:true})).job;await receive(currentJob);}
      }finally{quoting=false;render();}
      return;
    }
    if(action==='listen-range'){const r=range();return await listen(r.start,r.end);}
    if(action==='apply-lyrics'){
      const host=$('app');
      const text=host.querySelector('[name=manual-lyrics]')?.value||'';
      const start=Number(host.querySelector('[name=manual-start]')?.value||0);
      const span=Number(host.querySelector('[name=manual-span]')?.value||0);
      try{
        const result=await api(`/api/mv-director/${session.id}/lyrics`,{text,start,span});
        session=result.session;selection={mode:'lyrics',from:0,to:0};render();
      }catch(e){notice(e.message);}
      return;
    }
    if(action==='prepare')return await submit('prepare',{selection,idea,ratio,references:references.map(r=>r.id)});
    if(action==='previews'||action==='generate'){
      const complete=(await api(`/api/mv-director/${session.id}/quote?kind=complete`)).estimate;
      cost=complete;costKey=sessionStamp();renderCost();
      if(!complete.canComplete)return notice('制作额度不足或服务暂不可用，方案已保存，请查看费用说明。');
      const kind=action==='previews'?'preview':'render',q=(await api(`/api/mv-director/${session.id}/quote?kind=${kind}`)).estimate;
      if(await ask(kind==='preview'?'制作方案预览图':'确认生成 MV',`<p>${kind==='preview'?`本次制作 ${q.images} 张图片`:`本次音乐 ${q.duration.toFixed(1)} 秒，需要生成 ${q.shots} 个镜头；其余镜头复用`}。</p><p>本次预计 <strong>¥${q.total.toFixed(2)}</strong>${kind==='preview'?`；后续视频预计 ${money(complete.videoCost)}，完成当前方案合计约 ${money(complete.total)}`:''}，以实际服务账单为准。</p>`))await submit(kind,{confirmed:true,...(kind==='render'?{subtitles}:{})});
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
$('music-back').href=$('music-home').href=$('nav-music-home').href=musicUrl();
$('nav-music-create').href=musicUrl({view:'create'});
$('nav-current-mv').onclick=event=>{event.preventDefault();$('workspace-scroll').scrollTo({top:0,behavior:'smooth'});};
function sidebar(collapsed){
  document.body.classList.toggle('is-sidebar-collapsed',collapsed);
  const b=$('sidebar-toggle'),label=collapsed?'展开侧边栏':'收起侧边栏';
  b.setAttribute('aria-expanded',String(!collapsed));b.setAttribute('aria-label',label);b.title=label;b.innerHTML=icon(collapsed?'panel-open':'panel-close');
}
try{sidebar(localStorage.getItem('osmanthus-mv-sidebar-collapsed')==='true');}catch{sidebar(false);}
$('sidebar-toggle').onclick=()=>{const collapsed=!document.body.classList.contains('is-sidebar-collapsed');sidebar(collapsed);try{localStorage.setItem('osmanthus-mv-sidebar-collapsed',String(collapsed));}catch{}};
try{
  const params=new URLSearchParams(location.search);
  if(params.get('session'))session=(await api('/api/mv-director/'+params.get('session'))).session;
  else if(params.get('music')){const imported=await api('/api/music-import',{handoff_id:params.get('music')});session=(await api('/api/mv-director/open',{project_id:imported.project.id})).session;}
  else if(params.get('project'))session=(await api('/api/mv-director/open',{project_id:params.get('project')})).session;
  if(session){
    history.replaceState(null,'',localUrl('/director.html')+'?session='+session.id);audio.src=localUrl(session.source.url);selection=session.range||selection;idea=session.idea||'';ratio=session.ratio||ratio;
    if(session.references?.length){const library=(await api('/api/materials')).materials;references=library.filter(r=>session.references.includes(r.id));}
    subtitles=session.subtitles??session.generated?.subtitles??session.outputs.at(-1)?.subtitles??false;step=session.generated?'result':session.plan?'plan':'range';render();if(session.activeJob||session.lastJob)await receive((await api('/api/mv-director/jobs/'+(session.activeJob||session.lastJob))).job);
  }else{
    $('advanced').hidden=false;$('nav-mv-library').setAttribute('aria-current','page');$('view-title').textContent='我的 MV';
    const library=(await api('/api/mv-director')).sessions;
    $('app').innerHTML=`<div class="library-heading"><div><h1>我的 MV</h1><p>把你的音乐，变成看得见的故事。</p></div><a class="button-link primary" href="${esc(musicUrl())}">${icon('plus')}选择一首歌曲</a></div><div class="library">${library.map(s=>{
      const preview=s.previews?.[s.plan?.shots?.[0]?.id]?.url||Object.values(s.previews||{}).find(p=>p.url)?.url;
      return `<a class="library-card" href="${esc(localUrl('/director.html'))}?session=${s.id}"><div class="library-art">${preview?`<img src="${esc(localUrl(preview))}" alt="${esc(s.title)}" loading="lazy">`:`<div class="placeholder">${icon('film')}</div>`}<span class="library-badge">${s.generated?'已有成片':s.plan?'方案已保存':'待设计'}</span></div><div class="library-copy"><strong>${esc(s.title)}</strong><small>${s.range?`${time(s.range.end-s.range.start)} · `:''}${esc(s.ratio||'16:9')} · ${s.generated?'继续查看':s.plan?'继续创作':'设计画面'}</small></div></a>`;
    }).join('')}</div>${library.length?'':'<section class="panel"><p>从音乐作品点击「创作 MV」，歌曲和歌词会自动带入。</p></section>'}`;
  }
}catch(e){$('app').innerHTML=`<div class="page-intro"><h1>暂时无法打开这首歌</h1><p>${esc(e.message)}</p></div><a class="button-link" href="${esc(musicUrl())}">${icon('back')}返回音乐工作台</a>`;}
window.APP_READY=true;void detectShotRetry();
