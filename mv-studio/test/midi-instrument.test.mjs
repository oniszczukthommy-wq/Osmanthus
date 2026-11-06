import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMidiDocument, exportMidi, parseMidi, validateMidiDocument } from '../public/midi-document.js';
import { setTrackInstrument, chooseNewTrackChannel, previewGainForIntervals, updateNoteTiming, gridNeedsTickRounding } from '../public/midi-workbench.js';

test('instrument change updates every initial program on the track channel and preserves later and unrelated events', () => {
  const doc=createMidiDocument();
  const track=doc.tracks[0];track.channel=2;track.program=3;
  track.notes=[{id:'n1',pitch:60,start:0,duration:2,velocity:90}];
  track.events=[
    {beat:0,kind:'channel',data:[0xc2,3],order:1},
    {beat:0,kind:'channel',data:[0xc2,8],order:2},
    {beat:0,kind:'channel',data:[0xc3,7],order:3},
    {beat:0,kind:'channel',data:[0xb2,64,127],order:4},
    {beat:1,kind:'channel',data:[0xc2,42],order:5},
    {beat:2,kind:'meta',type:1,data:[65,66],order:6},
  ];
  const original=structuredClone(track.events);
  setTrackInstrument(track,24);
  assert.equal(track.program,24);
  assert.deepEqual(track.events[0].data,[0xc2,24]);
  assert.deepEqual(track.events[1].data,[0xc2,24]);
  assert.deepEqual(track.events.slice(2),original.slice(2));
  assert.doesNotThrow(()=>validateMidiDocument(doc));
});

test('MIDI import, instrument change and export retain the selected initial and later programs', () => {
  const source=createMidiDocument(),track=source.tracks[0];
  track.channel=4;track.program=12;
  track.notes=[{id:'n1',pitch:64,start:0,duration:2,velocity:80}];
  track.events=[
    {beat:0,kind:'channel',data:[0xc4,12],order:1},
    {beat:0,kind:'channel',data:[0xc4,14],order:2},
    {beat:1,kind:'channel',data:[0xc4,40],order:3},
    {beat:1,kind:'channel',data:[0xb4,64,127],order:4},
  ];
  const imported=parseMidi(exportMidi(source));
  const importedTrack=imported.tracks.find(t=>t.channel===4);
  assert.ok(importedTrack);
  setTrackInstrument(importedTrack,25);
  const reopened=parseMidi(exportMidi(imported)).tracks.find(t=>t.channel===4);
  const programs=reopened.events.filter(e=>e.kind==='channel'&&(e.data[0]&0xf0)===0xc0);
  assert.deepEqual(programs.map(e=>[e.beat,e.data[1]]),[[0,25],[0,25],[1,40]]);
  assert.ok(reopened.events.some(e=>e.beat===1&&e.data[0]===0xb4&&e.data[1]===64&&e.data[2]===127));
});

test('editing an initial instrument precedes a same-tick first note without changing untouched imports', () => {
  // Format-0 MIDI: note-on comes before the initial program change at tick 0.
  const bytes=Uint8Array.from([
    0x4d,0x54,0x68,0x64,0,0,0,6,0,0,0,1,1,0xe0,
    0x4d,0x54,0x72,0x6b,0,0,0,16,
    0,0x90,60,64, 0,0xc0,5, 0x83,0x60,0x80,60,0, 0,0xff,0x2f,0,
  ]);
  const imported=parseMidi(bytes),track=imported.tracks[0];
  const initial=track.events.find(e=>e.kind==='channel'&&(e.data[0]&0xf0)===0xc0);
  assert.ok(track.notes[0].startOrder<initial.order);
  const unedited=parseMidi(exportMidi(imported)).tracks[0];
  const originalProgram=unedited.events.find(e=>e.kind==='channel'&&(e.data[0]&0xf0)===0xc0);
  assert.ok(unedited.notes[0].startOrder<originalProgram.order,'an untouched import keeps its original ordering');
  setTrackInstrument(track,48);
  const exported=Buffer.from(exportMidi(imported));
  const reopened=parseMidi(exported).tracks[0];
  const changedProgram=reopened.events.find(e=>e.kind==='channel'&&(e.data[0]&0xf0)===0xc0);
  assert.ok(changedProgram.order<reopened.notes[0].startOrder,'the edited program precedes the note');
  const marker=Buffer.from('MTrk'),first=exported.indexOf(marker,14);
  const second=exported.indexOf(marker,first+8+exported.readUInt32BE(first+4));
  assert.ok(second>first);
  const trackBytes=exported.subarray(second+8,second+8+exported.readUInt32BE(second+4));
  const programPos=trackBytes.indexOf(Buffer.from([0xc0,48])),notePos=trackBytes.indexOf(Buffer.from([0x90,60,64]));
  assert.ok(programPos>=0&&notePos>=0&&programPos<notePos,'raw MIDI bytes place the new program before note-on');
});

