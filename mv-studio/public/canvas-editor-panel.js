import {localUrl} from './integration.js';
import {OUTPUT_RATIOS,getOutputFormat} from './output-format.js';

const SCHEMA='osmanthus-canvas-video-timeline-v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const copy=value=>JSON.parse(JSON.stringify(value));
const uid=()=>globalThis.crypto.randomUUID();
const validId=value=>typeof value==='string'&&SAFE_ID.test(value)&&!value.includes('..');
const round=value=>Number(value.toFixed(6));
const numeric=value=>value===''?NaN:Number(value);
const shown=value=>Number.isFinite(value)?value:'';
const totalOf=clips=>round(clips.reduce((total,clip)=>total+clip.end-clip.start,0));
const lengthLabel=value=>Number.isFinite(value)?`${Number(value.toFixed(2))} 秒`:'请填写起止时间';
const captionText=value=>typeof value==='string'&&value.trim()&&value.length<=1200&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const time=seconds=>{const ms=Math.round(seconds*1000);return`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
function safeMedia(value){
 if(typeof value!=='string'||/[\x00-\x20\x7f\\]/.test(value))return'';
 try{const origin=globalThis.location?.origin||'http://localhost',url=new URL(value,origin);if(url.origin!==origin||!/^\/(?:mv\/)?(?:files|assets)\//.test(url.pathname))return'';return localUrl(url.pathname+url.search);}catch{return'';}
}
function cuesChecked(cues,duration=60){
 if(!Array.isArray(cues)||cues.length>120)throw Error('字幕最多支持 120 条');let chars=0;
 const result=cues.map(cue=>{if(!cue||!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end<=cue.start||cue.end>duration+.000001)throw Error('字幕起止时间必须位于最终时间线内');if(!captionText(cue.text))throw Error('每条字幕需为 1–1200 字，且不能包含无效字符');chars+=cue.text.trim().length;return{start:round(cue.start),end:round(cue.end),text:cue.text.trim()};});
 if(chars>12000)throw Error('字幕总文字不能超过 12000 字');return result.sort((a,b)=>a.start-b.start||a.end-b.end);
}
export function formatCanvasSRT(cues){return cuesChecked(cues).map((cue,index)=>`${index+1}\n${time(cue.start)} --> ${time(cue.end)}\n${cue.text.replace(/\r/g,'').replace(/\n{2,}/g,'\n')}\n`).join('\n');}
export function formatCanvasLRC(cues){return cuesChecked(cues).map(cue=>{const cs=Math.round(cue.start*100);return`[${String(Math.floor(cs/6000)).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}]${cue.text.replace(/[\r\n]+/g,' ')}`;}).join('\n');}
export function parseCanvasSRT(text,duration=60){
 if(typeof text!=='string'||text.length>22000)throw Error('SRT 文本过长');if(!text.trim())return[];
 const parse=stamp=>{const match=/^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(stamp);if(!match)throw Error('SRT 时间格式应为 00:00:00,000');return Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;};
 const cues=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n[ \t]*\n/).map((block,index)=>{const lines=block.split('\n');if(/^\d+$/.test(lines[0]?.trim()))lines.shift();const match=/^\s*(\S+)\s+-->\s+(\S+)\s*$/.exec(lines.shift()||'');if(!match)throw Error(`第 ${index+1} 段 SRT 缺少有效时间行`);return{start:parse(match[1]),end:parse(match[2]),text:lines.join('\n')};});
 return cuesChecked(cues,duration);
}

/**
 * read() -> project. assetId(asset,node?) synchronously maps an owned reference
 * to a trusted server ID. edit/extractAudio/transcribe accept UUID-bound payloads
 * and return {job,materials?} or a job. configure({canvasVideoTimeline},false)
 * stores only this editor draft. Results are never added across project/session
 * changes. No API calls, original-song changes or generation occur in this UI.
 */
export function mountCanvasEditorPanel({read,toast,edit,extractAudio,transcribe,onAddMaterials,assetId,configure}={}){
 if(typeof read!=='function'||typeof assetId!=='function')throw TypeError('视频剪辑面板需要 read 与 assetId 回调');
 const doc=globalThis.document;if(!doc)throw Error('视频剪辑面板需要浏览器文档');
 if(!doc.querySelector('link[data-canvas-editor-css]')){const link=doc.createElement('link');link.rel='stylesheet';link.href=new URL('./canvas-editor-panel.css',import.meta.url).href;link.dataset.canvasEditorCss='';doc.head.append(link);}
 const dialog=doc.createElement('dialog');dialog.className='canvas-editor-dialog';dialog.setAttribute('aria-label','视频剪辑与字幕');doc.body.append(dialog);
 let projectId=null,session=0,disposed=false,busy=false,clips=[],music=null,ratio='16:9',cues=[],videos=[],audioOptions=[],activeKey=null,saveTimer=null,returnFocus=null,message='',srtBuffer=null,srtDirty=false,autoSave=typeof configure==='function',dragKey=null;
 let saveChain=Promise.resolve(),revision=0,lastSaved=-1;const requests=new Map(),applied=new Set();
 const notify=text=>toast?.(String(text));
 const current=()=>!disposed&&read()?.id===projectId;
 const context=()=>({projectId,session});
 const still=ctx=>!disposed&&ctx.projectId===projectId&&ctx.session===session&&read()?.id===ctx.projectId;
 const active=()=>clips.find(clip=>clip.key===activeKey)||clips[0];
 const candidate=clip=>videos.find(video=>video.id===clip.id);
 const duration=()=>totalOf(clips);
 const pause=()=>dialog.querySelectorAll('video,audio').forEach(media=>media.pause());
 function mapAsset(asset,node){try{const result=assetId(asset,node);return validId(result)?result:null;}catch{return null;}}
 function catalog(nodes,project){
  const seen=new Map(),list=[];
  for(const node of nodes){if(node?.type!=='video'||!node.asset)continue;const id=mapAsset(node.asset,node),url=safeMedia(node.asset.url);const identity=id||url||node.id;if(seen.has(identity)){seen.get(identity).nodeIds.push(node.id);continue;}const seconds=Number(node.asset.duration),metadata=project.studio?.canvasNodeMeta?.[node.id],item={id,nodeId:node.id,nodeIds:[node.id],name:String(node.title||node.asset.name||'未命名视频'),url,duration:Number.isFinite(seconds)&&seconds>0?seconds:null,final:!!(node.asset.url===project.generated?.url||/\/(?:jobs\/[^/]+\/mv\.mp4|canvas-edits\/[^/]+\/video\.mp4)(?:\?|$)/.test(node.asset.url||'')||metadata?.isFinal)};seen.set(identity,item);list.push(item);}
  const audio=[],audioIds=new Set();
  if(project.source&&project.source.id!=='sample'){const asset={...project.source},node={type:'audio',title:'原歌曲',asset},id=mapAsset(asset,node);if(id){audio.push({id,name:'原歌曲 · '+String(asset.name||project.title||'音乐'),url:safeMedia(asset.url),duration:Number.isFinite(asset.duration)?asset.duration:null,source:true});audioIds.add(id);}}
  for(const node of nodes){if(node?.type!=='audio'||!node.asset)continue;const id=mapAsset(node.asset,node);if(!id||audioIds.has(id))continue;audioIds.add(id);audio.push({id,name:String(node.title||node.asset.name||'画布音频'),url:safeMedia(node.asset.url),duration:Number.isFinite(node.asset.duration)?node.asset.duration:null,source:false});}
  return{videos:list,audio};
 }
 function allNodes(options,project){const map=new Map();for(const node of [...(project.studio?.canvas?.nodes||[]),...(Array.isArray(options.nodes)?options.nodes:[])])if(node?.id)map.set(node.id,node);return[...map.values()];}
 function makeClip(video){return{key:uid(),nodeId:video.nodeId,id:video.id,start:0,end:Math.min(video.duration||5,60),mute:!!music,gain:1,autoEnd:video.duration===null};}
 function initial(options,project){
  const result=catalog(allNodes(options,project),project);videos=result.videos;audioOptions=result.audio;
  ratio=OUTPUT_RATIOS.includes(project.studio?.ratio)?project.studio.ratio:'16:9';cues=[];music=null;clips=[];srtBuffer=null;srtDirty=false;message='';
  const source=audioOptions.find(option=>option.source);if(source){const start=Number(project.studio?.aiMVPlan?.start??project.start)||0;music={id:source.id,start:Math.max(0,start),gain:1};}
  const selected=new Set(Array.isArray(options.selectedIds)?options.selectedIds:[]),selectedVideos=videos.filter(video=>video.id&&video.nodeIds.some(id=>selected.has(id))),saved=project.studio?.canvasVideoTimeline;
  if(!selectedVideos.length&&saved?.schema===SCHEMA&&saved.project_id===projectId&&Array.isArray(saved.clips)){
   clips=saved.clips.slice(0,8).flatMap(clip=>{const video=videos.find(video=>video.id&&video.id===clip.id);if(!video||![clip.start,clip.end,clip.gain].every(Number.isFinite)||clip.start<0||clip.end<=clip.start||clip.end-clip.start>60||clip.gain<0||clip.gain>4||typeof clip.mute!=='boolean')return[];return[{key:uid(),nodeId:video.nodeId,id:video.id,start:clip.start,end:clip.end,mute:clip.mute,gain:clip.gain,autoEnd:false}];});
   if(OUTPUT_RATIOS.includes(saved.ratio))ratio=saved.ratio;
   music=saved.audio&&audioOptions.some(option=>option.id===saved.audio.id)&&Number.isFinite(saved.audio.start)&&saved.audio.start>=0&&Number.isFinite(saved.audio.gain)&&saved.audio.gain>=0&&saved.audio.gain<=4?{id:saved.audio.id,start:saved.audio.start,gain:saved.audio.gain}:null;
   try{cues=cuesChecked(saved.subtitles||[]);}catch{message='已忽略格式无效的字幕草稿，请重新填写。';}
   if(clips.length!==saved.clips.length)message='部分草稿素材已失效，请重新选择。';
  }
  if(!clips.length){const usable=selectedVideos.length?selectedVideos:videos.filter(video=>video.id&&!video.final);const defaults=usable.length?usable:videos.filter(video=>video.id);clips=defaults.slice(0,8).map(makeClip);if(defaults.length>8)message='已载入前 8 个视频；可取消选择后更换素材。';}
  if(music){const item=audioOptions.find(option=>option.id===music.id),total=totalOf(clips);if(Number.isFinite(item?.duration)&&music.start+total>item.duration+.05&&total<=item.duration)music.start=0;}
  activeKey=clips[0]?.key||null;revision=0;lastSaved=-1;
 }
 function validate({subtitles=true}={}){
  if(!current())throw Error('工程已切换，请重新打开剪辑面板');if(!UUID.test(projectId||''))throw Error('请先保存当前画布，再进行剪辑');
  if(!clips.length||clips.length>8)throw Error('请选择 1–8 个视频片段');
  for(const clip of clips){const item=candidate(clip);if(!item?.id)throw Error('部分视频已失效，请重新添加');if(!Number.isFinite(clip.start)||!Number.isFinite(clip.end)||clip.start<0||clip.end-clip.start<.04-.000001)throw Error('每段起止时间需有效，且至少保留 0.04 秒');if(Number.isFinite(item.duration)&&clip.end>item.duration+.05)throw Error(`「${item.name}」的裁剪终点超出原片时长`);if(!Number.isFinite(clip.gain)||clip.gain<0||clip.gain>4)throw Error('片段音量需为 0–4 倍');}
  const total=duration();if(!Number.isFinite(total)||total>60+.000001)throw Error('剪辑总时长不能超过 60 秒，请缩短片段或取消部分素材');getOutputFormat(ratio);
  if(music){const item=audioOptions.find(option=>option.id===music.id);if(!item||!Number.isFinite(music.start)||music.start<0||!Number.isFinite(music.gain)||music.gain<0||music.gain>4)throw Error('请填写有效的配乐起点和 0–4 倍音量');if(Number.isFinite(item.duration)&&music.start+total>item.duration+.05)throw Error('所选配乐剩余时长不足，请调整配乐起点或缩短时间线');}
  if(subtitles){if(srtDirty)throw Error('SRT 文本尚未应用，请先点击“应用 SRT 文本”');cuesChecked(cues,total);}return total;
 }
 function draft(){validate();return{schema:SCHEMA,project_id:projectId,clips:clips.map(({nodeId,id,start,end,mute,gain})=>({nodeId,id,start,end,mute,gain})),audio:music?copy(music):null,ratio,subtitles:cuesChecked(cues,duration())};}
 async function saveDraft(manual=false){
  clearTimeout(saveTimer);if(typeof configure!=='function'){if(manual)notify('当前没有配置草稿保存入口');return true;}const ctx=context(),version=revision;let value;try{value=draft();}catch(cause){if(manual)notify(cause.message);return false;}
  const task=async()=>{if(!still(ctx))return false;const result=await configure({canvasVideoTimeline:value},false);if(result===false)throw Error('草稿未保存，请稍后重试');if(still(ctx)){lastSaved=Math.max(lastSaved,version);if(manual)message='剪辑草稿已保存';updateSummary();}return true;};
  const promise=saveChain.catch(()=>{}).then(task);saveChain=promise;
  try{return await promise;}catch(cause){if(still(ctx))notify(cause.message||'剪辑草稿保存失败');return false;}
 }
 function changed({rerender=false}={}){revision++;message='';if(autoSave&&configure){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveDraft();},450);}if(rerender)render();else updateSummary();}
 function syncSRT(){if(srtDirty)return;try{srtBuffer=formatCanvasSRT(cues);const area=dialog.querySelector('[data-cep-srt]');if(area)area.value=srtBuffer;}catch{/* Preserve incomplete cue fields until the user finishes editing. */}}
 function statusError(){try{validate();return'';}catch(cause){return cause.message;}}
 function updateSummary(){
  const total=duration(),warning=statusError(),info=dialog.querySelector('[data-cep-summary]');if(info){info.textContent=`${clips.length} / 8 段 · ${lengthLabel(total)} / 60 秒`;info.classList.toggle('is-invalid',!!warning);}
  const status=dialog.querySelector('[data-cep-status]');if(status)status.textContent=busy?message:warning||message||(srtDirty?'SRT 文本尚未应用':configure&&revision>lastSaved?'草稿有修改':'可裁剪原素材并导出副本');
  const renderButton=dialog.querySelector('[data-cep-action=render]');if(renderButton)renderButton.disabled=busy||!!warning||typeof edit!=='function';
  const region=dialog.querySelector('[data-cep-cue-note]');if(region)region.textContent=cues.length?`${cues.length} 条字幕 · 时间相对最终成片；调整顺序或裁剪后请校对。`:'还没有字幕，可添加文字或识别所选片段。';
  for(const[index,clip]of clips.entries()){const label=dialog.querySelector(`[data-cep-clip-duration="${index}"]`);if(label)label.textContent=lengthLabel(clip.end-clip.start);}const selected=active(),range=dialog.querySelector('[data-cep-preview-range]');if(range&&selected)range.textContent=`${shown(selected.start)}–${shown(selected.end)} 秒`;
 }
 const button=(action,label,extra='')=>`<button type="button" data-cep-action="${action}" ${extra}>${label}</button>`;
 const field=(name,label,value,{min=0,max,step=.01,row,type='clip'}={})=>`<label>${label}<input type="number" data-cep-${type}="${name}" ${row!==undefined?`data-row="${row}"`:''} min="${min}" ${Number.isFinite(max)?`max="${max}"`:''} step="${step}" value="${shown(value)}" ${busy?'disabled':''}></label>`;
 function render(){
  if(disposed)return;pause();const chosen=active(),item=chosen?candidate(chosen):null,total=duration(),format=getOutputFormat(ratio),audio=music?audioOptions.find(option=>option.id===music.id):null;
  let buffer=srtBuffer;if(buffer===null){try{buffer=formatCanvasSRT(cues);}catch{buffer='';}srtBuffer=buffer;}
  dialog.innerHTML=`<header class="cep-header"><div><small>Osmanthus · 本地素材</small><h2>视频剪辑与字幕</h2></div>${button('close','✕','class="cep-close" aria-label="关闭剪辑面板"')}</header>
   <div class="cep-body"><aside class="cep-library"><h3>画布视频 <span>${videos.length}</span></h3><p class="cep-note">勾选加入时间线，最多 8 段。已有成片可手动选择。</p><div class="cep-catalog">${videos.length?videos.map((video,index)=>`<label class="cep-asset ${clips.some(clip=>clip.id===video.id)?'is-used':''}"><input type="checkbox" data-cep-material="${index}" ${clips.some(clip=>clip.id===video.id)?'checked':''} ${busy||!video.id?'disabled':''}><span class="cep-asset-icon">▶</span><span><strong>${esc(video.name)}</strong><small>${video.duration===null?'时长待读取':esc(lengthLabel(video.duration))}${video.final?' · 已有成片':''}${!video.id?' · 素材未登记':''}</small></span></label>`).join(''):'<p class="cep-empty">画布暂无可用视频。上传视频或生成镜头后再打开。</p>'}</div></aside>
   <main class="cep-main"><section class="cep-preview-section"><div class="cep-preview" style="aspect-ratio:${format.width}/${format.height}">${item?.url?`<video data-cep-preview data-clip-key="${esc(chosen.key)}" data-asset-id="${esc(item.id)}" src="${esc(item.url)}" controls playsinline preload="metadata"></video>`:'<p>选择时间线片段预览</p>'}</div><div class="cep-preview-label"><span>${esc(item?.name||'未选择视频')}</span><small data-cep-preview-range>${chosen?`${shown(chosen.start)}–${shown(chosen.end)} 秒`:'预览单个片段；导出时按时间线拼接'}</small></div></section>
   <section class="cep-timeline"><div class="cep-section-title"><h3>视频时间线</h3><output data-cep-summary></output></div><p class="cep-note">拖动左侧手柄或点击上下箭头排序。原片不变；导出会保留完整画面并适配比例。</p><ol class="cep-clips">${clips.map((clip,index)=>{const video=candidate(clip);return`<li data-cep-row="${index}" class="cep-clip ${clip.key===chosen?.key?'is-active':''}"><button type="button" draggable="${!busy}" class="cep-drag" data-cep-drag="${esc(clip.key)}" aria-label="拖动第 ${index+1} 段排序" ${busy?'disabled':''}>⠿</button><div class="cep-clip-detail"><div class="cep-clip-title"><button type="button" data-cep-select="${index}" aria-pressed="${clip.key===chosen?.key}" ${busy?'disabled':''}>${index+1}. ${esc(video?.name||'素材已失效')}</button><span data-cep-clip-duration="${index}">${esc(lengthLabel(clip.end-clip.start))}</span></div><div class="cep-clip-fields">${field('start','起点 / 秒',clip.start,{row:index,max:video?.duration})}${field('end','终点 / 秒',clip.end,{row:index,max:video?.duration})}<label class="cep-check"><input type="checkbox" data-cep-clip="mute" data-row="${index}" ${clip.mute?'checked':''} ${busy?'disabled':''}>静音原声</label>${field('gain','原声音量 / 倍',clip.gain,{row:index,max:4,step:.1})}</div></div><div class="cep-order"><button type="button" data-cep-move="${index}" data-step="-1" aria-label="上移第 ${index+1} 段" ${busy||!index?'disabled':''}>↑</button><button type="button" data-cep-move="${index}" data-step="1" aria-label="下移第 ${index+1} 段" ${busy||index===clips.length-1?'disabled':''}>↓</button><button type="button" data-cep-remove="${index}" aria-label="移除第 ${index+1} 段" ${busy?'disabled':''}>×</button></div></li>`;}).join('')}</ol>${clips.length?'':'<p class="cep-empty">从左侧勾选视频，开始排列片段。</p>'}</section>
   <section class="cep-audio"><div class="cep-section-title"><h3>配乐与比例</h3><label>画面比例<select data-cep-ratio ${busy?'disabled':''}>${OUTPUT_RATIOS.map(value=>`<option value="${value}" ${value===ratio?'selected':''}>${value}</option>`).join('')}</select></label></div><div class="cep-audio-fields"><label class="cep-music-select">配乐<select data-cep-music ${busy?'disabled':''}><option value="">使用片段原声</option>${audioOptions.map(option=>`<option value="${esc(option.id)}" ${music?.id===option.id?'selected':''}>${esc(option.name)}</option>`).join('')}</select></label>${music?field('start','配乐起点 / 秒',music.start,{type:'audio',max:audio?.duration})+field('gain','配乐音量 / 倍',music.gain,{type:'audio',max:4,step:.1}):''}</div>${audio?.url?`<audio controls preload="none" src="${esc(audio.url)}" aria-label="预听配乐"></audio>`:''}<p class="cep-note">选择配乐时默认静音片段原声，可逐段取消静音混入。配乐不会修改原歌曲。</p></section>
   <section class="cep-subtitles"><div class="cep-section-title"><h3>字幕</h3><div>${button('extract','分离所选片段音轨',busy||!chosen||typeof extractAudio!=='function'?'disabled':'')}${button('transcribe','识别本段并替换字幕',busy||!chosen||typeof transcribe!=='function'?'disabled':'')}</div></div><p class="cep-note">本机 Whisper 识别实际语音，结果需校对；不是歌词准确性保证。单次最多 60 秒、素材最多 16MB。</p><p class="cep-note" data-cep-cue-note></p><div class="cep-cue-list">${cues.map((cue,index)=>`<div class="cep-cue">${field('start','开始 / 秒',cue.start,{type:'cue',row:index,max:60})}${field('end','结束 / 秒',cue.end,{type:'cue',row:index,max:60})}<label>字幕文字<textarea rows="2" maxlength="1200" data-cep-cue="text" data-row="${index}" ${busy?'disabled':''}>${esc(cue.text)}</textarea></label><button type="button" data-cep-cue-remove="${index}" aria-label="删除第 ${index+1} 条字幕" ${busy?'disabled':''}>×</button></div>`).join('')}</div><div class="cep-subtitle-actions">${button('add-cue','＋ 添加字幕',busy||cues.length>=120?'disabled':'')}${button('download-srt','下载 SRT',busy||!cues.length?'disabled':'')}${button('download-lrc','下载 LRC',busy||!cues.length?'disabled':'')}</div><details class="cep-srt"><summary>SRT 文本编辑</summary><textarea data-cep-srt rows="8" maxlength="22000" spellcheck="false" aria-label="SRT 字幕文本" ${busy?'disabled':''}>${esc(buffer)}</textarea><div>${button('apply-srt','应用 SRT 文本',busy?'disabled':'')}<small>${srtDirty?'文本尚未应用':'可粘贴已有 SRT，再应用到上方字幕分段。'}</small></div></details></section>
   ${videos.some(video=>video.url&&video.duration===null)?`<div class="cep-metadata" aria-hidden="true">${videos.filter(video=>video.url&&video.duration===null).map(video=>`<video data-cep-metadata="${esc(video.id||'')}" preload="metadata" src="${esc(video.url)}"></video>`).join('')}</div>`:''}</main></div>
   <footer class="cep-footer"><div><p role="status" aria-live="polite" data-cep-status></p>${configure?`<label class="cep-check"><input type="checkbox" data-cep-autosave ${autoSave?'checked':''} ${busy?'disabled':''}>修改时保存草稿</label>`:''}</div><div>${button('close','关闭')}${configure?button('save','保存草稿',busy?'disabled':''):''}${button('render',busy?'正在处理…':'导出 MP4 并加入画布','class="cep-primary"')}</div></footer>`;
  updateSummary();
 }
 function activePayload(){const clip=active(),item=clip?candidate(clip):null;if(!current())throw Error('工程已切换，请重新打开剪辑面板');if(!UUID.test(projectId||''))throw Error('请先保存当前画布');if(!clip||!item?.id)throw Error('请先选择一个视频片段');if(!Number.isFinite(clip.start)||!Number.isFinite(clip.end)||clip.start<0||clip.end-clip.start<.2||clip.end-clip.start>60)throw Error('音轨提取和语音识别的选段需为 0.2–60 秒');if(item.duration!==null&&clip.end>item.duration+.05)throw Error('选段超出所选视频时长');return{clip,item,payload:{project_id:projectId,asset_id:clip.id,start:clip.start,end:clip.end}};}
 function requestId(mode,payload){const key=JSON.stringify([mode,payload]);if(!requests.has(key)){requests.set(key,uid());if(requests.size>30)requests.delete(requests.keys().next().value);}return requests.get(key);}
 function downloadable(materials,job,kind){if(Array.isArray(materials)&&materials.length)return materials;const url=job.generated?.url||job.audio?.url||job.url;if(!safeMedia(url))return[];const name=kind==='video'?'剪辑成片.mp4':'分离音轨.wav';return[{id:job.id,kind,name,url,duration:job.audio?.duration||job.duration,mimeType:kind==='video'?'video/mp4':'audio/wav'}];}
 async function addResults(result,job,kind,ctx){
  const materials=downloadable(result.materials,job,kind),identity=`${kind}:${job.id}`;if(!still(ctx)||applied.has(identity))return false;if(!materials.length)throw Error('任务完成，但没有可加入画布的媒体文件');if(typeof onAddMaterials!=='function')throw Error('任务完成，当前未配置画布素材接收入口');const accepted=await onAddMaterials(materials,{project_id:ctx.projectId});if(accepted===false)throw Error('素材尚未加入画布，导出文件已保留');if(still(ctx))applied.add(identity);return true;
 }
 async function operate(mode){
  if(busy)return;const ctx=context();let payload,clip,key,offset=0,baseRevision=revision;
  try{
   if(mode==='render'){validate();payload={project_id:projectId,clips:clips.map(({id,start,end,mute,gain})=>({id,start,end,mute,gain})),audio:music?copy(music):null,ratio,subtitles:cuesChecked(cues,duration())};if(typeof edit!=='function')throw Error('本地视频导出入口尚未接入');}
   else{const selected=activePayload();payload=selected.payload;clip=selected.clip;key=clip.key;for(const item of clips){if(item.key===key)break;offset+=item.end-item.start;}if(typeof(mode==='extract'?extractAudio:transcribe)!=='function')throw Error('该音频工具尚未接入');}
   clips.forEach(item=>{item.autoEnd=false;});busy=true;message=mode==='render'?'正在本地裁剪并合成 MP4…':mode==='extract'?'正在提取所选片段音轨…':'正在使用本机 Whisper 识别所选片段，请稍候…';render();
   if(mode==='render'&&configure&&!(await saveDraft()))throw Error('剪辑草稿未保存，请检查时间线后重试');if(!still(ctx))return;
   const fn=mode==='render'?edit:mode==='extract'?extractAudio:transcribe,result=await fn({request_id:requestId(mode,payload),...payload}),job=result?.job||result;
   if(!job||job.project_id!==ctx.projectId)throw Error('任务返回的工程不匹配，未改动画布');if(!still(ctx)){notify('处理结果已保留，当前工程或面板已切换，未加入画布');return;}
   if(job.status!=='ready')throw Error(job.error||job.message||'本地处理尚未完成，请保留原素材后重试');
   if(mode==='transcribe'){
    if(revision!==baseRevision||!clips.some(item=>item.key===key))throw Error('时间线已修改，转写结果已保留，请重新识别当前选段');const segments=job.segments||job.transcript?.segments;if(!Array.isArray(segments)||!segments.length)throw Error('该片段没有识别出可用语音');
    const selectedDuration=clip.end-clip.start,relative=cuesChecked(segments,selectedDuration),end=offset+selectedDuration,next=[...cues.filter(cue=>cue.end<=offset||cue.start>=end),...relative.map(cue=>({start:round(cue.start+offset),end:round(cue.end+offset),text:cue.text}))];cues=cuesChecked(next,duration());srtBuffer=null;srtDirty=false;changed();message='已填入真实语音分段，请校对文字和时间后导出';
   }else{await addResults(result,job,mode==='render'?'video':'audio',ctx);if(still(ctx)){message=mode==='render'?'MP4 已导出并加入当前画布':'WAV 音轨已加入当前画布';const refreshed=catalog(read().studio?.canvas?.nodes||[],read());audioOptions=refreshed.audio;}}
  }catch(cause){if(still(ctx)){message=cause.message||'本地处理未完成';notify(message);}}finally{if(still(ctx)){busy=false;render();}}
 }
 function download(kind){try{if(srtDirty)throw Error('请先应用 SRT 文本');const text=kind==='srt'?formatCanvasSRT(cuesChecked(cues,duration())):formatCanvasLRC(cuesChecked(cues,duration()));if(!text)throw Error('请先添加字幕');const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=doc.createElement('a');a.href=url;a.download=String(read().title||'剪辑字幕').replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').slice(0,80)+'.'+kind;doc.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(cause){notify(cause.message);}}
 function addCue(){try{if(!Number.isFinite(duration())||duration()<=0)throw Error('请先填写视频时间线');if(cues.length>=120)throw Error('字幕最多 120 条');const start=Math.min(Math.max(0,cues[cues.length-1]?.end||0),Math.max(0,duration()-.1));cues.push({start:round(start),end:round(Math.min(start+2,duration())),text:''});srtBuffer=null;srtDirty=false;changed({rerender:true});}catch(cause){notify(cause.message);}}
 function move(from,to){if(busy||from<0||to<0||from>=clips.length||to>=clips.length||from===to)return;const[clip]=clips.splice(from,1);clips.splice(to,0,clip);changed({rerender:true});}
 async function close(){if(disposed)return;const ctx=context();clearTimeout(saveTimer);if(!busy&&autoSave&&configure)await saveDraft();if(disposed||ctx.session!==session)return;pause();session++;busy=false;if(dialog.open)dialog.close();returnFocus?.focus?.();}
 dialog.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target||target.disabled)return;const action=target.dataset.cepAction;
  if(action==='close'){close();return;}if(busy)return;
  if(action==='render'||action==='transcribe'||action==='extract'){operate(action);return;}if(action==='save'){saveDraft(true);return;}if(action==='add-cue'){addCue();return;}if(action==='download-srt'||action==='download-lrc'){download(action.slice(9));return;}
  if(action==='apply-srt'){try{cues=parseCanvasSRT(dialog.querySelector('[data-cep-srt]')?.value??srtBuffer??'',duration());srtDirty=false;srtBuffer=null;changed({rerender:true});}catch(cause){notify(cause.message);}return;}
  if(target.dataset.cepSelect!==undefined){const clip=clips[Number(target.dataset.cepSelect)];if(clip){activeKey=clip.key;render();}return;}
  if(target.dataset.cepMove!==undefined){const index=Number(target.dataset.cepMove);move(index,index+Number(target.dataset.step));return;}
  if(target.dataset.cepRemove!==undefined){const index=Number(target.dataset.cepRemove);clips.splice(index,1);if(!clips.some(clip=>clip.key===activeKey))activeKey=clips[0]?.key||null;changed({rerender:true});return;}
  if(target.dataset.cepCueRemove!==undefined){cues.splice(Number(target.dataset.cepCueRemove),1);srtBuffer=null;srtDirty=false;changed({rerender:true});}
 });
 function fieldChange(event){
  if(busy||!current())return;const target=event.target,data=target.dataset||{},row=Number(data.row);
  if(data.cepClip!==undefined){const clip=clips[row];if(!clip)return;clip[data.cepClip]=data.cepClip==='mute'?target.checked:numeric(target.value);clip.autoEnd=false;changed({rerender:data.cepClip==='mute'});return;}
  if(data.cepAudio!==undefined&&music){music[data.cepAudio]=numeric(target.value);changed();return;}
  if(data.cepCue!==undefined){const cue=cues[row];if(!cue)return;cue[data.cepCue]=data.cepCue==='text'?target.value:numeric(target.value);syncSRT();changed();return;}
  if(target.hasAttribute?.('data-cep-srt')){srtBuffer=target.value;srtDirty=true;changed();return;}
  if(event.type!=='change')return;
  if(data.cepMaterial!==undefined){const item=videos[Number(data.cepMaterial)];if(!item?.id)return;if(target.checked){if(clips.length>=8){target.checked=false;notify('最多支持 8 个片段，请先移除部分片段');return;}const clip=makeClip(item);clips.push(clip);activeKey=clip.key;}else{clips=clips.filter(clip=>clip.id!==item.id);if(!clips.some(clip=>clip.key===activeKey))activeKey=clips[0]?.key||null;}changed({rerender:true});return;}
  if(target.hasAttribute?.('data-cep-ratio')){if(OUTPUT_RATIOS.includes(target.value)){ratio=target.value;changed({rerender:true});}return;}
  if(target.hasAttribute?.('data-cep-music')){const selected=audioOptions.find(option=>option.id===target.value);if(selected){if(!music)clips.forEach(clip=>{clip.mute=true;});music={id:selected.id,start:0,gain:music?.gain??1};}else music=null;changed({rerender:true});return;}
  if(target.hasAttribute?.('data-cep-autosave')){autoSave=target.checked;if(autoSave)saveDraft();else clearTimeout(saveTimer);}
 }
 dialog.addEventListener('input',fieldChange);dialog.addEventListener('change',fieldChange);
 dialog.addEventListener('loadedmetadata',event=>{const media=event.target,id=media.dataset?.cepMetadata||media.dataset?.assetId;if(!id||!current()||!Number.isFinite(media.duration)||media.duration<=0)return;const item=videos.find(video=>video.id===id);if(!item)return;const wasUnknown=item.duration===null;item.duration=media.duration;if(wasUnknown&&!busy){for(const[index,clip]of clips.entries())if(clip.id===id&&clip.autoEnd){clip.end=Math.min(media.duration,60);clip.autoEnd=false;const input=dialog.querySelector(`[data-cep-clip=end][data-row="${index}"]`);if(input)input.value=clip.end;}const selected=active(),label=dialog.querySelector('[data-cep-preview-range]');if(label&&selected)label.textContent=`${shown(selected.start)}–${shown(selected.end)} 秒`;revision++;updateSummary();if(autoSave&&configure){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveDraft();},450);}}if(media.hasAttribute?.('data-cep-preview')){const selected=active();if(selected&&media.dataset.clipKey===selected.key)try{media.currentTime=selected.start;}catch{}}},true);
 dialog.addEventListener('timeupdate',event=>{const media=event.target,clip=active();if(clip&&media.dataset?.clipKey===clip.key&&Number.isFinite(clip.end)&&media.currentTime>=clip.end&&!media.paused){media.pause();try{media.currentTime=clip.start;}catch{}}},true);
 dialog.addEventListener('dragstart',event=>{const target=event.target.closest('[data-cep-drag]');if(!target||busy){event.preventDefault();return;}dragKey=target.dataset.cepDrag;event.dataTransfer?.setData('text/plain',dragKey);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
 dialog.addEventListener('dragover',event=>{if(!busy&&dragKey&&event.target.closest('[data-cep-row]')){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';}});
 dialog.addEventListener('drop',event=>{const target=event.target.closest('[data-cep-row]');if(!target||busy||!dragKey)return;event.preventDefault();move(clips.findIndex(clip=>clip.key===dragKey),Number(target.dataset.cepRow));dragKey=null;});dialog.addEventListener('dragend',()=>{dragKey=null;});
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 return Object.freeze({open(options={}){if(disposed)throw Error('剪辑面板已销毁');if(busy&&current()){if(!dialog.open)dialog.showModal();return;}clearTimeout(saveTimer);pause();projectId=read()?.id;session++;busy=false;returnFocus=doc.activeElement;initial(options,read());render();if(!dialog.open)dialog.showModal();if(message)notify(message);},close,destroy(){if(disposed)return;clearTimeout(saveTimer);pause();session++;disposed=true;busy=false;if(dialog.open)dialog.close();dialog.remove();}});
}
