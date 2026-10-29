import {OII_PROMPT_TEMPLATES,buildTemplatePrompt,extractTemplateParameters} from './oiioii-canvas-catalog.js';
import {getOutputFormat} from './output-format.js';

const PAGE_SIZE=30,STORAGE_KEY='osmanthus.canvasTemplates.v1';
const ids=new Set(OII_PROMPT_TEMPLATES.map(item=>item.id));
const byId=new Map(OII_PROMPT_TEMPLATES.map(item=>[item.id,item]));
const copy=value=>JSON.parse(JSON.stringify(value));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const array=value=>Array.isArray(value)?value:[];
const safeUrl=value=>typeof value==='string'&&/^https?:\/\//i.test(value)&&!/[\u0000-\u001f]/.test(value)?value:'';

export function normalizeCanvasTemplatePreferences(value={}){
 const clean=(items,max)=>[...new Set(array(items).filter(id=>typeof id==='string'&&ids.has(id)))].slice(0,max);
 return{favorites:clean(value?.favorites,470),recent:clean(value?.recent,60)};
}

export function filterCanvasTemplates(items,{query='',type='all',tab='all',favorites=[],recent=[]}={}){
 const q=String(query).trim().toLocaleLowerCase(),favoriteIds=new Set(favorites);
 let result=array(items).filter(item=>(!['image','video'].includes(type)||item.type===type)&&(tab!=='favorites'||favoriteIds.has(item.id))&&(!q||[item.name,item.title,item.author,item.nativeModel?.method,...array(item.categories),...array(item.tags),item.prompt].join(' ').toLocaleLowerCase().includes(q)));
 if(tab==='recent'){const positions=new Map(recent.map((id,index)=>[id,index]));result=result.filter(item=>positions.has(item.id)).sort((a,b)=>positions.get(a.id)-positions.get(b.id));}
 return result;
}

export function pageCanvasTemplates(items,page=1){
 const total=items.length,pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),current=Math.max(1,Math.min(pages,Number.isFinite(page)?Math.floor(page):1));
 return{items:items.slice((current-1)*PAGE_SIZE,current*PAGE_SIZE),page:current,pages,total,pageSize:PAGE_SIZE};
}

/** Applies only source text/default parameters. The caller owns reference imports and paid execution. */
export function canvasTemplateApplyPayload(template,{values={},ratio=template?.ratio,duration=template?.duration,useExampleReferences=false}={}){
 if(!template||!ids.has(template.id))throw Error('请选择公开模板库中的模板');
 const canonical=byId.get(template.id),format=getOutputFormat(ratio);
 if(typeof useExampleReferences!=='boolean')throw Error('参考图片选项无效');
 const parameters=extractTemplateParameters(canonical),canonicalValues=Object.fromEntries(parameters.map(slot=>[slot.id,Object.hasOwn(values,slot.id)?values[slot.id]:slot.default]));
 // Validation and literal substitution share the catalog helper; unknown fields are rejected.
 buildTemplatePrompt(canonical,values);
 if(canonical.type==='video'&&duration!==null&&(!Number.isInteger(duration)||duration<1||duration>120))throw Error('视频时长需为1至120秒，实际模型支持由工作台确认');
 if(useExampleReferences&&!array(canonical.references?.images).length)throw Error('这个模板没有可用的示例图片参考');
 return{template:copy(canonical),prompt:buildTemplatePrompt(canonical,canonicalValues),ratio:format.ratio,duration:canonical.type==='video'?duration:null,useExampleReferences,values:canonicalValues};
}

