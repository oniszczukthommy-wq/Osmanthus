import {creationProgress,candidateProgress} from './studio-creation-request.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createCreationRequestRecovery,generationIsBlocked} from './studio-creation-request.js';

const id='11111111-1111-4111-8111-111111111111',payload={mode:'advanced',lyrics:'[Verse]\n原来的歌词',style:'中文流行'};
const error=(status,message='test error')=>Object.assign(Error(message),{status});
const flow={id,batch_id:id,batch:{id,candidates:[]}};
function fixture(saved=null,respond=async()=>flow){
 const values=new Map(saved?[['osmanthus-direct-generation-request',JSON.stringify(saved)]]:[]),calls=[],accepted=[];
 const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const recovery=createCreationRequestRecovery({storage,uuid:()=>id,api:async(path,body)=>{calls.push({path,body});return respond(path,body);},onAccepted:item=>accepted.push(item)});
 return{values,calls,accepted,storage,recovery};
}
let passed=0;
async function test(name,run){await run();passed++;process.stdout.write('PASS '+name+'\n');}

await test('new generation saves original id and payload before a single POST',async()=>{
 let f;f=fixture(null,async(path,body)=>{assert.ok(f.values.size);assert.equal(body.request_id,id);return flow;});
 assert.equal((await f.recovery.start(payload)).kind,'accepted');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{request_id:id,...payload});assert.equal(f.values.size,0);
});
await test('uncertain generation response keeps id and reload only looks up original request',async()=>{
 const f=fixture(null,async()=>{throw error(500);});await assert.rejects(f.recovery.start(payload));assert.equal(f.values.size,1);
 const restored=fixture(JSON.parse([...f.values.values()][0]));await restored.recovery.inspect();
 assert.equal(restored.calls.length,1);assert.equal(restored.calls[0].body,undefined);assert.equal(restored.accepted[0].id,id);assert.equal(restored.values.size,0);
});
await test('changed form while pending never submits a different paid request',async()=>{
 const f=fixture({id,payload},async()=>{throw error(404);});
 await assert.rejects(f.recovery.start({...payload,lyrics:'另一首歌词'}),/继续原请求/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);assert.equal(f.recovery.state.phase,'missing');assert.equal(f.values.size,1);
});
await test('explicit continue checks again then sends same original id and payload',async()=>{
 const f=fixture({id,payload},async(path,body)=>{if(!body)throw error(404);return flow;});
 await f.recovery.inspect();await f.recovery.continue();
 assert.deepEqual(f.calls.map(x=>x.body),[undefined,undefined,{request_id:id,...payload}]);assert.equal(f.values.size,0);
});
await test('explicit cancellation asks server for durable exclusion, never POSTs generation',async()=>{
 const f=fixture({id,payload},async(path,body)=>{if(!body)throw error(404);assert.equal(path,'/api/creation/jobs/'+id+'/cancel');return{cancelled:true};});
 assert.equal((await f.recovery.cancel()).kind,'cancelled');assert.equal(f.values.size,0);assert.equal(f.calls.length,2);
});
await test('late accepted request wins cancellation race and is restored',async()=>{
 const f=fixture({id,payload},async(path,body)=>{if(!body)throw error(404);return{cancelled:false,creation:flow};});
 assert.equal((await f.recovery.cancel()).kind,'accepted');assert.equal(f.accepted[0].id,id);assert.equal(f.values.size,0);assert.equal(f.calls.filter(c=>c.path==='/api/creation/jobs').length,0);
});
await test('failed cancellation leaves original request available for a safe retry',async()=>{
 const f=fixture({id,payload},async(path,body)=>{throw error(body?500:404);});
 await assert.rejects(f.recovery.cancel());assert.equal(f.values.size,1);
});
await test('network lookup failure or corrupt-state 409 never clears or resubmits',async()=>{
 for(const status of [undefined,409,500]){const f=fixture({id,payload},async()=>{throw error(status);});await assert.rejects(f.recovery.continue());assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);assert.equal(f.values.size,1);}
});
await test('local persistence failure starts no provider request',async()=>{
 const f=fixture();f.storage.setItem=()=>{throw Error('storage unavailable');};await assert.rejects(f.recovery.start(payload),/storage/);assert.equal(f.calls.length,0);
});
await test('rapid double click cannot start two submissions',async()=>{
 let resolve;const f=fixture(null,()=>new Promise(r=>resolve=r));const first=f.recovery.start(payload);
 await assert.rejects(f.recovery.start(payload),/稍候/);resolve(flow);await first;assert.equal(f.calls.length,1);
});
await test('corrupt local record is blocked instead of silently replaced',async()=>{
 const f=fixture({id:'broken',payload});await assert.rejects(f.recovery.start(payload),/记录不完整/);assert.equal(f.calls.length,0);assert.equal(f.values.size,1);
});

