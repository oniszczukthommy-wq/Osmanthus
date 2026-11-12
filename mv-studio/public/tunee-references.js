// Blueprint references are local visual inputs for image generation. The text
// planner receives their count only; these cards do not claim face locking.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eligible=m=>m?.kind==='image'&&UUID.test(m.id||'')&&Number.isFinite(m.bytes)&&m.bytes>0&&m.bytes<=10_000_000;
function safeImage(m){const match=/^\/files\/materials\/([a-f0-9-]{36})\.(png|jpg|jpeg|webp)$/.exec(m?.url||'');return match&&match[1]===m.id?m.url:'';}
export function validateReferences(ids,materials){
 if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!UUID.test(id)))throw Error('最多选择 3 张不同的参考图片');
 const available=new Map((Array.isArray(materials)?materials:[]).filter(eligible).map(m=>[m.id,m]));
 if(ids.some(id=>!available.has(id)))throw Error('所选参考图已失效或超过 10MB，请重新选择');
 return [...ids];
}
export function referenceSection(ids=[],materials=[],disabled=false,urlFor=x=>x){
 const byId=new Map((Array.isArray(materials)?materials:[]).filter(eligible).map(m=>[m.id,m]));
 const selected=(Array.isArray(ids)?ids:[]).map(id=>{const m=byId.get(id),url=safeImage(m);return `<div class="reference-card">${url?`<img src="${esc(urlFor(url))}" alt="${esc(m.name||'参考图')}">`:'<span>素材已不可用</span>'}<span>${esc(m?.name||'请移除后重新选择')}</span><button type="button" data-action="refs-remove" data-ref="${esc(id)}" aria-label="移除 ${esc(m?.name||'参考图')}" ${disabled?'disabled':''}>移除</button></div>`;}).join('');
 return `<section class="blueprint-references"><div class="reference-heading"><strong>视觉参考图</strong><span>${ids.length}/3</span></div><p class="hint">可选择已有图片或上传图片。角色、场景生图时会参考它们；文字创意模型不会读取图片内容。</p><div class="reference-list">${selected}</div><div class="buttons"><button type="button" data-action="refs-choose" ${disabled?'disabled':''}>选择已有图片</button><button type="button" data-action="refs-upload" ${disabled||ids.length>=3?'disabled':''}>上传参考图</button></div><input id="reference-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden></section>`;
}
export function referenceOptions(ids=[],materials=[],urlFor=x=>x){
 const list=(Array.isArray(materials)?materials:[]).filter(eligible);
 if(!list.length)return '<p>素材库暂无符合要求的图片，请先上传。</p>';
 return `<p>最多选择 3 张，每张不超过 10MB。所选图片作为整体视觉参考，不与特定角色一一绑定。</p><div class="candidate-grid">${list.map(m=>{const url=safeImage(m);return `<label class="candidate-option"><input type="checkbox" name="blueprint-reference" value="${esc(m.id)}" ${ids.includes(m.id)?'checked':''}>${url?`<img src="${esc(urlFor(url))}" alt="">`:''}<span>${esc(m.name||'图片素材')}</span></label>`;}).join('')}</div>`;
}
