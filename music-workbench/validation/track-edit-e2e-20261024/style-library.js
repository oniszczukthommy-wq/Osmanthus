// Curated creative directions. Audio examples can be attached later; a text
// direction is sent to the existing creation flow, not an audio reference.
export const STYLE_LIBRARY = [
  {id:'chinese-pop',name:'华语流行',category:'流行',description:'细腻旋律，清晰有层次的人声',tags:['旋律感','现代流行'],prompt:'华语流行，旋律流畅易记，情感细腻清晰，现代流行编曲，钢琴与吉他交织，鼓组层次递进。'},
  {id:'heartfelt-ballad',name:'温柔抒情',category:'治愈',description:'轻柔钢琴，缓缓展开的情绪',tags:['钢琴','温暖'],prompt:'抒情流行，缓慢温柔，钢琴为主，弦乐轻轻铺陈，鼓点克制，旋律自然舒展，副歌情绪逐步提升。'},
  {id:'urban-folk',name:'城市民谣',category:'治愈',description:'木吉他与生活感，温暖朴素',tags:['原声吉他','叙事'],prompt:'城市民谣，温暖自然的木吉他扫弦，轻柔钢琴，简洁低音与轻鼓，旋律有叙事感，编曲循序渐进。'},
  {id:'chinese-rnb',name:'柔情 R&B',category:'节奏',description:'松弛律动，柔和的灵魂质感',tags:['律动','电钢琴'],prompt:'华语 R&B，松弛的中慢速律动，温润电钢琴、圆润贝斯、轻柔鼓机，旋律有呼吸感，副歌层次丰富。'},
  {id:'city-pop',name:'都市夜行',category:'节奏',description:'复古都市流行，轻快又微醺',tags:['City Pop','复古'],prompt:'复古都市流行 City Pop，中速轻快律动，跳跃贝斯、干净电吉他、柔和合成器与鼓组，夜晚城市氛围，旋律明亮顺滑。'},
  {id:'lofi',name:'Lo-fi 漫步',category:'氛围',description:'慵懒节拍，安静的夜晚',tags:['松弛','低保真'],prompt:'Lo-fi 流行，慵懒慢速鼓点，温暖电钢琴与柔和贝斯，细微的磁带颗粒和空间感，情绪平静舒适，旋律简单耐听。'},
  {id:'dream-pop',name:'梦境流行',category:'氛围',description:'轻盈飘渺，宽阔的空间感',tags:['迷幻','柔光'],prompt:'梦境流行，漂浮轻盈的合成器与柔和吉他，缓慢律动，宽阔混响，朦胧而有希望的气氛，旋律清晰。'},
  {id:'pop-rock',name:'热血流行摇滚',category:'流行',description:'有力量的鼓点与明亮吉他',tags:['吉他','热烈'],prompt:'流行摇滚，清晰有力的鼓组，明亮电吉他与稳健贝斯，主歌克制、到副歌逐步爆发，旋律朗朗上口，情绪积极坚定。'},
  {id:'indie-pop',name:'独立流行',category:'流行',description:'轻巧清新，带一点不羁',tags:['清新','吉他'],prompt:'独立流行，轻快中速节奏，干净电吉他、弹性贝斯与简洁鼓组，清新真诚的情绪和有记忆点的副歌。'},
  {id:'chinese-style',name:'新中式',category:'氛围',description:'东方器乐与现代节奏相遇',tags:['东方','现代'],prompt:'新中式流行，以古筝或笛子的东方旋律点缀现代钢琴与弦乐，节奏克制，画面感细腻，现代流行结构。'},
  {id:'electronic-dance',name:'电子舞曲',category:'节奏',description:'明亮合成器，释放活力',tags:['电子','动感'],prompt:'旋律电子舞曲，明亮合成器旋律和富有弹性的电子贝斯，稳定舞曲鼓点，主歌逐渐积蓄能量，副歌开阔明快。'},
  {id:'jazz-lounge',name:'夜色爵士',category:'氛围',description:'柔和爵士和弦与轻摇节拍',tags:['爵士','夜晚'],prompt:'轻爵士流行，温暖电钢琴与柔和爵士和弦，低音提琴和轻刷鼓的松弛节奏，夜晚小酒馆氛围，旋律轻松细腻。'},
  {id:'cinematic',name:'电影叙事',category:'氛围',description:'从安静到辽阔，情绪渐进',tags:['弦乐','电影感'],prompt:'电影感抒情流行，钢琴和弦乐铺陈，氛围由安静逐渐开阔，鼓组在高潮稳步推进，旋律富有画面感。'},
  {id:'bright-acoustic',name:'阳光原声',category:'治愈',description:'轻快木吉他，温柔明亮',tags:['轻快','原声'],prompt:'明亮原声流行，轻快木吉他、温暖钢琴与柔和手鼓，节奏轻盈，旋律轻松明亮并有记忆点，传达温暖与希望。'},
  {id:'synth-pop',name:'霓虹合成器',category:'节奏',description:'复古合成器和流行旋律',tags:['Synth-pop','复古'],prompt:'Synth-pop 合成器流行，复古合成器音色、脉冲贝斯和清晰电子鼓，节奏富有推进感，副歌明亮开阔，旋律鲜明。'},
  {id:'gentle-piano',name:'静谧钢琴',category:'治愈',description:'留白与细节，温柔的情绪',tags:['钢琴','安静'],prompt:'安静抒情，以细腻钢琴为主体，少量柔和弦乐与环境氛围，留出呼吸和空间，缓慢旋律逐渐展开，情感真诚克制。'}
];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const CATEGORIES = ['全部','流行','治愈','节奏','氛围'];