test('editing an instrument preserves a bank selection that already precedes the first note', () => {
  const doc=createMidiDocument(),track=doc.tracks[0];
  track.notes=[{id:'note',pitch:60,start:0,duration:1,velocity:90,startOrder:3,endOrder:4}];
  track.events=[
    {beat:0,kind:'channel',data:[0xb0,0,1],order:1},
    {beat:0,kind:'channel',data:[0xc0,5],order:2},
  ];
  setTrackInstrument(track,48);
  assert.equal(track.events[0].order,1);
  assert.equal(track.events[1].order,2);
  const reopened=parseMidi(exportMidi(doc)).tracks[0];
  const bank=reopened.events.find(e=>e.data[0]===0xb0),program=reopened.events.find(e=>e.data[0]===0xc0);
  assert.ok(bank.order<program.order&&program.order<reopened.notes[0].startOrder);
});

test('editing an instrument moves its same-tick bank selects before the first note without changing unrelated events', () => {
  const doc=createMidiDocument(),track=doc.tracks[0];
  track.notes=[{id:'note',pitch:60,start:0,duration:1,velocity:90,startOrder:1,endOrder:8}];
  // Deliberately store events out of array order: their source order remains authoritative.
  track.events=[
    {beat:0,kind:'channel',data:[0xc0,5],order:5},
    {beat:0,kind:'channel',data:[0xb0,32,3],order:4},
    {beat:0,kind:'channel',data:[0xb0,0,2],order:3},
    {beat:0,kind:'channel',data:[0xb0,0,1],order:2},
    {beat:0,kind:'channel',data:[0xb0,7,100],order:6},
    {beat:1,kind:'channel',data:[0xc0,9],order:7},
  ];
  const unrelated=structuredClone(track.events.slice(4));
  const imported=parseMidi(exportMidi(doc)),selected=imported.tracks[0];
  setTrackInstrument(selected,48);
  const reopened=parseMidi(exportMidi(imported)).tracks[0],note=reopened.notes[0];
  const atZero=reopened.events.filter(e=>e.beat===0&&e.kind==='channel');
  const relevant=atZero.filter(e=>e.data[0]===0xc0||(e.data[0]===0xb0&&(e.data[1]===0||e.data[1]===32)));
  assert.deepEqual(relevant.map(e=>e.data),[[0xb0,0,1],[0xb0,0,2],[0xb0,32,3],[0xc0,48]]);
  assert.ok(relevant.every(e=>e.order<note.startOrder));
  const volume=atZero.find(e=>e.data[0]===0xb0&&e.data[1]===7);
  assert.deepEqual(volume.data,unrelated[0].data);assert.ok(volume.order>note.startOrder);
  assert.ok(reopened.events.some(e=>e.beat===1&&e.data[0]===0xc0&&e.data[1]===9));
});

test('tracks without an initial program round trip with the selected instrument', () => {
  const doc=createMidiDocument();setTrackInstrument(doc.tracks[0],48);
  const reopened=parseMidi(exportMidi(doc));
  assert.equal(reopened.tracks[0].program,48);
});

