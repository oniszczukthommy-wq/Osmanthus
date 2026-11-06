import test from 'node:test';
import assert from 'node:assert/strict';
import {importAlignedMusicLyrics,protectTranscription,formatCanvasSRT} from '../public/canvas-editor-panel.js';

const sourceId='source:12345678-1234-4234-8234-123456789012.mp3';
const lyrics=[
 {start:7,end:9,text:'窗外的风'},
 {start:9.5,end:11,text:'第一句'},
 {start:11,end:13.5,text:'第二句'},
 {start:14.5,end:17,text:'尾句'},
 {start:18,end:19,text:'片段之后'},
];
const args={lyrics,music:{id:sourceId,start:10,gain:1},sourceId,duration:6,existingCues:[],srtDirty:false};

test('已对齐歌词使用所选配乐实际起点换算，裁切两端且保留原始输入',()=>{
 const before=JSON.stringify(args);
 const cues=importAlignedMusicLyrics(args);
 assert.deepEqual(cues,[{start:0,end:1,text:'第一句'},{start:1,end:3.5,text:'第二句'},{start:4.5,end:6,text:'尾句'}]);
 assert.equal(JSON.stringify(args),before);
 assert.match(formatCanvasSRT(cues),/00:00:04,500 --> 00:00:06,000/);
});

test('没有已对齐歌词或配乐范围中没有歌词时明确提示，不伪造时间',()=>{
 assert.throws(()=>importAlignedMusicLyrics({...args,lyrics:[]}),/没有已对齐歌词/);
 assert.throws(()=>importAlignedMusicLyrics({...args,lyrics:undefined}),/没有已对齐歌词/);
 assert.throws(()=>importAlignedMusicLyrics({...args,music:{id:sourceId,start:30}}),/范围内没有/);
});

test('只允许来源为当前歌曲，拒绝不同配乐、无配乐和无效时间线',()=>{
 assert.throws(()=>importAlignedMusicLyrics({...args,music:{id:'other-audio',start:0}}),/选为当前歌曲/);
 assert.throws(()=>importAlignedMusicLyrics({...args,music:null}),/选为当前歌曲/);
 assert.throws(()=>importAlignedMusicLyrics({...args,music:{id:sourceId,start:-1}}),/配乐起点/);
 assert.throws(()=>importAlignedMusicLyrics({...args,duration:0}),/选择视频/);
 assert.throws(()=>importAlignedMusicLyrics({...args,duration:61}),/选择视频/);
});

test('已有手工字幕或未应用 SRT 均保护，输入仍原样保留',()=>{
 const existing=[{start:1,end:2,text:'我的字幕'}],before=JSON.stringify(existing);
 assert.throws(()=>importAlignedMusicLyrics({...args,existingCues:existing}),/已有字幕/);
 assert.throws(()=>importAlignedMusicLyrics({...args,srtDirty:true}),/尚未应用/);
 assert.equal(JSON.stringify(existing),before);
});

test('识别前保护未应用 SRT 与重叠字幕，其他时间的字幕不阻止',()=>{
 const cues=[{start:0,end:1,text:'开头'},{start:3,end:4,text:'后面'}];
 assert.throws(()=>protectTranscription({cues,srtDirty:true,start:1,end:3}),/尚未应用/);
 assert.throws(()=>protectTranscription({cues,start:.5,end:1.5}),/已有字幕/);
 assert.doesNotThrow(()=>protectTranscription({cues,start:1,end:3}));
 assert.throws(()=>protectTranscription({cues,start:2,end:2}),/有效/);
});
