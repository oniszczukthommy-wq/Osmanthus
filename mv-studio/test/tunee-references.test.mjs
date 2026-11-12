import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {referenceSection,referenceOptions,validateReferences} from '../public/tunee-references.js';

const pic=(overrides={})=>{const id=crypto.randomUUID();return {id,kind:'image',name:'图片',bytes:1024,url:`/files/materials/${id}.png`,...overrides};};
test('验证视觉参考图数量、类型和大小，缺失素材不能静默忽略',()=>{
 const a=pic(),b=pic(),c=pic(),d=pic(),all=[a,b,c,d];
 assert.deepEqual(validateReferences([a.id,b.id],all),[a.id,b.id]);
 assert.throws(()=>validateReferences([a.id,a.id],all),/3 张不同/);
 assert.throws(()=>validateReferences(all.map(x=>x.id),all),/3 张不同/);
 assert.throws(()=>validateReferences([a.id],[]),/失效/);
 assert.throws(()=>validateReferences([a.id],[{...a,kind:'video'}]),/失效/);
 assert.throws(()=>validateReferences([a.id],[{...a,bytes:10_000_001}]),/失效/);
});
test('参考图卡片安全转义，兼容 /mv 代理并给出真实能力提示',()=>{
 const a=pic({name:'<img src=x onerror=alert(1)>'});
 const markup=referenceSection([a.id],[a],false,path=>'/mv'+path);
 assert(markup.includes('/mv/files/materials/'));assert(markup.includes('&lt;img'));
 assert(markup.includes('文字创意模型不会读取图片内容'));
 assert(!referenceOptions([],[{...a,url:'https://example.invalid/evil.png'}]).includes('https://'));
 assert(referenceSection([a.id],[],false).includes('素材已不可用'));
});