test('explicitly choosing even program zero marks an inherited track as having a program', () => {
  const track=createMidiDocument().tracks[0];track.programExplicit=false;track.program=0;
  setTrackInstrument(track,0);
  assert.equal(track.program,0);assert.equal(track.programExplicit,true);
});

test('editing an inherited shared-channel track emits a program only after an explicit selection', () => {
  const doc=createMidiDocument(),first=doc.tracks[0];
  first.channel=0;first.program=48;first.programExplicit=true;first.notes=[{id:'note-1',pitch:60,start:0,duration:1,velocity:90}];
  doc.tracks.push({id:'track-2',name:'继承音色',channel:0,program:0,programExplicit:false,notes:[{id:'note-2',pitch:64,start:0,duration:1,velocity:90}],events:[]});
  const imported=parseMidi(exportMidi(doc));
  const inherited=imported.tracks.find(track=>track.name==='继承音色');
  assert.ok(inherited);assert.equal(inherited.programExplicit,false);
  assert.equal(inherited.events.filter(e=>e.kind==='channel'&&(e.data[0]&0xf0)===0xc0&&e.beat===0).length,0);
  setTrackInstrument(inherited,0);
  const reopened=parseMidi(exportMidi(imported)).tracks.find(track=>track.name==='继承音色');
  assert.ok(reopened);assert.equal(reopened.programExplicit,true);
  assert.ok(reopened.events.some(e=>e.kind==='channel'&&(e.data[0]&0xf0)===0xc0&&e.beat===0&&e.data[1]===0));
});

test('choosing a program on an inherited track places it after same-tick banks and before the first note', () => {
  const doc=createMidiDocument(),track=doc.tracks[0];track.programExplicit=false;
  track.notes=[{id:'note',pitch:60,start:0,duration:1,velocity:90,startOrder:1,endOrder:5}];
  track.events=[
    {beat:0,kind:'channel',data:[0xb0,0,1],order:2},
    {beat:0,kind:'channel',data:[0xb0,32,3],order:3},
    {beat:0,kind:'channel',data:[0xb0,7,100],order:4},
  ];
  const imported=parseMidi(exportMidi(doc)),selected=imported.tracks[0];
  assert.equal(selected.programExplicit,false);
  assert.ok(selected.notes[0].startOrder<selected.events.find(e=>e.data[1]===0).order);
  setTrackInstrument(selected,48);
  const reopened=parseMidi(exportMidi(imported)).tracks[0],note=reopened.notes[0];
  const atZero=reopened.events.filter(e=>e.beat===0&&e.kind==='channel');
  const relevant=atZero.filter(e=>e.data[0]===0xc0||(e.data[0]===0xb0&&(e.data[1]===0||e.data[1]===32)));
  assert.deepEqual(relevant.map(e=>e.data),[[0xb0,0,1],[0xb0,32,3],[0xc0,48]]);
  assert.ok(relevant.every(e=>e.order<note.startOrder));
  const volume=atZero.find(e=>e.data[0]===0xb0&&e.data[1]===7);
  assert.deepEqual(volume.data,[0xb0,7,100]);assert.ok(volume.order>note.startOrder);
});

test('note timing changes discard only obsolete event ordering and a cancelled drag restores it', () => {
  const original={id:'n',pitch:60,start:0,duration:1,velocity:90,startOrder:1,endOrder:3};
  const note=structuredClone(original);
  updateNoteTiming(note,1,1,original);
  assert.equal(note.startOrder,undefined);assert.equal(note.endOrder,undefined);
  updateNoteTiming(note,original.start,original.duration,original);
  assert.deepEqual(note,original);
  updateNoteTiming(note,0,2);
  assert.equal(note.startOrder,1);assert.equal(note.endOrder,undefined);
});

