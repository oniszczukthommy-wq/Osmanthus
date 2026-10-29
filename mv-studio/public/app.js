import {localUrl,musicUrl} from './integration.js';
import {STORIES,STYLES,makeProject,makePlan,steps,switchMode,shotAt,changeStory,resizePlan,localEdit,clone,validateProject,SAMPLE_LYRICS} from './domain.js';
import {drawFrame as drawSourceFrame} from './renderer.js';
import {createOutputFrameDrawer,getOutputFormat} from './output-format.js';
import {createCanvasDocument,validateCanvasDocument} from './canvas-document.js';
import {validateCanvasDrawings} from './canvas-preferences.js';
import {icon,hydrateIcons} from './icons.js';
import {controlsMarkup,editorMarkup} from './ui-parts.js';
import {mountStudio} from './studio-ui.js';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),time=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
let project=makeProject(),caps={},current=0,selected=null,beforeEdit=null,comparison='after',sourceTab='upload',wave=[],rich=false,running=null,preparing=false,planAbort=null,planCancelled=false,saving=null,savingTask=null,dirty=false,lastResponse='',toastTimer,drawerOpen=false,drawerView='settings',returnFocus=null,studio=null,saveRevision=0,switching=false,assisting=false,materialUploading=false;
const audio=$('audio'),movie=$('movie'),canvas=$('preview');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const formattedDrawFrame=createOutputFrameDrawer(drawSourceFrame);
function sizeOutputCanvas(target,p,maxEdge=null){const format=getOutputFormat(p.studio?.ratio),scale=maxEdge===null?1:Math.min(1,maxEdge/Math.max(format.width,format.height));const width=Math.round(format.width*scale),height=Math.round(format.height*scale);if(target.width!==width)target.width=width;if(target.height!==height)target.height=height;if(target.style)target.style.aspectRatio=`${format.width} / ${format.height}`;return format;}
function drawFrame(target,p,t=0,options={}){const {fullSize=false,...drawOptions}=options;sizeOutputCanvas(target,p,fullSize||target===canvas?null:Math.max(target.width,target.height));return formattedDrawFrame(target,p,t,drawOptions);}
function validateClientProject(p){
 validateProject(p);getOutputFormat(p.studio?.ratio);if(p.studio?.canvas!=null)validateCanvasDocument(p.studio.canvas);validateCanvasDrawings(p.studio?.canvasDrawings??[]);
 if(typeof p.title!=='string'||!p.title.trim()||p.title.trim().length>120||/[\x00-\x1f\x7f]/.test(p.title))throw Error('画布名称需为1至120字的单行文字');
 if(!Number.isFinite(p.source.duration)||p.source.duration<3||p.source.duration>1200||typeof p.source.name!=='string')throw Error('工程音乐信息不完整');
 const expected=p.source.id==='sample'?'/assets/sample-song.mp3':`/files/uploads/${p.source.id}`;
 if(p.source.url!==expected&&p.source.url!==`/mv${expected}`)throw Error('工程音乐引用与原音频标识不一致');
 if(!Array.isArray(p.lyrics)||p.lyrics.length>12000||p.lyrics.some(l=>!l||!Number.isFinite(l.start)||!Number.isFinite(l.end)||l.start<0||l.end<=l.start||l.end>p.source.duration+.15||typeof l.text!=='string'))throw Error('歌词时间轴无效');
 if(typeof p.manualLyrics!=='string'||p.manualLyrics.length>12000)throw Error('歌词文字无效');
 if(p.generated&&(!/^\/(?:mv\/)?files\/jobs\/[a-f0-9-]{36}\/mv\.mp4$/.test(p.generated.url||'')||!Number.isFinite(p.generated.duration)))throw Error('成片文件引用无效');
 return true;
}
const api=async(url,options={})=>{const res=await fetch(localUrl(url),options),d=await res.json();if(!res.ok)throw Object.assign(Error(d.error||'操作没有完成，请再试一次'),d,{status:res.status});return d;};
const post=(url,d,method='POST')=>api(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),5500);}
function save(){if(!UUID.test(project.id||''))project.id=crypto.randomUUID();dirty=true;saveRevision++;clearTimeout(saving);saving=null;const automatic=project.studio?.canvasSettings?.autosave!==false;$('save-status').textContent=automatic?'保存中':'未保存';if(automatic)saving=setTimeout(()=>flushSave().catch(e=>toast(e.message)),260);}
async function flushSave(force=false){
 clearTimeout(saving);saving=null;while(savingTask){try{await savingTask}catch{}}
 if(!dirty&&!force)return true;
 if(!UUID.test(project.id||''))project.id=crypto.randomUUID();validateClientProject(project);
 const snapshot=clone(project),revision=saveRevision,task=post('/api/project',snapshot,'PUT');savingTask=task;$('save-status').textContent='保存中';
 try{await task;if(project.id===snapshot.id&&revision===saveRevision){dirty=false;$('save-status').textContent='已保存'}return true;}
 catch(error){$('save-status').textContent='尚未保存';throw error;}
 finally{if(savingTask===task)savingTask=null;}
}
function pause(){audio.pause();movie.pause();$('play-button').innerHTML=icon('play');$('center-play').hidden=false;}
const showingMovie=()=>!!project.generated?.url&&selected===null;
function source(){if(audio.getAttribute('src')!==localUrl(project.source.url)){audio.src=localUrl(project.source.url);audio.load();}}
function draw(t=current){current=Math.max(0,Math.min(project.duration-.001,t));const p=comparison==='before'&&beforeEdit?beforeEdit:project;const d=drawFrame(canvas,p,current,{subtitles:p.subtitles!==false});const mini=$('edit-preview');if(mini&&mini.getClientRects().length)drawFrame(mini,p,current,{subtitles:false});$('current-time').textContent=time(current);$('duration').textContent=time(project.duration);$('seek').max=project.duration;$('seek').value=current;const s=project.plan.shots.find(x=>x.id===d.shot);$('scene-label').textContent=`${String(s.id).padStart(2,'0')} · ${s.label}`;}
function updatePreview(){
 const format=getOutputFormat(project.studio?.ratio),wrap=canvas.closest('.canvas-wrap');if(wrap)wrap.style.aspectRatio=`${format.width} / ${format.height}`;movie.style.aspectRatio=`${format.width} / ${format.height}`;const formatLabel=document.querySelector('.preview-header>span:last-child');if(formatLabel)formatLabel.textContent=`${format.ratio} · ${format.width}×${format.height}`;
 const real=showingMovie();movie.hidden=!real;canvas.hidden=real;$('scene-label').hidden=real;
 if(real&&movie.getAttribute('src')!==localUrl(project.generated.url)){movie.src=localUrl(project.generated.url);movie.load();}
 $('preview-title').textContent=`${project.plan.title} · ${real?'已生成':'预览'}`;
 $('preview-note').textContent=real?'当前播放的是已导出的有声MP4，历史版本仍保留。':project.planningSource==='deepseek'?'已按歌词主题丰富镜头表达，当前为代码预览。':'当前为模板分镜预览，点击生成后可导出有声 MP4。';
 $('download-button').disabled=!project.generated?.url;
 $('subtitle-toggle').setAttribute('aria-pressed',project.subtitles!==false);
 draw();
}
function renderSteps(){const list=steps(project.mode);$('steps').innerHTML=list.map(([id,title],i)=>`<button class="step-button ${project.step===id?'active':''}" data-step="${id}" ${project.step===id?'aria-current="step"':''}>${i+1} ${title}</button>`).join('');$('mode-free').setAttribute('aria-pressed',project.mode==='free');$('mode-pro').setAttribute('aria-pressed',project.mode==='pro');}
const headings={music:['音乐','选择片段'],plan:['故事与画风','按你的想法调整'],story:['故事','选择一个故事'],characters:['人物与画风','全片保持一致'],shots:['分镜','选择一镜进行修改'],result:['成片','已保存的创作']};
function renderControls(){const box=$('control-panel');box.innerHTML=controlsMarkup(project,caps,{sourceTab,rich});wireControls();if(running||preparing)box.querySelectorAll('input,textarea,select,button').forEach(x=>x.disabled=true);}

