import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_FONT_BYTES=256*1024*1024;
const unavailable=(message,code='SUBTITLE_FONT_UNAVAILABLE')=>Object.assign(new Error(`${message}；请安装支持字幕文字的字体，或设置 MV_SUBTITLE_FONT 为本机字体文件路径`),{status:503,code});
const invalid=()=>{throw unavailable('字幕字体文件不是可读取的 OpenType 字体');};

/** These are OS-provided candidates, not assets distributed with Osmanthus. */
export function defaultSubtitleFontCandidates(environment=process.env){
 const windows=environment.WINDIR||environment.SystemRoot||'C:\\Windows';
 const userFonts=environment.HOME?path.join(environment.HOME,'.local/share/fonts'):null;
 return [...new Set([
  '/System/Library/Fonts/PingFang.ttc','/System/Library/Fonts/STHeiti Light.ttc','/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc','/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc','/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ...(userFonts?[path.join(userFonts,'NotoSansCJK-Regular.ttc'),path.join(userFonts,'NotoSansSC-Regular.ttf')]:[]),
  path.join(windows,'Fonts','msyh.ttc'),path.join(windows,'Fonts','msyh.ttf'),path.join(windows,'Fonts','simhei.ttf'),path.join(windows,'Fonts','simsun.ttc'),
  // Latin-only installations remain useful for Latin subtitles; coverage is
  // checked before accepting them, so they cannot silently emit Chinese tofu.
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/System/Library/Fonts/Supplemental/Arial.ttf',path.join(windows,'Fonts','arial.ttf'),
 ])];
}

function fontReader(bytes){
 const inside=(offset,length)=>{if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>bytes.length)invalid();};
 const u16=offset=>{inside(offset,2);return bytes.readUInt16BE(offset);},i16=offset=>{inside(offset,2);return bytes.readInt16BE(offset);},u32=offset=>{inside(offset,4);return bytes.readUInt32BE(offset);};
 inside(0,12);let face=0;
 if(bytes.toString('ascii',0,4)==='ttcf'){const count=u32(8);if(!count||count>4096)invalid();inside(12,count*4);face=u32(12);}
 inside(face,12);const version=u32(face);if(![0x00010000,0x4f54544f,0x74727565,0x74797031].includes(version))invalid();
 const count=u16(face+4);if(!count||count>512)invalid();inside(face+12,count*16);const tables=new Map();
 for(let i=0;i<count;i++){const record=face+12+i*16,tag=bytes.toString('ascii',record,record+4),offset=u32(record+8),length=u32(record+12);inside(offset,length);tables.set(tag,{offset,length});}
 const table=(tag,min)=>{const t=tables.get(tag);if(!t||t.length<min)invalid();return t;};
 const maxp=table('maxp',6),glyphs=u16(maxp.offset+4);if(!glyphs)invalid();
 const bounded=(base,length)=>{inside(base,length);return(offset,size)=>{inside(offset,size);if(offset<base||offset+size>base+length)invalid();};};
 function family(){
  const {offset,length}=table('name',6),check=bounded(offset,length),count=u16(offset+2),storage=offset+u16(offset+4);check(offset+6,count*12);const names=[];
  for(let i=0;i<count;i++){const r=offset+6+i*12,platform=u16(r),language=u16(r+4),nameId=u16(r+6),n=u16(r+8),at=storage+u16(r+10);if(nameId!==1||!n)continue;check(at,n);let value;
   if(platform===0||platform===3){if(n%2)continue;const units=[];for(let p=at;p<at+n;p+=2)units.push(u16(p));value=String.fromCharCode(...units);}else if(platform===1)value=bytes.toString('latin1',at,at+n);else continue;
   value=value.replace(/\u0000/g,'').trim();if(value&&!/[\u0000-\u001f\u007f]/.test(value))names.push({value,rank:platform===3&&language===0x409?0:platform===0?1:platform===3?2:3});
  }
  names.sort((a,b)=>a.rank-b.rank);if(!names.length)invalid();return names[0].value;
 }
 function characterMaps(){
  const {offset,length}=table('cmap',4),check=bounded(offset,length),count=u16(offset+2);if(count>4096)invalid();check(offset+4,count*8);const maps=[],seen=new Set();
  for(let i=0;i<count;i++){const r=offset+4+i*8,platform=u16(r),encoding=u16(r+2);if(platform!==0&&!(platform===3&&[1,10].includes(encoding)))continue;const at=offset+u32(r+4);if(seen.has(at))continue;seen.add(at);check(at,2);const format=u16(at);
   if(format===12){check(at,16);const size=u32(at+4),groups=u32(at+12);if(size<16||groups>1000000||16+groups*12>size)invalid();check(at,size);let previous=-1;for(let g=0;g<groups;g++){const p=at+16+g*12,start=u32(p),end=u32(p+4);if(start<=previous||start>end||end>0x10ffff)invalid();previous=end;}maps.push({rank:platform===3&&encoding===10?0:1,map:code=>{let left=0,right=groups-1;while(left<=right){const middle=(left+right)>>>1,p=at+16+middle*12,start=u32(p),end=u32(p+4);if(code<start)right=middle-1;else if(code>end)left=middle+1;else return u32(p+8)+code-start;}return 0;}});
   }else if(format===4){check(at,14);const size=u16(at+2),segments=u16(at+6)/2;if(!Number.isInteger(segments)||!segments||size<16+segments*8)invalid();check(at,size);const ends=at+14,starts=ends+segments*2+2,deltas=starts+segments*2,ranges=deltas+segments*2;let previous=-1;for(let i=0;i<segments;i++){const start=u16(starts+i*2),end=u16(ends+i*2);if(start> end||end<previous)invalid();previous=end;}maps.push({rank:platform===3&&encoding===1?2:3,map:code=>{if(code>0xffff)return 0;for(let i=0;i<segments;i++){const end=u16(ends+i*2);if(code>end)continue;const start=u16(starts+i*2);if(code<start)return 0;const delta=i16(deltas+i*2),range=u16(ranges+i*2);if(!range)return(code+delta)&0xffff;const p=ranges+i*2+range+2*(code-start);if(p<at||p+2>at+size)return 0;const glyph=u16(p);return glyph?(glyph+delta)&0xffff:0;}return 0;}});}
  }
  if(!maps.length)invalid();maps.sort((a,b)=>a.rank-b.rank);return [code=>{const glyph=maps[0].map(code);return glyph>0&&glyph<glyphs?glyph:0;}];
 }
 return {family:family(),maps:characterMaps()};
}

