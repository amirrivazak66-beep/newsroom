export function publicHttpUrl(value:string):URL{
 const url=new URL(value);const h=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))||value.length>4096)throw new Error('unsafe_source_url');
 if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||h==='metadata.google.internal')throw new Error('private_source_host');
 return url;
}
export function isPublicAddress(ip:string):boolean{
 const v=ip.toLowerCase();
 if(v.includes(':'))return !(/^(?:::|fe[89ab]|f[cd]|ff|2001:db8)/.test(v)||v.includes('::ffff:'));
 const p=v.split('.').map(Number);if(p.length!==4||p.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
 return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&(p[1]===168||p[1]===0||p[1]===2)||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===198&&(p[1]===18||p[1]===19||p[1]===51)||p[0]===203&&p[1]===0&&p[2]===113);
}
export async function publicSourceFetch(value:string,init:RequestInit={},resolve=async(host:string)=>{
 const records=await Promise.allSettled([Deno.resolveDns(host,'A'),Deno.resolveDns(host,'AAAA')]);return records.flatMap(x=>x.status==='fulfilled'?x.value:[]);
}):Promise<Response>{
 let url=publicHttpUrl(value);
 for(let hop=0;hop<4;hop++){
  const host=url.hostname.replace(/^\[|\]$/g,'');const ips=/^[\d.]+$/.test(host)||host.includes(':')?[host]:await resolve(host);
  if(!ips.length||ips.some(ip=>!isPublicAddress(ip)))throw new Error('private_or_unresolved_source');
  const response=await fetch(url,{...init,redirect:'manual'});
  if(![301,302,303,307,308].includes(response.status))return response;
  const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('invalid_source_redirect');url=publicHttpUrl(new URL(location,url).href);
 }
 throw new Error('source_redirect_limit');
}
export async function limitedBody(response:Response,maxBytes:number):Promise<Uint8Array>{
 if(Number(response.headers.get('content-length')||0)>maxBytes)throw new Error('source_body_too_large');
 const reader=response.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new Error('source_body_too_large');chunks.push(value);}}catch(error){await reader.cancel();throw error;}
 const result=new Uint8Array(size);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}return result;
}
