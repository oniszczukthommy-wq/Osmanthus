import test from 'node:test';
import assert from 'node:assert/strict';
import {showcaseWindow} from '../public/showcase-pager.js';
test('26 desktop videos cover four pages without omissions, max two rows of four',()=>{
 const visited=[];
 for(let page=0;page<4;page++){
  const v=showcaseWindow(26,1200,page);assert.ok(v.end-v.start<=8);
  for(let i=v.start;i<v.end;i++)visited.push(i);
 }
 assert.deepEqual(visited,Array.from({length:26},(_,i)=>i));
});
test('mobile uses two rows of two; resize and invalid page are clamped',()=>{
 assert.deepEqual(showcaseWindow(26,390,6),{page:6,pages:7,start:24,end:26,size:4});
 assert.equal(showcaseWindow(26,1200,6).page,3);
 assert.equal(showcaseWindow(26,390,-1).start,0);
 assert.equal(showcaseWindow(0,390,10).pages,1);
});
