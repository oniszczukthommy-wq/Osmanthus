import {localUrl} from './integration.js';
import {esc} from './ui-parts.js';

const copy=x=>JSON.parse(JSON.stringify(x));
const done=new Set(['ready','failed','uncertain']);
/** The formal MV flow uses generated shots; no preset code animation is invoked. */
export function mountAIMVPanel({bridge,onPlan=()=>{},onJob=()=>{},getShots=plan=>plan.shots}){
 const dialog=document.createElement('dialog');dialog.className='aimv-dialog';dialog.setAttribute('aria-label','AI分镜与成片');document.body.append(dialog);
 let origin=null,plan=null,job=null,busy=false,timer=null,request=null,lastApplied=null;
 const $=s=>dialog.querySelector(s);
 const capability=()=>bridge.capabilities()?.aliyunVideo||{};
 function render(){
  const p=bridge.read(),available=capability().available;
  const oldText=$('[name=idea]')?.value,oldStart=$('[name=start]')?.value,oldDuration=$('[name=duration]')?.value;
  const active=job&&!done.has(job.status);
  dialog.innerHTML=`<header><div><small>Osmanthus · 阿里万相</small><h2>AI 分镜与成片</h2></div><button data-aimv="close" aria-label="返回画布">✕</button></header>
   <p class="aimv-source">${esc(p.title)} · 原歌曲音频</p>
   <div class="aimv-fields"><label>创作想法<textarea name="idea" rows="3" maxlength="2000" ${busy||active?'disabled':''} placeholder="描述主体、场景、情绪与镜头…">${esc(oldText??p.studio?.prompt??'')}</textarea></label><div><label>音乐起点（秒）<input name="start" type="number" min="0" step="0.1" max="${Math.max(0,p.source.duration-5)}" value="${esc(oldStart??String(p.start))}" ${busy||active?'disabled':''}></label><label>本次验证时长<select name="duration" ${busy||active?'disabled':''}><option value="5" ${(oldDuration||String(plan?.duration||10))==='5'?'selected':''}>5 秒 · 1 个镜头</option><option value="10" ${(oldDuration||String(plan?.duration||10))==='10'?'selected':''}>10 秒 · 2 个镜头</option></select></label></div><p class="aimv-note">先验证短片流程；分镜可以修改，生成后保留原歌曲作为音轨。</p></div>
   <div class="aimv-actions"><button class="secondary" data-aimv="plan" ${busy||active||!bridge.capabilities()?.deepseek?'disabled':''}>${busy?'正在处理…':plan?'重新规划分镜':'生成 AI 分镜'}</button><span>${available?`${esc(capability().model||'万相')} · 约 ¥${Number(capability().estimatedCostCny||1.2).toFixed(2)} / 5 秒`:'阿里视频接口未配置'}</span></div>
   ${plan?`<section class="aimv-plan"><h3>${esc(plan.summary||'分镜方案')}</h3><p>${esc(plan.visualBible||'')}</p>${getShots(plan).map((s,i)=>`<article><label>镜头 ${i+1} · ${s.start}–${s.end} 秒<input data-aimv-label="${esc(s.id)}" maxlength="100" value="${esc(s.label)}" ${active?'disabled':''}></label><textarea data-aimv-prompt="${esc(s.id)}" rows="3" maxlength="${capability().maxPromptChars||800}" aria-label="镜头${i+1}提示词" ${active?'disabled':''}>${esc(s.prompt)}</textarea></article>`).join('')}<div class="aimv-actions"><button data-aimv="generate" class="primary" ${busy||active||!available?'disabled':''}>${active?'AI 镜头生成中…':'生成镜头并合成 MV'}</button><span>最多约 ¥${(Number(capability().estimatedCostCny||1.2)*plan.shots.length).toFixed(2)}；未修改的镜头自动复用，费用以阿里账单为准</span></div></section>`:''}
   <section class="aimv-progress" aria-live="polite">${job?`<p>${esc(job.message||job.status)}</p><progress max="100" value="${job.progress||0}"></progress>${job.shots?.map((s,i)=>`<span>镜头 ${i+1}：${esc(({queued:'等待',submitting:'提交中',pending:'等待模型',running:'生成中',processing:'生成中',ready:'已完成',failed:'失败',uncertain:'状态待核对',download_failed:'已生成，正在恢复下载',downloading:'下载中'})[s.status]||s.status)}</span>`).join('')||''}${job.status==='ready'?`<video controls playsinline src="${esc(localUrl(job.generated.url))}"></video><div class="aimv-actions"><a class="primary" href="${esc(localUrl(job.generated.url))}" download="${esc(p.title)}-MV.mp4">下载 MP4</a><button class="secondary" data-aimv="apply">放入当前画布</button></div>`:''}${['failed','uncertain'].includes(job.status)?'<p>已有任务记录已保留。未自动重复提交收费任务。</p>':''}`:'<p>分镜确认后，AI 会逐镜生成视频，再合成原曲。</p>'}</section>`;
 }
 async function receive(next){
  if(!next||next.project_id!==origin||bridge.read().id!==origin)return;
  job=next;
  if(next.status==='ready'&&lastApplied!==next.id&&bridge.read().id===next.project_id){
   // A saved video remains downloadable if applying it to the canvas fails
   // (for example during a local service restart). Never hide the ready job
   // behind the previous generating state or submit another paid generation.
   try{if(await bridge.applyAIResult(next)){onJob(next);lastApplied=next.id;}}
   catch(error){bridge.toast(error.message);}
  }
  if(dialog.open&&origin===bridge.read().id)render();
  if(!done.has(next.status))schedule();
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{try{if(!job||done.has(job.status))return;const next=await bridge.aiMVJob(job.id);await receive(next);}catch(e){if(dialog.open)bridge.toast(e.message);schedule();}},5000);}
 async function open({autoPlan=false}={}){
  if(bridge.read().source.id==='sample')return bridge.toast('请先上传音乐或从歌曲进入 MV');
  const p=bridge.read(),requestedOrigin=p.id;if(p.id!==origin){clearTimeout(timer);origin=p.id;plan=copy(p.studio?.aiMVPlan||null);job=null;request=null;lastApplied=p.generated?.jobId||null;dialog.innerHTML='';}
  render();if(!dialog.open)dialog.showModal();
  try{const jobs=await bridge.aiMVJobs();if(requestedOrigin!==origin||origin!==bridge.read().id)return;if(jobs[0])await receive(jobs[0]);if(autoPlan&&!plan&&!job&&!busy&&$('[name=idea]').value.trim())$('[data-aimv=plan]').click();}catch(e){bridge.toast(e.message);}
 }
 function edits(){return plan.shots.map(s=>({id:s.id,label:$(`[data-aimv-label="${CSS.escape(String(s.id))}"]`)?.value||s.label,prompt:$(`[data-aimv-prompt="${CSS.escape(String(s.id))}"]`)?.value||s.prompt}));}
 dialog.addEventListener('click',async e=>{
  const action=e.target.closest('[data-aimv]')?.dataset.aimv;if(!action)return;
  if(action==='close'){dialog.querySelector('video')?.pause();dialog.close();return;}
  if(busy)return;
  if(action==='apply'){if(await bridge.applyAIResult(job)){onJob(job);lastApplied=job.id;dialog.close();}return;}
  busy=true;
  try{
   if(origin!==bridge.read().id)throw Error('歌曲工程已切换，请重新打开创作面板');
   if(action==='plan'){
    const input={instruction:$('[name=idea]').value.trim(),start:Number($('[name=start]').value),duration:Number($('[name=duration]').value)};
    if(!input.instruction)throw Error('先描述一下想创作的 MV');
    const key=JSON.stringify([origin,input]);if(request?.key!==key)request={key,id:crypto.randomUUID()};render();
    const result=await bridge.aiMVPlan({...input,request_id:request.id});if(result.plan.project_id!==origin||origin!==bridge.read().id)throw Error('工程已切换，分镜结果已保留');plan=result.plan;job=null;onPlan(plan);request=null;
   }
   if(action==='generate'){
    const shots=edits();plan={...plan,shots:plan.shots.map((s,i)=>({...s,...shots[i]}))};onPlan(plan);await bridge.flushSave();
    const key=JSON.stringify([origin,plan.id,shots]);if(request?.key!==key)request={key,id:crypto.randomUUID()};render();
    await receive(await bridge.aiMVStart({request_id:request.id,plan_id:plan.id,shots}));request=null;
   }
  }catch(err){if(action==='plan'&&err.uncertain===false)request=null;bridge.toast(err.message);}finally{busy=false;if(dialog.open)render();}
 });
 dialog.addEventListener('close',()=>dialog.querySelector('video')?.pause());
 return{open,close(){dialog.close();},get plan(){return copy(plan);},destroy(){clearTimeout(timer);dialog.remove();}};
}
