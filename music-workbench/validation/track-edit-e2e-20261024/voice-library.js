const $=id=>document.getElementById(id);
export function initializeVoiceLibrary({getProject,transport,settle}){
 let voices=[],projectId=null,choice='',loading=false,serial=0;
 const audio=$('voice-library-audio');
 Object.defineProperty(window,'voiceLibraryState',{get:()=>({projectId,choice,count:voices.length,previewPaused:audio.paused,source:audio.getAttribute('src')})});
 window.pauseVoiceLibraryPreview=()=>audio.pause();
 function filter(){const query=$('voice-library-search').value.trim().toLowerCase(),gender=$('voice-library-gender').value,language=$('voice-library-language').value;
  const rows=voices.filter(v=>(!gender||v.gender.includes(gender))&&(!language||v.languages.some(s=>s.includes(language)))&&[v.name,...v.tags,...v.languages].join(' ').toLowerCase().includes(query));
  const select=$('voice-library-select');select.replaceChildren(new Option('请选择已有音色',''),...rows.map(v=>new Option(`${v.name} · ${v.tags.join(' / ')}`,v.id)));
  if(rows.some(v=>v.id===choice))select.value=choice;else{choice='';audio.pause();audio.removeAttribute('src');}
  $('voice-library-count').textContent=`首版 ${voices.length} 个音色预设 · 当前筛选 ${rows.length} 个声音`;$('choose-voice-reference').disabled=!choice;
 }
 function change(){audio.pause();choice=$('voice-library-select').value;const voice=voices.find(v=>v.id===choice);if(voice)audio.src=voice.preview_url;else audio.removeAttribute('src');
  $('choose-voice-reference').disabled=!voice;$('voice-library-details').textContent=voice?`${voice.gender.join(' / ')} · ${voice.languages.join(' / ')} · ${voice.tags.join(' / ')}`:'';
 }
 async function load(){if(loading||!getProject())return;loading=true;const id=getProject().id,request=++serial;try{
  const r=await fetch('/api/voice-library?project_id='+encodeURIComponent(id));const data=await r.json();if(!r.ok)throw Error(data.error);if(getProject().id!==id||request!==serial)return;
  voices=data.voices;projectId=id;choice=data.selected?.voice_id||'';filter();$('voice-library-select').value=choice;change();
  $('voice-library-status').textContent=data.selected?`已选目标音色：${data.selected.name}。演唱转换尚待验证，当前歌曲未改变。`:'从已有库试听并选定目标音色，选择不会修改当前歌曲。';
 }catch(e){$('voice-library-status').textContent=e.message;}finally{loading=false;}}
 for(const id of ['voice-library-search','voice-library-gender','voice-library-language'])$(id).addEventListener(id==='voice-library-search'?'input':'change',filter);
 $('voice-library-select').onchange=change;
 audio.onplay=()=>{transport.pause();window.pauseScorePreview?.();window.pauseGenerationPreview?.();window.pauseVocalPreview?.();};
 $('choose-voice-reference').onclick=async()=>{if(!choice||!await settle())return;const p=getProject(),id=p.id;try{
  const r=await fetch('/api/voice-library/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:id,revision:p.revision,voice_id:choice})});const data=await r.json();if(!r.ok)throw Error(data.error);if(getProject().id!==id)return;
  $('voice-library-status').textContent=`已选目标音色：${data.selected.name}。演唱转换尚待验证，当前歌曲未改变。`;
 }catch(e){$('voice-library-status').textContent=e.message;}};
 setInterval(()=>{if(projectId!==getProject()?.id){audio.pause();load();}},1200);load();
}