test('changing note pitch discards obsolete orders and returning to original restores them', () => {
  const original={id:'n',pitch:60,start:0,duration:1,velocity:90,startOrder:1,endOrder:3};
  const note=structuredClone(original);
  updateNoteTiming(note,0,1,original,61);
  assert.equal(note.pitch,61);assert.equal(note.startOrder,undefined);assert.equal(note.endOrder,undefined);
  updateNoteTiming(note,0,1,original,60);
  assert.deepEqual(note,original);
  updateNoteTiming(note,0,2,original,60);
  assert.equal(note.startOrder,1);assert.equal(note.endOrder,undefined);
});

test('changing pitch to a same-tick repeated note does not reuse its old note-on order', () => {
  const doc=createMidiDocument(),track=doc.tracks[0];
  track.notes=[
    {id:'first',pitch:60,start:0,duration:1,velocity:90,startOrder:1,endOrder:4},
    {id:'second',pitch:61,start:1,duration:1,velocity:90,startOrder:3,endOrder:5},
  ];
  const second=track.notes[1];updateNoteTiming(second,second.start,second.duration,undefined,60);
  assert.equal(second.startOrder,undefined);assert.equal(second.endOrder,undefined);
  const reopened=parseMidi(exportMidi(doc)).tracks[0],first=reopened.notes.find(n=>n.start===0),next=reopened.notes.find(n=>n.start===1);
  assert.ok(first&&next);assert.equal(first.pitch,60);assert.equal(next.pitch,60);
  assert.ok(first.endOrder<next.startOrder,'the old note-off precedes the new same-pitch note-on');
});

test('grid warns when its spacing cannot be represented by the imported PPQ', () => {
  assert.equal(gridNeedsTickRounding(1,.25),true);
  assert.equal(gridNeedsTickRounding(3,.5),true);
  assert.equal(gridNeedsTickRounding(480,.125),false);
  assert.equal(gridNeedsTickRounding(1,1),false);
});

test('a moved imported note follows program and controller events at its new timestamps', () => {
  const doc=createMidiDocument(),track=doc.tracks[0];
  track.notes=[{id:'note',pitch:60,start:0,duration:1,velocity:90,startOrder:1,endOrder:3}];
  track.events=[
    {beat:1,kind:'channel',data:[0xc0,40],order:2},
    {beat:2,kind:'channel',data:[0xb0,64,0],order:4},
  ];
  updateNoteTiming(track.notes[0],1,1);
  const reopened=parseMidi(exportMidi(doc)).tracks[0],note=reopened.notes[0];
  const program=reopened.events.find(e=>e.beat===1&&e.data[0]===0xc0);
  const controller=reopened.events.find(e=>e.beat===2&&e.data[0]===0xb0);
  assert.ok(program.order<note.startOrder);assert.ok(controller.order<note.endOrder);
});

test('invalid program is rejected before a track is changed', () => {
  const track=createMidiDocument().tracks[0],before=structuredClone(track);
  for(const bad of [-1,128,3.5,NaN])assert.throws(()=>setTrackInstrument(track,bad));
  assert.deepEqual(track,before);
});

test('new tracks avoid channel 10 and report reuse only after all melodic channels are used', () => {
  const used=Array.from({length:9},(_,channel)=>({channel}));
  assert.deepEqual(chooseNewTrackChannel(used),{channel:10,shared:false});
  const all=Array.from({length:16},(_,channel)=>({channel}));
  assert.deepEqual(chooseNewTrackChannel(all),{channel:0,shared:true});
  assert.deepEqual(chooseNewTrackChannel([{channel:0},{channel:0},{channel:9}]),{channel:1,shared:false});
});

test('preview limits simultaneous voice gain without reducing sequential notes', () => {
  const simultaneous=Array.from({length:100},()=>({start:0,end:1}));
  assert.ok(previewGainForIntervals(simultaneous)*100<=.75);
  const sequential=Array.from({length:100},(_,i)=>({start:i,end:i+1}));
  assert.equal(previewGainForIntervals(sequential),.085);
  assert.equal(previewGainForIntervals([]),.085);
});
