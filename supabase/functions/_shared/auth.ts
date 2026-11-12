export function verifiedJwtClaims(token: string): Record<string,any> {
  try{const part=token.split('.')[1];const encoded=part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))));}catch{return {};}
}
export async function authorizeWebAdmin(db:any,header:string):Promise<{ok:boolean;status:number;actor?:string;user_id?:string;session_id?:string;error?:string}> {
  const token=header.match(/^Bearer\s+(.+)$/i)?.[1]||'';
  if(!token)return {ok:false,status:401,error:'authentication_required'};
  const {data,error}=await db.auth.getUser(token);const user=data?.user;
  if(error||!user?.email_confirmed_at)return {ok:false,status:401,error:'session_invalid'};
  const claims=verifiedJwtClaims(token);
  if(claims.aal!=='aal2')return {ok:false,status:403,error:'admin_second_factor_required'};
  const {data:allowed,error:allowError}=await db.from('web_admin_emails').select('email').eq('email',String(user.email||'').trim().toLowerCase()).eq('active',true).maybeSingle();
  if(allowError||!allowed)return {ok:false,status:403,error:'admin_not_allowed'};
  const {data:valid,error:sessionError}=await db.rpc('validate_web_admin_session',{p_user_id:user.id,p_session_id:claims.session_id||null});
  if(sessionError||valid!==true)return {ok:false,status:401,error:'admin_session_expired'};
  return {ok:true,status:200,actor:'web:'+user.id,user_id:user.id,session_id:claims.session_id};
}
export async function authorizeWorkflow(db:any,req:Request,key:string,secret:string) {
  const bearer=req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]||'';
  if(key&&secret&&bearer===key&&req.headers.get('x-radin-telegram-secret')===secret)return {ok:true,status:200,actor:'telegram',mode:'telegram'};
  const candidate=req.headers.get('x-radin-cron-secret')||'';
  if(candidate){const {data,error}=await db.rpc('verify_radin_cron_secret',{candidate});if(!error&&data===true)return {ok:true,status:200,actor:'scheduler',mode:'cron'};return {ok:false,status:401,error:'invalid_internal_credential'};}
  const admin=await authorizeWebAdmin(db,req.headers.get('authorization')||'');return {...admin,mode:'web'};
}