function wireControls(){
 $('audio-upload')?.addEventListener('change',e=>upload(e.target.files[0]));const zone=$('upload-zone');if(zone){zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag')});zone.addEventListener('dragleave',()=>zone.classList.remove('drag'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag');upload(e.dataTransfer.files[0])});}
 $('clip-start')?.addEventListener('input',e=>{pause();project.start=Number(e.target.value);project.generated=null;current=0;$('start-label').textContent=time(project.start);$('end-label').textContent=time(project.start+project.duration);updatePreview();renderSummary();save()});
 $('rich-plan')?.addEventListener('change',e=>rich=e.target.checked);
 document.querySelectorAll('[data-name]').forEach(input=>input.addEventListener('input',e=>{project.plan.names[Number(input.dataset.name)]=e.target.value;project.generated=null;save()}));
 $('mother-young')?.addEventListener('change',e=>{project.plan.motherYoung=e.target.checked;project.generated=null;renderFilmstrip();updatePreview();renderSummary();save()});
}
function renderFilmstrip(){$('filmstrip').innerHTML=project.plan.shots.map(s=>`<button class="shot-card ${selected===s.id?'selected':''}" data-shot="${s.id}" aria-label="第${s.id}镜 ${esc(s.label)}" aria-pressed="${selected===s.id}"><canvas width="320" height="180" data-thumb="${s.id}"></canvas><div class="shot-text"><span>${String(s.id).padStart(2,'0')} · ${esc(s.label)}</span><small>${time(s.start)} – ${time(s.end)}</small></div></button>`).join('');document.querySelectorAll('[data-thumb]').forEach(cv=>{const s=project.plan.shots.find(x=>x.id===Number(cv.dataset.thumb));drawFrame(cv,project,s.start+(s.end-s.start)*.65,{subtitles:false});});}
function renderEditor(){const box=$('shot-editor');box.hidden=selected===null;if(selected===null)return;box.innerHTML=editorMarkup(project,selected,beforeEdit,comparison,lastResponse);}

