// Curated creative directions; listening samples are not generation inputs.
const LEGACY_STYLE_LIBRARY = [
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

// Keep the previous presets available when restoring drafts made before this
// update, so switching styles preserves the user's own additions.
export const LEGACY_STYLE_PRESETS = LEGACY_STYLE_LIBRARY.map(style=>`【已选风格：${style.name}】${style.prompt}`);

const STYLE_PROMPTS = {
  'chinese-pop':'现代华语流行，中速约 90–100 BPM，旋律流畅、清晰易记，情绪真诚而温暖。钢琴与干净的原声吉他交织，搭配圆润贝斯和层次分明的流行鼓组；主歌克制细腻，预副歌逐渐推进，副歌旋律开阔、有记忆点，桥段稍作留白后回到高潮，结尾自然收束。人声贴近、中文吐字清晰，编曲为歌词留出空间。',
  'heartfelt-ballad':'温柔抒情流行，慢速约 68–76 BPM，以细腻钢琴和柔和弦乐为主，点缀轻柔吉他与克制鼓点。氛围安静、温暖，带一点感伤；主歌留白、娓娓讲述，副歌逐步抬升并增加弦乐层次，桥段短暂回落，最后一段副歌饱满但不过度煽情，尾奏轻柔结束。演唱自然、有呼吸感，突出歌词情绪。',
  'urban-folk':'现代城市民谣，中慢速约 78–90 BPM，以温暖木吉他的指弹与扫弦为核心，搭配轻钢琴、简洁贝斯和柔和手鼓，保留自然的原声质感。氛围朴素真诚、有日常生活画面；主歌像讲故事般娓娓道来，副歌旋律明亮舒展、容易跟唱，间奏用吉他承接，尾奏轻轻收束。人声自然亲切，歌词清晰可辨。',
  'chinese-rnb':'中文流行 R&B，中慢速约 75–85 BPM，节奏松弛，带轻微切分律动。温润电钢琴与柔和合成器铺底，配合圆润贝斯、克制鼓机和细腻打击乐；氛围亲密、慵懒，带一点夜色与暧昧。主歌留有呼吸，副歌通过旋律和少量和声逐渐展开，桥段减薄后自然回归；人声松弛细腻，避免过度堆叠。',
  'city-pop':'复古都市流行 City Pop，中速轻快，带夜晚城市的微醺感。以跳跃贝斯、干净节奏电吉他、复古电钢琴和柔和合成器构建律动，鼓组清晰而轻盈；主歌从容叙述，副歌旋律明亮顺滑，加入适量和声，间奏点缀短小器乐旋律，尾奏自然淡出。',
  'lofi':'Lo-fi 流行，慢速而松弛的节拍，温暖电钢琴、柔和贝斯和简洁鼓组为主，加入适度磁带颗粒与柔软空间感。氛围安静舒适，像夜晚独自散步；主歌保留留白，副歌以细微和声和旋律变化展开，避免过重鼓点，让歌词和人声自然靠前。',
  'dream-pop':'梦境流行，中慢速，轻盈漂浮而带有希望感。以柔和合成器、干净电吉他和朦胧铺底营造宽阔空间，贝斯与鼓点轻柔稳定；主歌亲密低声，副歌逐步加入和声与层次，让旋律清晰可辨，桥段留白，结尾缓缓消散。',
  'pop-rock':'旋律流行摇滚，中速偏快，情绪热烈而坚定。用明亮电吉他、稳健贝斯和有力鼓组推动歌曲，主歌保持克制，预副歌逐步累积能量，副歌打开吉他和鼓组、旋律朗朗上口；桥段短暂减弱后回到高潮，结尾有力而自然。',
  'indie-pop':'清新独立流行，中速轻快，情绪真诚自然，带一点自由不羁。以干净电吉他、弹性贝斯和简洁鼓组为骨架，点缀明亮键盘；主歌轻巧叙事，副歌加入和声与有记忆点的旋律，间奏保持简洁，整体留出呼吸空间。',
  'chinese-style':'新中式流行，中慢速，以古筝或笛子的旋律点缀现代钢琴与柔和弦乐，配合克制的流行节奏。氛围细腻、有东方意境，同时保持现代歌曲的清晰旋律；主歌留白，副歌渐次展开，间奏呼应东方器乐主题，尾奏自然收束。',
  'electronic-dance':'旋律电子舞曲，明快而有活力，稳定舞曲鼓点搭配弹性电子贝斯和明亮合成器。主歌保持轻盈，预副歌逐步积蓄能量，副歌以鲜明旋律和饱满节奏释放情绪；桥段短暂减弱，再回到最后高潮，混音清晰，避免掩盖人声。',
  'jazz-lounge':'轻爵士流行，松弛中慢速，营造温暖夜晚的室内氛围。以柔和爵士和弦、电钢琴、低音提琴和轻刷鼓为主，适量点缀吉他或萨克斯；主歌亲密从容，副歌旋律自然舒展，器乐间奏简短，整体保留呼吸感和即兴质地。',
  'cinematic':'电影感抒情流行，中慢速，从安静逐渐走向辽阔。钢琴与柔和弦乐铺陈，低音和鼓组在情绪上升时逐步加入；主歌细腻叙事，副歌旋律开阔有画面感，桥段回落后迎来最后一次推进，尾奏缓慢收束，突出情绪层次。',
  'bright-acoustic':'阳光原声流行，中速轻快，以木吉他扫弦、温暖钢琴和柔和手鼓为主，搭配简洁贝斯。氛围轻松明亮，传达温暖与希望；主歌自然叙述，副歌旋律上扬、容易跟唱，适量和声增加亲切感，结尾轻盈而完整。',
  'synth-pop':'复古合成器流行 Synth-pop，中速，具有霓虹夜色与向前推进的能量。以脉冲贝斯、复古合成器和清晰电子鼓构建律动，主歌留出空间，预副歌逐渐叠加音色，副歌明亮开阔、旋律鲜明，桥段变化后回到主旋律。',
  'gentle-piano':'静谧钢琴抒情，慢速，以细腻钢琴为主体，少量柔和弦乐和环境氛围作点缀。情绪真诚克制，音符之间保留呼吸与空间；主歌轻声讲述，副歌旋律稍微抬升并增加弦乐，高潮不过度堆叠，尾奏回到安静的钢琴。'
};

export const STYLE_LIBRARY = LEGACY_STYLE_LIBRARY.map(style=>({...style,prompt:STYLE_PROMPTS[style.id] || style.prompt}));

// Each excerpt keeps its original credit and licence alongside the player.
const PREVIEW_CREDITS = {
  "chinese-pop": {
    "title": "心跳的声音",
    "artist": "Adeline Yeo (HP)",
    "source": "https://freemusicarchive.org/music/adeline-yeo-hp/single/xintiaodeshengyin/",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "中文演唱，AI 人声"
  },
  "heartfelt-ballad": {
    "title": "在你离开后",
    "artist": "Adeline Yeo (HP)",
    "source": "https://freemusicarchive.org/music/adeline-yeo-hp/single/zainilikaihou/",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "中文抒情演唱参考"
  },
  "urban-folk": {
    "title": "Clear Air",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100626",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "原声器乐参考"
  },
  "chinese-rnb": {
    "title": "Slow Jam",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600015",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "R&B 器乐参考"
  },
  "city-pop": {
    "title": "Chill Wave",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600048",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "复古电子器乐参考，与 City Pop 有差异"
  },
  "lofi": {
    "title": "Dream Catcher",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1800019",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "Lo-fi 电子器乐参考"
  },
  "dream-pop": {
    "title": "Dream Pop",
    "artist": "HoliznaCC0",
    "source": "https://freemusicarchive.org/music/holiznacc0/only-in-the-milky-way-part-3/dream-pop/",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "note": "氛围器乐参考"
  },
  "pop-rock": {
    "title": "Americana",
    "artist": "HoliznaCC0",
    "source": "https://freemusicarchive.org/music/holiznacc0/rock-montage/americana-1/",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "note": "流行摇滚器乐参考"
  },
  "indie-pop": {
    "title": "Paper Mate",
    "artist": "HoliznaCC0",
    "source": "https://freemusicarchive.org/music/holiznacc0/washed-up/paper-mate/",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "note": "独立流行参考，含英文演唱"
  },
  "chinese-style": {
    "title": "Shenyang",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600066",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "东方传统器乐参考，现代编曲有所不同"
  },
  "electronic-dance": {
    "title": "Dance Robot ACTIVATE",
    "artist": "Loyalty Freak Music",
    "source": "https://freemusicarchive.org/music/Loyalty_Freak_Music/ROLLER_DISCO_DANCE_DANCE/Loyalty_Freak_Music_-_ROLLER_DISCO_DANCE_DANCE_-_02_Dance_Robot_ACTIVATE/",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "note": "电子舞曲器乐参考"
  },
  "jazz-lounge": {
    "title": "Long Stroll",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100174",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "爵士器乐参考"
  },
  "cinematic": {
    "title": "Eternal Hope",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100238",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "电影配乐器乐参考"
  },
  "bright-acoustic": {
    "title": "Happy Alley",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100482",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "原声器乐参考"
  },
  "synth-pop": {
    "title": "Newer Wave",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN2000024",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "复古合成器器乐参考"
  },
  "gentle-piano": {
    "title": "Meditation Impromptu 01",
    "artist": "Kevin MacLeod",
    "source": "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100163",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "note": "钢琴器乐参考"
  }
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const CATEGORIES = ['全部','流行','治愈','节奏','氛围'];
const COVER_IDS = new Set(STYLE_LIBRARY.map(style=>style.id));

/** Mount the homepage library. onSelect receives {id,name,prompt,...}; it never touches lyrics. */
export function initStyleLibrary({root,onSelect,icons,onPreviewPlay,styles=STYLE_LIBRARY}={}) {
  const home=root?.querySelector('[data-studio-home]'),hero=home?.querySelector('.rs-hero');
  if (!home || !hero || typeof onSelect !== 'function') return null;
  const existing=home.querySelector('[data-style-library]');if(existing) return existing;
  const section=document.createElement('section');section.className='style-library';section.dataset.styleLibrary='';section.setAttribute('aria-label','风格推荐');
  section.innerHTML=`<div class="style-library-heading"><div><h2>发现你的音乐风格</h2><p>试听是风格参考，选用后可以继续修改。</p></div></div><div class="style-library-filters" role="group" aria-label="筛选音乐风格">${CATEGORIES.map((category,i)=>`<button type="button" class="style-library-filter" data-style-filter="${escapeHtml(category)}" aria-pressed="${i===0}">${escapeHtml(category)}</button>`).join('')}</div><div class="style-library-grid"></div>`;
  hero.insertAdjacentElement('afterend',section);
  const grid=section.querySelector('.style-library-grid');let selectedCategory='全部';
  // The main player can call this when a song starts. Keep the mounted
  // section as the return value so existing callers remain compatible.
  function pausePreview(){grid.querySelectorAll('audio').forEach(audio=>audio.pause());}
  section.pausePreview=pausePreview;
  const catalog=styles.filter(style=>style&&typeof style.id==='string'&&typeof style.name==='string'&&typeof style.prompt==='string').map(style=>({...style}));
  function render() {
    const items=catalog.filter(style=>selectedCategory==='全部'||style.category===selectedCategory);
    grid.innerHTML=items.map(style=>{
      let preview='';
      if(style.previewUrl){try{const url=new URL(style.previewUrl,location.href);if(url.origin===location.origin&&/^https?:$/.test(url.protocol))preview=url.href;}catch{}}
      const tags=Array.isArray(style.tags)?style.tags.slice(0,2):[];
      const cover=COVER_IDS.has(style.id)?`<img src="/assets/style-covers/${encodeURIComponent(style.id)}.webp" alt="" loading="lazy" decoding="async">`:'';
      const credit=PREVIEW_CREDITS[style.id];
      const info=credit?`<p class="style-library-preview-note">${escapeHtml(credit.note)}</p><details class="style-library-credit"><summary>样曲信息</summary><p>${escapeHtml(credit.title)} · ${escapeHtml(credit.artist)}<br><a href="${escapeHtml(credit.source)}" target="_blank" rel="noopener noreferrer">原曲来源</a> · <a href="${escapeHtml(credit.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(credit.license)}</a> · 已截取、调整音量</p></details>`:'';
      const sample=preview?`<audio class="style-library-audio" controls preload="none" src="${escapeHtml(preview)}" aria-label="试听${escapeHtml(style.name)}"></audio>${info}`:'<p class="style-library-pending"><span aria-hidden="true">♫</span> 试听音频待补充</p>';
      return `<article class="style-library-card"><div class="style-library-card-body"><div class="style-library-card-header"><div class="style-library-art" aria-hidden="true">${cover}</div><div class="style-library-card-info"><div class="style-library-card-top"><h3>${escapeHtml(style.name)}</h3><span class="style-library-category">${escapeHtml(style.category)}</span></div><p class="style-library-description">${escapeHtml(style.description)}</p></div></div><div class="style-library-tags">${tags.map(tag=>`<span>${escapeHtml(tag)}</span>`).join('')}</div>${sample}<button type="button" class="style-library-use" data-style-use="${escapeHtml(style.id)}" aria-label="选用${escapeHtml(style.name)}风格"><span>选用风格</span><span aria-hidden="true">↗</span></button></div></article>`;
    }).join('');
    grid.querySelectorAll('audio').forEach(audio=>audio.addEventListener('play',()=>{grid.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});onPreviewPlay?.(audio);}));
  }
  async function loadLocalPreviews(){
    try{
      const response=await fetch('/api/style-previews',{cache:'no-store'});
      if(!response.ok)return;
      const data=await response.json();if(!Array.isArray(data?.ids))return;
      const ids=new Set(data.ids.filter(id=>typeof id==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)));
      let changed=false;
      for(const style of catalog)if(ids.has(style.id)&&!style.previewUrl){
        style.previewUrl=`/style-previews/${encodeURIComponent(style.id)}.mp3`;changed=true;
      }
      if(changed){pausePreview();render();}
    }catch{/* A missing catalog leaves the honest pending state. */}
  }
  section.addEventListener('click',event=>{
    const filter=event.target.closest('[data-style-filter]');
    if(filter&&section.contains(filter)){pausePreview();selectedCategory=filter.dataset.styleFilter;section.querySelectorAll('[data-style-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button===filter)));render();return;}
    const use=event.target.closest('[data-style-use]');if(!use||!section.contains(use))return;
    const style=catalog.find(item=>item.id===use.dataset.styleUse);if(style){pausePreview();onSelect({...style});}
  });
  render();
  void loadLocalPreviews();
  if(typeof MutationObserver!=='undefined'){const observer=new MutationObserver(()=>{if(!root.classList.contains('is-home'))pausePreview();});observer.observe(root,{attributes:true,attributeFilter:['class']});}
  window.addEventListener('pagehide',pausePreview);
  icons?.();return section;
}
