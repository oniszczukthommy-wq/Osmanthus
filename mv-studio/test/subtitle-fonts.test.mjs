import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {defaultSubtitleFontCandidates,inspectSubtitleFont,selectSubtitleFont} from '../subtitle-fonts.mjs';
import {wrapSubtitleText} from '../canvas-video-editor.mjs';

const unavailable=error=>error.status===503&&error.code==='SUBTITLE_FONT_UNAVAILABLE';
const missing=error=>error.status===503&&error.code==='SUBTITLE_FONT_MISSING_GLYPHS';
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'osmanthus-font-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function latinFont(){
 const windir=process.env.WINDIR||process.env.SystemRoot||'C:\\Windows';
 for(const p of ['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',path.join(windir,'Fonts','arial.ttf')]){
  try{inspectSubtitleFont(p,'ASCII');try{inspectSubtitleFont(p,'桂');}catch(error){if(missing(error))return p;}}catch{}
 }
 return null;
}

test('缺失或损坏字体明确503，未配置可用候选时不假成功',t=>{
 const dir=temp(t),bad=path.join(dir,'corrupt.ttf');fs.writeFileSync(bad,Buffer.alloc(20));
 assert.throws(()=>inspectSubtitleFont(path.join(dir,'absent.ttf'),'桂香入梦'),unavailable);
 assert.throws(()=>inspectSubtitleFont(bad,'桂香入梦'),unavailable);
 assert.throws(()=>selectSubtitleFont('桂香入梦',{fontPath:'',candidates:[]}),unavailable);
 assert.throws(()=>selectSubtitleFont('桂香入梦',{fontPath:bad,candidates:defaultSubtitleFontCandidates()}),unavailable);
});

test('显式Latin字体缺中文字形会拒绝，不静默换用系统CJK字体',t=>{
 const latin=latinFont();if(!latin)return t.skip('No OS Latin-only test font is installed');
 const font=inspectSubtitleFont(latin,'ASCII 123');assert.ok(font.family);assert.match(font.sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>selectSubtitleFont('桂香入梦',{fontPath:latin}),missing);
});

test('字幕换行只增加布局换行，原字符和显式换行保持不变',()=>{
 const text='桂香入梦\nSecond line: 100% {original}';
 assert.equal(wrapSubtitleText(text,200),text);
 const wrapped=wrapSubtitleText(text,8);assert.equal(wrapped.replaceAll('\n',''),text.replaceAll('\n',''));
 assert.ok(wrapped.includes('桂香入梦\n'));assert.equal(wrapSubtitleText('桂香入梦',2),'桂\n香\n入\n梦');
});

test('真实CJK字体经FFmpeg渲染四个汉字，得到四个不同的非空字形像素',t=>{
 let font;try{font=selectSubtitleFont('桂香入梦',{fontPath:'',candidates:defaultSubtitleFontCandidates()});}catch{return t.skip('No system font covers the CJK test phrase');}
 const ff=process.env.FFMPEG_BIN||'ffmpeg';try{execFileSync(ff,['-version'],{stdio:'ignore',timeout:10000});}catch{return t.skip('FFmpeg is not available');}
 const dir=temp(t);fs.copyFileSync(font.file,path.join(dir,'font.ttf'));
 const fingerprints=[],frames=[];
 for(const char of '桂香入梦'){
  fs.writeFileSync(path.join(dir,'glyph.txt'),char);
  const pixels=execFileSync(ff,['-v','error','-f','lavfi','-i','color=c=black:s=96x96:r=1','-vf','drawtext=fontfile=font.ttf:textfile=glyph.txt:expansion=none:fontcolor=white:fontsize=48:x=20:y=20','-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1'],{cwd:dir,timeout:30000,maxBuffer:500000});
  const mask=Buffer.from(pixels.map(v=>v>96?1:0));assert.equal(mask.length,96*96);assert.ok(mask.reduce((a,v)=>a+v,0)>80,`汉字 ${char} 应有真实笔画`);
  fingerprints.push(crypto.createHash('sha256').update(mask).digest('hex'));frames.push(mask);
 }
 assert.equal(new Set(fingerprints).size,4,'四个字符不能都渲染成相同缺字方框');
 for(let i=0;i<frames.length;i++)for(let j=i+1;j<frames.length;j++)assert.ok(frames[i].reduce((n,v,k)=>n+(v!==frames[j][k]),0)>40,'不同汉字应有不同笔画轮廓');
});