function renderProcess(){$('process-panel').innerHTML=`<h3>创作过程 · 连线与参数由系统处理</h3><div class="process-nodes">${[['音乐与歌词','音频与已有歌词'],['故事与人物',project.planningSource==='deepseek'?'已丰富镜头表达':'已准备的故事方案'],['8幕分镜','可预览、可修改'],['镜头制作',project.mode==='pro'?'AI视频待连接':'代码渲染可用'],['音乐与字幕合成',project.generated?'已生成MP4':'等待生成']].map(([name,status],i)=>`${i?'<span class="process-arrow">→</span>':''}<div class="process-node">${name}<small>${status}</small></div>`).join('')}</div>`;}
function sourceMusicContext(){if(UUID.test(project.musicHandoff?.project_id||''))return project.musicHandoff;const origin=project.studio?.originMusicSnapshot;if(!UUID.test(origin?.project_id||'')||!/^[a-f0-9]{64}$/.test(origin.audio_sha256||''))return null;const hash=origin.audio_sha256,originalSourceId=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}.mp3`;return project.source.id===originalSourceId?origin:null;}
function sourceMusicUrl(){const context=sourceMusicContext();return musicUrl(context?{song:context.project_id,view:'detail'}:{});}
function renderSummary(){
 const link=$('back-to-music');if(link)link.href=sourceMusicUrl();
 $('project-title').textContent=project.title;
 $('source-meta').textContent=`${project.source.id==='sample'?'示例音乐':'已导入'} · ${time(project.start)}–${time(project.start+project.duration)}`;
 $('story-short').textContent=project.plan.title;$('style-short').textContent=STYLES.find(s=>s.id===project.plan.style).name;
 $('clip-short').textContent=Number.isInteger(project.duration)?`${project.duration}秒`:time(project.duration);
 $('provider-label').textContent=project.mode==='pro'?'AI视频待接通':'代码预览';
}
function syncDrawer(){
 const edit=drawerView==='edit'&&selected!==null,modal=drawerOpen&&(!edit||matchMedia('(max-width:750px)').matches);
 $('settings-drawer').hidden=!drawerOpen;$('drawer-backdrop').hidden=!modal;$('settings-drawer').setAttribute('aria-modal',modal);document.body.classList.toggle('drawer-open',modal);document.body.classList.toggle('editing',drawerOpen&&edit);
 $('workspace').inert=modal;document.querySelector('.topbar').inert=modal;for(const id of ['home-view','canvas-view','downloads-view'])$(id).inert=modal;
 $('control-panel').hidden=edit;$('steps').hidden=edit;$('advanced-details').hidden=edit;$('shot-editor').hidden=!edit||!drawerOpen;
 const h=edit?[project.plan.shots.find(s=>s.id===selected).label,`第${String(selected).padStart(2,'0')}镜`]:headings[project.step]||headings.music;
 $('stage-title').textContent=h[0];$('stage-description').textContent=h[1];
}
function render(){renderSummary();renderSteps();renderControls();renderFilmstrip();renderEditor();renderProcess();source();updatePreview();syncDrawer();$('generate-button').disabled=engineBusy()||!!(project.studio?.freeCanvas&&project.source.id==='sample');$('generate-button').innerHTML=icon('spark')+'生成 MP4';$('generate-button').title='生成有声代码视频，AI视频模型待接通';hydrateIcons();studio?.sync(project);}
function openDrawer(step){
 pause();if(!drawerOpen)returnFocus=document.activeElement;
 if(step!=='edit'){selected=null;project.step=step||project.step;drawerView='settings';}else drawerView='edit';
 drawerOpen=true;render();$('drawer-close').focus();draw();
}
function closeDrawer(){drawerOpen=false;selected=null;comparison='after';renderFilmstrip();updatePreview();syncDrawer();(returnFocus?.isConnected?returnFocus:$('settings-button')).focus();}
function chooseShot(id){pause();selected=id;comparison='after';current=project.plan.shots.find(s=>s.id===id).start+.15;$('timeline-panel').hidden=false;$('timeline-toggle').setAttribute('aria-expanded','true');openDrawer('edit');}

function engineBusy(){return !!running||preparing||switching||assisting||materialUploading;}
function requireIdle(){if(engineBusy())throw Error('请先完成或停止当前操作，再切换或修改工程');}
function projectPath(id,action=''){if(!UUID.test(id||''))throw Error('画布项目标识无效');return `/api/canvas-projects/${id}${action?'/'+action:''}`;}
function updateProjectUrl(){const url=new URL(location.href);url.searchParams.delete('music');url.searchParams.set('canvas',project.id);url.hash='canvas';window.history.replaceState(null,'',url.pathname+url.search+url.hash);}
function acceptProject(result,{updateUrl=true}={}){
 const next=clone(result.project||result.record?.project||result);validateClientProject(next);pause();clearTimeout(saving);saving=null;
 project=next;wave=Array.isArray(result.waveform)?result.waveform:next.source.id==='sample'?(caps.sampleWave||[]):[];current=0;selected=null;beforeEdit=null;comparison='after';lastResponse='';rich=false;sourceTab='upload';drawerOpen=false;drawerView='settings';dirty=false;saveRevision++;
 audio.src=localUrl(project.source.url);audio.load();movie.removeAttribute('src');movie.load();if(updateUrl)updateProjectUrl();render();studio?.setView('canvas');return clone(project);
}
function makeEmptyCanvas(options={}){
 const title=typeof options==='string'?options:options.title||'未命名画布',next=makeProject();next.id=crypto.randomUUID();next.title=title;next.start=0;next.lyrics=[];next.manualLyrics='';next.generated=null;next.musicHandoff=null;
 next.studio={type:'canvas',prompt:'',enhance:false,ratio:'16:9',freeCanvas:true,canvas:createCanvasDocument(),canvasSettings:{grid:true,snap:true,showConnections:true,minimap:false,autosave:true}};validateClientProject(next);return next;
}
async function transitionProject(operation){requireIdle();switching=true;try{await flushSave();return await operation();}finally{switching=false;render();}}
async function newCanvas(options={}){return transitionProject(async()=>acceptProject(await post('/api/canvas-projects',{project:makeEmptyCanvas(options)})));}
async function openProject(id){return transitionProject(async()=>acceptProject(await post(projectPath(id,'open'),{})));}
async function listProjects(options={}){const archived=typeof options==='boolean'?options:!!options.archived;return(await api(`/api/canvas-projects${archived?'?archived=1':''}`)).projects;}
async function duplicateProject(id,options={}){if(id&&typeof id==='object'){options=id;id=undefined;}return transitionProject(async()=>{const copied=await post(projectPath(id||project.id,'duplicate'),options.title?{title:options.title}:{});return options.open===false?clone(copied.project):acceptProject(await post(projectPath(copied.project.id,'open'),{}));});}
async function renameProject(id,title){if(title===undefined){title=id;id=project.id;}return transitionProject(async()=>{const renamed=await post(projectPath(id,'rename'),{title});if(id===project.id){project.title=renamed.project.title;save();await flushSave();render();}return clone(renamed.project);});}
async function archiveProject(id=project.id){return transitionProject(async()=>{const archived=await post(projectPath(id,'archive'),{});if(id===project.id){const remaining=await listProjects();if(remaining.length)acceptProject(await post(projectPath(remaining[0].id,'open'),{}));else acceptProject(await post('/api/canvas-projects',{project:makeEmptyCanvas()}));}return clone(archived.record||archived);});}
async function restoreProject(id,options={}){return transitionProject(async()=>{const restored=await post(projectPath(id,'restore'),{});return options.open?acceptProject(await post(projectPath(id,'open'),{})):clone(restored.project);});}
async function importProject(input){
 let raw=input;if(input&&typeof input.text==='function'){if(input.size>16_000_000)throw Error('工程JSON不能超过16MB');raw=await input.text();}
 if(typeof raw==='string'){if(new TextEncoder().encode(raw).length>16_000_000)throw Error('工程JSON不能超过16MB');try{raw=JSON.parse(raw)}catch{throw Error('工程JSON格式无效');}}
 const wrapped=['osmanthus-mv-project-export-v1','osmanthus-canvas-project-v1'].includes(raw?.schema),next=clone(wrapped?raw.project:raw);validateClientProject(next);
 return transitionProject(async()=>acceptProject(await post('/api/canvas-projects/import',{project:next})));
}
function openEngine(){if(project.studio?.freeCanvas&&project.source.id==='sample'){closeEngine();toast('请先上传音乐，或把音频素材选为MV音乐');return false;}const overlay=$('legacy-engine-overlay');if(overlay){overlay.hidden=false;overlay.classList.add('is-open');document.body.classList.add('engine-open');}render();return true;}
function closeEngine(){pause();if(drawerOpen)closeDrawer();const overlay=$('legacy-engine-overlay');if(overlay){overlay.hidden=true;overlay.classList.remove('is-open');document.body.classList.remove('engine-open');}return true;}

function materialView(material){const tags=project.studio?.assetLibrary?.tags?.[material.id]||{},type=material.kind||material.type,asset={id:material.id,url:material.url,name:material.name};if(Number.isFinite(material.duration))asset.duration=material.duration;return{...material,...tags,type,thumbnailUrl:type==='image'?material.url:'',asset};}
async function listMaterials(context={}){let materials=(await api('/api/materials')).materials.map(materialView);if(context.library==='actors')materials=materials.filter(item=>['image','video'].includes(item.type)&&(item.category||'role')==='role');if(context.type)materials=materials.filter(item=>item.type===context.type);return materials;}
async function uploadMaterials(files,context={}){
 requireIdle();materialUploading=true;const uploaded=[],errors=[];
 try{
 if(!UUID.test(project.id||'')){save();await flushSave();}const uploadProjectId=project.id;
 for(const file of Array.from(files||[])){try{const extension=file.name?.split('.').at(-1)?.toLowerCase(),limit=['png','jpg','jpeg','webp','gif'].includes(extension)?20e6:80e6;if(!file.size||file.size>limit)throw Error(`文件为空或超过${limit/1e6}MB`);const result=await api('/api/materials',{method:'POST',headers:{'x-filename':encodeURIComponent(file.name)},body:file});uploaded.push(materialView(result.material));}catch(error){errors.push(`${file.name||'素材'}：${error.message}`);}}
 if(project.id!==uploadProjectId)throw Error('上传时当前工程已改变，素材已保存在本地资产库，请在目标工程重新选择');
 if(uploaded.length){const library=project.studio?.assetLibrary||{},tags={...library.tags};for(const item of uploaded)tags[item.id]={category:context.category||'role',library:context.library||'assets',era:context.era||'',region:context.region||''};project.studio={...project.studio,assetLibrary:{...library,tags}};save();render();}
 if(errors.length){if(!uploaded.length)throw Error(errors.join('；'));toast(`已上传${uploaded.length}项；${errors.join('；')}`);}
 return uploaded.map(item=>({...item,...project.studio.assetLibrary.tags[item.id]}));
 }finally{materialUploading=false;render();}
}
async function deleteMaterial(id){requireIdle();await flushSave();return(await api(`/api/materials/${encodeURIComponent(id)}`,{method:'DELETE'})).removed===true;}
async function resolveMaterial(value){const id=typeof value==='string'?value:value?.asset?.id||value?.id;if(!UUID.test(id||''))throw Error('素材标识无效');const material=(await listMaterials()).find(item=>item.id===id);if(!material)throw Error('找不到当前本地素材');return material;}
async function previewMaterial(value){let material;if(value&&typeof value==='object'&&typeof value.url==='string'&&['image','video','audio'].includes(value.kind||value.type)){if(!/^(?:\/(?!\/)|https?:\/\/|blob:)/i.test(value.url)||/[\x00-\x1f\x7f]/.test(value.url))throw Error('素材预览引用无效');material={...value,type:value.kind||value.type};}else material=await resolveMaterial(value);const url=esc(localUrl(material.url));pause();const html=material.type==='image'?`<img src="${url}" alt="${esc(material.name)}" style="display:block;max-width:100%;max-height:65dvh;margin:auto">`:material.type==='video'?`<video src="${url}" controls playsinline style="max-width:100%;max-height:65dvh"></video>`:`<audio src="${url}" controls style="width:100%"></audio>`;modal(material.name||'素材预览',html);$('modal').querySelector('video,audio')?.play().catch(()=>{});return material;}
async function useMaterialAsMusic(value){const material=await resolveMaterial(value);if(material.type!=='audio')throw Error('请选择音频素材作为MV音乐');return transitionProject(async()=>{await post('/api/versions',{project:clone(project),label:'更换MV音乐前的方案'});return acceptProject(await post(`/api/materials/${material.id}/use-audio`,{project:clone(project)}));});}
const assistantRequests=new Map();
async function canvasAssistant(request){
 requireIdle();const input=typeof request==='string'?{instruction:request}:request||{},mode=input.mode||'canvas',instruction=input.instruction||input.message||'',base=clone(input.canvas===undefined?(project.studio?.canvas||createCanvasDocument()):input.canvas),selectedIds=input.selected_ids||input.selectedIds||[];if(base)validateCanvasDocument(base);
 const signature=JSON.stringify([mode,instruction,base,selectedIds]);let requestId=input.request_id||input.requestId||assistantRequests.get(signature);if(!requestId){requestId=crypto.randomUUID();assistantRequests.set(signature,requestId);}
 const payload={request_id:requestId,mode,instruction,canvas:base,selected_ids:selectedIds};assisting=true;
 try{const result=await post('/api/canvas-assist',payload);if(mode==='canvas')validateCanvasDocument(result.nextCanvas);return result;}
 finally{assisting=false;render();}
}

async function aiMVPlan(input){
 requireIdle();const base=clone(project);await flushSave(true);if(project.id!==base.id||project.source.id!==base.source.id)throw Error('歌曲已切换，请在当前画布重新发起创作');
 const result=await post('/api/ai-mv/plan',{...input,project:base});
 if(project.id!==base.id||project.source.id!==base.source.id)throw Error('歌曲已切换，分镜已保存，请回到原画布查看');
 project.studio={...project.studio,aiMVPlan:result.plan};save();await flushSave();return result;
}
async function aiMVStart(input){requireIdle();const base=clone(project);await flushSave(true);if(project.id!==base.id||project.source.id!==base.source.id)throw Error('歌曲已切换，本次未提交视频任务');return(await post('/api/ai-mv/jobs',{...input,project:base})).job;}
async function aiMVJob(id){return(await api('/api/ai-mv/jobs/'+encodeURIComponent(id))).job;}
async function aiMVJobs(){return(await api('/api/ai-mv/jobs?project_id='+encodeURIComponent(project.id))).jobs;}
async function canvasTool(route,input={}){const base=clone(project);await flushSave(true);if(project.id!==base.id)throw Error('工程已切换，请在当前画布重试');const result=await post('/api/canvas/'+route,{...input,project:base});if(result.materials)result.materials=result.materials.map(materialView);if(result.material)result.material=materialView(result.material);return result;}
async function canvasGeneration(input){return(await canvasTool('generation',input)).job;}
async function canvasGenerationJob(id){return(await api('/api/canvas/generation/'+encodeURIComponent(id))).job;}
async function canvasGenerationJobs(){return(await api('/api/canvas/generation?project_id='+encodeURIComponent(project.id))).jobs;}
async function applyAIResult(job){
 if(job?.status!=='ready'||job.project_id!==project.id||job.source_id!==project.source.id){toast('成片已保留在原歌曲的任务中，请返回对应画布查看');return false;}
 if(project.generated?.jobId===job.id)return true;
 if(project.studio?.aiMVPlan?.id!==job.plan.id){toast('当前分镜已改变，旧版成片已保留，可下载');return false;}
 if((project.studio?.ratio||'16:9')!==job.plan.ratio){toast('画面比例已改变，原比例的成片已保留，可在任务中下载');return false;}
 return transitionProject(async()=>{if(job.project_id!==project.id||job.source_id!==project.source.id||project.studio?.aiMVPlan?.id!==job.plan.id)throw Error('工程已切换，成片已保留，未覆盖当前画布');const old=clone(project);await post('/api/versions',{project:old,label:'AI MV合成前的工程'});
 project=resizePlan(project,job.plan.duration,job.plan.start);project.generated=clone(job.generated);project.studio={...project.studio,aiMVJob:job.id,aiMVPlan:clone(job.plan)};selected=null;save();await flushSave();await post('/api/versions',{project:clone(project),label:'阿里万相 AI MV',output:project.generated});render();return true;});
}

async function upload(file){if(!file)return;if(file.size>80e6)return toast('文件超过80MB，请先截取需要的片段');try{return await transitionProject(async()=>{$('save-status').textContent='导入中';const r=await api('/api/upload',{method:'POST',headers:{'x-filename':encodeURIComponent(file.name)},body:file}),duration=Math.min(30,r.source.duration);await post('/api/versions',{project:clone(project),label:'更换MV音乐前的方案'});const next={...project,id:crypto.randomUUID(),musicHandoff:null,title:file.name.replace(/\.[^.]+$/,'').slice(0,120),source:r.source,start:0,duration,plan:makePlan(project.plan.story,duration),lyrics:[],manualLyrics:'',generated:null,planningSource:'preset',studio:{...project.studio,freeCanvas:false}};const created=await post('/api/canvas-projects',{project:next});acceptProject({...created,waveform:r.waveform});toast('音频已导入。可以试听片段，并补充歌词。');return r.source;});}catch(e){toast(e.message);$('save-status').textContent='导入未完成';return null}}
function modal(title,html){$('modal-body').innerHTML=`<div class="modal-header"><h2>${esc(title)}</h2><button class="icon-button" data-action="close-modal" data-icon="close" title="关闭" aria-label="关闭弹窗"></button></div>${html}`;hydrateIcons($('modal-body'));if(!$('modal').open)$('modal').showModal();}
async function history(){if(drawerOpen)closeDrawer();try{const {versions}=await api('/api/versions');modal('历史作品与方案',versions.length?versions.map(v=>`<div class="history-item"><div><strong>《${esc(v.project.plan.title)}》· ${esc(v.label)}</strong><p>${new Date(v.createdAt).toLocaleString('zh-CN')} · ${v.output?'MP4已保存':'方案记录'}</p></div><div>${v.output?`<a class="text-button" download href="${esc(localUrl(v.output.url))}">下载 ↗</a>`:''}<button class="secondary" data-restore="${v.id}">从此版本继续</button></div></div>`).join(''):'<p class="empty">生成视频或应用修改后，历史版本会出现在这里。</p>');window.__history=versions;}catch(e){toast(e.message)}}
function lyrics(){const text=project.lyrics.length?project.lyrics.map(l=>`[${time(l.start)}.${String(Math.round((l.start%1)*100)).padStart(2,'0')}]${l.text}`).join('\n'):project.manualLyrics||'';modal('校对歌词与字幕',`<p class="small muted">LRC时间对应原音频时间。普通歌词会保留为创意参考，当前不会自动分配字幕时间。</p><div class="field"><label for="lyrics-text">歌词内容</label><textarea id="lyrics-text" style="min-height:250px" maxlength="12000">${esc(text)}</textarea></div><p class="hint">这一版暂未接回语音识别服务。原示例保留已有的核对时间。</p><div class="panel-footer"><button class="primary" data-action="save-lyrics">保存歌词</button></div>`);}
function saveLyrics(){const text=$('lyrics-text').value,arr=[];for(const line of text.split('\n')){const m=line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);if(m)arr.push({start:Number(m[1])*60+Number(m[2]),text:m[3].trim()});}arr.sort((a,b)=>a.start-b.start);project.lyrics=arr.map((a,i)=>({...a,end:arr[i+1]?.start??Math.min(project.source.duration,a.start+4)}));project.manualLyrics=text;project.generated=null;save();$('modal').close();updatePreview();toast(arr.length?'歌词与时间已更新':'已保留歌词文字，字幕需要LRC时间标记');}
async function performEdit(text,shot,scope){if(running||preparing){toast('请先完成或停止当前制作');return false;}const old=clone(project),r=localEdit(project,shot,text,scope);if(!r.applied){toast(r.message);return false;}try{await post('/api/versions',{project:old,label:'修改前的方案'});beforeEdit=old;project=r.project;comparison='after';lastResponse=r.message;await post('/api/versions',{project,label:`${scope==='all'?'全片':`第${shot}镜`}：${text.slice(0,45)}`});save();render();toast('修改已应用，历史版本保留');return true;}catch(e){toast(e.message);return false;}}
async function applyEdit(){return performEdit($('edit-request').value,selected,document.querySelector('input[name=scope]:checked').value);}
async function renderCode(){
 if(engineBusy())return;if(project.studio?.freeCanvas&&project.source.id==='sample')return toast('请先上传音乐，或把音频素材选为MV音乐');if(drawerOpen)closeDrawer();preparing=true;planCancelled=false;$('generate-button').disabled=true;pause();selected=null;beforeEdit=null;comparison='after';renderControls();
 try{validateClientProject(project);if(!caps.freeRender)throw Error('当前本地视频编码器不可用，仍可预览分镜');
  if(rich){$('progress').hidden=false;$('progress-title').textContent='丰富镜头表达';$('progress-detail').textContent='正在根据歌词主题整理景别与情绪';$('progress-bar').removeAttribute('value');planAbort=new AbortController();project=(await api('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project}),signal:planAbort.signal})).project;planAbort=null;rich=false;renderFilmstrip();}
  if(planCancelled)throw Error('已取消后续制作');
  const frozen=clone(project),j=await post('/api/render',{project:frozen});running={id:j.id,cancelled:false};const active=running;
  $('progress').hidden=false;$('progress-title').textContent='正在绘制镜头';$('generate-button').disabled=true;$('progress-bar').value=0;
  const heartbeat=setInterval(()=>post(`/api/jobs/${j.id}/heartbeat`,{}).catch(()=>{}),4000);active.heartbeat=heartbeat;
  const frameCanvas=document.createElement('canvas'),format=getOutputFormat(frozen.studio?.ratio);frameCanvas.width=format.width;frameCanvas.height=format.height;if(j.dimensions&&(j.dimensions.width!==format.width||j.dimensions.height!==format.height))throw Error('编码服务尺寸与所选比例不一致，请检查当前视频服务版本');
  for(let i=0;i<j.total;i++){if(active.cancelled)throw Error('本次制作已停止');drawFrame(frameCanvas,frozen,i/24,{subtitles:frozen.subtitles!==false,fullSize:true});const blob=await new Promise(r=>frameCanvas.toBlob(r,'image/jpeg',.89));await api(`/api/jobs/${j.id}/frame?index=${i}`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});if(i%12===0){$('progress-detail').textContent=`${i+1} / ${j.total} 帧 · 第${shotAt(frozen.plan,i/24).id}镜`;$('progress-bar').value=(i+1)/j.total*88;draw(i/24);await new Promise(r=>setTimeout(r,0));}}
  await post(`/api/jobs/${j.id}/finish`,{});$('progress-title').textContent='正在合成原曲与字幕';
  let result;for(let i=0;i<180;i++){if(active.cancelled)throw Error('本次制作已停止');result=await api(`/api/jobs/${j.id}`);$('progress-bar').value=result.progress;if(result.status==='ready')break;if(['failed','cancelled'].includes(result.status))throw Error(result.error||result.message||'本次制作未完成');$('progress-detail').textContent='画面已完成，正在检查成片';await new Promise(r=>setTimeout(r,700));}
  if(result?.status!=='ready')throw Error('合成仍未完成，请查看历史或手动重试');project={...frozen,step:'result',generated:result.generated?clone(result.generated):{url:result.url,duration:frozen.duration,dimensions:result.dimensions||format},version:project.version+1};current=0;save();toast('有声MV已生成，可以播放或下载');
 }catch(e){toast(e.message);if(running&&!running.cancelled)await post(`/api/jobs/${running.id}/cancel`,{}).catch(()=>{});}
 finally{if(running?.heartbeat)clearInterval(running.heartbeat);running=null;preparing=false;planAbort=null;$('progress').hidden=true;render();}
}
async function cancel(){if(!running){if(preparing){planCancelled=true;planAbort?.abort();toast('已取消后续制作。已经提交的镜头整理请求可能仍会完成。')}return;}running.cancelled=true;await post(`/api/jobs/${running.id}/cancel`,{}).catch(()=>{});toast('已停止本次制作，方案和历史作品仍保留');}
async function play(){try{if(showingMovie()){audio.pause();if(movie.currentTime>=project.duration-.1)movie.currentTime=0;if(movie.paused)await movie.play();else movie.pause();}else{movie.pause();if(!audio.paused){pause();return;}const seg=drawerOpen&&drawerView==='edit'&&selected?project.plan.shots[selected-1]:null;if(seg&&(current<seg.start||current>=seg.end-.1))current=seg.start;else if(current>=project.duration-.1)current=0;audio.currentTime=project.start+current;await audio.play();}$('center-play').hidden=!(showingMovie()?movie.paused:audio.paused);$('play-button').innerHTML=icon($('center-play').hidden?'pause':'play');}catch{toast('音频或视频尚未就绪，请稍后再试')}}
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b||b.disabled)return;
 if((running||preparing)&&(b.dataset.story||b.dataset.style||b.dataset.duration||b.dataset.restore||['apply-edit','undo','save-lyrics'].includes(b.dataset.action)))return toast('请先完成或停止当前制作，再修改方案');
 try{
  if(b.dataset.step){pause();project.step=b.dataset.step;selected=null;save();render();}
  if(b.dataset.story){pause();project=changeStory(project,b.dataset.story);selected=null;current=0;beforeEdit=null;save();render();}
  if(b.dataset.style){project.plan.style=b.dataset.style;project.generated=null;save();render();}
  if(b.dataset.source){sourceTab=b.dataset.source;renderControls();}
  if(b.dataset.duration){pause();const d=b.dataset.duration==='full'?Math.min(180,project.source.duration):Number(b.dataset.duration);project=resizePlan(project,d,Math.min(project.start,Math.max(0,project.source.duration-d)));current=0;save();render();}
  if(b.dataset.shot)chooseShot(Number(b.dataset.shot));
  if(b.dataset.chip)$('edit-request').value=b.dataset.chip;
  if(b.hasAttribute('data-select-first')){chooseShot(1);$('edit-request').value=b.textContent;}
  if(b.dataset.comparison){comparison=b.dataset.comparison;document.querySelectorAll('[data-comparison]').forEach(x=>x.classList.toggle('active',x.dataset.comparison===comparison));draw();}
  if(b.hasAttribute('data-next')){pause();const list=steps(project.mode),n=list.findIndex(s=>s[0]===project.step);project.step=list[Math.min(list.length-1,n+1)][0];selected=null;save();render();}
  if(b.dataset.restore){const v=window.__history.find(v=>v.id===b.dataset.restore);await transitionProject(async()=>{const next=clone(v.project);if(!UUID.test(next.id||''))next.id=crypto.randomUUID();next.step='result';validateClientProject(next);await post('/api/project',next,'PUT');acceptProject(await api('/api/project'));$('modal').close();toast('已从此版本继续，其他历史记录保持不变');});}
  const action=b.dataset.action;if(action==='lyrics')lyrics();if(action==='save-lyrics')saveLyrics();if(action==='history')history();if(action==='close-modal')$('modal').close();if(action==='close-editor')closeDrawer();if(action==='apply-edit')await applyEdit();if(action==='undo'&&beforeEdit){project=clone(beforeEdit);beforeEdit=null;lastResponse='已撤回这次修改。';comparison='after';save();renderFilmstrip();renderEditor();updatePreview();}if(action==='render-code')renderCode();
  if(action==='import-link'){const v=$('music-link').value.trim();try{const u=new URL(v);if(!['https:','http:'].includes(u.protocol))throw Error()}catch{return toast('请粘贴有效的音乐分享链接')}await post('/api/import-link',{url:v});}
 }catch(err){toast(err.message)}
});
$('mode-free').onclick=()=>{if(running||preparing)return toast('请先完成或停止当前制作');pause();project=switchMode(project,'free');selected=null;save();render()};$('mode-pro').onclick=()=>{if(running||preparing)return toast('请先完成或停止当前制作');pause();project=switchMode(project,'pro');selected=null;save();render()};
$('process-button').onclick=()=>{$('process-panel').hidden=!$('process-panel').hidden;$('process-button').setAttribute('aria-expanded',!$('process-panel').hidden);renderProcess()};
$('settings-button').onclick=()=>openDrawer(project.step==='result'?(project.mode==='pro'?'story':'plan'):project.step);
$('music-settings').onclick=()=>openDrawer('music');$('quick-clip').onclick=()=>{openDrawer('music');$('clip-start')?.focus()};
$('quick-story').onclick=()=>openDrawer(project.mode==='pro'?'story':'plan');$('quick-style').onclick=()=>{openDrawer(project.mode==='pro'?'characters':'plan');document.querySelector('.style-option.selected')?.focus()};
$('quick-upload-button').onclick=()=>$('quick-upload').click();$('quick-upload').onchange=async e=>{await upload(e.target.files[0]);e.target.value=''};
$('quick-link-button').onclick=()=>{sourceTab='link';openDrawer('music');$('music-link')?.focus()};
$('drawer-close').onclick=closeDrawer;$('drawer-backdrop').onclick=closeDrawer;
$('timeline-toggle').onclick=()=>{const open=$('timeline-panel').hidden;$('timeline-panel').hidden=!open;$('timeline-toggle').setAttribute('aria-expanded',open);$('timeline-toggle').title=open?'收起分镜':'展开分镜'};
$('music-strip').addEventListener('dragover',e=>{e.preventDefault();$('music-strip').classList.add('drag')});$('music-strip').addEventListener('dragleave',()=>$('music-strip').classList.remove('drag'));$('music-strip').addEventListener('drop',e=>{e.preventDefault();$('music-strip').classList.remove('drag');upload(e.dataTransfer.files[0])});
document.addEventListener('keydown',e=>{if(!drawerOpen||$('modal').open)return;if(e.key==='Escape'){e.preventDefault();closeDrawer();return;}if(e.key==='Tab'&&$('settings-drawer').getAttribute('aria-modal')==='true'){const list=[...$('settings-drawer').querySelectorAll('button:not(:disabled),input:not(:disabled),textarea,summary,a[href]')].filter(x=>x.getClientRects().length);if(!list.length)return;const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
$('generate-button').onclick=renderCode;$('play-button').onclick=play;$('center-play').onclick=play;$('history-button').onclick=history;$('cancel-job').onclick=cancel;
$('seek').oninput=e=>{const t=Number(e.target.value);if(showingMovie()){movie.currentTime=t;current=t;$('current-time').textContent=time(t)}else{audio.currentTime=project.start+t;draw(t)}};
$('subtitle-toggle').onclick=()=>{if(running||preparing)return toast('请先完成或停止当前制作');pause();project.subtitles=project.subtitles===false;project.generated=null;save();updatePreview();toast(project.subtitles?'下次生成会显示歌词字幕':'下次生成将关闭歌词字幕')};
$('fullscreen-button').onclick=()=>document.querySelector('.canvas-wrap').requestFullscreen?.();
$('download-button').onclick=()=>{if(!project.generated?.url)return;const a=document.createElement('a');a.href=localUrl(project.generated.url);a.download=`${project.title}-${project.plan.title}.mp4`;a.click()};
$('capabilities-button').onclick=()=>modal('当前Demo可用能力',`<p class="small muted">本次重新建立的本地版本。可先验证界面和代码视频流程。</p>${[['音频上传与截取',true],['故事与画风预设',true],['逐镜预览与局部调整',true],['有声MP4导出',caps.freeRender],['历史版本与继续修改',true],['故事助手',caps.deepseek],['平台分享链接解析',false],['自动识别歌词',false],['ComfyUI AI视频生成',false]].map(([k,v])=>`<div class="capability-row">${k}<span class="${v?'':'unavailable'}">${v?'可用':'待接通'}</span></div>`).join('')}`);
for(const media of [audio,movie])for(const event of ['play','pause','ended','emptied'])media.addEventListener(event,()=>studio?.syncPlayback?.());
audio.addEventListener('ended',pause);movie.addEventListener('ended',()=>{pause();current=project.duration;$('seek').value=current;$('current-time').textContent=time(current)});
function tick(){if(!audio.paused&&!running){const t=audio.currentTime-project.start;const seg=drawerOpen&&drawerView==='edit'&&selected?project.plan.shots[selected-1]:null;const end=seg?seg.end:project.duration;if(t>=end){pause();draw(end-.001)}else draw(t);}if(!movie.paused&&showingMovie()){current=movie.currentTime;$('seek').value=current;$('current-time').textContent=time(current)}requestAnimationFrame(tick)}
window.addEventListener('pagehide',()=>{if(dirty){const pending=JSON.stringify(project);if(new TextEncoder().encode(pending).byteLength<60000)navigator.sendBeacon(localUrl('/api/project'),new Blob([pending],{type:'application/json'}));}if(running)navigator.sendBeacon(localUrl(`/api/jobs/${running.id}/cancel`),new Blob(['{}'],{type:'application/json'}));});
window.addEventListener('resize',()=>{syncDrawer();draw()});
window.MV_DEMO=window.OSMANTHUS_MV={get project(){return clone(project)},get running(){return running?.id||null},get selected(){return selected},get capabilities(){return caps},drawFrame,makePlan};
try{const [c,p]=await Promise.all([api('/api/capabilities'),api('/api/project')]);caps=c;wave=c.sampleWave||[];if(p.project){validateClientProject(p.project);project=p.project;wave=p.waveform||wave;project.step=steps(project.mode).some(s=>s[0]===project.step)?project.step:'music';}}catch(e){toast('已打开默认方案。'+e.message)}
let musicImportError=null;
const requestedMusic=new URLSearchParams(location.search).get('music');
if(requestedMusic){try{const imported=await post('/api/music-import',{handoff_id:requestedMusic});validateClientProject(imported.project);project=imported.project;wave=imported.waveform||[];}catch(error){musicImportError=error.message;caps.freeRender=false;toast('歌曲导入未完成：'+error.message);}}
else{const requestedCanvas=new URLSearchParams(location.search).get('canvas');if(requestedCanvas)try{const opened=await post(projectPath(requestedCanvas,'open'),{});validateClientProject(opened.project);project=opened.project;wave=opened.waveform||[];}catch(error){toast('画布打开未完成：'+error.message);}}
const returnLink=$('back-to-music');if(returnLink)returnLink.href=sourceMusicUrl();
if(returnLink)returnLink.addEventListener('click',async event=>{event.preventDefault();try{await flushSave(true);pause();location.assign(returnLink.href);}catch(error){toast('方案尚未保存：'+error.message);}});
const engineBridge={read:()=>clone(project),capabilities:()=>caps,waveform:()=>wave,busy:engineBusy,pause,play,playing:()=>!audio.paused||!movie.paused,toast,modal,lyrics,history,upload,drawFrame,openDrawer,chooseShot,
 flushSave,newCanvas,openProject,duplicateProject,listProjects,renameProject,archiveProject,restoreProject,importProject,listMaterials,uploadMaterials,deleteMaterial,previewMaterial,useMaterialAsMusic,canvasAssistant,aiMVPlan,aiMVStart,aiMVJob,aiMVJobs,applyAIResult,openEngine,closeEngine,renderCode,
 canvasGeneration,canvasGenerationJob,canvasGenerationJobs,canvasAnalyze:input=>canvasTool('analyze',input),canvasVision:input=>canvasTool('vision',input),canvasEdit:input=>canvasTool('edit',input),canvasExtractAudio:input=>canvasTool('extract-audio',input),canvasTranscribe:input=>canvasTool('transcribe',input),canvasTemplateReference:input=>canvasTool('template-reference',input),
 configure:(fields,invalidate=true)=>{if(running||preparing||switching){toast('请先完成或停止当前制作');return false;}try{if(Object.hasOwn(fields,'ratio'))getOutputFormat(fields.ratio);if(Object.hasOwn(fields,'canvas'))validateCanvasDocument(fields.canvas);if(Object.hasOwn(fields,'canvasDrawings'))validateCanvasDrawings(fields.canvasDrawings);const ratioChanged=Object.hasOwn(fields,'ratio')&&fields.ratio!==project.studio?.ratio;project.studio={...project.studio,...clone(fields)};if(Object.hasOwn(fields,'enhance'))rich=!!fields.enhance&&caps.deepseek;if(invalidate||ratioChanged)project.generated=null;if(ratioChanged){beforeEdit=null;comparison='after';}save();render();return true;}catch(error){toast(error.message);return false;}},
 setStory:id=>{if(running||preparing||switching)return false;pause();project=changeStory(project,id);current=0;selected=null;beforeEdit=null;save();render();return true;},
 setStyle:id=>{if(running||preparing||switching||!STYLES.some(s=>s.id===id))return false;project.plan.style=id;project.generated=null;save();render();return true;},
 rename:title=>{if(typeof title!=='string'||!title.trim()||title.trim().length>120||/[\x00-\x1f\x7f]/.test(title)){toast('画布名称需为1至120字的单行文字');return false;}project.title=title.trim();save();render();return true;},edit:(text,shot,scope)=>performEdit(text,shot,scope)};
window.OSMANTHUS_MV.bridge=engineBridge;
studio=mountStudio(engineBridge);
render();tick();window.APP_READY=true;
if(musicImportError)modal('歌曲导入未完成',`<p>${esc(musicImportError)}</p><a class="primary" href="${esc(musicUrl())}">返回音乐工作台</a>`);
