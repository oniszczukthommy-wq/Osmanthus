import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findExecutable,mediaTools,readOptionalEnv} from '../runtime-config.mjs';

function sandbox(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'osmanthus-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function executable(root,name){const file=path.join(root,name);fs.writeFileSync(file,'fixture');fs.chmodSync(file,0o755);return file;}
test('media executables resolve from configured paths or PATH, with sibling ffprobe fallback',t=>{
 const root=sandbox(t),ff=executable(root,'ffmpeg'),fp=executable(root,'ffprobe');
 assert.equal(findExecutable('ffmpeg',undefined,{PATH:root}),ff);
 assert.deepEqual(mediaTools({PATH:root}),{ffmpeg:ff,ffprobe:fp});
 assert.deepEqual(mediaTools({PATH:'',FFMPEG_BIN:ff}),{ffmpeg:ff,ffprobe:fp});
 const override=executable(root,'my-ffmpeg');assert.equal(mediaTools({PATH:root,FFMPEG_BIN:override}).ffmpeg,override);
 const missing=path.join(root,'missing');assert.equal(findExecutable('ffmpeg',missing,{PATH:root}),missing);
 assert.equal(fs.existsSync(findExecutable('missing-binary',undefined,{PATH:''})),false);
});
test('an env file is only read when explicitly selected and its content is never executed',t=>{
 const root=sandbox(t);fs.writeFileSync(path.join(root,'.env'),"# comment\nPORT=8900\nexport DEEPSEEK_API_KEY='fixture-key'\nPROMPT=\"value with spaces\"\nRAW=$(not-executed)\n");
 assert.deepEqual(readOptionalEnv(undefined,root),{});
 assert.deepEqual(readOptionalEnv('.env',root),{PORT:'8900',DEEPSEEK_API_KEY:'fixture-key',PROMPT:'value with spaces',RAW:'$(not-executed)'});
 assert.throws(()=>readOptionalEnv('missing.env',root),{code:'ENOENT'});
});
