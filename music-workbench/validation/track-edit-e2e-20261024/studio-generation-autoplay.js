// One listening intent per generation. It never selects a project or submits music.
export function createGenerationAutoplay({play,storage,onBlocked=()=>{},now=Date.now}){
 const key='osmanthus-generation-autoplay';let intent=null,serial=0;
 try{const saved=JSON.parse(storage?.getItem(key)||'null');if(saved?.batchId&&now()-saved.at<1800000)intent=saved;}catch{}
 function save(){try{storage?.setItem(key,JSON.stringify(intent));}catch{}}
 function arm(batchId){if(!batchId||intent?.batchId===batchId)return;serial++;intent={batchId,at:now(),stage:'armed'};save();}
 function cancel(){if(!intent)return;serial++;intent={...intent,stage:'cancelled'};save();}
 async function observe(batches){if(intent?.stage!=='armed')return;const batch=batches.find(b=>b.id===intent.batchId);if(!batch)return;
  const candidates=batch.candidates||[],song=candidates.find(c=>c.media?.stream)||candidates.find(c=>c.media?.complete||c.media?.preview_complete);if(!song)return;
  const token=serial;intent={...intent,stage:'starting',candidateId:song.id};save();
  try{const result=await play(song.id,{toggle:false,automatic:true});if(token!==serial)return;intent={...intent,stage:result?.superseded?'cancelled':'playing'};save();}
  catch(error){if(token!==serial)return;intent={...intent,stage:'blocked'};save();onBlocked(error,song.id);}
 }
 // A reload during buffering may retry listening, never the paid generation.
 if(intent?.stage==='starting')intent.stage='armed';
 return {arm,cancel,observe,get state(){return intent?{...intent}:null;}};
}
