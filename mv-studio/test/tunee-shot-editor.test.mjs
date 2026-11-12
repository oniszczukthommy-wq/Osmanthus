import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSegments,serializeSegments,splitLastSegment,buildShotEdit,validateRelipEstimate} from '../public/tunee-shot-editor.js';

test('普通画面描述保持原样；分段文字可以保存并读回',()=>{
  assert.deepEqual(parseSegments('缓慢走进雨夜',5),[{start:0,end:5,description:'缓慢走进雨夜'}]);
  assert.equal(serializeSegments([{start:0,end:5,description:'缓慢走进雨夜'}],5),'缓慢走进雨夜');
  assert.equal(serializeSegments([{start:0,end:5,description:'缓慢走进雨夜\n镜头跟随'}],5),'缓慢走进雨夜\n镜头跟随');
  const rows=[{start:0,end:2,description:'望向前方'},{start:2,end:5,description:'轻轻转身'}];
  assert.deepEqual(parseSegments(serializeSegments(rows,5),5),rows);
});
test('无效时间、漏填及过长描述阻止保存',()=>{
  assert.throws(()=>serializeSegments([{start:1,end:5,description:'画面'}],5),/连续/);
  assert.throws(()=>serializeSegments([{start:0,end:2,description:'画面'},{start:3,end:5,description:'画面'}],5),/连续/);
  assert.throws(()=>serializeSegments([{start:0,end:2,description:'画面'}],5),/结束时间/);
  assert.throws(()=>serializeSegments([{start:0,end:5,description:''}],5),/填写/);
  assert.throws(()=>serializeSegments([{start:0,end:5,description:'长'.repeat(651)}],5),/650/);
});
test('添加时间段会平分最后一段、保留已填写的画面描述',()=>{
  const segments=splitLastSegment([{start:0,end:5,description:'已有描述'}],5);
  assert.deepEqual(segments,[{start:0,end:2.5,description:'已有描述'},{start:2.5,end:5,description:''}]);
  assert.throws(()=>splitLastSegment([{start:0,end:0,description:'x'}],5));
});
test('单镜保存保留其他镜头、歌词时间由后端继续持有',()=>{
  const plan={scenes:[{id:'scene-1'},{id:'scene-2'}],characters:[{id:'character-1'}],shots:[{id:'shot-1',duration:5,description:'旧',sceneId:'scene-1',characterIds:[],musicStructure:'前奏'},{id:'shot-2',duration:3,description:'保持',sceneId:'scene-1',characterIds:[]}]};
  const out=buildShotEdit(plan,'shot-1',[{start:0,end:5,description:'新画面'}],'scene-2',['character-1']);
  assert.deepEqual(out,[{id:'shot-1',description:'新画面',sceneId:'scene-2',characterIds:['character-1'],musicStructure:'前奏'},{id:'shot-2',description:'保持',sceneId:'scene-1',characterIds:[]}]);
  assert.throws(()=>buildShotEdit(plan,'shot-1',[{start:0,end:5,description:'新'}],'foreign',[]));
  assert.equal(plan.shots[0].description,'旧');
});
test('口型报价必须有可用服务、有效时长、金额和足够的本地预算',()=>{
  const good={available:true,canSubmit:true,estimatedCostCny:3,remainingCny:5,inputDuration:2,outputDuration:2};
  assert.equal(validateRelipEstimate(good).estimatedCostCny,3);
  for(const bad of [{...good,available:false},{...good,canSubmit:false},{...good,estimatedCostCny:0},{...good,remainingCny:2},{...good,inputDuration:NaN},{...good,outputDuration:-1}])assert.throws(()=>validateRelipEstimate(bad));
});
