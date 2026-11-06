import { validateMidiDocument } from './midi-document.js';
import { getMidiBarLines } from './midi-timeline.js';

// A self-contained, non-destructive piano-roll editor. Files and persistence are
// supplied by the host so this component never touches a song project itself.
const copy = value => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const pitchName = pitch => `${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const isEditable = element => !!element?.closest?.('input,select,textarea,[contenteditable="true"]');
const WIDTH = 72, HEIGHT = 24, KEY_WIDTH = 58, MAX_BEATS = 4096;
const MAX_EDIT_NOTES = 2000, MAX_TRACKS = 128, MAX_DOCUMENT_BYTES = 2_000_000;
const MIN_BPM = 60e6 / 0xffffff, MAX_EVENT_BEAT = 1_000_000;
const INSTRUMENT_NAMES = Object.freeze({
  0:'大钢琴',1:'明亮钢琴',2:'电钢琴',4:'电钢琴 1',5:'电钢琴 2',6:'羽管键琴',
  11:'颤音琴',16:'击杆风琴',19:'教堂风琴',21:'手风琴',24:'尼龙弦吉他',25:'钢弦吉他',
  26:'爵士电吉他',27:'清音电吉他',29:'驱动电吉他',30:'失真电吉他',
  32:'原声贝斯',33:'指弹电贝斯',34:'拨片电贝斯',36:'拍弦贝斯',
  40:'小提琴',41:'中提琴',42:'大提琴',43:'低音提琴',46:'竖琴',
  48:'弦乐合奏',49:'慢速弦乐',52:'合唱',56:'小号',57:'长号',60:'圆号',
  64:'高音萨克斯',65:'中音萨克斯',66:'次中音萨克斯',68:'双簧管',71:'单簧管',
  73:'长笛',74:'竖笛',80:'合成主音 1',81:'合成主音 2',88:'合成铺底 1',
  89:'温暖合成铺底',104:'西塔琴',105:'班卓琴',115:'木块',
});

/** Update only the selected track's initial program; later and other-channel events remain intact. */
export function setTrackInstrument(track, program) {
  if (!track || !Number.isInteger(track.channel) || track.channel < 0 || track.channel > 15 || !Number.isInteger(program) || program < 0 || program > 127) throw new Error('MIDI 乐器编号无效');
  track.program = program;
  track.programExplicit = true;
  const firstNoteOrder=(track.notes||[]).reduce((first,n)=>n.start===0&&Number.isInteger(n.startOrder)?Math.min(first,n.startOrder):first,Infinity);
  const ordered=(track.events||[]).map((event,index)=>({event,index})).filter(({event})=>event.beat===0&&event.kind==='channel'&&Array.isArray(event.data)&&(event.data[0]&15)===track.channel)
    .sort((a,b)=>(Number.isInteger(a.event.order)?a.event.order:Number.MAX_SAFE_INTEGER)-(Number.isInteger(b.event.order)?b.event.order:Number.MAX_SAFE_INTEGER)||a.index-b.index);
  const banks=[],moved=new Set();let processedBanks=0,hasInitialProgram=false;
  const moveBeforeFirstNote=event=>{if(Number.isFinite(firstNoteOrder)&&(!Number.isInteger(event.order)||event.order>firstNoteOrder)){event.order=firstNoteOrder;moved.add(event);}};
  for (const {event} of ordered) {
    const kind=event.data[0]&0xf0;
    if(kind===0xb0&&event.data.length===3&&(event.data[1]===0||event.data[1]===32))banks.push(event);
    if(kind===0xc0&&event.data.length===2){
      hasInitialProgram=true;
      event.data[1]=program;
      // If a note preceded the program, move its preceding bank selectors too.
      // Equal source orders put track events before notes; original order within
      // this moved group is retained, and later events are never changed.
      if(Number.isFinite(firstNoteOrder)&&(!Number.isInteger(event.order)||event.order>firstNoteOrder)){
        for(;processedBanks<banks.length;processedBanks++)moveBeforeFirstNote(banks[processedBanks]);
        moveBeforeFirstNote(event);
      }
    }
  }
  if(!hasInitialProgram&&banks.length){
    // A synthesized program must follow existing bank selectors. Without an
    // explicit event the exporter would place its default program before them.
    for(const bank of banks)moveBeforeFirstNote(bank);
    const event={beat:0,kind:'channel',data:[0xc0|track.channel,program]};
    if(Number.isFinite(firstNoteOrder)){event.order=firstNoteOrder;moved.add(event);}
    track.events=Array.isArray(track.events)?track.events:[];
    track.events.push(event);ordered.push({event,index:track.events.length-1});
  }
  if(moved.size>1){const sorted=ordered.map(x=>x.event).filter(event=>moved.has(event));let index=0;track.events=track.events.map(event=>moved.has(event)?sorted[index++]:event);}
  return track;
}

/** Old source orders belong to the old note and timestamps, not an edited event. */
export function updateNoteTiming(note, start, duration, original = {...note}, pitch = note.pitch) {
  note.start=start;note.duration=duration;note.pitch=pitch;
  if(start!==original.start||pitch!==original.pitch){delete note.startOrder;delete note.endOrder;}
  else {
    if(original.startOrder===undefined)delete note.startOrder;else note.startOrder=original.startOrder;
    if(duration!==original.duration||original.endOrder===undefined)delete note.endOrder;else note.endOrder=original.endOrder;
  }
  return note;
}

/** True when a chosen beat grid cannot be represented exactly by MIDI ticks. */
export function gridNeedsTickRounding(ppq, step) {
  const ticks=ppq*step;
  return Number.isFinite(ticks)&&Math.abs(ticks-Math.round(ticks))>1e-9;
}

/** Prefer an unused melodic channel; channel 10 is commonly reserved for drums. */
export function chooseNewTrackChannel(tracks) {
  const counts = Array(16).fill(0);
  for (const track of tracks || []) if (Number.isInteger(track.channel) && track.channel >= 0 && track.channel < 16) counts[track.channel]++;
  const melodic = Array.from({length:16},(_,index)=>index).filter(channel=>channel!==9);
  const free = melodic.find(channel=>counts[channel]===0);
  if (free !== undefined) return {channel:free,shared:false};
  const channel = melodic.reduce((best,candidate)=>counts[candidate]<counts[best]?candidate:best,melodic[0]);
  return {channel,shared:true};
}

/** Conservative per-voice gain for simultaneous synthesized notes. */
export function previewGainForIntervals(intervals) {
  const edges=[];
  for(const interval of intervals){
    if(!Number.isFinite(interval.start)||!Number.isFinite(interval.end)||interval.end<=interval.start)continue;
    edges.push([interval.start,1],[interval.end,-1]);
  }
  edges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let active=0,peak=1;
  for(const edge of edges){active+=edge[1];peak=Math.max(peak,active);}
  return Math.min(.085,.75/peak);
}

function editableCopy(value) {
  if (!value || !Array.isArray(value.tracks)) throw new Error('MIDI 工程格式无效');
  if (value.tracks.length > MAX_TRACKS) throw new Error('暂不支持编辑超过 128 条音轨的 MIDI，原文件未修改。');
  let count = 0;
  for (const track of value.tracks) {
    if (!track || !Array.isArray(track.notes)) throw new Error('MIDI 音轨格式无效');
    count += track.notes.length;
    if (count > MAX_EDIT_NOTES) throw new Error('暂不支持编辑超过 2000 个音符的 MIDI，原文件未修改。');
  }
  const json = JSON.stringify(value);
  if (json.length > MAX_DOCUMENT_BYTES) throw new Error('MIDI 数据过大，暂不支持在编辑器中打开，原文件未修改。');
  validateMidiDocument(value);
  return JSON.parse(json);
}

function pushHistory(stack, value) {
  stack.push(value);
  let size = stack.reduce((sum,item) => sum + JSON.stringify(item).length,0);
  while (stack.length > 1 && (stack.length > 40 || size > 12_000_000)) size -= JSON.stringify(stack.shift()).length;
}

function secondsAtBeat(doc, end) {
  const changes = [...(doc.tempoMap || [])].filter(x => Number.isFinite(x.beat) && x.beat >= 0 && x.bpm > 0).sort((a,b) => a.beat - b.beat);
  let bpm = Number(doc.bpm) || 120, last = 0, result = 0;
  for (const change of changes) {
    if (change.beat > end) break;
    result += (change.beat - last) * 60 / bpm;
    last = change.beat; bpm = change.bpm;
  }
  return result + (end - last) * 60 / bpm;
}

/** Mount the editor. onImport(File) must return a document; onExport(doc)
 * writes the file. onChange(doc) is called only after a committed edit. */
export function mountMidiWorkbench(host, options = {}) {
  if (!host) throw new Error('找不到 MIDI 编辑器容器');
  const abort = new AbortController(), signal = abort.signal;
  let doc = editableCopy(options.document), selectedTrack = 0, selectedNote = null;
  let undo = [], redo = [], drag = null, sound = null, endTimer = null, audioSerial = 0;
  let revision = 0, importSerial = 0, disposed = false;
  let minPitch = 36, maxPitch = 84, gridBeats = 32, dirty = false;
  host.classList.add('mwb');
  host.innerHTML = `<section class="mwb-shell" aria-label="MIDI 音符编辑器">
    <header class="mwb-heading"><div><span class="mwb-eyebrow">MIDI WORKSPACE</span><h2>MIDI 工作台</h2><p>用音符记录旋律和编曲</p></div><div class="mwb-file-actions"><button type="button" data-mwb="new" title="新建 MIDI 工程">新建</button><button type="button" data-mwb="import">导入 MIDI</button><input type="file" accept=".mid,.midi,audio/midi,audio/x-midi" data-mwb-file hidden><button type="button" class="mwb-primary" data-mwb="export">导出 MIDI</button></div></header>
    <div class="mwb-toolbar"><button type="button" class="mwb-play" data-mwb="play" aria-label="试听 MIDI">▶ <span>试听</span></button><button type="button" data-mwb="stop" aria-label="停止试听">■ <span>停止</span></button><span class="mwb-separator"></span><button type="button" data-mwb="undo" title="撤销 (Ctrl+Z)" aria-label="撤销">↶</button><button type="button" data-mwb="redo" title="重做 (Ctrl+Shift+Z)" aria-label="重做">↷</button><label>速度 <input data-mwb-tempo type="number" min="3.576278899686271" max="1000" step="any" aria-label="速度 BPM"> BPM</label><label>拍号 <select data-mwb-meter aria-label="拍号"><option value="4/4">4/4</option><option value="3/4">3/4</option><option value="2/4">2/4</option><option value="6/8">6/8</option></select></label><label>网格 <select data-mwb-snap aria-label="网格吸附"><option value="1">1 拍</option><option value="0.5">1/2 拍</option><option value="0.25" selected>1/4 拍</option><option value="0.125">1/8 拍</option></select></label><span data-mwb-grid-hint style="color:#d5c58a;font-size:11px" hidden></span><span class="mwb-status" data-mwb-status role="status" aria-live="polite"></span></div>
    <div class="mwb-body"><aside class="mwb-tracks"><div class="mwb-section-title"><strong>音轨</strong><button type="button" data-mwb="track-add" title="添加音轨" aria-label="添加音轨">＋</button></div><div class="mwb-track-list" data-mwb-tracks></div><div class="mwb-track-actions"><button type="button" data-mwb="track-rename">重命名</button><button type="button" data-mwb="track-delete">删除音轨</button></div><label style="display:flex;flex-direction:column;gap:6px;margin:16px 5px 0;color:#aeb8ab;font-size:11px">当前音轨乐器<select data-mwb-program aria-label="当前音轨 MIDI 乐器编号" style="width:100%;padding:7px;border:1px solid #3d443d;border-radius:7px;background:#101310;color:#e8eee5"></select></label><p data-mwb-channel-info aria-live="polite" style="display:block;margin-top:7px"></p><p>选择音轨后，在右侧画布添加和编辑音符。</p></aside>
    <main class="mwb-main"><div class="mwb-roll-heading"><div><strong>钢琴卷帘</strong><span data-mwb-track-title></span></div><div class="mwb-roll-help">点击空白处添加音符 · 拖动移动 · 拖动右侧调整长度</div></div><div class="mwb-scroll" data-mwb-scroll tabindex="0" aria-label="钢琴卷帘，点击添加音符，方向键移动所选音符"><div class="mwb-ruler" data-mwb-ruler></div><div class="mwb-grid" data-mwb-grid><div class="mwb-keys" data-mwb-keys></div><div class="mwb-notes" data-mwb-notes></div></div></div><div class="mwb-inspector"><span class="mwb-selection-label" data-mwb-selection>选择一个音符后可编辑</span><label>音高 <input data-mwb-pitch type="number" min="0" max="127" step="1" aria-label="音符音高"></label><label>开始 <input data-mwb-start type="number" min="0" max="1000000" step="0.125" aria-label="音符起始拍"></label><label>时长 <input data-mwb-duration type="number" min="0.01" max="1000000" step="0.125" aria-label="音符时长"></label><label>力度 <input data-mwb-velocity type="number" min="1" max="127" step="1" aria-label="音符力度"></label><button type="button" data-mwb="note-delete">删除音符</button></div><p class="mwb-footnote">试听使用简易合成音色，不还原原文件的音色、踏板和弯音；按 Delete 可删除选中音符。</p></main></div>
  </section>`;
  const q = selector => host.querySelector(selector);
  const grid = q('[data-mwb-grid]'), notesLayer = q('[data-mwb-notes]'), scroll = q('[data-mwb-scroll]');
  const programSelect=q('[data-mwb-program]');
  const inheritedProgram=document.createElement('option');inheritedProgram.value='';inheritedProgram.textContent='继承通道音色（未指定）';inheritedProgram.disabled=true;programSelect.append(inheritedProgram);
  for(let program=0;program<128;program++){const option=document.createElement('option');option.value=String(program);option.textContent=`${program} · ${INSTRUMENT_NAMES[program]||'MIDI 乐器'}`;programSelect.append(option);}
  const active = () => doc.tracks[selectedTrack];
  const note = () => active()?.notes.find(n => n.id === selectedNote);
  const hasContent = () => dirty || (doc.events || []).length > 0 || doc.tracks.some(t => (t.notes || []).length > 0 || (t.events || []).length > 0);
  const status = message => { q('[data-mwb-status]').textContent = message; };
  const sync = () => {
    try {
      const result=options.onChange?.(copy(doc));
      if(result && typeof result.then==='function')result.catch(error=>{if(!disposed)status(error.message||'草稿保存失败，请先导出备份。');});
      return true;
    } catch(error) { status(error.message||'草稿保存失败，请先导出备份。'); return false; }
  };
  const tickRound = value => Math.round(value * doc.ppq) / doc.ppq;
  const snap = value => { const step = Number(q('[data-mwb-snap]').value) || .25; return tickRound(Math.round(value / step) * step); };
  function updateSnapHint(){
    const step=Number(q('[data-mwb-snap]').value),hint=q('[data-mwb-grid-hint]');
    const rounded=gridNeedsTickRounding(doc.ppq,step);
    hint.hidden=!rounded;hint.textContent=rounded?`当前 MIDI 精度为 1/${doc.ppq} 拍，网格会按此精度取整。`:'';
  }
  function stop() {
    audioSerial++;
    if (endTimer) clearTimeout(endTimer); endTimer = null;
    if (sound) { for (const source of sound.sources) { try { source.stop(); } catch {} } sound.ctx.close().catch(() => {}); sound = null; }
    q('[data-mwb=play]').classList.remove('is-playing');
  }
  function remember(before) {
    if (JSON.stringify(before) === JSON.stringify(doc)) return;
    try { editableCopy(doc); }
    catch(error) { doc=before; selectedTrack=clamp(selectedTrack,0,Math.max(0,doc.tracks.length-1));selectedNote=null;render();status(error.message||'修改超出 MIDI 支持范围，已恢复。');return; }
    pushHistory(undo,before); redo = []; dirty = true; revision++; stop(); render(); sync();
  }
  function setDocument(next) {
    const candidate=editableCopy(next);
    stop(); drag = null; doc = candidate; selectedTrack = 0; selectedNote = null; undo = []; redo = []; dirty = false; revision++; render(true); return sync();
  }
  function trackRanges() {
    const all = doc.tracks.flatMap(t => t.notes || []);
    const pitchRange = all.reduce((range,n) => Number.isFinite(n.pitch) ? [Math.min(range[0],n.pitch),Math.max(range[1],n.pitch)] : range,[36,84]);
    minPitch = clamp(pitchRange[0] - 2, 0, 127);
    maxPitch = clamp(pitchRange[1] + 2, minPitch, 127);
    const maxEnd = all.reduce((m,n) => Math.max(m, n.start + n.duration), 0);
    gridBeats = Math.min(MAX_BEATS, Math.max(32, Math.ceil((maxEnd + 4) / 4) * 4));
    if (maxEnd > MAX_BEATS) status('此文件很长：画布显示前 4096 拍，导出仍保留全部音符。');
  }
  function renderTracks() {
    const list = q('[data-mwb-tracks]'); list.replaceChildren();
    doc.tracks.forEach((track,index) => {
      const button = document.createElement('button'); button.type='button'; button.className='mwb-track'+(index===selectedTrack?' is-selected':''); button.dataset.mwbTrack=String(index);
      const symbol=document.createElement('span'); symbol.className='mwb-track-icon'; symbol.textContent='♫';
      const text=document.createElement('span'); text.className='mwb-track-name'; text.textContent=track.name || `音轨 ${index+1}`;
      const count=document.createElement('small'); count.textContent=String((track.notes||[]).length);
      button.append(symbol,text,count); list.append(button);
    });
    q('[data-mwb-track-title]').textContent=active()?.name || '请选择音轨';
    q('[data-mwb=track-delete]').disabled=!active()||doc.tracks.length<=1; q('[data-mwb=track-rename]').disabled=!active();
    programSelect.disabled=!active();programSelect.value=active()?.programExplicit===false?'':String(active()?.program??0);
    const track=active(),other=track&&doc.tracks.some((item,index)=>index!==selectedTrack&&item.channel===track.channel);
    const later=track?.events?.some(event=>event.kind==='channel'&&event.beat>0&&(event.data[0]&0xf0)===0xc0&&(event.data[0]&15)===track.channel);
    q('[data-mwb-channel-info]').textContent=track?(track.channel===9?'通道 10 通常为打击乐，乐器编号的效果取决于播放器。':`MIDI 通道 ${track.channel+1}。`)+(track.programExplicit===false?' 开头未指定乐器，沿用通道音色。':'')+(later?' 此选项修改开头乐器，原有的中途乐器变化会保留。':'')+(other?' 与其他音轨共享通道，播放器中乐器变化可能相互影响；简易试听不会还原此影响。':''):'';
  }
  function renderGrid(scrollToMiddle = false) {
    trackRanges();
    const height=(maxPitch-minPitch+1)*HEIGHT, width=gridBeats*WIDTH;
    grid.style.width=`${width+KEY_WIDTH}px`; grid.style.height=`${height}px`;
    notesLayer.style.left=`${KEY_WIDTH}px`; notesLayer.style.width=`${width}px`; notesLayer.style.height=`${height}px`;
    const ruler=q('[data-mwb-ruler]'); ruler.style.width=`${width+KEY_WIDTH}px`; ruler.replaceChildren();
    const bars=getMidiBarLines(doc,gridBeats);
    for(const bar of bars.lines) {
      const mark=document.createElement('span'); mark.style.left=`${KEY_WIDTH+bar.beat*WIDTH}px`; mark.textContent=String(bar.number); mark.title=`第 ${bar.number} 小节 · ${bar.numerator}/${bar.denominator}`; ruler.append(mark);
    }
    if(bars.truncated)status('小节标尺数量过多，已截断显示；原始拍号和音符仍会保留。');
    const keys=q('[data-mwb-keys]'); keys.style.height=`${height}px`; keys.replaceChildren();
    for(let pitch=maxPitch;pitch>=minPitch;pitch--) {
      const key=document.createElement('div'); key.className='mwb-key'+([1,3,6,8,10].includes(pitch%12)?' is-black':''); key.style.top=`${(maxPitch-pitch)*HEIGHT}px`;
      if(pitch%12===0)key.textContent=pitchName(pitch); keys.append(key);
    }
    renderNotes();
    if(scrollToMiddle) requestAnimationFrame(() => { scroll.scrollTop = Math.max(0,(maxPitch-68)*HEIGHT); });
  }
  function renderNotes() {
    notesLayer.replaceChildren();
    for(const n of active()?.notes || []) {
      if(n.start>=gridBeats || n.pitch<minPitch || n.pitch>maxPitch) continue;
      const button=document.createElement('button'); button.type='button'; button.className='mwb-note'+(n.id===selectedNote?' is-selected':''); button.dataset.mwbNote=n.id;
      button.style.left=`${n.start*WIDTH}px`; button.style.top=`${(maxPitch-n.pitch)*HEIGHT+2}px`; button.style.width=`${Math.max(7,Math.min(n.duration,gridBeats-n.start)*WIDTH-1)}px`;
      button.title=`${pitchName(n.pitch)} · ${n.start.toFixed(2)} 拍 · ${n.duration.toFixed(2)} 拍 · 力度 ${n.velocity}`; button.setAttribute('aria-label',button.title);
      const label=document.createElement('span'); label.textContent=pitchName(n.pitch); const grip=document.createElement('span'); grip.className='mwb-note-grip'; grip.dataset.mwbResize=''; grip.setAttribute('aria-hidden','true'); button.append(label,grip); notesLayer.append(button);
    }
  }
  function renderInspector() {
    const n=note(); q('[data-mwb-selection]').textContent=n?`${pitchName(n.pitch)} · 当前音符`:'选择一个音符后可编辑';
    for(const key of ['pitch','start','duration','velocity']) { const input=q(`[data-mwb-${key}]`); input.disabled=!n; input.value=n?String(n[key]):''; if(key==='duration'){input.min=String(1/doc.ppq);input.step='any';}if(key==='start')input.step='any'; }
    q('[data-mwb=note-delete]').disabled=!n;
  }
  function render(scrollToMiddle = false) {
    selectedTrack=clamp(selectedTrack,0,Math.max(0,doc.tracks.length-1));
    if(!note())selectedNote=null;
    q('[data-mwb-tempo]').value=String(doc.bpm || 120);
    const meter=q('[data-mwb-meter]'), signature=(doc.timeSignature||[4,4]).join('/');
    if(![...meter.options].some(o=>o.value===signature)){ const opt=document.createElement('option'); opt.value=signature; opt.textContent=signature; meter.append(opt); } meter.value=signature;
    q('[data-mwb=undo]').disabled=!undo.length; q('[data-mwb=redo]').disabled=!redo.length;
    updateSnapHint();
    renderTracks(); renderGrid(scrollToMiddle); renderInspector();
  }
  async function play() {
    stop();
    const entries=doc.tracks.flatMap(t=>(t.notes||[]).map(n=>({n,track:t})));
    if(!entries.length) { status('先在画布中添加音符。'); return; }
    if(entries.length>1000) { status('音符超过 1000 个，暂不支持一次试听；文件仍可导出。'); return; }
    if(entries.some(({n})=>secondsAtBeat(doc,n.start+n.duration)>3600)){status('试听时长超过 1 小时，暂不支持一次试听；文件仍可导出。');return;}
    const AudioContextClass=window.AudioContext || window.webkitAudioContext;
    if(!AudioContextClass){status('当前浏览器不支持音频试听。');return;}
    const serial=audioSerial,ctx=new AudioContextClass();
    try{await ctx.resume();}catch(error){ctx.close().catch(()=>{});throw error;}
    if(serial!==audioSerial){ctx.close().catch(()=>{});return;}
    const sources=[]; let end=0;
    const base=ctx.currentTime+.08;
    const schedule=entries.map(({n,track})=>{const start=secondsAtBeat(doc,n.start),finish=secondsAtBeat(doc,n.start+n.duration);return {n,track,start,finish:start+Math.max(.04,finish-start)};});
    const voiceGain=previewGainForIntervals(schedule.map(({start,finish})=>({start,end:finish})));
    const output=ctx.createGain();output.gain.value=1;
    if(typeof ctx.createDynamicsCompressor==='function'){
      const compressor=ctx.createDynamicsCompressor();compressor.threshold.value=-6;compressor.knee.value=6;compressor.ratio.value=12;compressor.attack.value=.003;compressor.release.value=.2;
      output.connect(compressor);compressor.connect(ctx.destination);
    }else output.connect(ctx.destination);
    for(const {n,track,start,finish} of schedule) {
      const length=finish-start, when=base+start;
      const osc=ctx.createOscillator(), gain=ctx.createGain();
      osc.type=track.channel===9?'triangle':(['sine','triangle','sawtooth','square'][Math.floor((track.program||0)/32)] || 'triangle');
      osc.frequency.value=440*2**((n.pitch-69)/12);
      const volume=voiceGain*clamp(n.velocity/127,.01,1);
      gain.gain.setValueAtTime(.0001,when); gain.gain.linearRampToValueAtTime(volume,when+.012);
      gain.gain.setValueAtTime(volume,Math.max(when+.012,when+length-.025)); gain.gain.linearRampToValueAtTime(.0001,when+length);
      osc.connect(gain);gain.connect(output);osc.start(when);osc.stop(when+length+.01);sources.push(osc);end=Math.max(end,finish);
    }
    sound={ctx,sources};q('[data-mwb=play]').classList.add('is-playing');status('正在试听，音色为简易合成音。');
    endTimer=setTimeout(()=>{stop();status('试听结束。');},(end+.2)*1000);
  }
  function undoEdit(direction) {
    const from=direction==='undo'?undo:redo,to=direction==='undo'?redo:undo;if(!from.length)return;
    pushHistory(to,copy(doc));doc=from.pop();selectedNote=null;selectedTrack=clamp(selectedTrack,0,Math.max(0,doc.tracks.length-1));dirty=true;revision++;stop();render();sync();
  }
  function buttonAction(action) {
    if(action==='play')return play().catch(()=>status('音频试听失败，请检查浏览器音频设置。'));
    if(action==='stop'){stop();status('已停止试听。');return;}
    if(action==='undo'||action==='redo')return undoEdit(action);
    if(action==='new'){
      const token=++importSerial;
      if(hasContent() && !window.confirm('新建会替换当前 MIDI 草稿。建议先导出备份，确定继续吗？'))return;
      if(typeof options.onNew!=='function'){status('新建功能未连接。');return;}
      const baseRevision=revision,base=JSON.stringify(doc);
      return Promise.resolve().then(()=>options.onNew()).then(next=>{if(disposed)return;if(token!==importSerial||baseRevision!==revision||drag||base!==JSON.stringify(doc)){status('读取期间工程已变化，未替换当前草稿。');return;}if(next)setDocument(next);}).catch(e=>{if(!disposed)status(e.message||'无法新建工程。');});
    }
    if(action==='import'){importSerial++;return q('[data-mwb-file]').click();}
    if(action==='export'){
      if(typeof options.onExport!=='function'){status('导出功能未连接。');return;}
      const baseRevision=revision,base=JSON.stringify(doc);
      return Promise.resolve().then(()=>options.onExport(copy(doc))).then(()=>{if(disposed)return;if(baseRevision===revision&&!drag&&base===JSON.stringify(doc)){dirty=false;status('MIDI 文件已导出。');}else status('MIDI 已导出，之后的修改尚未导出。');}).catch(e=>{if(!disposed)status(e.message||'导出失败。');});
    }
    if(action==='track-add'){
      if(doc.tracks.length>=MAX_TRACKS){status('最多可编辑 128 条音轨。');return;}
      const before=copy(doc),{channel,shared}=chooseNewTrackChannel(doc.tracks);
      doc.tracks.push({id:uid(),name:`音轨 ${doc.tracks.length+1}`,channel,program:0,programExplicit:true,notes:[]});selectedTrack=doc.tracks.length-1;selectedNote=null;remember(before);if(shared)status(`旋律通道已用完，新音轨与其他音轨共享通道 ${channel+1}。`);return;
    }
    if(action==='track-rename'){
      if(!active())return; const name=window.prompt('音轨名称',active().name||'');if(name===null)return;
      const before=copy(doc); active().name=name.trim().slice(0,100)||'未命名音轨';remember(before);return;
    }
    if(action==='track-delete'){
      if(!active())return;if(doc.tracks.length<=1){status('至少保留一条音轨。');return;}if(!window.confirm(`删除音轨“${active().name || '未命名音轨'}”？可用撤销恢复。`))return;
      const before=copy(doc);doc.tracks.splice(selectedTrack,1);selectedTrack=Math.max(0,selectedTrack-1);selectedNote=null;remember(before);return;
    }
    if(action==='note-delete'){
      if(!note())return;const before=copy(doc);active().notes=active().notes.filter(n=>n.id!==selectedNote);selectedNote=null;remember(before);
    }
  }
  host.addEventListener('click',e=>{
    const track=e.target.closest('[data-mwb-track]');if(track){selectedTrack=Number(track.dataset.mwbTrack);selectedNote=null;render(true);return;}
    const action=e.target.closest('[data-mwb]');if(action)buttonAction(action.dataset.mwb);
  },{signal});
  q('[data-mwb-file]').addEventListener('change',async e=>{
    const token=++importSerial,file=e.target.files?.[0];e.target.value='';if(!file)return;
    if(hasContent() && !window.confirm('导入会替换当前 MIDI 草稿。建议先导出备份，确定继续吗？'))return;
    if(typeof options.onImport!=='function'){status('导入功能未连接。');return;}
    const baseRevision=revision,base=JSON.stringify(doc);
    try{const loaded=await options.onImport(file);if(disposed)return;if(token!==importSerial||baseRevision!==revision||drag||base!==JSON.stringify(doc)){status('导入期间工程已变化，未替换当前草稿。');return;}if(loaded && setDocument(loaded))status('MIDI 已导入。');}catch(error){if(!disposed)status(error.message||'导入失败，请检查 MIDI 文件。');}
  },{signal});
  host.addEventListener('input',e=>{if(e.target.matches('input:not([type=file]),select'))revision++;},{signal});
  q('[data-mwb-snap]').addEventListener('change',updateSnapHint,{signal});
  programSelect.addEventListener('change',e=>{
    const track=active(),program=Number(e.target.value);if(!track||!Number.isInteger(program)||program<0||program>127){renderTracks();return;}
    const before=copy(doc);setTrackInstrument(track,program);remember(before);
    if(doc.tracks.some((item,index)=>index!==selectedTrack&&item.channel===track.channel))status(`通道 ${track.channel+1} 由多个音轨共享，MIDI 播放器中的音色可能相互影响。`);
  },{signal});
  q('[data-mwb-tempo]').addEventListener('change',e=>{
    const value=Number(e.target.value);if(!Number.isFinite(value)||value<MIN_BPM||value>1000){e.target.value=String(doc.bpm||120);status('速度需在 MIDI 支持范围内（约 3.577–1000 BPM）。');return;}
    const before=copy(doc);doc.bpm=value;doc.tempoMap=Array.isArray(doc.tempoMap)?doc.tempoMap:[];
    const first=doc.tempoMap.filter(t=>t.beat===0).at(-1);if(first)first.bpm=value;else doc.tempoMap.unshift({beat:0,bpm:value});remember(before);
  },{signal});
  q('[data-mwb-meter]').addEventListener('change',e=>{
    const [numerator,denominator]=e.target.value.split('/').map(Number),before=copy(doc);doc.timeSignature=[numerator,denominator];doc.timeSignatureMap=Array.isArray(doc.timeSignatureMap)?doc.timeSignatureMap:[];
    const first=doc.timeSignatureMap.filter(t=>t.beat===0).at(-1);if(first){first.numerator=numerator;first.denominator=denominator;}else doc.timeSignatureMap.unshift({beat:0,numerator,denominator});remember(before);
  },{signal});
  for(const key of ['pitch','start','duration','velocity'])q(`[data-mwb-${key}]`).addEventListener('change',e=>{
    const n=note(),v=Number(e.target.value);if(!n||!Number.isFinite(v))return renderInspector();
    const before=copy(doc);
    if(key==='start')updateNoteTiming(n,Math.min(MAX_EVENT_BEAT-n.duration,Math.max(0,tickRound(v))),n.duration);
    else if(key==='duration')updateNoteTiming(n,n.start,Math.min(MAX_EVENT_BEAT-n.start,Math.max(1/doc.ppq,tickRound(v))));
    else if(key==='pitch')updateNoteTiming(n,n.start,n.duration,undefined,Math.round(clamp(v,0,127)));
    else n[key]=Math.round(clamp(v,1,127));
    remember(before);
  },{signal});
  notesLayer.addEventListener('pointerdown',e=>{
    if(e.button!==0 || !active())return;
    e.preventDefault();const target=e.target.closest('[data-mwb-note]'),rect=notesLayer.getBoundingClientRect(),before=copy(doc);
    const point={beat:Math.max(0,(e.clientX-rect.left)/WIDTH),pitch:clamp(maxPitch-Math.floor((e.clientY-rect.top)/HEIGHT),minPitch,maxPitch)};
    if(target)selectedNote=target.dataset.mwbNote;else {if(doc.tracks.reduce((count,track)=>count+track.notes.length,0)>=MAX_EDIT_NOTES){status('最多可编辑 2000 个音符。');return;}const n={id:uid(),pitch:point.pitch,start:snap(point.beat),duration:1,velocity:96};active().notes.push(n);selectedNote=n.id;}
    const n=note(); if(!n)return;
    drag={pointer:e.pointerId,before,originalNote:copy(n),originX:e.clientX,originY:e.clientY,start:n.start,pitch:n.pitch,duration:n.duration,mode:target?(e.target.closest('[data-mwb-resize]')?'resize':'move'):'new'};
    notesLayer.setPointerCapture(e.pointerId);renderNotes();renderInspector();
  },{signal});
  notesLayer.addEventListener('pointermove',e=>{
    if(!drag||drag.pointer!==e.pointerId)return;const n=note();if(!n)return;
    const dx=(e.clientX-drag.originX)/WIDTH,dy=Math.round((e.clientY-drag.originY)/HEIGHT);
    if(drag.mode==='resize'||drag.mode==='new'){
      const offset=drag.mode==='new'&&dx<=.15?0:snap(dx);
      updateNoteTiming(n,drag.start,Math.min(MAX_EVENT_BEAT-drag.start,Math.max(1/doc.ppq,drag.duration+offset)),drag.originalNote);
    }else if(drag.mode==='move'){updateNoteTiming(n,Math.min(MAX_EVENT_BEAT-drag.duration,Math.max(0,drag.start+snap(dx))),drag.duration,drag.originalNote,clamp(drag.pitch-dy,minPitch,maxPitch));}
    renderNotes();renderInspector();
  },{signal});
  function finishPointer(e){if(!drag||drag.pointer!==e.pointerId)return;const before=drag.before;drag=null;remember(before);}
  notesLayer.addEventListener('pointerup',finishPointer,{signal});
  notesLayer.addEventListener('pointercancel',e=>{if(!drag||drag.pointer!==e.pointerId)return;doc=drag.before;drag=null;selectedNote=null;render();},{signal});
  notesLayer.addEventListener('focusin',e=>{
    const target=e.target.closest('[data-mwb-note]');if(!target)return;selectedNote=target.dataset.mwbNote;
    for(const item of notesLayer.querySelectorAll('[data-mwb-note]'))item.classList.toggle('is-selected',item===target);
    renderInspector();
  },{signal});
  host.addEventListener('keydown',e=>{
    if(isEditable(e.target))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undoEdit(e.shiftKey?'redo':'undo');return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();undoEdit('redo');return;}
    if((e.key==='Delete'||e.key==='Backspace')&&note()){e.preventDefault();buttonAction('note-delete');return;}
    const n=note();if(!n||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const before=copy(doc);
    if(e.key==='ArrowUp')updateNoteTiming(n,n.start,n.duration,undefined,clamp(n.pitch+1,0,127));if(e.key==='ArrowDown')updateNoteTiming(n,n.start,n.duration,undefined,clamp(n.pitch-1,0,127));
    const arrowStep=Math.max(1/doc.ppq,Math.abs(snap(Number(q('[data-mwb-snap]').value))));
    if(e.key==='ArrowLeft')updateNoteTiming(n,Math.max(0,n.start-arrowStep),n.duration);if(e.key==='ArrowRight')updateNoteTiming(n,Math.min(MAX_EVENT_BEAT-n.duration,n.start+arrowStep),n.duration);const id=n.id;remember(before);
    [...notesLayer.querySelectorAll('[data-mwb-note]')].find(item=>item.dataset.mwbNote===id)?.focus({preventScroll:true});
  },{signal});
  render(true);
  return {load:setDocument,getDocument:()=>copy(doc),destroy(){disposed=true;importSerial++;stop();abort.abort();host.replaceChildren();host.classList.remove('mwb');}};
}
