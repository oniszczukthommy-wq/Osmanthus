import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../public/assets/vendor/three/three.module.min.js';
import {defaultPrevisScene,normalizePrevisScene,previsShotPreset,samplePrevisCameraPath,createPrevisActor,PREVIS_SHOT_PRESETS} from '../public/canvas-previs.js';

test('previs scene serializes a canonical isolated project scene',()=>{
 const source=defaultPrevisScene();source.unexpected='ignored';source.camera.extra='ignored';
 const actual=normalizePrevisScene(source);assert.equal(actual.version,1);assert.equal(actual.actors[0].kind,'mannequin');
 assert.equal(actual.unexpected,undefined);assert.equal(actual.camera.extra,undefined);
 actual.actors[0].position[0]=42;assert.equal(source.actors[0].position[0],0);
 assert.deepEqual(normalizePrevisScene(JSON.parse(JSON.stringify(source))),normalizePrevisScene(source));
});

test('invalid coordinates, object data, image protocols and paths are rejected',()=>{
 for(const alter of[
  s=>s.camera.position=[Infinity,0,0],s=>s.camera.position=new Array(3),s=>s.camera.target=[...s.camera.position],
  s=>s.camera.fov=180,s=>s.actors=[null],s=>s.actors=new Array(1),s=>s.actors[0].position=[0,null,0],
  s=>s.actors.push({...s.actors[0]}),s=>s.actors[0].kind='injected-js',s=>s.actors[0].color='url(javascript:alert(1))',
  s=>s.path.keyframes=new Array(2),s=>s.path.duration=0,s=>s.lighting.keyPosition=[NaN,0,0],
  s=>s.reference={url:'javascript:alert(1)',name:'bad',position:[0,2,-4],width:8,height:4.5,rotation:0},
 ]){const s=defaultPrevisScene();alter(s);assert.throws(()=>normalizePrevisScene(s));}
 const withImage=defaultPrevisScene();withImage.reference={id:'material-1',url:'/files/materials/image.png',name:'背景',position:[0,2,-4],width:8,height:4.5,rotation:0};
 assert.equal(normalizePrevisScene(withImage).reference.url,'/files/materials/image.png');
});

test('camera presets create real distinct world-space views and valid perspective cameras',()=>{
 const target=[2,1,-3],seen=new Set();
 for(const preset of PREVIS_SHOT_PRESETS){const view=previsShotPreset(preset.id,target);seen.add(view.position.join(','));assert.deepEqual(view.target,target);assert.ok(view.fov>=5&&view.fov<=160);const camera=new THREE.PerspectiveCamera(view.fov,16/9,.01,2000);camera.position.fromArray(view.position);camera.lookAt(new THREE.Vector3(...target));camera.updateMatrixWorld();const projected=new THREE.Vector3(...target).project(camera);assert.ok(Math.abs(projected.x)<1e-6);assert.ok(Math.abs(projected.y)<1e-6);}
 assert.equal(seen.size,7);assert.throws(()=>previsShotPreset('unknown'));
});

test('camera path interpolates exact endpoints and continuous position, look target and FOV',()=>{
 const a={position:[0,2,5],target:[0,1,0],fov:40},b={position:[4,4,8],target:[2,2,1],fov:60};const path={duration:8,keyframes:[a,b]};
 assert.deepEqual(samplePrevisCameraPath(path,-2),a);assert.deepEqual(samplePrevisCameraPath(path,10),b);
 assert.deepEqual(samplePrevisCameraPath(path,4),{position:[2,3,6.5],target:[1,1.5,.5],fov:50});
 assert.deepEqual(samplePrevisCameraPath({duration:6,keyframes:[a]},3),a);
 assert.throws(()=>samplePrevisCameraPath({duration:6,keyframes:[]},0));
 const crossing={duration:2,keyframes:[{position:[0,0,1],target:[0,0,0],fov:40},{position:[0,0,-1],target:[0,0,0],fov:40}]};
 const mid=samplePrevisCameraPath(crossing,1);assert.ok(Math.hypot(...mid.position.map((v,i)=>v-mid.target[i]))>=.05);
 const near=samplePrevisCameraPath(crossing,1.04);assert.ok(Math.hypot(...near.position.map((v,i)=>v-near.target[i]))>=.05);
});

test('blocking actors are genuine transformed 3D meshes with spatial extents',()=>{
 for(const kind of ['mannequin','box','sphere']){const actor={...defaultPrevisScene().actors[0],kind,position:[3,1,-2],scale:2,rotation:45};const group=createPrevisActor(actor);group.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(group);assert.equal(group.userData.actorId,actor.id);assert.ok(bounds.max.y>bounds.min.y+.9);assert.ok(bounds.min.x<3&&bounds.max.x>3);assert.ok(group.children.length>0);assert.ok(group.children.every(x=>x.isMesh));group.traverse(x=>{x.geometry?.dispose();x.material?.dispose();});}
});
