import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}

test('preview button maps 0, 50 and 100 percent to safe segment commands without applying them',async()=>{
 const code=section("const segmentVolume=$('segment-volume')","$('remove-track').onclick=");
 const volume={value:'50',addEventListener(){}},preview={},status={},output={};const calls=[];
 const nodes={'segment-volume':volume,'segment-preview':preview,'segment-preview-status':status,'segment-volume-value':output};
 const ctx={ $:id=>nodes[id]||null,busy:false,project:{duration:20},selected:'drums',selection:[2,5],
   candidateReview:{open:async value=>calls.push(value)},notice(){} };
 vm.runInNewContext(code,ctx);assert.equal(output.textContent,'50%');
 for(const amount of ['0','50','100']){volume.value=amount;await preview.onclick();}
 assert.deepEqual(calls.map(c=>c.segment.mode),['mute','gain','gain']);
 assert.equal(calls[0].segment.gain_db,0);assert.ok(Math.abs(calls[1].segment.gain_db+6.020599913)<1e-6);
 assert.equal(calls[2].segment.gain_db,0);assert.equal(calls[2].segment.track_id,'drums');
 assert.equal(calls[2].segment.start_seconds,2);assert.equal(calls[2].segment.end_seconds,5);
 ctx.selection=[19,21];await preview.onclick();assert.equal(calls.length,3);assert.match(status.textContent,/有效/);
});

test('initial short-song selection stays inside the actual duration',async()=>{
 const code=section('async function loadInitialProject(){','\nawait loadInitialProject();');
 for(const [duration,start,end] of [[6,0,6],[180,30,45]]){
  const inputs={start:{},end:{},ready:{}},ctx={project:null,window:{osmanthusIntegrated:true},$:id=>inputs[id],
    api:async()=>({duration}),render(){},setBusy(){},notice(){},event(){}};
  vm.createContext(ctx);vm.runInContext(code,ctx);await ctx.loadInitialProject();
  assert.equal(inputs.start.value,start);assert.equal(inputs.end.value,end);
 }
});
