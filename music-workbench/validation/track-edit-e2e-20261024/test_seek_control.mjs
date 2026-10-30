import assert from 'node:assert/strict';
import {initializeSeekControl} from './seek-control.js';
class Hub{listeners=new Map();addEventListener(t,f){this.listeners.set(t,f);}removeEventListener(t){this.listeners.delete(t);}fire(t){this.listeners.get(t)?.({type:t,preventDefault(){}});}}
function fixture(){const view=new Hub(),input=new Hub();input.ownerDocument={defaultView:view};input.value=0;let at=20,playing=true,p={id:'one',duration:200.729},allowed=true;const resumes=[],notifications=[];
 const control=initializeSeekControl({input,getProject:()=>p,getTime:()=>at,getEnd:()=>p.duration,isPlaying:()=>playing,canSeek:()=>allowed,pause:()=>{playing=false;},setTime:v=>{at=v;},resume:(...args)=>{resumes.push(args);},onSeek:v=>notifications.push(v)});
 return{view,input,control,resumes,notifications,get at(){return at;},setProject:v=>p=v,disallow:()=>allowed=false};}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name);}
test('dragging pauses once and commits only the last requested point',()=>{const f=fixture();f.input.fire('pointerdown');for(const v of [50,100,160]){f.input.value=v;f.input.fire('input');}assert.equal(f.control.dragging,true);assert.equal(f.resumes.length,0);f.view.fire('pointerup');assert.equal(f.at,160);assert.equal(f.resumes.length,1);assert.equal(f.control.dragging,false);});
test('end of song is reachable and never restarts at zero',()=>{const f=fixture();f.input.fire('pointerdown');f.input.value=200.729;f.input.fire('input');f.input.fire('change');f.view.fire('pointerup');assert.equal(f.at,200.729);assert.equal(f.resumes.length,0);assert.equal(f.notifications.length,1);});
test('a newer seek invalidates an older asynchronous resume',()=>{const f=fixture();f.input.value=80;f.input.fire('input');const valid=f.resumes[0][2];assert.equal(valid(),true);f.input.value=150;f.input.fire('input');assert.equal(valid(),false);assert.equal(f.at,150);});
test('cancel restores the position before the drag',()=>{const f=fixture();f.input.fire('pointerdown');f.input.value=170;f.input.fire('input');f.view.fire('pointercancel');assert.equal(f.at,20);});
test('project switch cannot apply an old drag to the new song',()=>{const f=fixture();f.input.fire('pointerdown');f.setProject({id:'two',duration:50});f.input.value=49;f.view.fire('pointerup');assert.equal(f.at,20);assert.equal(f.resumes.length,0);});
console.log(count+' tests passed');
