// Standard MIDI file model. Musical positions are quarter-note beats.
// The original bytes are never modified; controller and metadata events are
// retained alongside editable notes instead of being silently discarded.
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TRACKS = 256;
const MAX_EVENTS = 250000;
const MAX_BEATS = 1000000;
const MAX_VLQ = 0x0fffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const finite = n => typeof n === 'number' && Number.isFinite(n);
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const fail = message => { throw new Error(message); };
const validBeat = n => finite(n) && n >= 0 && n <= MAX_BEATS;
const validBpm = n => finite(n) && n >= 60e6 / 0xffffff && n <= 1000;
const validDenominator = n => integer(n, 1, 128) && (n & (n - 1)) === 0;
const byteArray = data => Array.isArray(data) && data.every(b => integer(b, 0, 255));

export function createMidiDocument() {
  return {
    version: 1, ppq: 480, bpm: 120, timeSignature: [4, 4],
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSignatureMap: [{ beat: 0, numerator: 4, denominator: 4 }],
    tracks: [{ id: 'track-1', name: '钢琴', channel: 0, program: 0, programExplicit: true, notes: [], events: [] }],
    warnings: [],
  };
}

export function validateMidiDocument(doc) {
  if (!doc || typeof doc !== 'object' || doc.version !== 1) fail('不支持的 MIDI 工程格式');
  if (!integer(doc.ppq, 1, 32767)) fail('MIDI 每拍精度无效');
  if (!validBpm(doc.bpm)) fail('速度超出 MIDI 支持范围');
  if (!Array.isArray(doc.timeSignature) || !integer(doc.timeSignature[0], 1, 255) || !validDenominator(doc.timeSignature[1])) fail('拍号无效');
  if (doc.endBeat !== undefined && !validBeat(doc.endBeat)) fail('MIDI 结束时间无效');
  if (!Array.isArray(doc.tracks) || !doc.tracks.length || doc.tracks.length > MAX_TRACKS) fail('MIDI 轨道数量无效');
  const trackIds = new Set(), noteIds = new Set();
  let count = 0, extraBytes = 0;
  for (const track of doc.tracks) {
    if (!track || typeof track.id !== 'string' || !track.id || trackIds.has(track.id)) fail('轨道标识无效或重复');
    trackIds.add(track.id);
    if (typeof track.name !== 'string' || track.name.length > 1000 || !integer(track.channel, 0, 15) || !integer(track.program, 0, 127)) fail('轨道名称、通道或乐器无效');
    if (track.programExplicit !== undefined && typeof track.programExplicit !== 'boolean') fail('轨道乐器状态无效');
    if (track.endBeat !== undefined && !validBeat(track.endBeat)) fail('轨道结束时间无效');
    if (!Array.isArray(track.notes)) fail('音符列表无效');
    for (const note of track.notes) {
      if (!note || typeof note.id !== 'string' || !note.id || noteIds.has(note.id)) fail('音符标识无效或重复');
      noteIds.add(note.id);
      if (!integer(note.pitch, 0, 127) || !integer(note.velocity, 1, 127) || !validBeat(note.start) || !finite(note.duration) || note.duration <= 0 || note.start + note.duration > MAX_BEATS) fail('音符的音高、力度或时间无效');
      if (note.releaseVelocity !== undefined && !integer(note.releaseVelocity, 0, 127)) fail('音符释放力度无效');
      if ((note.startOrder !== undefined && !integer(note.startOrder, 1, MAX_EVENTS)) || (note.endOrder !== undefined && !integer(note.endOrder, 1, MAX_EVENTS))) fail('音符事件顺序无效');
      count += 2; // Every note is exported as a note-on and note-off.
      if (count > MAX_EVENTS) fail('MIDI 音符或事件过多');
    }
    if (track.events !== undefined && !Array.isArray(track.events)) fail('MIDI 附加事件无效');
    for (const event of track.events || []) {
      if (!event || !validBeat(event.beat) || !byteArray(event.data) || event.data.length > MAX_BYTES) fail('MIDI 附加事件无效');
      if (event.order !== undefined && !integer(event.order, 1, MAX_EVENTS)) fail('MIDI 事件顺序无效');
      extraBytes += event.data.length;
      if (extraBytes > MAX_BYTES) fail('MIDI 附加数据过大');
      if (event.kind === 'channel') {
        const s = event.data[0], kind = s & 0xf0, n = kind === 0xc0 || kind === 0xd0 ? 2 : 3;
        if (!integer(s, 0x80, 0xef) || kind === 0x80 || kind === 0x90 || event.data.length !== n || event.data.slice(1).some(b => b > 127)) fail('MIDI 通道事件无效');
      } else if (event.kind === 'meta') {
        if (!integer(event.type, 0, 127) || [0x2f, 0x51, 0x58].includes(event.type)) fail('MIDI 元事件无效');
      } else if (event.kind === 'sysex') {
        if (![0xf0, 0xf7].includes(event.status)) fail('MIDI 系统消息无效');
      } else fail('不支持的 MIDI 附加事件');
      if (++count > MAX_EVENTS) fail('MIDI 音符或事件过多');
    }
  }
  if (doc.tempoMap !== undefined && (!Array.isArray(doc.tempoMap) || doc.tempoMap.length > MAX_EVENTS || doc.tempoMap.some(t => !t || !validBeat(t.beat) || !validBpm(t.bpm)))) fail('速度变化数据无效');
  if (doc.timeSignatureMap !== undefined && (!Array.isArray(doc.timeSignatureMap) || doc.timeSignatureMap.length > MAX_EVENTS || doc.timeSignatureMap.some(t => !t || !validBeat(t.beat) || !integer(t.numerator, 1, 255) || !validDenominator(t.denominator) || (t.clocksPerClick !== undefined && !integer(t.clocksPerClick, 0, 255)) || (t.thirtySecondsPerQuarter !== undefined && !integer(t.thirtySecondsPerQuarter, 0, 255))))) fail('拍号变化数据无效');
  if (count + (doc.tempoMap?.length || 1) + (doc.timeSignatureMap?.length || 1) + doc.tracks.length * 3 + 1 > MAX_EVENTS) fail('MIDI 音符或事件过多');
  return doc;
}

