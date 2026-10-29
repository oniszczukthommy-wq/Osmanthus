const $=id=>document.getElementById(id),token=location.pathname.split('/').filter(Boolean).at(-1);
const status=text=>$('share-status').textContent=text;
let share=null;
try{
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token))throw Error('分享地址不完整');
 const r=await fetch('/api/shares/'+token),data=await r.json();if(!r.ok)throw Error(data.error||'无法读取分享');share=data;
 if(share.stage!=='ready')throw Error(share.error||'分享文件尚未准备完成');
 document.title=share.title+' · Osmanthus';$('share-title').textContent=share.title;
 if(share.quote){$('share-quote').textContent=share.quote;$('share-quote').hidden=false;}
 if(share.creator){$('share-creator').textContent='创作：'+share.creator;$('share-creator').hidden=false;}
 $('share-audio').src=share.audio_url;$('share-download').href=share.audio_url;$('share-download').download=share.title.replace(/[\\/:*?"<>|]/g,'_')+'.mp3';$('share-download').hidden=false;
 if(share.cover_url){$('share-cover').src=share.cover_url;$('share-cover').hidden=false;$('cover-empty').hidden=true;$('cover-download').href=share.cover_url;$('cover-download').hidden=false;}
 if(share.poster_url){$('poster-download').href=share.poster_url;$('poster-download').hidden=false;}
 $('share-scope').textContent=share.scope_note;$('share-copy').disabled=false;$('share-send').disabled=false;
}catch(error){status(error.message);}
$('share-copy').onclick=async()=>{try{await navigator.clipboard.writeText(share.share_text);status('歌名与歌词已复制。');}catch{status('复制未完成，可选中文字后手动复制。');}};
$('share-send').onclick=async()=>{const b=$('share-send');b.disabled=true;try{
 const r=await fetch(share.audio_url);if(!r.ok)throw Error('音频文件读取失败');const file=new File([await r.blob()],share.title.replace(/[\\/:*?"<>|]/g,'_')+'.mp3',{type:'audio/mpeg'});
 if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({title:share.title,text:share.share_text,files:[file]});status('音频文件已交给系统分享。');}
 else{const a=$('share-download');a.click();status('当前浏览器不支持系统文件分享，已发起音频下载，可把文件发送给朋友。');}
}catch(error){status(error.name==='AbortError'?'已取消分享。':error.message);}finally{b.disabled=false;}};
