import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMidiDocument, parseMidi, exportMidi, validateMidiDocument } from '../public/midi-document.js';

const chunk = data => [0x4d,0x54,0x72,0x6b,(data.length>>>24)&255,(data.length>>>16)&255,(data.length>>>8)&255,data.length&255,...data];
const file = (format, division, tracks) => new Uint8Array([0x4d,0x54,0x68,0x64,0,0,0,6,0,format,0,tracks.length,(division>>>8)&255,division&255,...tracks.flatMap(chunk)]);
const eot = [0,0xff,0x2f,0];

test('multi-track notes, tempo, meter, controllers, pitch bends and sysex survive round trip', () => {
  const doc=createMidiDocument();
  doc.tempoMap=[{beat:0,bpm:120},{beat:4,bpm:90}];
  doc.timeSignatureMap=[{beat:0,numerator:4,denominator:4},{beat:8,numerator:3,denominator:4,clocksPerClick:36,thirtySecondsPerQuarter:8}];
  doc.tracks[0].notes=[{id:'one',pitch:60,start:0,duration:2,velocity:100},{id:'two',pitch:60,start:1,duration:2,velocity:80}];
  doc.tracks[0].events=[{beat:0,kind:'channel',data:[0xb0,64,127]},{beat:1.5,kind:'channel',data:[0xe0,1,65]},{beat:2,kind:'sysex',status:0xf0,data:[125,1,0xf7]},{beat:3,kind:'meta',type:6,data:[109,97,114,107]}];
  doc.tracks.push({id:'drums',name:'鼓组',channel:9,program:0,notes:[{id:'kick',pitch:36,start:2,duration:.5,velocity:120}],events:[]});
  const encoded=exportMidi(doc);
  assert.ok(encoded instanceof Uint8Array);
  const restored=parseMidi(encoded);
  assert.equal(restored.tracks.length,2);
  assert.deepEqual(restored.tracks[0].notes.map(n=>[n.pitch,n.start,n.duration,n.velocity]),[[60,0,2,100],[60,1,2,80]]);
  assert.deepEqual(restored.tempoMap.map(t=>[t.beat,Math.round(t.bpm)]),[[0,120],[4,90]]);
  assert.deepEqual(restored.timeSignatureMap.map(t=>[t.beat,t.numerator,t.denominator]),[[0,4,4],[8,3,4]]);
  assert.equal(restored.tracks[1].channel,9);
  for(const event of doc.tracks[0].events) assert.ok(restored.tracks[0].events.some(e=>e.kind===event.kind && e.beat===event.beat && JSON.stringify(e.data)===JSON.stringify(event.data)));
});

test('format 0 running status and overlapping same-pitch notes retain release pairing', () => {
  const raw=file(0,480,[[0,0x90,60,100,120,60,110,120,0x80,60,64,120,60,65,...eot]]);
  const first=parseMidi(raw);
  assert.deepEqual(first.tracks[0].notes.map(n=>[n.start,n.duration,n.velocity,n.releaseVelocity]),[[0,.5,100,64],[.25,.5,110,65]]);
  const second=parseMidi(exportMidi(first));
  assert.deepEqual(second.tracks[0].notes.map(n=>[n.start,n.duration,n.velocity,n.releaseVelocity]),[[0,.5,100,64],[.25,.5,110,65]]);
});

test('same-tick event ordering and track end silence are preserved', () => {
  const raw=file(0,480,[[0,0x90,60,100,0,0xc0,40,0x83,0x60,0x80,60,0,0x83,0x60,0xff,0x2f,0]]);
  const first=parseMidi(raw);
  assert.equal(first.endBeat,2);
  const second=parseMidi(exportMidi(first));
  const note=second.tracks[0].notes[0], program=second.tracks[0].events.find(e=>e.kind==='channel' && (e.data[0]&0xf0)===0xc0);
  assert.ok(note.startOrder < program.order);
  assert.equal(second.endBeat,2);
  assert.equal(second.tracks[0].endBeat,2);
});