class Reader {
  constructor(bytes, start = 0, end = bytes.length) { this.bytes = bytes; this.pos = start; this.end = end; }
  need(n) { if (!integer(n, 0, MAX_BYTES) || this.pos + n > this.end) fail('MIDI 文件不完整或数据长度无效'); }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  u16() { return this.u8() * 256 + this.u8(); }
  u32() { return ((this.u8() * 0x1000000) + (this.u8() << 16) + (this.u8() << 8) + this.u8()) >>> 0; }
  take(n) { this.need(n); const out = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return out; }
  text(n) { return String.fromCharCode(...this.take(n)); }
  vlq() { let value = 0; for (let i = 0; i < 4; i++) { const b = this.u8(); value = value * 128 + (b & 127); if (!(b & 128)) return value; } fail('MIDI 可变长度数值无效'); }
}

/** Parse SMF format 0 or 1. Format 2 and SMPTE divisions are rejected. */
export function parseMidi(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else fail('请选择 MIDI 文件');
  if (bytes.length > MAX_BYTES) fail('MIDI 文件超过 20 MB 限制');
  const reader = new Reader(bytes);
  if (reader.text(4) !== 'MThd') fail('不是标准 MIDI 文件');
  const headerLength = reader.u32();
  if (headerLength < 6) fail('MIDI 文件头无效');
  reader.need(headerLength);
  const headerEnd = reader.pos + headerLength;
  const format = reader.u16(), trackCount = reader.u16(), ppq = reader.u16();
  if (format === 2) fail('暂不支持 MIDI 格式 2：各轨道是独立片段');
  if (format > 2) fail('不支持的 MIDI 文件格式');
  if (!trackCount || trackCount > MAX_TRACKS + 1 || (format === 0 && trackCount !== 1)) fail('MIDI 轨道数量无效');
  if (!ppq || (ppq & 0x8000)) fail('暂不支持 SMPTE 时间编码的 MIDI');
  reader.pos = headerEnd;
  const tracks = [], tempoMap = [], timeSignatureMap = [], warnings = [];
  if (headerLength > 6) warnings.push('MIDI 文件头包含额外数据，导出时不会保留。');
  let totalEvents = 0, nextTrack = 0, nextNote = 0, endBeat = 0;
  for (let sourceIndex = 0; sourceIndex < trackCount; sourceIndex++) {
    if (reader.text(4) !== 'MTrk') fail('MIDI 轨道块无效');
    const size = reader.u32(); reader.need(size);
    const chunk = new Reader(bytes, reader.pos, reader.pos + size); reader.pos += size;
    const channels = new Map(), generic = [], open = new Map();
    let ticks = 0, running = 0, name = '', ended = false;
    const channelTrack = channel => {
      if (!channels.has(channel)) channels.set(channel, { channel, program: 0, programExplicit: false, notes: [], events: [] });
      return channels.get(channel);
    };
    while (chunk.pos < chunk.end) {
      if (++totalEvents > MAX_EVENTS) fail('MIDI 事件过多');
      ticks += chunk.vlq();
      const beat = ticks / ppq;
      if (!validBeat(beat)) fail('MIDI 时长超出支持范围');
      let status = chunk.u8(), first = null;
      if (status < 0x80) { if (!running) fail('MIDI running status 无效'); first = status; status = running; }
      else if (status < 0xf0) running = status;
      else running = 0;
      if (status === 0xff) {
        const type = chunk.u8(), payload = Array.from(chunk.take(chunk.vlq()));
        if (type === 0x2f) { if (payload.length) fail('MIDI 轨道结束事件无效'); ended = true; if (chunk.pos !== chunk.end) fail('MIDI 轨道结束后存在多余事件'); break; }
        if (type === 0x51) {
          if (payload.length !== 3) fail('MIDI 速度事件无效');
          const us = payload[0] * 65536 + payload[1] * 256 + payload[2];
          if (!us || !validBpm(60e6 / us)) fail('MIDI 速度超出支持范围');
          tempoMap.push({ beat, bpm: 60e6 / us });
        } else if (type === 0x58) {
          if (payload.length !== 4 || payload[0] < 1 || payload[1] > 7) fail('MIDI 拍号事件无效');
          timeSignatureMap.push({ beat, numerator: payload[0], denominator: 2 ** payload[1], clocksPerClick: payload[2], thirtySecondsPerQuarter: payload[3] });
        } else if (type === 0x03 && !name) {
          name = decoder.decode(new Uint8Array(payload));
          // Keep the original track-name bytes so non-UTF-8 MIDI stays intact.
          generic.push({ beat, kind: 'meta', type, data: payload, order:totalEvents });
        } else generic.push({ beat, kind: 'meta', type, data: payload, order:totalEvents });
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { generic.push({ beat, kind: 'sysex', status, data: Array.from(chunk.take(chunk.vlq())), order:totalEvents }); continue; }
      if (status >= 0xf0) fail('MIDI 包含不支持的系统事件');
      const kind = status & 0xf0, channel = status & 15;
      const a = first === null ? chunk.u8() : first, b = kind === 0xc0 || kind === 0xd0 ? null : chunk.u8();
      if (a > 127 || (b !== null && b > 127)) fail('MIDI 通道事件数据无效');
      const target = channelTrack(channel), key = channel + ':' + a;
      if (kind === 0x90 && b > 0) {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ id: 'note-' + (++nextNote), pitch: a, start: beat, velocity: b, startOrder:totalEvents });
      } else if (kind === 0x80 || kind === 0x90) {
        const queue = open.get(key);
        if (!queue?.length) fail('MIDI 含有未配对的音符结束事件，未导入以免丢失数据');
        const note = queue.shift(); note.duration = beat - note.start;
        if (note.duration <= 0) fail('MIDI 含有零长度音符，未导入以免丢失数据');
        note.releaseVelocity = kind === 0x80 ? b : 0; note.endOrder = totalEvents;
        target.notes.push(note);
      } else {
        // If several changes occur at beat zero, the last one is the final
        // state for that beat. Keep every event below in its original order.
        if (kind === 0xc0 && beat === 0) { target.program = a; target.programExplicit = true; }
        target.events.push({ beat, kind: 'channel', data: b === null ? [status, a] : [status, a, b], order:totalEvents });
      }
    }
    if ([...open.values()].some(queue => queue.length)) fail('MIDI 含有未结束的音符，未导入以免丢失数据');
    if (!ended) warnings.push(`轨道 ${sourceIndex + 1} 缺少标准结束标记，导出时会补齐。`);
    endBeat = Math.max(endBeat, ticks / ppq);
    if (channels.size > 1 && generic.some(e => e.kind === 'sysex')) warnings.push(`轨道 ${sourceIndex + 1} 已按通道拆分；系统消息与其他通道同一时刻的相对顺序可能变化。`);
    // A channel-free tempo/signature conductor need not appear as an empty track.
    if (!channels.size && generic.length) channelTrack(0);
    let first = true;
    for (const item of channels.values()) {
      const trackName = name || `轨道 ${sourceIndex + 1}${channels.size > 1 ? ' · 通道 ' + (item.channel + 1) : ''}`;
      tracks.push({ id: 'track-' + (++nextTrack), name: trackName, channel: item.channel, program: item.program, programExplicit:item.programExplicit, endBeat:ticks/ppq, notes: item.notes.sort((a,b) => a.start-b.start || a.pitch-b.pitch), events: first ? [...item.events, ...generic] : item.events });
      first = false;
      if (tracks.length > MAX_TRACKS) fail('按通道拆分后 MIDI 轨道过多');
    }
  }
  if (reader.pos !== reader.end) warnings.push('文件尾部包含额外数据，导出时不会保留。');
  if (!tracks.length) tracks.push({ id:'track-1', name:'钢琴', channel:0, program:0, programExplicit:false, notes:[], events:[] });
  tempoMap.sort((a,b) => a.beat-b.beat); timeSignatureMap.sort((a,b) => a.beat-b.beat);
  if (!tempoMap.length || tempoMap[0].beat > 0) tempoMap.unshift({ beat:0, bpm:120 });
  if (!timeSignatureMap.length || timeSignatureMap[0].beat > 0) timeSignatureMap.unshift({ beat:0, numerator:4, denominator:4 });
  // Equal-time changes are applied in file order, so the last beat-zero
  // change is the value effective after the initial events have run.
  const initialTempo=tempoMap.filter(t=>t.beat===0).at(-1);
  const initialSignature=timeSignatureMap.filter(t=>t.beat===0).at(-1);
  const doc = { version:1, ppq, bpm:initialTempo.bpm, timeSignature:[initialSignature.numerator,initialSignature.denominator], tempoMap, timeSignatureMap, endBeat, tracks, warnings };
  return validateMidiDocument(doc);
}

