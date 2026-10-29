import {shotAt,lyricAt} from './domain.js';
const W=1280,H=720,clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)),mix=(a,b,t)=>a+(b-a)*t;
const ease=t=>{t=clamp(t);return t*t*(3-2*t)},p=(a,b,t)=>[mix(a[0],b[0],t),mix(a[1],b[1],t)];
const scratch=typeof document!=='undefined'?document.createElement('canvas'):null;
export function drawFrame(canvas,project,t=0,options={}){
 const shot=options.shot||shotAt(project.plan,t),pixel=project.plan.style==='pixel',print=project.plan.style==='print';
 let c=canvas.getContext('2d'),surface=canvas;
 if(pixel){scratch.width=320;scratch.height=180;surface=scratch;c=scratch.getContext('2d');}
 c.setTransform(surface.width/W,0,0,surface.height/H,0,0);
 const warm=shot.warm||0,K={sky:print?'#23434b':warm>.3?'#344454':'#172e43',far:print?'#446a6d':'#35536a',mid:print?'#6b8580':'#5b7687',floor:print?'#23434b':'#273e4e',paper:'#ead9b8',cream:'#f0dfb9',gold:print?'#dfb96f':'#e4b879',red:print?'#bb6b51':'#b27566',ink:'#203947',wood:'#946d53'};
 const fill=(col)=>{c.fillStyle=col},rect=(x,y,w,h,col)=>{fill(col);c.fillRect(x,y,w,h)},line=(a,b,col=K.ink,w=3)=>{c.strokeStyle=col;c.lineWidth=w;c.lineCap='round';c.beginPath();c.moveTo(...a);c.lineTo(...b);c.stroke()},poly=(points,col)=>{fill(col);c.beginPath();c.moveTo(...points[0]);for(const q of points.slice(1))c.lineTo(...q);c.closePath();c.fill()},ell=(x,y,rx,ry,col)=>{fill(col);c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fill()},path=(d,col)=>{fill(col);c.fill(new Path2D(d))};
 let u=clamp((t-shot.start)/(shot.end-shot.start));u=ease(clamp((u-(shot.pause||0)*.14)/(1-(shot.pause||0)*.14)));
 if(shot.soft>.3)u=ease(u);
 const action=shot.action,kind=project.plan.story;
 rect(0,0,W,H,K.sky);
 const cx=['bread','message','window'].includes(action)?610:650,cy=['bread','message','window'].includes(action)?425:420,z=shot.camera==='close'?1.75:shot.camera==='medium'?1.27:1.0;
 c.save();c.translate(640,355);c.scale(z+(print?0:.025*u),z+(print?0:.025*u));c.translate(-cx,-cy);
 const city=()=>{
  if(!print){const g=c.createLinearGradient(0,0,0,550);g.addColorStop(0,K.sky);g.addColorStop(1,warm>.3?'#877766':'#566d7b');fill(g);c.fillRect(-500,-250,2300,1400);}else rect(-500,-250,2300,1400,K.sky);
  ell(1120,96,27,27,K.cream);ell(1110,88,26,26,K.sky);
  for(let layer=0;layer<3;layer++)for(let i=-2;i<18;i++){const x=i*103+layer*38,hh=100+(i*47+layer*53+500)%210,yy=467-hh;rect(x,yy,90,hh,layer===0?K.mid:layer===1?K.far:K.sky);for(let a=0;a<4;a++)for(let b=0;b<5;b++)if((i+a+b+layer)%3===0&&yy+26+b*34<467)rect(x+13+a*18,yy+18+b*34,6,9,(a+i)%2?K.gold:K.mid);}
  rect(-500,470,2300,550,K.floor);rect(-500,493,2300,5,K.mid);
  for(let i=-2;i<7;i++){const x=i*280+170;line([x,340],[x,600],K.ink,7);line([x,340],[x+50,340],K.ink,7);ell(x+50,345,19,5,K.gold);if(!print){const g=c.createRadialGradient(x+50,360,0,x+50,360,85);g.addColorStop(0,'#e4b87938');g.addColorStop(1,'#e4b87900');fill(g);c.fillRect(x-50,280,200,200);}}
  line([-200,620],[1450,620],K.mid,2);for(let i=-2;i<10;i++)line([i*210,626],[i*210-55,920],K.far,1);
 };
 const shelter=()=>{city();const end=kind==='friendship'?650:1100;rect(95,190,end-75,18,K.ink);poly([[115,171],[end-35,171],[end+25,193],[70,193]],K.mid);rect(118,207,end-200,250,K.far);for(let x=150;x<end-70;x+=220)rect(x,210,4,248,K.mid);rect(112,195,9,418,K.paper);rect(end-55,195,9,418,K.mid);rect(230,492,330,15,K.red);rect(251,507,9,98,K.ink);rect(530,507,9,98,K.ink);rect(246,440,300,13,K.red);rect(246,467,300,10,K.red);};
 const busInside=()=>{city();rect(-80,0,1440,64,K.mid);rect(40,58,1190,10,K.cream);for(const x of [60,410,805,1200])rect(x,60,8,362,K.mid);rect(40,402,1190,42,K.mid);rect(-100,444,1480,500,K.floor);rect(295,478,475,24,K.red);rect(315,423,440,13,K.red);rect(325,502,11,102,K.ink);rect(742,502,11,102,K.ink);line([80,70],[80,505],K.mid,7);line([80,505],[148,505],K.mid,7);for(let i=0;i<3;i++){ell(250+i*345,60,40,8,K.gold);line([250+i*345,65],[250+i*345,156],K.mid,3);ell(250+i*345,172,16,20,K.mid);}};
 const home=()=>{rect(-500,-300,2300,1400,K.wood);rect(-500,-300,2300,804,warm>.3?'#efdcad':K.paper);rect(90,100,355,280,K.wood);rect(106,116,322,248,K.sky);for(let i=0;i<6;i++)rect(125+i*49,210-(i%3)*28,30,139,K.far);rect(266,110,8,260,K.wood);rect(105,254,325,7,K.wood);line([660,0],[660,116],K.ink,3);poly([[615,116],[707,116],[740,162],[581,162]],K.red);ell(660,165,56,8,K.gold);rect(1060,185,130,260,K.mid);rect(1068,260,114,5,K.paper);for(let i=0;i<3;i++){rect(1075+i*34,211,20,40,K.gold);ell(1085+i*34,212,10,4,K.cream);}for(const x of [510,800]){rect(x-45,432,90,12,K.wood);rect(x-45,444,7,161,K.ink);rect(x+38,444,7,161,K.ink);rect(x-44,520,88,11,K.wood);}};
 const table=()=>{rect(350,475,590,14,K.gold);rect(350,489,590,14,K.wood);rect(375,503,13,110,K.ink);rect(899,503,13,110,K.ink);};
 const bus=(front,open=0)=>{const x=front-880;rect(x,165,880,395,K.mid);rect(x+10,189,850,165,K.sky);for(let i=0;i<6;i++)rect(x+25+i*132,200,111,140,K.far);rect(x+5,379,865,26,K.gold);rect(x+5,422,865,94,K.red);for(const xx of [x+170,x+715]){ell(xx,553,44,44,K.ink);ell(xx,553,20,20,K.mid);}const dx=front-183;rect(dx,195,117,358,K.sky);rect(dx,195,54*(1-open),343,K.far);rect(dx+117-54*(1-open),195,54*(1-open),343,K.far);rect(dx+4,550,108,10,K.cream);rect(front-38,381,25,22,K.gold);};
 const bag=(x,bottom)=>{rect(x-29,bottom-80,58,78,K.mid);rect(x-22,bottom-42,44,33,K.red);line([x-10,bottom-80],[x-10,bottom-92],K.ink,4);line([x-10,bottom-92],[x+10,bottom-92],K.ink,4);line([x+10,bottom-92],[x+10,bottom-80],K.ink,4);};
 const bread=(x,y)=>{poly([[x-28,y+13],[x-31,y-9],[x-22,y-20],[x+7,y-22],[x+25,y-9],[x+23,y+15]],K.gold);line([x-13,y-12],[x-7,y-2],K.cream,3);line([x+3,y-13],[x+8,y-4],K.cream,3);};
 const bowl=(x,y,scale=1)=>{path(`M${x-34*scale} ${y}Q${x-27*scale} ${y+31*scale} ${x} ${y+32*scale}Q${x+27*scale} ${y+31*scale} ${x+34*scale} ${y}Z`,K.red);ell(x,y,34*scale,9*scale,K.cream);ell(x,y-1,28*scale,6*scale,K.gold);for(let i=0;i<3;i++){ell(x+(i-1)*13*scale,y-1,4*scale,2*scale,K.mid);const xx=x+(i-1)*14;line([xx,y-13],[xx+Math.sin(t*2+i)*4,y-37],K.cream,1.8);}};
 const phone=(x,y)=>{rect(x-26,y-48,52,95,K.ink);rect(x-20,y-40,40,70,K.cream);rect(x-15,y-29,30,18,K.mid);fill(K.ink);c.font='11px "PingFang SC",sans-serif';c.textAlign='center';c.fillText('回家',x,y+2);c.fillText('吃饭',x,y+17);ell(x,y+38,3,3,K.mid);};
 let armQueue=[];
 const actor=(id,x,y=605,opt={})=>{
  const mother=id===1&&kind==='family',z=mother?.94:1,skin=mother?'#dfbfa5':'#edc6a5',hair=mother&&!project.plan.motherYoung?'#a8a7a1':id?'#493730':'#2b303a',coat=id?(print?'#203f48':kind==='friendship'?'#718269':'#966f58'):(print?'#bb6b51':'#3e617a'),pants=print?'#78928b':'#263948';
  const hip=opt.sit?510:y-146*z+(opt.drop||0),sy=hip-101*z,head=hip-157*z,feet=opt.sit?[[x+50*z,y],[x+82*z,y]]:[[x-17*z,y],[x+20*z,y]];
  if(opt.walk){const ph=(u*1.4+(opt.phase||0))*Math.PI*2;feet[0]=[x-9+Math.sin(ph)*26,y-Math.max(0,Math.cos(ph))*14];feet[1]=[x+9-Math.sin(ph)*26,y-Math.max(0,-Math.cos(ph))*14];}
  const limb=(a,b,width,col)=>{c.strokeStyle=col;c.lineWidth=width;c.lineCap=print?'butt':'round';c.beginPath();c.moveTo(...a);c.lineTo(...b);c.stroke();};
  for(let i=0;i<2;i++){const h=[x+(i?14:-14)*z,hip],f=feet[i],k=opt.sit?[x+50*z,hip+12*z]:[mix(h[0],f[0],.5)+(opt.drop?(i?25:-25):opt.walk?9:0),mix(hip,f[1],.52)];limb(h,k,21*z,pants);limb(k,f,17*z,pants);ell(f[0]+4,f[1]-1,15*z,5*z,K.ink);}
  poly([[x-32*z,sy-9*z],[x-19*z,sy-18*z],[x+19*z,sy-18*z],[x+32*z,sy-8*z],[x+35*z,hip+6*z],[x-35*z,hip+6*z]],coat);rect(x-8*z,sy-27*z,16*z,23*z,skin);poly([[x-11*z,sy-11*z],[x+11*z,sy-11*z],[x+7*z,hip+5*z],[x-7*z,hip+5*z]],K.cream);line([x-18*z,sy-12*z],[x-4*z,sy+21*z],K.ink,1);line([x+18*z,sy-12*z],[x+4*z,sy+21*z],K.ink,1);
  ell(x,head-7*z,36*z,43*z,hair);path(`M${x-28*z} ${head-18*z}Q${x} ${head-37*z} ${x+29*z} ${head-17*z}L${x+27*z} ${head+18*z}Q${x} ${head+57*z} ${x-28*z} ${head+17*z}Z`,skin);
  if(mother)path(`M${x-36*z} ${head+23*z}L${x-34*z} ${head-24*z}Q${x} ${head-60*z} ${x+36*z} ${head-20*z}L${x+37*z} ${head+27*z}L${x+28*z} ${head+18*z}L${x+23*z} ${head-16*z}L${x+8*z} ${head-26*z}L${x-6*z} ${head-13*z}L${x-15*z} ${head-24*z}L${x-26*z} ${head-8*z}L${x-28*z} ${head+24*z}Z`,hair);
  else path(`M${x-36*z} ${head-5*z}L${x-32*z} ${head-27*z}Q${x-4*z} ${head-62*z} ${x+31*z} ${head-27*z}L${x+36*z} ${head-5*z}L${x+24*z} ${head+4*z}L${x+18*z} ${head-19*z}L${x+3*z} ${head-8*z}L${x+4*z} ${head-26*z}L${x-13*z} ${head-10*z}L${x-14*z} ${head-25*z}L${x-25*z} ${head-5*z}Z`,hair);
  const blink=(t+id*1.8)%4.8>4.64,gaze=opt.gaze||0;
  for(const side of [-1,1]){const ex=x+side*12*z;line([ex-6*z,head-2*z],[ex+5*z,head-4*z],hair,1.8*z);if(blink)line([ex-5*z,head+8*z],[ex+5*z,head+8*z],K.ink,1.5*z);else{ell(ex+gaze*z,head+9*z,2.3*z,3.7*z,K.ink);if(!print)ell(ex+gaze*z-1,head+7*z,.7,.7,K.cream);}}
  c.strokeStyle=K.ink;c.lineWidth=1.7*z;c.beginPath();c.moveTo(x-6*z,head+26*z);c.quadraticCurveTo(x,head+(opt.tired?27:31)*z,x+7*z,head+25*z);c.stroke();
  for(const [side,sgn]of [['left',-1],['right',1]]){
   const a=[x+sgn*28*z,sy],h=opt[side]||[x+sgn*36*z,hip+31*z],dx=h[0]-a[0],dy=h[1]-a[1],d=Math.max(.001,Math.hypot(dx,dy)),dd=Math.min(147*z,d),hh=[a[0]+dx*dd/d,a[1]+dy*dd/d],height=Math.sqrt(Math.max(0,(74*z)**2-(dd/2)**2)),center=p(a,hh,.5);
   const candidates=[-1,1].map(q=>[center[0]-dy/d*height*q,center[1]+dx/d*height*q]),natural=[a[0]+sgn*25*z,a[1]+70*z];candidates.sort((aa,bb)=>Math.hypot(aa[0]-natural[0],aa[1]-natural[1])-Math.hypot(bb[0]-natural[0],bb[1]-natural[1]));
   armQueue.push(()=>{limb(a,candidates[0],20*z,coat);limb(candidates[0],hh,14*z,coat);ell(hh[0],hh[1],6*z,7*z,skin);});
  }
 };
 const arms=()=>{armQueue.forEach(f=>f());armQueue=[]};
 const scarf=(x,y,worn=false)=>{if(worn){poly([[x-30,y-6],[x+32,y-6],[x+28,y+17],[x-28,y+17]],K.gold);poly([[x+8,y+8],[x+29,y+11],[x+33,y+93],[x+9,y+88]],K.gold);}else{rect(x-56,y-8,112,20,K.gold);rect(x+31,y+9,21,59,K.gold);}};
 let rainCover=null;
 const umbrella=(x,y,open,tilt=0)=>{const tx=x+tilt,top=y-225,r=mix(8,223,open);line([x,y+15],[tx,top-12],K.cream,4);if(open<.12)poly([[tx-8,top],[tx+8,top],[x+12,y-30],[x-8,y-30]],K.red);else{path(`M${tx-r} ${top+56}Q${tx-r*.5} ${top-30} ${tx} ${top-13}Q${tx+r*.5} ${top-30} ${tx+r} ${top+56}Q${tx+r*.5} ${top+30} ${tx} ${top+50}Q${tx-r*.5} ${top+30} ${tx-r} ${top+56}Z`,K.red);for(const f of [-.6,0,.6])line([tx,top-13],[tx+r*f,top+48],K.gold,1.3);}rainCover={tx,top,r,open};};
 if(['bread','message','window'].includes(action)){
  busInside();const opt={sit:true,tired:action!=='message',gaze:2};let q=[640,mix(449,409,u)];
  if(action==='bread')opt.right=[q[0]+13,q[1]+7];
  if(action==='message'){q=p([540,418],[588,463],ease(clamp(u*1.5)));opt.left=[q[0]+13,q[1]+7];opt.right=[660,415];}
  actor(0,580,605,opt);bag(585,512);arms();if(action==='bread')bread(...q);if(action==='message'){if(u<.7)bread(...q);phone(660,398);}
 }else if(action==='soup'){
  home();const q=p([745,440],[605,456],ease(clamp(u*1.5)));actor(1,775,605,{left:[q[0]+27,q[1]+8],gaze:-2});table();arms();bowl(...q);
 }else if(action==='offbus'||action==='arrive'){
  shelter();bus(action==='arrive'?mix(-60,785,ease(clamp(u*1.5))):785,action==='offbus'?ease(clamp(u*2.3)):0);
  if(action==='offbus'){const x=mix(660,540,ease(u)),y=mix(553,605,ease(clamp(u*2)));actor(0,x,y,{walk:u>.1,left:kind==='family'?[x-55,y-112]:undefined,gaze:2});arms();if(kind==='family')bag(x-55,y-20);}
  if(kind==='romance'){actor(1,960,605,{left:[923,439],gaze:-2});arms();scarf(923,431);}
 }else if(action==='door'){
  city();rect(495,75,565,545,K.wood);rect(616,172,230,438,K.gold);rect(628,184,207,420,K.paper);rect(649,376,158,126,K.wood);const op=ease(clamp((u-.15)/.75)),dx=mix(619,817,op),dw=231*(1-op*.9);poly([[dx,184],[dx+dw,184+op*25],[dx+dw,606-op*20],[dx,610]],K.mid);const handle=[650+op*164,425];ell(...handle,5,7,K.gold);const x=mix(510,650,u);actor(1,850,605,{gaze:-2});actor(0,x,605,{walk:u>.35,right:u<.4?handle:undefined,left:[x-55,493],gaze:2});arms();bag(x-55,585);
 }else if(['bag','bowl','dinner'].includes(action)){
  home();const x=520,mx=780;let q=[605,456],m=[790,456];
  if(action==='bag'){const bottom=mix(555,618,ease(clamp(u*1.4))),drop=40*Math.sin(Math.PI*u);actor(0,x,605,{drop,left:u<.78?[450,bottom-88]:undefined,gaze:-1});actor(1,mx,605,{gaze:-2});table();arms();bag(450,bottom);bowl(...q);}
  if(action==='bowl'){q=p([666,435],[582,435],ease(clamp((u-.15)/.75)));actor(0,x,605,{right:p([556,490],[q[0]-26,q[1]+8],ease(clamp(u*2.1))),gaze:2});actor(1,mx,605,{left:u<.65?[q[0]+26,q[1]+8]:undefined,gaze:-2});table();arms();bag(450,618);bowl(...q);}
  if(action==='dinner'){const lift=ease(clamp((u-.1)/.3))*(1-ease(clamp((u-.78)/.2))),ml=ease(clamp((u-.3)/.32));q=[mix(577,521,lift),mix(456,379,lift)];m=[mix(790,780,ml),mix(456,387,ml)];actor(0,x,605,{sit:true,left:[q[0]-26,q[1]+8],right:[q[0]+26,q[1]+8],gaze:1});actor(1,mx,605,{sit:true,left:[m[0]-22,m[1]+7],right:[m[0]+22,m[1]+7],gaze:-1});table();arms();bag(450,618);bowl(...q);bowl(...m,.85);}
 }else if(kind==='friendship'){
  shelter();let hx=450,fx=850,open=0,tilt=0,handle=[550,425],h={},f={left:[825,323]},showH=action!=='rain',showF=action!=='alone';
  if(action==='open')open=ease(u);
  if(['approach','share','pass','leave'].includes(action)){open=1;hx=action==='approach'?mix(450,550,u):550;fx=action==='share'?mix(850,760,u):action==='approach'?850:760;handle=[hx+95,425];h={walk:action==='approach',gaze:2};if(action!=='approach')f={walk:action==='share',gaze:-2};}
  if(action==='pass'){f.left=p([724,490],[handle[0],439],ease(clamp(u*2.2)));h.right=u<.65?handle:p(handle,[586,490],ease((u-.65)/.35));tilt=-24*ease(u);}
  if(action==='leave'){const dx=100*u;hx+=dx;fx+=dx;handle[0]+=dx;tilt=-24;h={walk:true,gaze:1};f={walk:true,gaze:1,left:[handle[0],439],phase:.25};}
  if(showH)actor(0,hx,605,{...h,right:action==='leave'?undefined:h.right||handle});if(showF)actor(1,fx,605,f);arms();if(showH)umbrella(...handle,open,tilt);
 }else{
  shelter();if(action==='wait'){actor(1,790,605,{left:[750,439],gaze:-2});arms();scarf(750,431);}
  if(action==='recognize'){actor(0,540,605,{right:p([576,490],[595,374],ease(u)),gaze:2});actor(1,780,605,{left:[740,420],gaze:-2});arms();scarf(740,412);}
  if(action==='scarf'){const q=p([711,426],[605,426],ease(u));actor(0,540,605,{right:p([576,490],[q[0]-29,q[1]+7],ease(clamp(u*2))),gaze:2});actor(1,780,605,{left:u<.62?[q[0]+29,q[1]+7]:undefined,gaze:-2});arms();scarf(...q);}
  if(action==='wrap'){const q=p([605,426],[540,350],ease(clamp(u*1.3))),release=ease(clamp((u-.78)/.22));actor(0,540,605,{left:p([q[0]-38,q[1]+5],[504,490],release),right:p([q[0]+38,q[1]+5],[576,490],release),gaze:2});actor(1,780,605,{gaze:-2});arms();scarf(...q,u>.76);}
  if(action==='hands'){const point=[655,470],reach=ease(clamp(u*1.7));actor(0,550,605,{right:p([586,490],point,reach),gaze:2});actor(1,760,605,{left:p([724,490],point,reach),gaze:-2});arms();scarf(550,350,true);}
 }
 if(shot.rain>0&&!['bread','message','window','soup','bag','bowl','dinner','door'].includes(action))for(let i=0;i<shot.rain*140;i++){
  const x=(i*157+t*90)%1400-60,y=(i*79+t*280)%800-70,roof=kind==='friendship'&&x>110&&x<650&&y>210&&y<615,cover=rainCover&&rainCover.open>.8&&Math.abs(x-rainCover.tx)<rainCover.r*.9&&y>rainCover.top+58;
  if(!roof&&!cover){c.globalAlpha=.35;line([x,y],[x-8,y+24],K.cream,1.5);c.globalAlpha=1;}
 }
 c.restore();c.setTransform(surface.width/W,0,0,surface.height/H,0,0);
 if(print){c.strokeStyle=K.paper;c.lineWidth=14;c.strokeRect(14,14,W-28,H-28);for(let i=0;i<200;i++){c.globalAlpha=.05;rect((i*157)%W,(i*97)%H,2,2,K.paper);}c.globalAlpha=1;}
 if(options.subtitles!==false){const text=lyricAt(project,t);if(text){c.textAlign='center';c.textBaseline='middle';c.font='28px "PingFang SC",sans-serif';c.lineWidth=5;c.lineJoin='round';c.strokeStyle=K.ink;c.strokeText(text,640,668);fill(K.cream);c.fillText(text,640,668);}}
 if(pixel){const o=canvas.getContext('2d');o.setTransform(1,0,0,1,0,0);o.imageSmoothingEnabled=false;o.drawImage(surface,0,0,canvas.width,canvas.height);}
 return{shot:shot.id,action,u};
}
