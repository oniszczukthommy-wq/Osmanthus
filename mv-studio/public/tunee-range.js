// Local audio selection for the real MV workspace. No audio is uploaded.
const MAX_WAVE_BYTES=16_000_000, MAX_WAVE_SECONDS=240;
const waveCache=new Map();

export function audioRange(start,end,duration){
  if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(duration)||duration<=0||start<0||end<=start||end>duration+.001)return null;
  return {start,end};
}
export function localAudioUrl(value,base){
  try{const origin=new URL(base),url=new URL(value,origin);return ['http:','https:'].includes(url.protocol)&&url.origin===origin.origin&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function peakBins(samples,bins=256){
  if(!samples?.length||!Number.isInteger(bins)||bins<1)return [];
  const out=[];for(let i=0;i<bins;i++){const from=Math.floor(i*samples.length/bins),to=Math.floor((i+1)*samples.length/bins);let peak=0;for(let j=from;j<to;j++)peak=Math.max(peak,Math.abs(samples[j])||0);out.push(Math.min(1,peak));}return out;
}
export function createRangePlayer(audio,getRange,report=()=>{}){
  let active=false,timer=null,version=0;
  const clear=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
  const stop=()=>{version++;clear();if(active){active=false;audio.pause();}report('');};
  const tick=()=>{clear();if(!active)return;const range=getRange();if(!range){stop();report('请选择有效的起止时间');return;}if(audio.currentTime>=range.end-.015||audio.ended){audio.pause();audio.currentTime=range.start;active=false;report('已试听选中片段');return;}timer=setTimeout(tick,Math.max(80,Math.min(1000,(range.end-audio.currentTime)*1000)));};
  const onTime=()=>tick();const onEnded=()=>tick();
  audio.addEventListener('timeupdate',onTime);audio.addEventListener('ended',onEnded);
  async function toggle(){
    if(active){stop();report('已停止试听');return;}
    const range=getRange();if(!range){report('请选择歌曲范围内有效的起止时间');return;}
    if(!audio.src&&!audio.currentSrc){report('请先选择可用的音乐');return;}
    const run=++version;active=true;
    try{audio.currentTime=range.start;await audio.play();if(run!==version){audio.pause();return;}report('正在试听选中片段');tick();}
    catch{if(run===version){active=false;clear();report('无法播放该音频，请检查文件后重试');}}
  }
  function dispose(){stop();audio.removeEventListener('timeupdate',onTime);audio.removeEventListener('ended',onEnded);}
  return {toggle,stop,dispose,isActive:()=>active};
}

async function limitedBytes(response){
  if(!response.ok)throw Error('音频暂时无法读取');
  const declared=Number(response.headers?.get('content-length')||0);if(declared>MAX_WAVE_BYTES)throw Error('音频较大，暂不绘制波形，仍可输入时间试听');
  if(!response.body?.getReader){const bytes=await response.arrayBuffer();if(bytes.byteLength>MAX_WAVE_BYTES)throw Error('音频较大，暂不绘制波形，仍可输入时间试听');return bytes;}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_WAVE_BYTES){await reader.cancel();throw Error('音频较大，暂不绘制波形，仍可输入时间试听');}chunks.push(value);}}finally{reader.releaseLock();}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}return all.buffer;
}
async function readPeaks(url){
  if(waveCache.has(url))return waveCache.get(url);
  const task=(async()=>{const response=await fetch(url,{credentials:'same-origin',redirect:'error'});if(response.url&&!localAudioUrl(response.url,location.href))throw Error('音频来源不可用');const bytes=await limitedBytes(response);const Context=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Context)throw Error('当前浏览器不支持绘制音频波形');const context=new Context();try{const decoded=await context.decodeAudioData(bytes);if(decoded.duration>MAX_WAVE_SECONDS)throw Error('歌曲较长，暂不绘制波形，仍可输入时间试听');return peakBins(decoded.getChannelData(0));}finally{await context.close().catch(()=>{});}})();
  waveCache.set(url,task);while(waveCache.size>3)waveCache.delete(waveCache.keys().next().value);
  try{return await task;}catch(error){waveCache.delete(url);throw error;}
}

