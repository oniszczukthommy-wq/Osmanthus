import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {Writable} from 'node:stream';import {execFileSync} from 'node:child_process';import {streamZip,validateZipEntries} from '../stream-zip.mjs';
test('ZIP 分块流式写入，可被标准解压工具校验，拒绝越界路径',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mv-zip-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'audio.bin'),zip=path.join(dir,'export.zip'),bytes=crypto.randomBytes(1_000_000);fs.writeFileSync(file,bytes);
 const data=Buffer.from('测试'),stat=fs.statSync(file),identity={dev:stat.dev,ino:stat.ino,mtimeMs:stat.mtimeMs},entries=[{name:'manifest.json',data,size:data.length},{name:'Audio/source.wav',file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),identity}];
 let max=0;const out=fs.createWriteStream(zip);const dst=new Writable({write(chunk,_encoding,cb){max=Math.max(max,chunk.length);out.write(chunk,cb);},final(cb){out.end(cb);}});await streamZip(entries,dst);assert(max<=128*1024,'大素材不能整文件加载到导出流');
 const py='import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.namelist()==["manifest.json","Audio/source.wav"]; print(len(z.read("Audio/source.wav")))';
 assert.equal(execFileSync('python',['-c',py,zip],{encoding:'utf8'}).trim(),'1000000');
 for(const name of ['../secrets.txt','/secrets.txt','Audio/../../env.txt','Audio\\env.txt'])assert.throws(()=>validateZipEntries([{name,data,size:data.length}]),/名称无效/);
 assert.throws(()=>validateZipEntries([entries[0],entries[0]]),/名称无效/);
 await assert.rejects(streamZip([{...entries[1],sha256:'0'.repeat(64)}],new Writable({write(_c,_e,cb){cb()}})),/发生变化/);
});