/** Mount the homepage library. onSelect receives {id,name,prompt,...}; it never touches lyrics. */
export function initStyleLibrary({root,onSelect,icons,onPreviewPlay,styles=STYLE_LIBRARY}={}) {
  const home=root?.querySelector('[data-studio-home]'),hero=home?.querySelector('.rs-hero');
  if (!home || !hero || typeof onSelect !== 'function') return null;
  const existing=home.querySelector('[data-style-library]');if(existing) return existing;
  const section=document.createElement('section');section.className='style-library';section.dataset.styleLibrary='';section.setAttribute('aria-label','风格推荐');
  section.innerHTML=`<div class="style-library-heading"><div><h2>发现你的音乐风格</h2><p>从一个喜欢的方向开始，选用后还可以继续修改。</p></div><span class="style-library-caption">风格推荐</span></div><div class="style-library-filters" role="group" aria-label="筛选音乐风格">${CATEGORIES.map((category,i)=>`<button type="button" class="style-library-filter" data-style-filter="${escapeHtml(category)}" aria-pressed="${i===0}">${escapeHtml(category)}</button>`).join('')}</div><div class="style-library-grid"></div>`;
  hero.insertAdjacentElement('afterend',section);
  const grid=section.querySelector('.style-library-grid');let selectedCategory='全部';
  const catalog=styles.filter(style=>style&&typeof style.id==='string'&&typeof style.name==='string'&&typeof style.prompt==='string');
  function render() {
    const items=catalog.filter(style=>selectedCategory==='全部'||style.category===selectedCategory);
    grid.innerHTML=items.map((style,index)=>{
      let preview='';
      if(style.previewUrl){try{const url=new URL(style.previewUrl,location.href);if(url.origin===location.origin&&/^https?:$/.test(url.protocol))preview=url.href;}catch{}}
      const tags=Array.isArray(style.tags)?style.tags.slice(0,2):[];
      return `<article class="style-library-card"><div class="style-library-art style-art-${index%6}" aria-hidden="true"><span class="style-library-art-index">${String(index+1).padStart(2,'0')}</span><span class="style-library-art-symbol">${['◒','◍','◌','◉','◐','◔'][index%6]}</span><span class="style-library-art-lines"></span></div><div class="style-library-card-body"><div class="style-library-card-top"><h3>${escapeHtml(style.name)}</h3><span class="style-library-category">${escapeHtml(style.category)}</span></div><p class="style-library-description">${escapeHtml(style.description)}</p><div class="style-library-tags">${tags.map(tag=>`<span>${escapeHtml(tag)}</span>`).join('')}</div>${preview?`<audio class="style-library-audio" controls preload="none" src="${escapeHtml(preview)}" aria-label="试听${escapeHtml(style.name)}"></audio>`:'<p class="style-library-pending"><span aria-hidden="true">♫</span> 试听音频待补充</p>'}<button type="button" class="style-library-use" data-style-use="${escapeHtml(style.id)}" aria-label="选用${escapeHtml(style.name)}风格"><span>选用风格</span><span aria-hidden="true">↗</span></button></div></article>`;
    }).join('');
    grid.querySelectorAll('audio').forEach(audio=>audio.addEventListener('play',()=>{grid.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});onPreviewPlay?.(audio);}));
  }
  section.addEventListener('click',event=>{
    const filter=event.target.closest('[data-style-filter]');
    if(filter&&section.contains(filter)){selectedCategory=filter.dataset.styleFilter;section.querySelectorAll('[data-style-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button===filter)));render();return;}
    const use=event.target.closest('[data-style-use]');if(!use||!section.contains(use))return;
    const style=catalog.find(item=>item.id===use.dataset.styleUse);if(style)onSelect({...style});
  });
  render();icons?.();return section;
}
