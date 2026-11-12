import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
const scheduleJson=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
Deno.serve(async(req:Request)=>{
 if(req.method!=='POST')return scheduleJson({error:'POST required'},405);
 const url=Deno.env.get('SUPABASE_URL')||'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',secret=req.headers.get('x-radin-cron-secret')||'';
 if(!url||!key||!secret)return scheduleJson({error:'Unauthorized'},401);
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const auth=await db.rpc('verify_radin_cron_secret',{candidate:secret});if(auth.error||auth.data!==true)return scheduleJson({error:'Unauthorized'},401);
 await db.rpc('recover_stale_publications');
 const {data:settings,error:settingsError}=await db.from('bot_settings').select('auto_publish').eq('id','main').maybeSingle();
 if(settingsError)return scheduleJson({error:'settings_unavailable'},503);
 if(!settings?.auto_publish)return scheduleJson({ok:true,skipped:'disabled'});
 const {data:due,error}=await db.from('news_items').select('id,editorial_revision').eq('published',false).eq('review_status','approved').eq('publication_state','idle').is('telegram_message_id',null).not('scheduled_at','is',null).lte('scheduled_at',new Date().toISOString()).order('scheduled_at',{ascending:true}).limit(5);
 if(error)return scheduleJson({error:'queue_unavailable'},503);
 const results=[];
 for(const item of due||[]){
  try{const response=await fetch(url+'/functions/v1/radin-publish-news',{method:'POST',headers:{'content-type':'application/json','x-radin-cron-secret':secret},body:JSON.stringify({id:item.id,action:'publish',scheduled:true,expected_revision:item.editorial_revision}),signal:AbortSignal.timeout(55000)});const result=await response.json().catch(()=>({}));results.push({id:item.id,ok:result.ok===true,state:result.state,error:result.error});}
  catch{results.push({id:item.id,ok:false,state:'inspect_attempt_ledger'});}
 }
 return scheduleJson({ok:results.every(x=>x.ok),results});
});