test('the final beat-zero program is shown while every original event stays ordered', () => {
  const raw=file(0,480,[[0,0xc0,3,0,0x90,60,100,0,0xc0,40,0x83,0x60,0x80,60,0,...eot]]);
  const first=parseMidi(raw);
  assert.equal(first.tracks[0].program,40);
  const firstPrograms=first.tracks[0].events.filter(e=>e.kind==='channel' && (e.data[0]&0xf0)===0xc0);
  assert.deepEqual(firstPrograms.map(e=>e.data[1]),[3,40]);
  assert.ok(firstPrograms[0].order < first.tracks[0].notes[0].startOrder);
  assert.ok(first.tracks[0].notes[0].startOrder < firstPrograms[1].order);
  const roundtrip=parseMidi(exportMidi(first));
  const savedPrograms=roundtrip.tracks[0].events.filter(e=>e.kind==='channel' && (e.data[0]&0xf0)===0xc0);
  assert.equal(roundtrip.tracks[0].program,40);
  assert.deepEqual(savedPrograms.map(e=>e.data[1]),[3,40]);
  assert.ok(savedPrograms[0].order < roundtrip.tracks[0].notes[0].startOrder);
  assert.ok(roundtrip.tracks[0].notes[0].startOrder < savedPrograms[1].order);
});

test('the last beat-zero tempo and meter are displayed and all changes round-trip', () => {
  const raw=file(0,480,[[
    0,0xff,0x51,3,0x07,0xa1,0x20, // 120 BPM
    0,0xff,0x51,3,0x09,0x27,0xc0, // 100 BPM
    0,0xff,0x58,4,4,2,24,8,        // 4/4
    0,0xff,0x58,4,3,3,36,8,        // 3/8
    0,0x90,60,100,0x83,0x60,0x80,60,0,...eot,
  ]]);
  const first=parseMidi(raw);
  assert.equal(first.bpm,100);
  assert.deepEqual(first.timeSignature,[3,8]);
  assert.deepEqual(first.tempoMap.map(t=>[t.beat,t.bpm]),[[0,120],[0,100]]);
  assert.deepEqual(first.timeSignatureMap.map(t=>[t.beat,t.numerator,t.denominator,t.clocksPerClick]),[[0,4,4,24],[0,3,8,36]]);
  const restored=parseMidi(exportMidi(first));
  assert.equal(restored.bpm,100);
  assert.deepEqual(restored.timeSignature,[3,8]);
  assert.deepEqual(restored.tempoMap,first.tempoMap);
  assert.deepEqual(restored.timeSignatureMap,first.timeSignatureMap);
});

test('multi-channel format 0 is split by channel without dropping notes', () => {
  const raw=file(0,480,[[0,0x90,60,90,0,0x99,36,110,0x83,0x60,0x80,60,0,0,0x89,36,0,...eot]]);
  const doc=parseMidi(raw);
  assert.deepEqual(doc.tracks.map(t=>t.channel),[0,9]);
  assert.equal(new Set(doc.tracks.map(t=>t.id)).size,2);
  assert.equal(new Set(doc.tracks.flatMap(t=>t.notes.map(n=>n.id))).size,2);
  assert.deepEqual(parseMidi(exportMidi(doc)).tracks.map(t=>t.notes[0].pitch),[60,36]);
});

