export function initStemSplitter({root,icons}) {
  const nav=root.querySelector('.studio-sidebar-nav');
  const button=document.createElement('button');
  button.type='button'; button.dataset.studioNav='stems'; button.setAttribute('aria-pressed','false');
  button.innerHTML='<i data-lucide="audio-lines" aria-hidden="true"></i><span>音轨分离</span>';
  nav.append(button);
  const link=document.createElement('link'); link.rel='stylesheet'; link.href='/stem-split.css'; document.head.append(link);
  const page=document.createElement('main'); page.className='studio-shell-main stem-page'; page.dataset.studioStems=''; page.hidden=true;
  page.innerHTML=`<div class="stem-wrap"><header class="stem-heading"><span class="stem-eyebrow">音频工具</span><h1>音轨分离</h1><p>把一首歌拆分为人声、鼓、贝斯和其他伴奏，方便单独试听和下载。</p></header>
    <section class="stem-card" aria-label="上传音频"><div class="stem-drop" tabindex="0" role="button" aria-label="选择音频文件"><div class="stem-drop-icon"><i data-lucide="upload" aria-hidden="true"></i></div><h2>拖放音频到这里，或点击上传</h2><p>支持 MP3、WAV、FLAC、M4A，最大 150 MB，最长 10 分钟</p><button class="stem-choose" type="button">选择音频</button><input class="stem-file" type="file" accept=".mp3,.wav,.flac,.m4a,audio/mpeg,audio/wav,audio/flac,audio/mp4" hidden></div>
    <div class="stem-selected" hidden><div><strong class="stem-filename"></strong><span class="stem-size"></span></div><button type="button" class="stem-clear">更换音频</button></div><div class="stem-actions"><button type="button" class="primary stem-start" disabled>开始分离</button><span>音频在本机处理，耗时取决于歌曲长度。</span></div></section>
    <section class="stem-progress" hidden aria-live="polite"><div><strong class="stem-progress-title"></strong><p class="stem-progress-message"></p></div><progress aria-label="音轨分离进度"></progress></section>
    <section class="stem-results" hidden aria-label="分离结果"><div class="stem-results-header"><div><h2>分离完成</h2><p>选择音轨试听，或下载音频。</p></div><button type="button" class="stem-again">分离另一首</button></div><div class="stem-list"></div></section>
    <p class="stem-error" role="alert" hidden></p></div>`;
  root.querySelector('[data-studio-home]').before(page);
  const el=s=>page.querySelector(s),input=el('.stem-file'),drop=el('.stem-drop'),selected=el('.stem-selected'),start=el('.stem-start'),notice=el('.stem-error'),progress=el('.stem-progress'),results=el('.stem-results');
  const storageKey='osmanthus-stem-split-job'; let file=null, busy=false, jobId=null, timer=null;
  const setError=message=>{notice.textContent=message||'';notice.hidden=!message;};
  const setBusy=value=>{busy=value;start.disabled=value||!file;el('.stem-choose').disabled=value;el('.stem-clear').disabled=value;drop.classList.toggle('is-disabled',value);};
  const fmtSize=n=>`${(n/1024/1024).toFixed(1)} MB`;
  function chooseFile(next) {
    if(busy||!next)return;
    if(!/\.(mp3|wav|flac|m4a)$/i.test(next.name)){setError('请选择 MP3、WAV、FLAC 或 M4A 文件。');return;}
    if(next.size===0||next.size>150*1024*1024){setError('音频文件不能为空，且不能超过 150 MB。');return;}
    file=next;setError('');el('.stem-filename').textContent=next.name;el('.stem-size').textContent=fmtSize(next.size);selected.hidden=false;start.disabled=false;results.hidden=true;progress.hidden=true;
  }
  drop.addEventListener('click',e=>{if(!busy&&e.target!==input)input.click();});
  drop.addEventListener('keydown',e=>{if(!busy&&e.target===drop&&(e.key==='Enter'||e.key===' ')){e.preventDefault();input.click();}});
  ['dragenter','dragover'].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();if(!busy)drop.classList.add('is-dragging');}));
  ['dragleave','drop'].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove('is-dragging');}));
  drop.addEventListener('drop',e=>chooseFile(e.dataTransfer?.files?.[0]));
  input.addEventListener('change',()=>{chooseFile(input.files?.[0]);input.value='';});
  el('.stem-clear').addEventListener('click',()=>{if(!busy)input.click();});
  function progressState(title,message){progress.hidden=false;el('.stem-progress-title').textContent=title;el('.stem-progress-message').textContent=message;}
  function renderResults(data){
    const list=el('.stem-list');list.replaceChildren();
    for(const stem of data.stems||[]){
      let url;try{url=new URL(stem.url,location.href);if(url.origin!==location.origin)continue;}catch{continue;}
      const row=document.createElement('div');row.className='stem-row';
      const text=document.createElement('strong');text.textContent=stem.label||stem.id;
      const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=url.href;
      audio.addEventListener('play',()=>list.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();}));
      const a=document.createElement('a');a.href=url.href;a.download=`${stem.id}.wav`;a.textContent='下载';row.append(text,audio,a);list.append(row);
    }
    if(!list.children.length){setError('任务已完成，但没有找到可试听的音轨。');return;}
    el('.stem-results-header p').textContent=data.filename?`${data.filename} · 选择音轨试听，或下载音频。`:'选择音轨试听，或下载音频。';results.hidden=false;start.disabled=true;
  }
  async function poll(){
    if(!jobId)return;
    try {
      const response=await fetch(`/api/stem-split/jobs/${encodeURIComponent(jobId)}`,{cache:'no-store'});
      const data=await response.json(); if(response.status===404){clearTimeout(timer);jobId=null;try{localStorage.removeItem(storageKey);}catch{};setBusy(false);progress.hidden=true;setError(data.error||'找不到该任务，请重新选择音频。');return;} if(!response.ok)throw Error(data.error||`查询失败 (${response.status})`);
      setError('');
      if(data.status==='ready'){clearTimeout(timer);setBusy(false);progress.hidden=true;renderResults(data);return;}
      if(data.status==='error'){clearTimeout(timer);setBusy(false);progress.hidden=true;setError(data.error||'分离失败，请更换音频后重试。');return;}
      progressState(data.status==='queued'?'等待处理':'正在分离音轨',data.status==='queued'?'任务已创建，请稍候。':'本机正在处理音频，较长的歌曲可能需要几分钟。');
    } catch(error){progressState('等待连接','暂时无法查询进度，正在重试，请保持服务运行。');}
    timer=setTimeout(poll,3000);
  }
  start.addEventListener('click',async()=>{
    if(!file||busy)return;setError('');setBusy(true);progressState('正在上传音频','请稍候，大文件上传可能需要一些时间。');
    try{
      const response=await fetch(`/api/stem-split/jobs?filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
      const data=await response.json();if(!response.ok)throw Error(data.error||`上传失败 (${response.status})`);if(!data.id)throw Error('服务未返回任务编号。');
      jobId=data.id;try{localStorage.setItem(storageKey,jobId);}catch{};await poll();
    }catch(error){setBusy(false);progress.hidden=true;setError(error.message||'上传失败，请检查服务后重试。');}
  });
  el('.stem-again').addEventListener('click',()=>{clearTimeout(timer);jobId=null;try{localStorage.removeItem(storageKey);}catch{};file=null;selected.hidden=true;results.hidden=true;progress.hidden=true;setError('');setBusy(false);});
  try{jobId=localStorage.getItem(storageKey);}catch{};if(jobId){setBusy(true);progressState('正在恢复分离任务','正在查询任务状态。');void poll();}
  icons();
}