const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
await test('real form disables song creation during AI rewrite despite nonempty lyrics',async()=>{
 const nodes={'studio-generate-song':{},'studio-write-lyrics':{},'studio-custom-lyrics':{value:'旧歌词'},'studio-simple-prompt':{value:'创作想法'}};
 const context={creationRecovery:{state:{working:false,pending:null}},generationIsBlocked,creating:false,lyricsRequest:'rewrite',mode:'advanced',instrumental:false,all:()=>[],q:()=>null,$:id=>nodes[id]};
 const fn=source.slice(source.indexOf('function updateGenerateButton()'),source.indexOf('async function resumeCreation'));
 vm.runInNewContext(fn+';updateGenerateButton();',context);assert.equal(nodes['studio-generate-song'].disabled,true);assert.equal(nodes['studio-write-lyrics'].disabled,true);
 context.lyricsRequest=null;vm.runInNewContext('updateGenerateButton();',context);assert.equal(nodes['studio-generate-song'].disabled,false);
});
await test('real generation action refuses rewrite race before building or sending request',async()=>{
 const fn=source.slice(source.indexOf('async function generate('),source.indexOf('async function writeLyrics('));
 const context={creating:false,lyricsRequest:'rewrite'};vm.runInNewContext(fn+';globalThis.result=generate();',context);
 await assert.rejects(context.result,/歌词写作完成/);
});
await test('empty-candidate failure renders real recovery button and disappears after cancellation',async()=>{
 const children={'h3':{},'[data-batch-status]':{},'[data-batch-resume]':{}},nodes=new Map(),resumed=[];
 let removed=false;
 const node={dataset:{},querySelector:key=>children[key],remove:()=>{removed=true;}},holder={prepend:()=>{},classList:{toggle:()=>{}}},empty={};
 const context={creationProgress,batches:[],creations:[{id,input:{title:'未完成'},stage:'error',error:'写词服务失败',can_resume:true}],batchNodes:nodes,
  document:{createElement:()=>node},$:()=>holder,guarded:fn=>fn(),resumeCreation:key=>{resumed.push(key);},
  displaySongTitle:value=>value,labels:{error:'失败'},resumingBatches:new Set(),library:[],activeBatchId:null,
  renderWorkspaceLegacy:()=>{},orderWorkspace:()=>{},filterWorkspace:()=>{},applyFavoriteState:()=>{},applyPlaybackState:()=>{},player:null,q:()=>empty,icons:()=>{}};
 const ensure=source.slice(source.indexOf('function ensureBatch('),source.indexOf('function renderWorkspaceLegacy('));
 const render=source.slice(source.indexOf('function renderBatches('),source.indexOf('async function refresh('));
 vm.runInNewContext(ensure+'\n'+render+'\nrenderBatches();',context);
 assert.equal(children['[data-batch-resume]'].hidden,false);assert.equal(children['[data-batch-status]'].textContent,'写词服务失败');
 await children['[data-batch-resume]'].onclick();assert.deepEqual(resumed,[id]);
 context.creations=[];vm.runInNewContext('renderBatches();',context);assert.equal(removed,true);assert.equal(nodes.size,0);
});
await test('stream, provider completion and full local download have distinct truthful progress',async()=>{
 assert.match(creationProgress({candidates:[{media:{stream:'/stream'}}]}),/已可试听/);
 assert.match(candidateProgress({media:{stream:'/stream'}},'正在生成'),/可试听/);
 assert.match(creationProgress({candidates:[{status:'done'}]}),/接收完整音频/);
 assert.match(creationProgress({candidates:[{media:{complete:'/a'}},{media:{complete:'/b'}}]}),/两版歌曲已生成/);
 assert.equal(creationProgress({error:'本次生成失败'}),'本次生成失败');
});
await test('real generate action persists one draft request and never submits music before approval',async()=>{
 const values=new Map(),calls=[],shown=[],draft={id,stage:'ready'},nodes={'studio-create-status':{}};
 const context={creationRecovery:{state:{pending:null}},creating:false,lyricsRequest:null,instrumental:false,mode:'advanced',creationBody:()=>payload,updateGenerateButton:()=>{},$:key=>nodes[key],crypto:{randomUUID:()=>id},drafts:[],lyricDraftId:null,
 localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
 api:async(path,body)=>{assert.ok(values.has('osmanthus-pending-lyric-start'));calls.push({path,body});return draft;},showDraftReview:d=>shown.push(d),renderHomeCreation:()=>{}};
 const fn=source.slice(source.indexOf('async function generate('),source.indexOf('async function writeLyrics('));
 vm.runInNewContext(fn+';globalThis.result=generate();',context);await context.result;
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/generation/drafts');assert.equal(calls[0].body.lyrics,payload.lyrics);assert.equal(shown[0],draft);assert.equal(context.creating,false);
});
await test('instrumental directly starts one recoverable pair and never creates a lyric draft',async()=>{
 const calls=[],accepted=[],nodes={'studio-create-status':{}},values=new Map(),flow={id,batch_id:id,stage:'generating',batch:{instrumental:true,candidates:[]}};
 const context={creating:false,lyricsRequest:null,instrumental:true,mode:'simple',creationBody:()=>({prompt:'安静的钢琴',mode:'simple',instrumental:true}),updateGenerateButton:()=>{},$:k=>nodes[k],
  creationRecovery:{state:{pending:null},start:async body=>{calls.push(body);return{kind:'accepted',flow};}},acceptCreationFlow:value=>accepted.push(value),refresh:async()=>{},creationProgress,
  localStorage:{removeItem:key=>values.delete(key)},api:()=>{throw Error('instrumental must not call lyric draft API');},lyricDraftId:'old'};
 const fn=source.slice(source.indexOf('async function generate('),source.indexOf('async function writeLyrics('));
 vm.runInNewContext(fn,context);await context.generate();assert.equal(calls.length,1);assert.equal(calls[0].instrumental,true);assert.equal(accepted.length,1);assert.equal(context.lyricDraftId,null);assert.equal(context.creating,false);
});
await test('instrumental payload excludes retained lyrics and vocal settings without erasing them',async()=>{
 const nodes={'studio-simple-prompt':{value:'雨后钢琴'},'studio-custom-lyrics':{value:'保留的歌词'},'studio-custom-style':{value:'轻柔民谣'},'studio-custom-title':{value:'雨后'},'studio-custom-voice':{value:'男声'}};
 const context={instrumental:true,mode:'advanced',$:id=>nodes[id]};
 vm.runInNewContext(source.slice(source.indexOf('function creationBody()'),source.indexOf('function setInstrumental(')),context);
 const body=context.creationBody();assert.equal(body.instrumental,true);assert.equal(body.title,'雨后');assert.equal('lyrics' in body,false);assert.equal('voice' in body,false);assert.equal(nodes['studio-custom-lyrics'].value,'保留的歌词');
 context.instrumental=false;assert.equal(context.creationBody().lyrics,'保留的歌词');
});
await test('approval saves edited lyrics before confirming returned version and fingerprint',async()=>{
 const calls=[],nodes={'studio-confirm-lyrics':{},'studio-review-title':{value:'edited title'},'studio-review-lyrics':{value:'edited lyrics'},'studio-dialog':{close:()=>{}},'studio-create-status':{}};
 const saved={id,stage:'ready',version:2,fingerprint:'saved-fingerprint'},result={draft:{...saved,stage:'confirmed'},batch:{id,candidates:[]}};
 const context={draftReview:{id,stage:'ready',version:1,style:'中文流行',voice:'男声'},draftConfirming:false,$:key=>nodes[key],activeCreationId:null,activeBatchId:null,
 api:async(path,body)=>{calls.push({path,body});return path.endsWith('/save')?saved:result;},refresh:async()=>{},creationProgress:()=>'',renderBatches:()=>{}};
 const fn=source.slice(source.indexOf('async function confirmLyricDraft('),source.indexOf('async function generate('));
 vm.runInNewContext(fn+';globalThis.result=confirmLyricDraft();',context);await context.result;
 assert.equal(calls.length,2);assert.ok(calls[0].path.endsWith('/save'));assert.equal(calls[0].body.lyrics,'edited lyrics');assert.ok(calls[1].path.endsWith('/confirm'));assert.equal(calls[1].body.version,2);assert.equal(calls[1].body.fingerprint,'saved-fingerprint');
});