/** Attach under the existing start/end fields. Caller disposes before rerender. */
export function mountTuneeRange({host,audio,startInput,endInput,duration,disabled=false}={}){
  if(!host||!audio||!startInput||!endInput)throw Error('选段组件缺少必要控件');
  let disposed=false,values=null,total=Number(duration);
  host.innerHTML='<div class="tunee-range"><canvas width="700" height="88" role="img" aria-label="音乐波形，选中片段会高亮"></canvas><p class="tunee-range-status" role="status">正在本机读取波形…</p><label>开始位置<input type="range" class="tunee-range-start" aria-label="拖动选择开始时间" min="0" step="0.1"></label><label>结束位置<input type="range" class="tunee-range-end" aria-label="拖动选择结束时间" min="0" step="0.1"></label><button type="button" class="tunee-range-play">试听选中片段</button><p class="hint">波形仅在本机读取；拖动滑杆或输入秒数选段。</p></div>';
  const canvas=host.querySelector('canvas'),status=host.querySelector('.tunee-range-status'),startSlider=host.querySelector('.tunee-range-start'),endSlider=host.querySelector('.tunee-range-end'),button=host.querySelector('.tunee-range-play');
  startSlider.disabled=endSlider.disabled=button.disabled=!!disabled;
  function range(){const a=startInput.value.trim(),b=endInput.value.trim();return a&&b?audioRange(Number(a),Number(b),total):null;}
  const player=createRangePlayer(audio,range,text=>{if(!disposed){if(text)status.textContent=text;button.textContent=player.isActive()?'停止试听':'试听选中片段';}});
  function paint(){const ctx=canvas.getContext('2d');if(!ctx)return;const {width:w,height:h}=canvas;ctx.clearRect(0,0,w,h);ctx.fillStyle='#f4f1fb';ctx.fillRect(0,0,w,h);const r=range();if(r){ctx.fillStyle='#d8cff5';ctx.fillRect(w*r.start/total,0,w*(r.end-r.start)/total,h);}ctx.fillStyle='#8e80c8';(values||[]).forEach((v,i)=>{const height=Math.max(2,v*(h-8));ctx.fillRect(i*w/values.length,(h-height)/2,Math.max(1,w/values.length-1),height);});}
  function sync(){if(!Number.isFinite(total)||total<=0){status.textContent='歌曲时长不可用，请重新选择音乐';startSlider.disabled=endSlider.disabled=button.disabled=true;return;}startSlider.max=endSlider.max=String(total);startSlider.value=startInput.value||'0';endSlider.value=endInput.value||String(total);paint();}
  const update=(which,value)=>{if(!Number.isFinite(total)||total<=0)return;let n=Math.max(0,Math.min(total,Number(value)));if(!Number.isFinite(n))return;const other=which==='start'?Number(endInput.value):Number(startInput.value);if(which==='start'&&Number.isFinite(other))n=Math.min(n,Math.max(0,other-.1));if(which==='end'&&Number.isFinite(other))n=Math.max(n,Math.min(total,other+.1));const field=which==='start'?startInput:endInput;field.value=String(Math.round(n*1000)/1000);field.dispatchEvent(new Event('input',{bubbles:true}));player.stop();sync();};
  const startDrag=()=>update('start',startSlider.value),endDrag=()=>update('end',endSlider.value),onInput=()=>{player.stop();sync();},onClick=()=>void player.toggle(),onMeta=()=>{if(Number.isFinite(audio.duration)&&audio.duration>0){total=audio.duration;sync();}};
  startSlider.addEventListener('input',startDrag);endSlider.addEventListener('input',endDrag);startInput.addEventListener('input',onInput);endInput.addEventListener('input',onInput);button.addEventListener('click',onClick);audio.addEventListener('loadedmetadata',onMeta);sync();
  const src=localAudioUrl(audio.currentSrc||audio.src,location.href);
  if(!src)status.textContent='音频地址不可用，请重新选择音乐';
  else if(total>MAX_WAVE_SECONDS)status.textContent='歌曲较长，暂不绘制波形，仍可输入时间试听';
  else readPeaks(src).then(peaks=>{if(disposed)return;values=peaks;status.textContent='波形已在本机生成';paint();}).catch(error=>{if(!disposed)status.textContent=String(error.message||'无法绘制波形，仍可输入时间试听');});
  function dispose(){if(disposed)return;disposed=true;player.dispose();startSlider.removeEventListener('input',startDrag);endSlider.removeEventListener('input',endDrag);startInput.removeEventListener('input',onInput);endInput.removeEventListener('input',onInput);button.removeEventListener('click',onClick);audio.removeEventListener('loadedmetadata',onMeta);}
  return {dispose};
}
