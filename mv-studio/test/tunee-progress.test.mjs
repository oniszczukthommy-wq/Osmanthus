import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFacts,shotReadiness,stageSummary} from '../public/tunee-progress.js';

test('音乐信息只使用工程真实记录及有效选段',()=>{
  const facts=projectFacts({source:{duration:30},lyrics:[{text:'一句'},{text:''},'两句']},5,20);
  assert.deepEqual(facts,[{label:'歌曲时长',seconds:30},{label:'选择片段',start:5,end:20},{label:'已载入歌词',lines:2}]);
  assert.deepEqual(projectFacts({source:{duration:10}},5,11),[{label:'歌曲时长',seconds:10}]);
});

test('选择了过期素材时不会回退或者展示旧生成镜头',()=>{
  const imported={shot1:{selected:'v1'}};
  assert.deepEqual(shotReadiness('shot1',imported,{valid:false,url:'/old.mp4'},'/generated.mp4'),{ready:false,kind:'stale',url:''});
  assert.deepEqual(shotReadiness('shot1',imported,{valid:true,url:'/new.mp4'},'/generated.mp4'),{ready:true,kind:'imported',url:'/new.mp4'});
  assert.deepEqual(shotReadiness('shot1',{},null,'/generated.mp4'),{ready:true,kind:'generated',url:'/generated.mp4'});
  assert.equal(shotReadiness('shot1',{},null,'').ready,false);
});

test('进度呈现实际就绪数量，未完成不显示成片',()=>{
  const stages=stageSummary({hasPlan:true,assetsTotal:2,assetsConfirmed:1,shotsTotal:3,shotsReady:2});
  assert.equal(stages[2].state,'1/2 已确认');
  assert.equal(stages[3].state,'2/3 可用镜头');
  assert.equal(stages[4].state,'待合成');
  assert.equal(stageSummary()[1].state,'待设计');
});