test('untouched tracks sharing a channel never gain an invented initial program change', () => {
  const raw=file(1,480,[
    [0,0xc0,40,0,0x90,60,90,0x83,0x60,0x80,60,0,...eot],
    [0,0x90,64,90,0x83,0x60,0x80,64,0,...eot],
  ]);
  const imported=parseMidi(raw);
  assert.equal(imported.tracks.length,2);
  assert.equal(imported.tracks[0].program,40);
  assert.equal(imported.tracks[0].programExplicit,true);
  assert.equal(imported.tracks[1].programExplicit,false);
  const restored=parseMidi(exportMidi(imported));
  assert.equal(restored.tracks.length,2);
  assert.equal(restored.tracks[0].program,40);
  assert.equal(restored.tracks[1].programExplicit,false);
  assert.equal(restored.tracks[1].events.filter(e=>e.kind==='channel' && (e.data[0]&0xf0)===0xc0).length,0);
  assert.deepEqual(restored.tracks.map(t=>t.notes.map(n=>n.pitch)),[[60],[64]]);
});

test('unsupported, truncated and unmatched data fails instead of losing notes', () => {
  assert.throws(()=>parseMidi(file(2,480,[eot])),/格式 2/);
  assert.throws(()=>parseMidi(file(1,0xe728,[eot])),/SMPTE/);
  assert.throws(()=>parseMidi(new Uint8Array([0x4d,0x54,0x68,0x64,0])),/不完整/);
  assert.throws(()=>parseMidi(file(0,480,[[0,0x90,60,100,...eot]])),/未结束/);
  assert.throws(()=>parseMidi(file(0,480,[[0x81,0x81,0x81,0x81,0,...eot]])),/可变长度/);
});

test('additional MIDI header bytes are explicitly reported before export', () => {
  const original=file(0,480,[[0,0x90,60,90,0x83,0x60,0x80,60,0,...eot]]);
  const extended=Uint8Array.from([...original.slice(0,7),8,...original.slice(8,14),0xab,0xcd,...original.slice(14)]);
  const imported=parseMidi(extended);
  assert.ok(imported.warnings.some(message=>message.includes('文件头') && message.includes('不会保留')));
  assert.equal(imported.tracks[0].notes[0].pitch,60);
  assert.equal(parseMidi(exportMidi(imported)).tracks[0].notes[0].pitch,60);
});

test('nested same-pitch notes are rejected rather than exported with swapped durations', () => {
  const doc=createMidiDocument();
  doc.tracks[0].notes=[{id:'outer',pitch:60,start:0,duration:4,velocity:90},{id:'inner',pitch:60,start:1,duration:1,velocity:80}];
  assert.throws(()=>exportMidi(doc),/嵌套/);
});

test('an edited same-pitch note-off is placed before a following note-on at the same tick', () => {
  const raw=file(0,480,[[0,0x90,60,90,0x81,0x70,0x80,60,0,0x81,0x70,0x90,60,95,0x83,0x60,0x80,60,0,...eot]]);
  const doc=parseMidi(raw), [first,second]=doc.tracks[0].notes;
  assert.equal(first.duration,.5);
  assert.equal(second.start,1);
  first.duration=1; delete first.endOrder; // UI timing edit.
  const [a,b]=parseMidi(exportMidi(doc)).tracks[0].notes;
  assert.deepEqual([[a.start,a.duration,a.velocity],[b.start,b.duration,b.velocity]],[[0,1,90],[1,1,95]]);
  assert.ok(a.endOrder < b.startOrder, 'edited note-off must precede the next same-pitch note-on');
});

test('an untouched same-tick note-on before note-off retains its original order', () => {
  const raw=file(0,480,[[0,0x90,60,90,0x83,0x60,0x90,60,95,0,0x80,60,0,0x83,0x60,0x80,60,0,...eot]]);
  const doc=parseMidi(raw), [first,second]=doc.tracks[0].notes;
  assert.ok(second.startOrder < first.endOrder);
  const [a,b]=parseMidi(exportMidi(doc)).tracks[0].notes;
  assert.ok(b.startOrder < a.endOrder, 'untouched MIDI order is preserved');
});

