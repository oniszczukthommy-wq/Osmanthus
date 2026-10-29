import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const VALIDATION=path.join(HERE,'models/vision');
const DEFAULT_PYTHON=path.join(HERE,'.venv/bin/python');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const OPERATIONS=new Set(['remove-background','layer-split','upscale','grid-split','depth']);
const MODELS={
  'u2netp.onnx':'309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
  'realesr-general-x4v3.pth':'8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292',
  'depth-anything-v2-small/config.json':'c56698d3643dde1f83ea2212759e6b31a22b8f827246a36dd007ee8a22b3ff75',
  'depth-anything-v2-small/preprocessor_config.json':'d41175c0d889477ca8fc67191e540faef14baf6275157b3fdecf78469e6bbf84',
  'depth-anything-v2-small/model.safetensors':'3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70',
};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function regular(file,max=20*1024*1024){
  const before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>max)throw fail('图像文件无效');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const now=fs.fstatSync(fd);if(now.dev!==before.dev||now.ino!==before.ino||now.size!==before.size)throw fail('图像文件已改变');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function pngSize(bytes){
  if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw fail('本地处理没有生成有效PNG',500);
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(!width||!height||width*height>16_777_216)throw fail('输出尺寸超过4096×4096像素面积限制',413);
  return {width,height};
}
function atomicJson(file,value){const temp=file+'.tmp-'+crypto.randomUUID();try{fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}}
function runPython(python,helper,payload,packages,timeoutMs){
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[helper],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONNOUSERSITE:'1',PYTHONPATH:[packages,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');done(fail('本地图像处理超时',504));},timeoutMs);
    function done(error,result){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);}
    child.on('error',()=>done(fail('本地视觉Python无法启动',503)));
    child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1024*1024){child.kill('SIGKILL');done(fail('本地图像处理输出异常',500));}});
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-8192);});
    child.on('close',code=>{if(code!==0){let message='本地图像处理失败';try{message=JSON.parse(stderr.trim().split('\n').at(-1)).error||message;}catch{}return done(fail(message,422));}try{done(null,JSON.parse(stdout));}catch{done(fail('本地图像结果无法读取',500));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
  });
}