function vlq(value) {
  if (!integer(value, 0, MAX_VLQ)) fail('MIDI 事件间隔超出支持范围');
  const out = [value & 127];
  while ((value = Math.floor(value / 128))) out.unshift((value & 127) | 0x80);
  return out;
}
const number32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];

/** Export a validated document as a type-1 Standard MIDI File. */
export function exportMidi(doc) {
  validateMidiDocument(doc);
  let order = 0;
  const tick = beat => Math.round(beat * doc.ppq);
  // Track chunks do not guarantee a common event order between tracks. If an
  // edit creates a same-tick handoff of the same channel/pitch across tracks,
  // refuse rather than guess which note-off a MIDI player will consume.
  const boundaries = new Map(), intervals = new Map();
  const mark = (entry, key, trackIndex) => {
    if (entry[key] === undefined) entry[key] = trackIndex;
    else if (entry[key] !== trackIndex) entry[key] = -1;
  };
  for (let trackIndex=0; trackIndex<doc.tracks.length; trackIndex++) {
    const track=doc.tracks[trackIndex];
    for (const note of track.notes) {
      const firstTick=tick(note.start), lastTick=tick(note.start+note.duration);
      if(lastTick<=firstTick) fail('音符短于 MIDI 精度，请延长音符或提高精度');
      const intervalKey=`${track.channel}/${note.pitch}`;
      let group=intervals.get(intervalKey);if(!group){group={notes:[],edited:false};intervals.set(intervalKey,group);}
      const edited=note.startOrder===undefined||note.endOrder===undefined;
      group.notes.push({start:firstTick,end:lastTick,trackIndex,edited});
      group.edited ||= edited;
      for (const [kind,at,sourceOrder] of [['on',note.start,note.startOrder],['off',note.start+note.duration,note.endOrder]]) {
        const key=`${tick(at)}/${track.channel}/${note.pitch}`;
        let entry=boundaries.get(key);if(!entry){entry={};boundaries.set(key,entry);}
        mark(entry,kind,trackIndex);
        if(sourceOrder===undefined)mark(entry,'edited'+kind,trackIndex);
      }
    }
  }
  const differentTracks = (a,b) => a!==undefined && b!==undefined && (a===-1 || b===-1 || a!==b);
  for (const entry of boundaries.values()) {
    if (differentTracks(entry.editedoff,entry.on) || differentTracks(entry.editedon,entry.off)) fail('不同音轨的相同通道和音高在同一时刻交接，且其中有编辑过的音符；轨间事件顺序无法保证，请错开一个 tick 后导出');
  }
  // MIDI note-offs have no note ID. On the same channel and pitch, edited
  // overlapping notes in different tracks can release each other's voices.
  // A min-heap of active end times avoids comparing every pair of notes.
  for (const group of intervals.values()) {
    if(!group.edited || group.notes.length<2)continue;
    group.notes.sort((a,b)=>a.start-b.start || a.end-b.end || a.trackIndex-b.trackIndex);
    const heap=[], allByTrack=new Map(), editedByTrack=new Map();
    let active=0,activeEdited=0;
    const adjust=(map,key,delta)=>{const count=(map.get(key)||0)+delta;if(count)map.set(key,count);else map.delete(key);};
    const push=item=>{let i=heap.length;heap.push(item);while(i){const p=Math.floor((i-1)/2);if(heap[p].end<=item.end)break;heap[i]=heap[p];i=p;}heap[i]=item;};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(true){const left=i*2+1;if(left>=heap.length)break;const right=left+1,c=right<heap.length&&heap[right].end<heap[left].end?right:left;if(heap[c].end>=last.end)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
    for(const item of group.notes){
      while(heap.length && heap[0].end<=item.start){const done=pop();active--;adjust(allByTrack,done.trackIndex,-1);if(done.edited){activeEdited--;adjust(editedByTrack,done.trackIndex,-1);}}
      const otherActive=active-(allByTrack.get(item.trackIndex)||0);
      const otherEdited=activeEdited-(editedByTrack.get(item.trackIndex)||0);
      if(item.edited ? otherActive>0 : otherEdited>0) fail('不同音轨的相同通道和音高存在修改后的重叠音符，MIDI 无法可靠区分结束事件；请错开音符后导出');
      push(item);active++;adjust(allByTrack,item.trackIndex,1);if(item.edited){activeEdited++;adjust(editedByTrack,item.trackIndex,1);}
    }
  }
  const makeTrack = (events, endBeat = 0) => {
    events.sort((a,b) => {
      if (a.tick !== b.tick) return a.tick-b.tick;
      if (a.sourceOrder !== undefined && b.sourceOrder !== undefined) return a.sourceOrder-b.sourceOrder;
      if (a.sourceOrder !== undefined || b.sourceOrder !== undefined) {
        const aFirst = a.sourceOrder !== undefined ? b.priority !== 0 : a.priority === 0;
        return aFirst ? -1 : 1;
      }
      return a.priority-b.priority || a.order-b.order;
    });
    // Stable post-processing avoids a non-transitive comparison function.
    // Imported events retain their order. Only an edited/new note-off moves
    // before an earlier same-tick note-on of the same channel and pitch.
    const ordered=[];
    for(let start=0;start<events.length;){
      let end=start+1;while(end<events.length&&events[end].tick===events[start].tick)end++;
      const firstOn=new Map(), insertions=new Map(), moved=new Set();
      for(let i=start;i<end;i++){
        const item=events[i], status=item.bytes[0], kind=status&0xf0;
        if(kind!==0x80&&kind!==0x90)continue;
        const key=((status&15)<<7)|item.bytes[1];
        if(kind===0x90){if(!firstOn.has(key))firstOn.set(key,i);}
        else if(item.sourceOrder===undefined&&firstOn.has(key)){
          const target=firstOn.get(key);if(!insertions.has(target))insertions.set(target,[]);
          insertions.get(target).push(item);moved.add(i);
        }
      }
      for(let i=start;i<end;i++){
        if(insertions.has(i))for(const item of insertions.get(i))ordered.push(item);
        if(!moved.has(i))ordered.push(events[i]);
      }
      start=end;
    }
    const data = []; let previous = 0;
    for (const event of ordered) {
      const delta = vlq(event.tick - previous);
      if (data.length + delta.length + event.bytes.length > MAX_BYTES) fail('导出的 MIDI 过大');
      for (const byte of delta) data.push(byte);
      for (const byte of event.bytes) data.push(byte);
      previous = event.tick;
    }
    data.push(...vlq(Math.max(0,tick(endBeat)-previous)), 0xff, 0x2f, 0);
    return [...[0x4d,0x54,0x72,0x6b], ...number32(data.length), ...data];
  };
  const event = (beat, priority, bytes, sourceOrder) => ({ tick:tick(beat), priority, order:order++, sourceOrder, bytes });
  const conductor = [];
  const tempos = doc.tempoMap?.length ? doc.tempoMap : [{beat:0,bpm:doc.bpm}];
  if (!tempos.some(t => t.beat === 0)) conductor.push(event(0, 0, meta(0x51, [(Math.round(60e6/doc.bpm) >>> 16)&255, (Math.round(60e6/doc.bpm) >>> 8)&255, Math.round(60e6/doc.bpm)&255])));
  for (const t of tempos) {
    const us = Math.round(60e6 / t.bpm);
    conductor.push(event(t.beat, 0, meta(0x51, [(us >>> 16) & 255, (us >>> 8) & 255, us & 255])));
  }
  const signatures = doc.timeSignatureMap?.length ? doc.timeSignatureMap : [{beat:0,numerator:doc.timeSignature[0],denominator:doc.timeSignature[1]}];
  if (!signatures.some(t => t.beat === 0)) conductor.push(event(0, 1, meta(0x58, [doc.timeSignature[0], Math.log2(doc.timeSignature[1]), 24, 8])));
  for (const t of signatures) conductor.push(event(t.beat, 1, meta(0x58, [t.numerator, Math.log2(t.denominator), t.clocksPerClick ?? 24, t.thirtySecondsPerQuarter ?? 8])));
  const chunks = [makeTrack(conductor, doc.endBeat ?? 0)];
  for (const track of doc.tracks) {
    const events = [];
    // A single MIDI channel does not identify note-off events by note ID.
    // Reject nested same-pitch notes whose intended durations cannot survive
    // a FIFO MIDI interpretation instead of silently changing their lengths.
    const byPitch = new Map();
    for (const note of track.notes) { if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, []); byPitch.get(note.pitch).push(note); }
    for (const notes of byPitch.values()) {
      notes.sort((a,b) => a.start-b.start || (a.start+a.duration)-(b.start+b.duration));
      for (let i=1; i<notes.length; i++) if (notes[i].start > notes[i-1].start && notes[i].start+notes[i].duration < notes[i-1].start+notes[i-1].duration) fail('同一音轨存在嵌套的同音高音符，请调整后再导出，以免时长发生变化');
    }
    const originalName = (track.events || []).find(e => e.kind === 'meta' && e.type === 3 && e.beat === 0);
    if (!originalName || decoder.decode(new Uint8Array(originalName.data)) !== track.name) events.push(event(0, 0, meta(3, [...encoder.encode(track.name)])));
    const initialProgram = (track.events || []).some(e => e.kind === 'channel' && (e.data[0] & 0xf0) === 0xc0 && (e.data[0] & 15) === track.channel && e.beat === 0);
    if (!initialProgram && track.programExplicit !== false) events.push(event(0, 0, [0xc0 | track.channel, track.program]));
    for (const extra of track.events || []) {
      if (extra.kind === 'meta' && extra.type === 3 && originalName === extra && decoder.decode(new Uint8Array(extra.data)) !== track.name) continue;
      const bytes = extra.kind === 'channel' ? extra.data : extra.kind === 'meta' ? meta(extra.type, extra.data) : [extra.status, ...vlq(extra.data.length), ...extra.data];
      events.push(event(extra.beat, 1, bytes, extra.order));
    }
    const orderedNotes=[...track.notes].sort((a,b)=>a.start-b.start || (a.start+a.duration)-(b.start+b.duration));
    for (const note of orderedNotes) {
      const start = tick(note.start), end = tick(note.start + note.duration);
      if (end <= start) fail('音符短于 MIDI 精度，请延长音符或提高精度');
      events.push({tick:start, priority:3, order:order++, sourceOrder:note.startOrder, bytes:[0x90 | track.channel, note.pitch, note.velocity]});
      events.push({tick:end, priority:2, order:order++, sourceOrder:note.endOrder, bytes:[0x80 | track.channel, note.pitch, note.releaseVelocity ?? 0]});
    }
    chunks.push(makeTrack(events, track.endBeat ?? 0));
  }
  const header = [0x4d,0x54,0x68,0x64,0,0,0,6,0,1,(chunks.length >>> 8)&255,chunks.length&255,(doc.ppq >>> 8)&255,doc.ppq&255];
  const size = header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (size > MAX_BYTES) fail('导出的 MIDI 超过 20 MB 限制');
  const out = new Uint8Array(size); out.set(header); let at = header.length;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
