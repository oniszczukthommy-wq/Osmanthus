import assert from 'node:assert/strict';
import {lyricSource,lineAt} from './lyrics.js';
const current={id:'one',title:'原工程',source_sha256:'hash'},state={playing:false,currentTime:12},legacy={paused:true,currentTime:4};
const native={id:'two',kind:'preview',time:66.4,song:{title:'正在试听的歌',lyrics:'新的歌词'}};
const source=lyricSource(current,null,state,legacy,native);assert.equal(source.id,'two');assert.equal(source.kind,'candidate');assert.equal(source.time,66.4);assert.equal(source.lyrics,'新的歌词');
const pure=lyricSource(current,null,state,legacy,{...native,song:{instrumental:true}});assert.equal(pure.instrumental,true);
const engine=lyricSource(current,{id:'stale',stage:'generating'},state,legacy,{id:'one',kind:'engine',time:123});assert.equal(engine.kind,'project');assert.equal(engine.time,123);assert.equal(engine.id,'one');
assert.equal(lineAt([],12),-1);assert.equal(lineAt([{start:20,end:24}],12),-1);assert.equal(lineAt([{start:20,end:24}],22),0);assert.equal(lineAt([{start:20,end:24}],24),-1);
console.log('PASS actual native and engine clocks select matching lyric identities; instrumental skips alignment; silence has no invented active line');
