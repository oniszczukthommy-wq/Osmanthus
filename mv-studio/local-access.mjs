/** Check the server's actual listening authority, never a forwarded hostname. */
export function localRequestAllowed(req) {
  const port=req.socket.localPort,allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  if(port===80){allowed.add('127.0.0.1');allowed.add('localhost');}
  const values=name=>req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()===name).length;
  const host=req.headers.host?.toLowerCase();
  if(values('host')!==1||!allowed.has(host)||values('origin')>1)return false;
  if(req.headers.origin!==undefined&&req.headers.origin!==`http://${host}`)return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  return req.url.startsWith('/')&&!req.url.startsWith('//');
}
