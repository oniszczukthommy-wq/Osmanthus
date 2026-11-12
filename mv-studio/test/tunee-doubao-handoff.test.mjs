import test from 'node:test';
import assert from 'node:assert/strict';
import {imageHandoff} from '../public/tunee-doubao-handoff.js';

const plan={style:'胶片电影',characters:[{id:'character-1',name:'小雨',description:'蓝外套短发'},{id:'character-2',name:'阿明',description:'黑色夹克'}],scenes:[{id:'scene-1',name:'雨夜街头',description:'霓虹映在地面'}],shots:[{id:'shot-1',name:'回头',description:'小雨转身看向镜头',characterIds:['character-1'],sceneId:'scene-1'}]};

test('角色和场景提示词分别保留各自创意与画幅',()=>{
 const character=imageHandoff(plan,'character-1','9:16');
 assert.match(character.prompt,/角色定妆图/);assert.match(character.prompt,/小雨/);assert.match(character.prompt,/蓝外套短发/);assert.match(character.prompt,/9:16/);assert.deepEqual(character.referenceIds,[]);
 const scene=imageHandoff(plan,'scene-1','16:9');assert.match(scene.prompt,/场景设定图/);assert.match(scene.prompt,/霓虹映在地面/);assert.doesNotMatch(scene.prompt,/角色定妆图/);
});
test('单镜关键帧只带该镜关联角色和场景，供手动下载参考',()=>{
 const result=imageHandoff(plan,'shot-1','16:9');
 assert.match(result.prompt,/小雨转身看向镜头/);assert.match(result.prompt,/蓝外套短发/);assert.match(result.prompt,/雨夜街头/);assert.doesNotMatch(result.prompt,/阿明/);
 assert.deepEqual(result.referenceIds,['character-1','scene-1']);
 assert.throws(()=>imageHandoff(plan,'shot-9','16:9'),/找不到当前素材/);
});
