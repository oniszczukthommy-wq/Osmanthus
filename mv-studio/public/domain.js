export const STYLES=[{id:'cel',name:'温柔动画',note:'冷暖光线 · 柔和轮廓'},{id:'pixel',name:'像素夜话',note:'雨夜霓虹 · 游戏质感'},{id:'print',name:'复古丝印',note:'暖色墨印 · 简洁构图'}];
export const STORIES=[
 {id:'family',title:'留灯',tag:'亲情',style:'cel',summary:'收起将就的面包，回家接过一碗热汤。',arc:['一个人将就','有人等你回家','接受一份照顾'],names:['小川','妈妈'],actions:['bread','soup','message','offbus','door','bag','bowl','dinner'],labels:['车上的剩面包','母亲留一碗汤','收到回家消息','末班车到站','推开家门','放下疲惫与背包','接过母亲的汤','一起坐下喝汤']},
 {id:'friendship',title:'同伞',tag:'友情',style:'pixel',summary:'看见雨中的朋友，把一把伞变成两个人的归途。',arc:['雨中的朋友','撑伞靠近','彼此照顾'],names:['阿杰','小文'],actions:['alone','rain','notice','open','approach','share','pass','leave'],labels:['准备独自离开','朋友在雨中','看见对方','打开雨伞','撑伞靠近','一起进入伞下','接过伞，向对方倾回','同伞离开']},
 {id:'romance',title:'围巾',tag:'爱情',style:'print',summary:'末班车靠站，等候的人把围巾递到你的手里。',arc:['有人在等','认出彼此','围巾与相握的手'],names:['林溪','阿岸'],actions:['window','wait','arrive','offbus','recognize','scarf','wrap','hands'],labels:['末班车窗边','带着围巾等候','公交驶入站台','走下公交','彼此认出','递出围巾','接过并围好','握住彼此的手']}
];
export const SAMPLE_LYRICS=[
 [.3,3.65,'背包里装着没吃完的面包'],[4.1,7.39,'耳机重复那首老歌谣'],[7.99,11.47,'手机亮起妈妈发的唠叨'],[11.47,15.42,'说天凉了要穿件外套'],[15.78,19.51,'车窗里的我对自己微笑'],[19.78,22.96,'虽然累却还没想逃'],[23.32,26.13,'每一站都是小小的停靠'],[26.32,29.63,'倒影里那个人依然骄傲']
].map(([start,end,text])=>({start:start+47.95,end:end+47.95,text}));
export const clone=x=>JSON.parse(JSON.stringify(x));
export function makePlan(storyId='family',duration=30){
 const s=STORIES.find(x=>x.id===storyId)||STORIES[0];
 return {story:s.id,title:s.title,summary:s.summary,style:s.style,names:[...s.names],motherYoung:false,shots:s.actions.map((action,i)=>({id:i+1,action,label:s.labels[i],start:duration*i/8,end:duration*(i+1)/8,camera:['medium','wide','close','wide','medium','medium','close','wide'][i],warm:0,rain:s.id==='friendship'?.5:0,soft:0,pause:0,caption:s.labels[i]}))};
}
export function makeProject(){return{id:'draft',title:'末班车的窗',source:{id:'sample',url:'/assets/sample-song.mp3',name:'末班车的窗 · 原创示例',duration:142.942},start:47.95,duration:30,mode:'free',step:'music',plan:makePlan(),lyrics:clone(SAMPLE_LYRICS),manualLyrics:'',version:1,generated:null,planningSource:'preset'};}
export function steps(mode){return mode==='pro'?[['music','音乐','选一段想讲的旋律'],['story','故事','选择故事的方向'],['characters','人物与画风','让主角保持一致'],['shots','分镜','看懂每一段画面'],['result','MV','预览、修改与下载']]:[['music','音乐','上传，或粘贴音乐链接'],['plan','创作方案','故事和画风已经备好'],['result','MV','看看这首歌的样子']];}
export function switchMode(p,mode){const next=clone(p);next.mode=mode==='pro'?'pro':'free';const valid=steps(next.mode).map(s=>s[0]);if(!valid.includes(next.step))next.step=next.mode==='free'?'plan':'story';return next;}
export function shotAt(plan,t){return plan.shots.find(s=>t>=s.start&&t<s.end)||plan.shots.at(-1);}
export function validateProject(p){
 if(!p||!Number.isFinite(p.duration)||p.duration<3||p.duration>180)throw Error('时长需在3–180秒之间');
 if(!Number.isFinite(p.start)||p.start<0||!p.source?.id)throw Error('请先选择音乐');
 if(p.start+p.duration>p.source.duration+.15)throw Error('所选片段超出音频长度');
 if(!STORIES.some(s=>s.id===p.plan?.story)||!STYLES.some(s=>s.id===p.plan?.style))throw Error('创作方案不可用');
 const preset=STORIES.find(s=>s.id===p.plan.story);
 if(p.plan.shots.length!==8)throw Error('当前预设需要8个连续镜头');
 let end=0;for(const [i,s]of p.plan.shots.entries()){
  if(s.id!==i+1||s.action!==preset.actions[i]||Math.abs(s.start-end)>.02||s.end<=s.start||!['wide','medium','close'].includes(s.camera))throw Error('分镜时间或动作不完整');
  for(const k of ['warm','rain','soft','pause'])if(!Number.isFinite(s[k])||s[k]<0||s[k]>1)throw Error('镜头调整值不可用');end=s.end;
 }
 if(Math.abs(end-p.duration)>.03)throw Error('分镜需完整覆盖选中的音乐');
 if(!Array.isArray(p.plan.names)||p.plan.names.length!==2||p.plan.names.some(x=>typeof x!=='string'||x.length>24))throw Error('人物名称不可用');return true;
}
export function changeStory(p,id){const next=clone(p);next.plan=makePlan(id,next.duration);next.generated=null;next.planningSource='preset';return next;}
export function resizePlan(p,duration,start=p.start){const next=clone(p),ratio=duration/p.duration;next.duration=duration;next.start=start;next.plan.shots.forEach(s=>{s.start*=ratio;s.end*=ratio});next.generated=null;return next;}
export function localEdit(p,shotId,request,scope='shot'){
 if(typeof request!=='string'||request.length>600)throw Error('请用600字以内描述修改');
 const next=clone(p),targets=scope==='all'?next.plan.shots:next.plan.shots.filter(s=>s.id===shotId),changes=[];
 const set=(k,v,label)=>{targets.forEach(s=>s[k]=v);changes.push(label)};
 if(/暖|温柔|温馨/.test(request))set('warm',.8,'暖色灯光');
 if(/冷色|冷一点|蓝色/.test(request))set('warm',0,'夜色冷光');
 if(/近景|拉近|特写|看清/.test(request))set('camera','close','拉近取景');
 if(/全景|远景|拉远/.test(request))set('camera','wide','拉远取景');
 if(/自然|柔和|流畅|缓慢|慢一点/.test(request))set('soft',.8,'柔和的动作曲线');
 if(/停顿|犹豫|等一下/.test(request))set('pause',.55,'动作前稍作停顿');
 if(/大雨|雨更大|多.*雨/.test(request))set('rain',.9,'增加雨量');
 if(/少.*雨|不要.*雨|停雨/.test(request))set('rain',0,'减少雨量');
 if(!changes.length)return{project:p,applied:false,message:'这句话还没能转换成可执行的调整。可以先试「镜头拉近一点」「动作自然一点」或「灯光更温暖」。'};
 next.generated=null;next.version++;return{project:next,applied:true,message:`${scope==='all'?'所有镜头':`第${String(shotId).padStart(2,'0')}镜`}已调整：${changes.join('、')}。${scope==='all'?'人物与音乐保留。':'其余镜头保持原样。'}`};
}
export function lyricAt(p,t){return(p.lyrics||[]).find(l=>p.start+t>=l.start&&p.start+t<l.end)?.text||'';}