/** No network or model download occurs here. resolveMaterial(id) must return a registered {file,material}. */
export function createCanvasVision({data,resolveMaterial,pythonPath=process.env.MV_VISION_PYTHON||DEFAULT_PYTHON,modelDir=process.env.MV_VISION_MODELS||path.join(VALIDATION,'models'),pythonPackages=process.env.MV_VISION_PACKAGES||path.join(VALIDATION,'python-packages'),helperPath=path.join(HERE,'canvas-vision.py'),timeoutMs=240_000}={}){
  if(typeof data!=='string'||typeof resolveMaterial!=='function')throw new TypeError('data 和 resolveMaterial 必填');
  const requested=path.resolve(data,'canvas-vision');fs.mkdirSync(requested,{recursive:true});
  if(fs.lstatSync(requested).isSymbolicLink())throw fail('视觉结果目录不能是链接',500);
  const root=fs.realpathSync(requested),rootStat=fs.statSync(root);
  let queue=Promise.resolve();const verifiedModels=new Map();
  function checkRoot(){const s=fs.lstatSync(root);if(s.isSymbolicLink()||s.ino!==rootStat.ino||s.dev!==rootStat.dev)throw fail('视觉结果目录已改变',500);}
  function directory(id){if(!UUID.test(id||''))throw fail('视觉请求标识无效');checkRoot();const dir=path.join(root,id);if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw fail('视觉任务目录不能是链接',500);return dir;}
  function modelsReady(){const ready={};for(const [name,expected]of Object.entries(MODELS)){try{const file=path.join(modelDir,name),stat=fs.lstatSync(file),stamp=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');if(stat.isSymbolicLink()||!stat.isFile())throw Error();const prior=verifiedModels.get(name);ready[name]=prior?.stamp===stamp?prior.valid:hash(regular(file,300*1024*1024))===expected;verifiedModels.set(name,{stamp,valid:ready[name]});}catch{ready[name]=false;verifiedModels.delete(name);}}return ready;}
  function capabilities(){const models=modelsReady(),python=fs.existsSync(pythonPath)&&fs.existsSync(helperPath),segmentation=python&&models['u2netp.onnx'],upscale=python&&models['realesr-general-x4v3.pth'],depth=python&&Object.keys(MODELS).filter(x=>x.startsWith('depth-')).every(x=>models[x]);return {available:python,local:true,paid:false,operations:{'remove-background':!!segmentation,'layer-split':!!segmentation,upscale:!!upscale,'grid-split':python,depth:!!depth},models:{u2netp:!!models['u2netp.onnx'],realesrGeneralX4v3:!!models['realesr-general-x4v3.pth'],depthAnythingV2Small:!!depth},limits:{inputBytes:20*1024*1024,inputPixels:16_777_216,upscaleInputPixels:4_194_304,upscale4xInputPixels:1_048_576,outputPixels:16_777_216,maxCells:64},layerSemantics:'foreground plus visible background; occluded background is not reconstructed',depthSemantics:'relative inverse depth; white is nearer; not a metric distance map'};}
  function read(id){try{const dir=directory(id),v=JSON.parse(regular(path.join(dir,'result.json'),1024*1024));if(v.id!==id||!OPERATIONS.has(v.operation)||!['running','ready','failed'].includes(v.status)||!SHA.test(v.signature||'')||!Array.isArray(v.outputs)||v.outputs.length>64)return null;for(const o of v.outputs)if(!/^[a-z0-9-]+\.png$/.test(o.filename||'')||!SHA.test(o.sha256||'')||o.url!==`/files/canvas-vision/${id}/${o.filename}`)return null;return v;}catch{return null;}}
  function asset(id,filename){
    if(typeof filename!=='string'||!/^[a-z0-9-]+\.png$/.test(filename))return null;
    const result=read(id);if(result?.status!=='ready')return null;const meta=result.outputs.find(x=>x.filename===filename);if(!meta)return null;
    try{const file=path.join(directory(id),filename),bytes=regular(file,100*1024*1024);if(bytes.length!==meta.bytes||hash(bytes)!==meta.sha256)return null;return {file,mime:'image/png',output:meta};}catch{return null;}
  }
  async function execute(input){
    const {request_id:id,material_id:materialId,operation}=input||{};
    if(!UUID.test(id||'')||!UUID.test(materialId||'')||!OPERATIONS.has(operation))throw fail('视觉任务参数无效');
    if(operation==='upscale'&&input.scale!==undefined&&![2,4].includes(input.scale))throw fail('超分倍数必须为2或4');
    const rows=input.rows??2,columns=input.columns??2;
    if(operation==='grid-split'&&(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||columns<1||rows>10||columns>10||rows*columns>64))throw fail('宫格参数无效');
    const found=await resolveMaterial(materialId),material=found?.material;
    if(!found?.file||material?.id!==materialId||material.kind!=='image'||!SHA.test(material.sha256||''))throw fail('请先选择已注册的图片素材',404);
    const source=regular(found.file);if(hash(source)!==material.sha256)throw fail('原始素材哈希不匹配',409);
    const parameters={scale:operation==='upscale'?(input.scale??2):null,rows:operation==='grid-split'?rows:null,columns:operation==='grid-split'?columns:null};
    const signature=hash(JSON.stringify({operation,material_id:materialId,source_sha256:material.sha256,parameters}));
    const dir=directory(id),prior=read(id);
    if(prior){if(prior.signature!==signature)throw fail('同一请求不能改用其他图像或参数',409);if(prior.status==='ready'&&prior.outputs.every(o=>asset(id,o.filename)))return {...prior,replayed:true};throw fail('此请求结果不完整，请使用新的请求标识重试',409);}
    if(fs.existsSync(dir))throw fail('此视觉请求已存在，请使用新的请求标识',409);
    if(!capabilities().operations[operation])throw fail('本地图像模型未就绪',503);
    fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'source.bin'),source,{flag:'wx',mode:0o600});
    const record={id,status:'running',operation,material_id:materialId,source_sha256:material.sha256,signature,parameters,createdAt:new Date().toISOString(),outputs:[]};atomicJson(path.join(dir,'result.json'),record);
    try{
      const payload={operation,input_file:path.join(dir,'source.bin'),output_dir:dir,model_dir:modelDir,...parameters};
      const result=await runPython(pythonPath,helperPath,payload,pythonPackages,timeoutMs);
      if(!Array.isArray(result.outputs)||!result.outputs.length||result.outputs.length>64)throw fail('本地图像输出数量无效',500);
      record.outputs=result.outputs.map(x=>{if(!/^[a-z0-9-]+\.png$/.test(x.filename||''))throw fail('图像输出名称无效',500);const bytes=regular(path.join(dir,x.filename),100*1024*1024),size=pngSize(bytes);if(size.width!==x.width||size.height!==x.height)throw fail('图像尺寸校验不通过',500);return {...x,...size,url:`/files/canvas-vision/${id}/${x.filename}`,mime:'image/png',bytes:bytes.length,sha256:hash(bytes)};});
      record.status='ready';record.metadata=result.metadata;record.completedAt=new Date().toISOString();atomicJson(path.join(dir,'result.json'),record);return record;
    }catch(error){record.status='failed';record.error=String(error.message||error);atomicJson(path.join(dir,'result.json'),record);throw error;}
  }
  function processImage(input){const work=queue.then(()=>execute(input));queue=work.catch(()=>{});return work;}
  return {capabilities,process:processImage,get:read,asset};
}
