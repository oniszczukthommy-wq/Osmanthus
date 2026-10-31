// A view over existing draft/batch DOM. No generation requests or form writes.
export function initializeCreateWorkspace(studio,{onHome=()=>{},onCreateView=()=>{}}={}){
 const root=document.getElementById('os-mix-28'),workspace=root?.querySelector('[data-studio-create]');
 if(!root||!workspace)return null;
 const draftMount=document.getElementById('studio-drafts'),batchMount=document.getElementById('studio-batches');
 const resumeWrap=root.querySelector('[data-create-resume-wrap]'),resumeButton=root.querySelector('[data-create-resume]'),resumeLabel=root.querySelector('[data-create-resume-label]'),back=workspace.querySelector('[data-create-home]');
 const draftEmpty=workspace.querySelector('[data-create-draft-empty]'),resultsEmpty=workspace.querySelector('[data-create-results-empty]');
 const caption=root.querySelector('[data-studio-editor] .rs-projecthead .rs-caption');
 let returnButton=root.querySelector('[data-create-return]');
 if(!returnButton&&caption){returnButton=document.createElement('button');returnButton.type='button';returnButton.className='studio-create-return rs-outline';returnButton.dataset.createReturn='';returnButton.textContent='返回两首方案';returnButton.hidden=true;caption.after(returnButton);}
 let activeDraftId=null,resumableId=null;
 const drafts=()=>Array.isArray(studio.drafts)?studio.drafts:[];
 const batches=()=>Array.isArray(studio.batches)?studio.batches:[];
 const title=draft=>studio.displaySongTitle?.(draft?.title)||draft?.title||'未命名歌曲';
 function unfinished(draft){if(draft.stage!=='confirmed')return true;const batch=batches().find(item=>item.id===draft.batch_id);return !batch||batch.stage!=='ready'||!batch.project_id;}
 function ownsCurrentProject(batch){const id=studio.engine?.getProject?.()?.id;return !!id&&Array.isArray(batch?.candidates)&&batch.candidates.some(candidate=>candidate.id===id);}
 function sync(){
  const available=drafts(),draft=available.find(item=>item.id===activeDraftId),batch=draft?.batch_id?batches().find(item=>item.id===draft.batch_id):null;
  let visibleDraft=false,visibleBatch=false;
  for(const node of draftMount.querySelectorAll('[data-draft]')){
   const selected=node.dataset.draft===activeDraftId;node.hidden=!selected;visibleDraft ||= selected;
   if(selected&&draft?.stage==='confirmed'){
    const approved=node.querySelector('[data-draft-approved]');
    if(approved&&!approved.dataset.workspaceOpened){approved.open=true;approved.dataset.workspaceOpened='true';}
   }
  }
  for(const node of batchMount.querySelectorAll('[data-batch]')){const selected=!!batch&&node.dataset.batch===batch.id;node.hidden=!selected;visibleBatch ||= selected;}
  draftEmpty.hidden=visibleDraft;draftEmpty.textContent=activeDraftId?'':'从首页写下歌曲想法，先准备一份歌词。';resultsEmpty.hidden=visibleBatch;
  const currentStep=batch?.stage==='ready'&&batch.project_id?2:draft?.stage==='confirmed'?1:0;
  for(const [index,node] of [...workspace.querySelectorAll('[data-create-step]')].entries()){
   node.dataset.state=index<currentStep?'done':index===currentStep?'current':'next';
   if(index===currentStep)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
  }
  const latest=[...available].sort((a,b)=>(b.created_at||0)-(a.created_at||0))[0];
  resumableId=latest?.id||null;resumeWrap.hidden=!resumableId;
  if(latest)resumeLabel.textContent=unfinished(latest)?'继续《'+title(latest)+'》':'查看《'+title(latest)+'》的两首方案';
  if(returnButton)returnButton.hidden=!draft||!ownsCurrentProject(batch);
  workspace.dataset.activeDraft=activeDraftId||'';
 }
 function show(draftId){
  activeDraftId=draftId||resumableId||drafts()[0]?.id||null;
  onCreateView(activeDraftId);workspace.hidden=false;sync();window.scrollTo({top:0,behavior:'instant'});
 }
 function hide(){workspace.hidden=true;}
 if(returnButton)returnButton.onclick=()=>{const draft=drafts().find(item=>item.id===activeDraftId),batch=draft?.batch_id?batches().find(item=>item.id===draft.batch_id):null;if(draft&&ownsCurrentProject(batch))show(draft.id);};
 back.onclick=()=>onHome();resumeButton.onclick=()=>{if(resumableId)show(resumableId);};sync();
 return {show,hide,sync,get activeDraftId(){return activeDraftId;}};
}