/** Validate glyph coverage in the first face, matching drawtext's default face.
 * File existence alone does not establish that a subtitle can be rendered.
 */
export function inspectSubtitleFont(file,text=''){
 if(typeof file!=='string'||!file||typeof text!=='string')throw unavailable('字幕字体配置无效');
 let bytes;try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size<12||stat.size>MAX_FONT_BYTES)invalid();bytes=fs.readFileSync(file);if(bytes.length!==stat.size||bytes.length>MAX_FONT_BYTES)invalid();}catch(cause){if(cause?.code?.startsWith('SUBTITLE_FONT_'))throw cause;throw unavailable('字幕字体文件无法读取');}
 const parsed=fontReader(bytes),required=[...new Set([...text].filter(char=>!/^\s$/u.test(char)).map(char=>char.codePointAt(0)))];
 const missing=required.filter(code=>!parsed.maps.some(map=>map(code)!==0));
 if(missing.length)throw unavailable(`字幕字体缺少 ${missing.slice(0,6).map(code=>'U+'+code.toString(16).toUpperCase()).join('、')}${missing.length>6?' 等字形':''}`,'SUBTITLE_FONT_MISSING_GLYPHS');
 return {file:path.resolve(file),family:parsed.family,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}

/** An explicit font is authoritative: invalid/incomplete choices must not be
 * silently replaced with a different face. No font files are downloaded.
 */
export function selectSubtitleFont(text,{fontPath=process.env.MV_SUBTITLE_FONT,candidates=defaultSubtitleFontCandidates()}={}){
 if(typeof text!=='string')throw unavailable('字幕文字需为文本');
 if(fontPath!==undefined&&fontPath!=='')return inspectSubtitleFont(fontPath,text);
 if(!Array.isArray(candidates))throw unavailable('字幕字体候选配置无效');
 for(const file of candidates)try{return inspectSubtitleFont(file,text);}catch{}
 throw unavailable('本机未找到能完整显示当前字幕的字体');
}