export function mountCanvasTemplatePanel({read,toast,onApply,onOpenPrevis}={}){
 if(typeof onApply!=='function')throw Error('模板库需要onApply回调');
 if(read!=null&&typeof read!=='function')throw Error('模板库read需要函数');
 const document=globalThis.document;if(!document)throw Error('模板库需要浏览器文档');
 if(!document.querySelector('link[data-canvas-template-panel-css]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./canvas-template-panel.css',import.meta.url).href;link.dataset.canvasTemplatePanelCss='';document.head.append(link);}
 const dialog=document.createElement('dialog');dialog.className='ctp-dialog';dialog.setAttribute('aria-label','模板库');document.body.append(dialog);
 dialog.innerHTML=`<header class="ctp-header"><div><h2>模板</h2><span>470 个公开模板 · 图片与视频</span></div><div>${typeof onOpenPrevis==='function'?'<button data-ctp-action="previs">3D 机位预演</button>':''}<button data-ctp-action="close" class="ctp-close" aria-label="关闭模板库">×</button></div></header><div class="ctp-toolbar"><label class="ctp-search">⌕ <input data-ctp-search type="search" placeholder="搜索模板、内容或风格" aria-label="搜索模板"></label><div class="ctp-tabs" role="tablist" aria-label="模板范围"></div><label class="ctp-type-label">类型<select data-ctp-type aria-label="模板类型"><option value="all">全部类型</option><option value="image">图片</option><option value="video">视频</option></select></label></div><div class="ctp-body"><section class="ctp-library"><div class="ctp-result-count" aria-live="polite"></div><div class="ctp-grid"></div><div class="ctp-pagination"></div></section><aside class="ctp-detail" aria-label="模板详情" hidden></aside></div><footer class="ctp-footnote">选择模板只会填入提示词与参数。图片由 Qwen、视频由 Wan 执行，生成时由工作台检查模型、参考素材与费用。</footer>`;
 const $=selector=>dialog.querySelector(selector),report=message=>toast?.(String(message?.message||message));
 let prefs={favorites:[],recent:[]},query='',type='all',tab='all',page=1,selected=null,values={},ratio='16:9',duration=null,useExampleReferences=false,busy=false,disposed=false,session=0,projectId=null;
 try{prefs=normalizeCanvasTemplatePreferences(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY)||'{}'));}catch{}
 function savePrefs(){prefs=normalizeCanvasTemplatePreferences(prefs);try{globalThis.localStorage?.setItem(STORAGE_KEY,JSON.stringify(prefs));}catch{report('浏览器未允许保存模板收藏，本次选择仍可使用');}}
 function current(){return selected?byId.get(selected):null;}
 function renderTabs(){$('.ctp-tabs').innerHTML=[['all','全部模板'],['favorites',`收藏 (${prefs.favorites.length})`],['recent','最近使用']].map(([id,label])=>`<button role="tab" aria-selected="${tab===id}" data-ctp-tab="${id}" ${busy?'disabled':''}>${label}</button>`).join('');}
 function renderList(){
  renderTabs();$('[data-ctp-search]').disabled=busy;$('[data-ctp-type]').disabled=busy;const filtered=filterCanvasTemplates(OII_PROMPT_TEMPLATES,{query,type,tab,...prefs}),result=pageCanvasTemplates(filtered,page);page=result.page;
  $('.ctp-result-count').textContent=`${result.total} 个${type==='image'?'图片':type==='video'?'视频':''}模板 · 第 ${page} / ${result.pages} 页`;
  $('.ctp-grid').innerHTML=result.items.map(item=>{const favorite=prefs.favorites.includes(item.id),url=safeUrl(item.coverUrl);return`<article class="ctp-card ${selected===item.id?'is-selected':''}"><button class="ctp-card-open" data-ctp-template="${item.id}" aria-label="查看模板 ${esc(item.name)}" ${busy?'disabled':''}><div class="ctp-card-image"><span class="ctp-card-fallback">${item.type==='video'?'▷':'▧'}</span>${url?`<img src="${esc(url)}" alt="${esc(item.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}<span class="ctp-type-badge">${item.type==='video'?'视频':'图片'}</span>${item.type==='video'&&item.duration?`<span class="ctp-duration">${item.duration}s</span>`:''}</div><strong>${esc(item.name)}</strong><span class="ctp-card-meta">${esc(item.ratio)} · ${esc(item.categories?.[0]||'创作模板')}</span></button><button class="ctp-favorite ${favorite?'is-favorite':''}" data-ctp-favorite="${item.id}" aria-label="${favorite?'取消收藏':'收藏'} ${esc(item.name)}" aria-pressed="${favorite}" ${busy?'disabled':''}>${favorite?'★':'☆'}</button></article>`;}).join('')||`<div class="ctp-empty"><strong>${tab==='favorites'?'还没有收藏模板':tab==='recent'?'还没有使用过模板':'没有匹配的模板'}</strong><p>${tab==='favorites'?'点击卡片上的星号收藏，方便下次使用。':tab==='recent'?'成功应用模板后，会显示在这里。':'试试其他关键词或类型。'}</p></div>`;
  $('.ctp-pagination').innerHTML=`<button data-ctp-action="previous" ${page<=1||busy?'disabled':''}>← 上一页</button><span>${page} / ${result.pages}</span><button data-ctp-action="next" ${page>=result.pages||busy?'disabled':''}>下一页 →</button>`;
 }
 function referenceMarkup(item){
  const images=array(item.referenceUrls?.images).filter(safeUrl),hasImages=array(item.references?.images).length>0,hasVideo=!!item.references?.video,hasAudio=!!item.references?.audio;
  return`<section class="ctp-detail-section"><h3>参考素材</h3><div class="ctp-reference-choice"><label><input type="radio" name="ctp-reference-mode" value="own" ${!useExampleReferences?'checked':''} ${busy?'disabled':''}>使用自己的参考</label><label><input type="radio" name="ctp-reference-mode" value="example" ${useExampleReferences?'checked':''} ${!hasImages||busy?'disabled':''}>使用模板示例参考${hasImages?`（${item.references.images.length} 张图片）`:'（此模板没有示例图片）'}</label></div>${images.length?`<div class="ctp-reference-images">${images.map((url,i)=>`<figure><img src="${esc(url)}" alt="示例参考 ${i+1}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption>图片 ${i+1}</figcaption></figure>`).join('')}</div>`:'<p class="ctp-note">可在画布中添加自己的参考图片，也可以只使用文字提示词。</p>'}<p class="ctp-note" data-ctp-reference-note>${useExampleReferences?'应用模板时才会请求导入所选示例图片，不会触发生成。':'示例图片只作预览。请在画布中选择或上传自己的图片参考。'}</p>${hasVideo?'<p class="ctp-unsupported">此模板包含视频参考。本面板不导入视频参考，需要在画布中另行提供；是否支持由生成执行端确认。</p>':''}${hasAudio?'<p class="ctp-unsupported">此模板包含音频参考。本面板不导入音频参考，需要另行提供；当前执行端不保证支持。</p>':''}</section>`;
 }
 function renderDetail(){
  const item=current(),detail=$('.ctp-detail');detail.hidden=!item;dialog.classList.toggle('has-detail',!!item);if(!item){detail.innerHTML='';return;}
  const parameters=extractTemplateParameters(item),prompt=buildTemplatePrompt(item,values);
  detail.innerHTML=`<div class="ctp-detail-title"><div><span>${item.type==='image'?'图片模板':'视频模板'}</span><h3>${esc(item.name)}</h3></div><button data-ctp-action="close-detail" aria-label="关闭模板详情" ${busy?'disabled':''}>×</button></div>${item.author?`<p class="ctp-author">原作者：${esc(item.author)}</p>`:''}<section class="ctp-detail-section"><h3>输出参数</h3><div class="ctp-output-fields"><label>画面比例<select data-ctp-ratio ${busy?'disabled':''}>${['16:9','4:3','3:2','1:1','3:4','2:3','9:16'].map(value=>`<option ${ratio===value?'selected':''}>${value}</option>`).join('')}</select></label>${item.type==='video'?`<label>时长（秒）<input type="number" data-ctp-duration min="1" max="120" step="1" value="${duration??''}" placeholder="未标注" ${busy?'disabled':''}></label>`:'<span class="ctp-static-field">图片模板 · 无时长</span>'}</div><p class="ctp-note">原站推荐模型：<code>${esc(item.nativeModel?.method||'未标注')}</code></p><p class="ctp-execution">在 Osmanthus 中使用 ${item.type==='image'?'Qwen 图片':'Wan 视频'}执行。原站推荐模型作为来源信息保留。</p>${item.type==='video'?'<p class="ctp-note">时长按模板保留；实际模型是否支持此时长，由工作台确认。</p>':''}</section>${parameters.length?`<section class="ctp-detail-section"><h3>可替换参数 <span>${parameters.length}</span></h3><div class="ctp-parameters">${parameters.map(slot=>`<label>${esc(slot.label)}<textarea data-ctp-parameter="${slot.id}" rows="2" ${busy?'disabled':''}>${esc(values[slot.id]??slot.default)}</textarea></label>`).join('')}</div><button data-ctp-action="reset-values" class="ctp-quiet" ${busy?'disabled':''}>恢复模板默认参数</button></section>`:'<section class="ctp-detail-section"><p class="ctp-note">此模板没有占位参数，完整提示词会直接填入画布。</p></section>'}${referenceMarkup(item)}<section class="ctp-detail-section"><h3>完整提示词 <span data-ctp-prompt-count>${prompt.length} 字</span></h3><textarea class="ctp-prompt-preview" data-ctp-prompt readonly aria-label="完整模板提示词">${esc(prompt)}</textarea></section><div class="ctp-apply-bar"><button data-ctp-action="apply" class="ctp-primary" ${busy?'disabled':''}>${busy?'正在应用模板…':'使用此模板'}</button><span>应用不会自动生成或付费</span></div>`;
 }
 function select(id){if(!byId.has(id))return;selected=id;const item=current();values=Object.fromEntries(extractTemplateParameters(item).map(slot=>[slot.id,slot.default]));ratio=item.ratio;duration=item.type==='video'?item.duration:null;useExampleReferences=false;renderList();renderDetail();$('.ctp-detail').scrollTop=0;}
 function updatePrompt(){const item=current();if(!item)return;const prompt=buildTemplatePrompt(item,values);$('[data-ctp-prompt]').value=prompt;$('[data-ctp-prompt-count]').textContent=`${prompt.length} 字`;}
 async function apply(){
  if(busy||!current())return;const token=session;
  if(read&&projectId!=null&&projectId!==read()?.id)return report('工程已切换，请重新打开模板库');
  let payload;try{payload=canvasTemplateApplyPayload(current(),{values,ratio,duration,useExampleReferences});}catch(error){return report(error);}
  busy=true;dialog.setAttribute('aria-busy','true');renderList();renderDetail();
  try{const accepted=await onApply(payload);if(token!==session||disposed)return;if(accepted===false)return;prefs.recent=[payload.template.id,...prefs.recent.filter(id=>id!==payload.template.id)].slice(0,60);savePrefs();close();}
  catch(error){if(token===session)report(error);}
  finally{if(token===session){busy=false;dialog.removeAttribute('aria-busy');renderList();renderDetail();}}
 }
 dialog.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;const action=button.dataset.ctpAction;if(action==='close')return close();if(busy)return;if(button.dataset.ctpTemplate)return select(button.dataset.ctpTemplate);if(button.dataset.ctpFavorite){const id=button.dataset.ctpFavorite;prefs.favorites=prefs.favorites.includes(id)?prefs.favorites.filter(x=>x!==id):[id,...prefs.favorites];savePrefs();return renderList();}if(button.dataset.ctpTab){tab=button.dataset.ctpTab;page=1;return renderList();}if(action==='previous'){page--;return renderList();}if(action==='next'){page++;return renderList();}if(action==='close-detail'){selected=null;renderList();return renderDetail();}if(action==='reset-values'){const item=current();values=Object.fromEntries(extractTemplateParameters(item).map(slot=>[slot.id,slot.default]));return renderDetail();}if(action==='apply')return apply();if(action==='previs'&&typeof onOpenPrevis==='function'){close();Promise.resolve(onOpenPrevis()).catch(report);}});
 dialog.addEventListener('input',event=>{if(busy)return;const input=event.target;if(input.dataset.ctpSearch!=null){query=input.value;page=1;return renderList();}if(input.dataset.ctpParameter){values[input.dataset.ctpParameter]=input.value;try{updatePrompt();}catch(error){report(error);}}});
 dialog.addEventListener('change',event=>{if(busy)return;const input=event.target;if(input.dataset.ctpType!=null){type=input.value;page=1;return renderList();}if(input.dataset.ctpRatio!=null)ratio=input.value;if(input.dataset.ctpDuration!=null)duration=input.value===''?null:Number(input.value);if(input.name==='ctp-reference-mode'){useExampleReferences=input.value==='example';const note=$('[data-ctp-reference-note]');if(note)note.textContent=useExampleReferences?'应用模板时才会请求导入所选示例图片，不会触发生成。':'示例图片只作预览。请在画布中选择或上传自己的图片参考。';}});
 dialog.addEventListener('error',event=>{if(event.target.tagName==='IMG'){event.target.hidden=true;event.target.closest('figure')?.classList.add('image-unavailable');}},true);
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 function close(){session++;busy=false;dialog.removeAttribute('aria-busy');if(dialog.open)dialog.close();}
 function open(options={}){if(disposed)throw Error('模板库已卸载');close();projectId=read?.()?.id??null;selected=null;values={};query='';page=1;tab='all';type=['image','video'].includes(options.type)?options.type:'all';$('[data-ctp-search]').value='';$('[data-ctp-type]').value=type;renderList();renderDetail();dialog.showModal();$('[data-ctp-search]').focus();return api;}
 const api={open,close,destroy(){close();disposed=true;dialog.remove();}};return api;
}
