import os from 'node:os';
// Isolated UI fixture; all model behavior is local mock data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createMVDirector} from '../mv-director.mjs';
import {createMaterialStore} from '../materials.mjs';
import {mediaTools} from '../runtime-config.mjs';
import {createMediaProcessing} from '../media-processing.mjs';
const root=process.env.BRIDGE_FIXTURE_ROOT||path.join(os.tmpdir(),'guihua-bridge-fixture-20261111');
const data=path.join(root,'data');fs.mkdirSync(data,{recursive:true});fs.mkdirSync(path.join(data,'uploads'),{recursive:true});
const {ffmpeg,ffprobe}=mediaTools(),probe=createMediaProcessing({ffmpeg,ffprobe}).probe;
const audioId=crypto.randomUUID()+'.wav',audioFile=path.join(data,'uploads',audioId),frame=path.join(root,'frame.png');
execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=330:sample_rate=16000','-t','10',audioFile]);
execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=1280x720','-frames:v','1',frame]);
const materials=createMaterialStore({data,probe,write:(f,v)=>fs.writeFileSync(f,JSON.stringify(v),{flag:'wx',mode:0o600})});
const material=await materials.upload('参考图.png',fs.readFileSync(frame));
const pictures=new Map();
const image={capabilities:()=>({available:true,remainingCny:100,estimatedCostCny:.2}),get:id=>pictures.get(id),asset:id=>pictures.has(id)?{file:frame}:null,submit:async input=>{const result={id:input.request_id,status:'ready',url:material.url};pictures.set(result.id,result);return result;}};
const video={capabilities:()=>({available:false,reason:'隔离测试禁用视频模型'}),get:()=>null,asset:()=>null};
let mockCalls=0;const fetchImpl=async(_url,options)=>{mockCalls++;const context=JSON.parse(JSON.parse(options.body).messages[1].content);const response={summary:'虚构的海边短片',style:'电影感',characters:[{name:'旅人',description:'穿蓝外套的旅人'}],scenes:[{name:'海边',description:'清晨海岸'}],shots:context.slots.map((x,i)=>({id:x.id,name:'海边'+(i+1),description:'海边缓慢行走，镜头平移',sceneId:'scene-1',characterIds:['character-1']}))};return{ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]})};};
const source={id:audioId,duration:10,url:'/files/uploads/'+audioId,name:'合成测试音乐'},project={id:crypto.randomUUID(),title:'测试工程（合成素材）',source,lyrics:[{start:0,end:4,text:'这是合成测试歌词'}],manualLyrics:'这是合成测试歌词'};
const director=createMVDirector({data,key:'isolated-mock',image,video,materials,audioPath:()=>audioFile,probe,ffmpeg,fetchImpl,analyze:async()=>({accents:[],energy:[]})});
async function execute(session,kind,input){const job=director.start({session_id:session.id,revision:session.revision,request_id:crypto.randomUUID(),kind,input});await director.refresh(job.id);const out=director.job(job.id);if(out.status!=='ready')throw Error(out.message);return director.get(session.id);}
let s=director.open(project);s=await execute(s,'prepare',{selection:{mode:'full'},idea:'测试',ratio:'16:9',productionMode:'manual-web',references:[]});if(process.env.BRIDGE_FIXTURE_NO_PREVIEW!=='1')s=await execute(s,'preview',{confirmed:true});director.close();
fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({sessionId:s.id,projectId:project.id,sourceId:audioId,mockCalls,root}),{mode:0o600});
console.log(JSON.stringify({sessionId:s.id,shots:s.plan.shots.length,mockCalls,root}));
