import fs from 'node:fs';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

// Small dependency-free ZIP32 writer: STORE, data descriptors and UTF-8 names.
// It streams one entry at a time and refuses Zip64-sized archives.
const MAX=0xffffffff, table=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}
function crc32(crc,buffer){for(const b of buffer)crc=table[(crc^b)&255]^(crc>>>8);return crc>>>0;}
const nameOK=name=>typeof name==='string'&&/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name)&&Buffer.byteLength(name)<256;
function u16(buf,offset,value){buf.writeUInt16LE(value,offset);}function u32(buf,offset,value){buf.writeUInt32LE(value>>>0,offset);}
export function validateZipEntries(entries){
 if(!Array.isArray(entries)||entries.length>65535)throw Error('素材过多，无法导出');let sum=22;const names=new Set();
 for(const e of entries){if(!nameOK(e.name)||names.has(e.name))throw Error('导出素材名称无效');names.add(e.name);
  if(!Number.isSafeInteger(e.size)||e.size<0||e.size>MAX||(!Buffer.isBuffer(e.data)&&(!e.file||!e.identity||!/^[a-f0-9]{64}$/.test(e.sha256||''))))throw Error('导出素材无效');
  if(Buffer.isBuffer(e.data)&&e.data.length!==e.size)throw Error('导出清单无效');sum+=e.size+92+2*Buffer.byteLength(e.name);if(sum>MAX)throw Error('素材总量超过 ZIP 导出上限，请分批处理');
 }
}
async function* zip(entries){
 let offset=0;const central=[];
 for(const e of entries){let fd;try{
  if(!e.data){const before=fs.lstatSync(e.file);if(!before.isFile()||before.isSymbolicLink())throw Error('素材在导出时发生变化');fd=fs.openSync(e.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const actual=fs.fstatSync(fd),expected=e.identity;if(!actual.isFile()||actual.dev!==expected.dev||actual.ino!==expected.ino||actual.size!==e.size||actual.mtimeMs!==expected.mtimeMs||before.dev!==actual.dev||before.ino!==actual.ino)throw Error('素材在导出时发生变化');
   // Validate the same opened file before any of its bytes are sent.
   const probe=crypto.createHash('sha256'),buffer=Buffer.alloc(128*1024);let position=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,position))>0){position+=n;probe.update(buffer.subarray(0,n));}const checked=fs.fstatSync(fd);if(position!==e.size||checked.mtimeMs!==expected.mtimeMs||probe.digest('hex')!==e.sha256)throw Error('素材在导出时发生变化');
  }
  const name=Buffer.from(e.name),header=Buffer.alloc(30);u32(header,0,0x04034b50);u16(header,4,20);u16(header,6,0x0808);u16(header,8,0);u16(header,10,0);u16(header,12,33);u16(header,26,name.length);const start=offset;offset+=header.length+name.length;yield header;yield name;
  let crc=0xffffffff,size=0;const digest=crypto.createHash('sha256'),chunks=e.data?[e.data]:fs.createReadStream(e.file,{fd,autoClose:false,start:0,highWaterMark:128*1024});
  for await(const chunk of chunks){size+=chunk.length;if(size>e.size)throw Error('素材在导出时发生变化');crc=crc32(crc,chunk);digest.update(chunk);yield chunk;}
  if(size!==e.size||e.sha256&&digest.digest('hex')!==e.sha256)throw Error('素材在导出时发生变化');crc=(crc^0xffffffff)>>>0;
  const desc=Buffer.alloc(16);u32(desc,0,0x08074b50);u32(desc,4,crc);u32(desc,8,size);u32(desc,12,size);yield desc;offset+=size+desc.length;
  const h=Buffer.alloc(46);u32(h,0,0x02014b50);u16(h,4,20);u16(h,6,20);u16(h,8,0x0808);u16(h,10,0);u16(h,12,0);u16(h,14,33);u32(h,16,crc);u32(h,20,size);u32(h,24,size);u16(h,28,name.length);u32(h,42,start);central.push(h,name);
 }finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 const centralStart=offset;for(const b of central){offset+=b.length;yield b;}const end=Buffer.alloc(22);u32(end,0,0x06054b50);u16(end,8,entries.length);u16(end,10,entries.length);u32(end,12,offset-centralStart);u32(end,16,centralStart);yield end;
}
export async function streamZip(entries,destination){validateZipEntries(entries);await pipeline(Readable.from(zip(entries)),destination);}