await test('rejected lyric request can be corrected while uncertain requests retain their identity',async()=>{
 const fn=source.slice(source.indexOf('async function generate('),source.indexOf('async function writeLyrics('));
 for(const status of [422,500,undefined]){
  const values=new Map(),calls=[],nodes={'studio-create-status':{}},draft={id,stage:'ready'};let reject=true;
  const context={creationRecovery:{state:{pending:null}},creating:false,lyricsRequest:null,instrumental:false,mode:'advanced',creationBody:()=>payload,updateGenerateButton:()=>{},$:key=>nodes[key],crypto:{randomUUID:()=>id},drafts:[],lyricDraftId:null,
   localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},api:async(path,body)=>{calls.push(body);if(reject)throw error(status);return draft;},showDraftReview:()=>{},renderHomeCreation:()=>{}};
  vm.runInNewContext(fn+';globalThis.result=generate();',context);await assert.rejects(context.result);
  assert.equal(values.has('osmanthus-pending-lyric-start'),status!==422);
  reject=false;context.creationBody=()=>({...payload,lyrics:'corrected lyrics'});vm.runInNewContext('globalThis.result=generate();',context);await context.result;
  assert.equal(calls[1].lyrics,status===422?'corrected lyrics':payload.lyrics);
 }
});
function reviewFixture(){
 const fields={'studio-review-title':{},'studio-review-lyrics':{},'studio-review-status':{},'studio-confirm-lyrics':{},'studio-resume-lyrics':{}};let builds=0;
 const box={set innerHTML(value){builds++;}},context={draftReview:null,draftReviewKey:'',draftConfirming:false,ensureDialogSection:()=>box,$:key=>fields[key],draftProgress:()=>'',dialog:()=>{}};
 const fn=source.slice(source.indexOf('function showDraftReview('),source.indexOf('async function confirmLyricDraft('));vm.runInNewContext(fn,context);
 return{fields,context,builds:()=>builds,show:d=>context.showDraftReview(d)};
}
await test('lyric polling and reopening preserve unsaved edits; stale polls cannot downgrade saved content',async()=>{
 const f=reviewFixture(),d={id,stage:'ready',version:1,title:'title',lyrics:'original',can_confirm:true};f.show(d);f.fields['studio-review-lyrics'].value='unsaved edit';f.show({...d});
 assert.equal(f.fields['studio-review-lyrics'].value,'unsaved edit');assert.equal(f.builds(),1);
 f.context.draftReview={...d,version:2};f.context.draftReviewKey=[id,2,'ready'].join('|');f.show({...d});assert.equal(f.context.draftReview.version,2);assert.equal(f.fields['studio-review-lyrics'].value,'unsaved edit');
 f.context.draftReview={...d,version:2,stage:'confirmed'};f.show({...d,version:2});assert.equal(f.context.draftReview.stage,'confirmed');
});
await test('successful lyric save plus failed confirmation preserves subsequent edits through polling',async()=>{
 const f=reviewFixture(),d={id,stage:'ready',version:1,title:'title',lyrics:'original',can_confirm:true},saved={...d,version:2,lyrics:'edited lyrics',fingerprint:'saved'};f.show(d);f.fields['studio-review-lyrics'].value='edited lyrics';
 Object.assign(f.context,{activeCreationId:null,activeBatchId:null,api:async path=>{if(path.endsWith('/save'))return saved;throw error(500);},refresh:async()=>{},renderBatches:()=>{},creationProgress:()=>''});
 const fn=source.slice(source.indexOf('async function confirmLyricDraft('),source.indexOf('async function generate('));vm.runInNewContext(fn+';globalThis.result=confirmLyricDraft();',f.context);await assert.rejects(f.context.result);
 assert.equal(f.fields['studio-review-lyrics'].disabled,false);f.fields['studio-review-lyrics'].value='new edit after network error';f.show(saved);assert.equal(f.fields['studio-review-lyrics'].value,'new edit after network error');assert.equal(f.builds(),1);
});
await test('lyrics lock during confirmation and a late response never closes another dialog',async()=>{
 let finishSave,closed=0;const nodes={'studio-confirm-lyrics':{},'studio-review-title':{value:'title'},'studio-review-lyrics':{value:'lyrics'},'studio-dialog':{open:true,close:()=>{closed++;}},'studio-lyric-approval':{hidden:false},'studio-create-status':{}};
 const d={id,stage:'ready',version:1,can_confirm:true};const context={draftReview:d,draftReviewKey:'',draftConfirming:false,$:key=>nodes[key],api:async path=>path.endsWith('/save')?new Promise(r=>finishSave=r):{draft:{...d,stage:'confirmed'},batch:{id,candidates:[]}},activeCreationId:null,activeBatchId:null,refresh:async()=>{},renderBatches:()=>{},creationProgress:()=>''};
 const fn=source.slice(source.indexOf('async function confirmLyricDraft('),source.indexOf('async function generate('));vm.runInNewContext(fn+';globalThis.result=confirmLyricDraft();',context);
 assert.equal(nodes['studio-review-lyrics'].disabled,true);nodes['studio-lyric-approval'].hidden=true;finishSave({...d,version:2,fingerprint:'saved'});await context.result;assert.equal(closed,0);
});
await test('detail play controls reflect play and pause without changing queue cover buttons',async()=>{
 const attrs=new Map(),button={dataset:{songPlay:id},getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v)},context={all:selector=>selector==='[data-detail-play]'?[button]:[],songMetadata:()=>({title:'song'})};
 const fn=source.slice(source.indexOf('function applyPlaybackState('),source.indexOf('async function playSong('));vm.runInNewContext(fn,context);context.applyPlaybackState({id,playing:true});assert.equal(attrs.get('aria-pressed'),'true');assert.match(button.innerHTML,/暂停/);context.applyPlaybackState({id,playing:false});assert.equal(attrs.get('aria-pressed'),'false');assert.match(button.innerHTML,/播放/);
});
await test('candidate like buttons reflect favorites immediately and after unliking',async()=>{
 const attrs=new Map(),button={dataset:{songFavorite:id},setAttribute:(k,v)=>attrs.set(k,v)},favorites=new Set([id]),context={all:()=>[button],favorites,songMetadata:()=>({title:'song'})};
 const fn=source.slice(source.indexOf('function applyFavoriteState('),source.indexOf('function saveFavorites('));vm.runInNewContext(fn,context);context.applyFavoriteState();assert.equal(attrs.get('aria-pressed'),'true');assert.equal(attrs.get('aria-label'),'取消喜欢song');favorites.delete(id);context.applyFavoriteState();assert.equal(attrs.get('aria-pressed'),'false');assert.equal(attrs.get('aria-label'),'喜欢song');
});
await test('library distinguishes no search matches and no favorites from a genuinely empty library',async()=>{
 const nodes={'.tl-count':{},'.tl-empty':{},'.tl-empty p':{},'.tl-empty span':{},'.tl-rows':{}},context={library:[],favorites:new Set(),query:'',sort:'new',lastLibrary:'',q:key=>nodes[key],applyPlaybackState:()=>{},player:null,icons:()=>{}};
 const fn=source.slice(source.indexOf('function renderLibrary('),source.indexOf('function ensureBatch('));vm.runInNewContext(fn,context);context.renderLibrary();assert.equal(nodes['.tl-empty p'].textContent,'你的音乐会出现在这里');
 context.query='no-match';context.library=[{id,title:'song'}];context.renderLibrary();assert.equal(nodes['.tl-empty p'].textContent,'没有找到匹配的歌曲');assert.match(nodes['.tl-empty span'].textContent,/关键词/);
 context.query='';context.sort='favorite';context.renderLibrary();assert.equal(nodes['.tl-empty p'].textContent,'还没有喜欢的歌曲');assert.match(nodes['.tl-empty span'].textContent,/喜欢按钮/);
 context.library=[];context.renderLibrary();assert.equal(nodes['.tl-empty p'].textContent,'你的音乐会出现在这里');
});
await test('correcting creation input clears only its own stale error, preserving a newer unrelated error',async()=>{
 const node=()=>({textContent:'',hidden:false,classList:{remove:()=>{}}}),nodes={'studio-global-status':node(),'studio-dialog-status':node()},context={creationFormError:null,$:key=>nodes[key],status:(text)=>{for(const n of Object.values(nodes))n.textContent=text;}};
 const fn=source.slice(source.indexOf('async function guarded('),source.indexOf('function closeDrawers('));vm.runInNewContext(fn,context);
 await context.guarded(async()=>{throw Error('创作描述至少需要3个字。');},'creation');assert.equal(context.creationFormError,'创作描述至少需要3个字。');context.clearCreationFormError();assert.equal(nodes['studio-global-status'].hidden,true);assert.equal(context.creationFormError,null);
 context.creationFormError='old creation error';nodes['studio-global-status'].textContent='new export error';context.clearCreationFormError();assert.equal(nodes['studio-global-status'].textContent,'new export error');
});
await test('changing routes dismisses stale global and dialog errors without relying on polling',async()=>{
 const cleared=[],element={hidden:false},context={status:(text,error)=>cleared.push([text,error]),creationFormError:'old',navigation:0,pendingEditor:{},page:'create',closeDrawers:()=>{},$:()=>({close:()=>{}}),root:{classList:{remove:()=>{},add:()=>{}}},q:()=>element,all:()=>[],window:{scrollTo:()=>{}}};
 const fn=source.slice(source.indexOf('function navigate('),source.indexOf('function home('));vm.runInNewContext(fn,context);context.navigate('editor');assert.deepEqual(cleared,[['',false]]);assert.equal(context.creationFormError,null);assert.equal(context.page,'editor');
});
await test('hidden legacy recovery still resolves before a new lyric draft and never resends old music',async()=>{
 const fn=source.slice(source.indexOf('async function generate('),source.indexOf('async function writeLyrics('));
 for(const outcome of ['accepted','cancelled','unknown']){
  const calls=[],values=new Map(),nodes={'studio-create-status':{}};
  const context={creating:false,lyricsRequest:null,instrumental:false,mode:'advanced',creationBody:()=>payload,updateGenerateButton:()=>{},$:key=>nodes[key],crypto:{randomUUID:()=>id},drafts:[],lyricDraftId:null,
   localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
   creationRecovery:{state:{pending:{id}},inspect:async()=>{calls.push('inspect');if(outcome==='unknown')throw error(500);return{kind:outcome==='accepted'?'accepted':'missing'};},cancel:async()=>{calls.push('cancel');return{kind:'cancelled'};}},
   api:async(path)=>{calls.push(path);return{id,stage:'ready'};},showDraftReview:()=>{},renderHomeCreation:()=>{},refresh:async()=>{calls.push('refresh');}};
  vm.runInNewContext(fn+';globalThis.result=generate();',context);
  if(outcome==='unknown')await assert.rejects(context.result);else await context.result;
  assert.equal(calls[0],'inspect');assert.equal(calls.includes('/api/generation/drafts'),outcome==='cancelled');assert.equal(calls.includes('/api/creation/jobs'),false);
  if(outcome==='cancelled')assert.deepEqual(calls.slice(0,2),['inspect','cancel']);
 }
});
process.stdout.write(passed+' tests passed\n');