test('reordering an edited note-off does not reorder existing controllers and note-ons', () => {
  const raw=file(0,480,[[0,0x90,60,90,0x81,0x70,0x80,60,0,0x81,0x70,0x90,60,95,0,0xb0,64,127,0x83,0x60,0x80,60,0,...eot]]);
  const doc=parseMidi(raw), [first]=doc.tracks[0].notes;
  first.duration=1; delete first.endOrder;
  const track=parseMidi(exportMidi(doc)).tracks[0], [a,b]=track.notes;
  const controller=track.events.find(e=>e.kind==='channel' && e.data[0]===0xb0 && e.data[1]===64);
  assert.ok(a.endOrder < b.startOrder && b.startOrder < controller.order);
});

test('large simultaneous edited handoffs export without pairwise sorting', () => {
  const doc=createMidiDocument();
  for(let i=0;i<1000;i++) {
    const pitch=i%128;
    doc.tracks[0].notes.push({id:`early-${i}`,pitch,start:0,duration:1,velocity:80});
    doc.tracks[0].notes.push({id:`late-${i}`,pitch,start:1,duration:1,velocity:90,startOrder:10000+i,endOrder:20000+i});
  }
  assert.equal(parseMidi(exportMidi(doc)).tracks[0].notes.length,2000);
});

test('edited same-tick same-pitch handoffs across shared-channel tracks are rejected', () => {
  const raw=file(1,480,[
    [0,0x90,60,90,0x83,0x60,0x80,60,0,...eot],
    [0x83,0x60,0x90,60,95,0x83,0x60,0x80,60,0,...eot],
  ]);
  const doc=parseMidi(raw);
  assert.doesNotThrow(()=>exportMidi(doc), 'an unchanged shared-channel MIDI must stay exportable');
  delete doc.tracks[0].notes[0].endOrder; // Simulate an edited note end at the existing handoff.
  assert.throws(()=>exportMidi(doc),/不同音轨.*同一时刻/);
});

test('edited overlapping same-pitch notes on shared-channel tracks are rejected', () => {
  const raw=file(1,480,[
    [0,0x90,60,90,0x83,0x60,0x80,60,0,...eot], // [0,1]
    [0x87,0x40,0x90,60,95,0x83,0x60,0x80,60,0,...eot], // [2,3]
  ]);
  const doc=parseMidi(raw), note=doc.tracks[1].notes[0];
  note.start=.25;note.duration=.25;delete note.startOrder;delete note.endOrder;
  assert.throws(()=>exportMidi(doc),/不同音轨.*重叠音符/); // Nested [0.25,0.5]
  note.start=.5;note.duration=1;
  assert.throws(()=>exportMidi(doc),/不同音轨.*重叠音符/); // Partial overlap [0.5,1.5]
  note.start=1.25;note.duration=.25;
  assert.doesNotThrow(()=>exportMidi(doc), 'non-overlapping edited notes remain exportable');
  note.start=.25;doc.tracks[1].channel=1;
  assert.doesNotThrow(()=>exportMidi(doc), 'notes on separate channels can overlap');
});

test('existing unedited overlaps on shared-channel tracks remain exportable', () => {
  const raw=file(1,480,[
    [0,0x90,60,90,0x83,0x60,0x80,60,0,...eot], // [0,1]
    [120,0x90,60,95,120,0x80,60,0,...eot],       // [0.25,0.5]
  ]);
  const doc=parseMidi(raw), result=parseMidi(exportMidi(doc));
  assert.deepEqual(result.tracks.map(t=>t.notes.map(n=>[n.start,n.duration])),[[[0,1]],[[.25,.25]]]);
});

test('large metadata exports without argument-stack overflow', () => {
  const doc=createMidiDocument();
  doc.tracks[0].events=[{beat:0,kind:'meta',type:1,data:Array(180000).fill(65)}];
  assert.equal(parseMidi(exportMidi(doc)).tracks[0].events.find(e=>e.type===1).data.length,180000);
  assert.throws(()=>validateMidiDocument({...doc,ppq:0}),/精度/);
});
