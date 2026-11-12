import test from 'node:test';
import assert from 'node:assert/strict';
import {readyShotPath} from '../public/tunee-workspace-core.js';
const id='d3d87090-18b1-4c98-ad16-1fd6e8cb3bf0', shot={id:'shot-2'},path=`/files/wan3-tasks/${id}/video.mp4`;
test('已完成镜头在其他任务修改 revision 后仍可显示',()=>{
 const session={id:'s',revision:5,productionMode:'lip-sync',shotVideos:{[shot.id]:path}};
 assert.equal(readyShotPath(session,{session_id:'s',revision:4,kind:'relip-shot'},shot),path);
 assert.equal(readyShotPath({...session,planStale:true},null,shot),'');
 assert.equal(readyShotPath({...session,importedShots:{[shot.id]:{selected:'old-invalid'}}},null,shot),'');
});
test('拒绝伪造视频路径及非本工程或过期任务',()=>{
 const session={id:'s',revision:5,shotVideos:{[shot.id]:'//evil.example/video.mp4'}};
 assert.equal(readyShotPath(session,null,shot),'');
 assert.equal(readyShotPath({...session,shotVideos:{[shot.id]:`/files/wan3-tasks/${id}/../../../secret`}},null,shot),'');
 const job={session_id:'s',revision:4,shots:[{id:shot.id,status:'ready',taskId:id}]};
 assert.equal(readyShotPath(session,job,shot),'');
 assert.equal(readyShotPath(session,{...job,session_id:'other',revision:5},shot),'');
 assert.equal(readyShotPath(session,{...job,revision:5},shot),`/files/aliyun-video/${id}/video.mp4`);
});
