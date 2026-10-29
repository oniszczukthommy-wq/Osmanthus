// One UI works standalone and under the music workbench's /mv/ gateway.
export const mounted=globalThis.location?.pathname.startsWith('/mv/')||false;
export function localUrl(value){if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return value;const canonical=value.startsWith('/mv/')?value.slice(3):value;return(mounted?'/mv':'')+canonical;}
export function localAssets(value){if(Array.isArray(value))return value.map(localAssets);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,localAssets(v)]));return localUrl(value);}
export function musicUrl(params={}){const origin=mounted?location.origin:'http://127.0.0.1:8603';const url=new URL('/',origin);for(const[k,v]of Object.entries(params))if(v!=null)url.searchParams.set(k,v);return url.href;}
