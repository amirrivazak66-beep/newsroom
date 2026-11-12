import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { authorizeWorkflow } from "../_shared/auth.ts";
import { editorialCaption, editorialPublishError } from "../_shared/editorial.ts";
import { recordDiagnostic } from "../_shared/diagnostics.ts";
const publishCors={"Access-Control-Allow-Origin":"https://amirrivazak66-beep.github.io","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Content-Type":"application/json; charset=utf-8"};
const publishJson=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:publishCors});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:publishCors});
 if(req.method!=='POST')return publishJson({error:'POST required'},405);
 const url=Deno.env.get('SUPABASE_URL')||'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',secret=Deno.env.get('TELEGRAM_WEBHOOK_SECRET')||'';
 if(!url||!key)return publishJson({error:'server_configuration_missing'},500);
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const auth=await authorizeWorkflow(db,req,key,secret);
 if(!auth.ok)return publishJson({error:auth.error},auth.status);
 let body:any;try{const raw=await req.text();if(raw.length>10000)return publishJson({error:'request_too_large'},413);body=JSON.parse(raw);}catch{return publishJson({error:'invalid_json'},400);}
 if(!/^[0-9a-f-]{36}$/i.test(String(body.id||''))||!['publish','reject'].includes(body.action))return publishJson({error:'invalid_publication_request'},400);
 if(body.action==='reject'){
  if(auth.mode==='cron')return publishJson({error:'human_action_required'},403);
  const {data,error}=await db.from('news_items').update({review_status:'rejected',scheduled_at:null}).eq('id',body.id).eq('published',false).not('publication_state','in','(claimed,sending,unknown)').select('id').maybeSingle();
  return error||!data?publishJson({error:'story_not_rejectable'},409):publishJson({ok:true,action:'rejected'});
 }
 const scheduled=body.scheduled===true;
 if(scheduled&&auth.mode!=='cron'||!scheduled&&auth.mode==='cron')return publishJson({error:'invalid_publication_mode'},403);
 const {data:claim,error:claimError}=await db.rpc('claim_editorial_publication',{p_item_id:body.id,p_actor:auth.actor,p_scheduled:scheduled,p_expected_revision:Number.isInteger(body.expected_revision)?body.expected_revision:null});
 if(claimError)return publishJson({error:'publication_claim_failed'},503);
 if(claim?.error)return publishJson({error:claim.error,retryable:false},claim.status||409);
 if(!claim?.attempt_id||!claim.payload)return publishJson({error:'publication_claim_failed'},503);
 const trace=claim.trace_id,attempt=claim.attempt_id;
 const finish=async(state:string,code:string|null=null,messageId:number|null=null,retryable=false,retrySeconds=60)=>db.rpc('finish_publication_send',{p_attempt:attempt,p_message_id:messageId,p_state:state,p_error:code,p_retryable:retryable,p_retry_seconds:retrySeconds});
 const invalid=editorialPublishError(claim.payload,claim.destination);
 const token=Deno.env.get('BOT_TOKEN')||'';
 if(invalid||!token){await finish('blocked',invalid||'bot_token_missing');return publishJson({error:invalid||'bot_token_missing',trace_id:trace,retryable:false},invalid==='caption_too_long'?413:409);}
 const {data:started,error:startError}=await db.rpc('start_publication_send',{p_attempt:attempt});
 if(startError||started!==true)return publishJson({error:'publication_start_uncertain',trace_id:trace,retryable:false},409);
 const caption=editorialCaption(claim.payload,claim.destination);
 try{
  const video=claim.payload.video_file_id;const method=video?'sendVideo':'sendPhoto';
  const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(video?{chat_id:claim.destination,video,cover:claim.payload.graphic_url,caption,parse_mode:'HTML',supports_streaming:true}:{chat_id:claim.destination,photo:claim.payload.graphic_url,caption,parse_mode:'HTML'}),signal:AbortSignal.timeout(45000)});
  const result=await response.json().catch(()=>null);
  if(response.ok&&result?.ok===true&&Number.isSafeInteger(result.result?.message_id)){
   const messageId=result.result.message_id;const completed=await finish('sent',null,messageId);
   if(completed.error||completed.data!==true){await recordDiagnostic(db,{trace_id:trace,item_id:body.id,component:'publication',operation:'persist_receipt',error_code:'receipt_commit_uncertain'});return publishJson({ok:false,state:'unknown',error:'receipt_commit_uncertain',message_id:messageId,trace_id:trace,retryable:false},202);}
   await db.from('bot_activity').insert({event_type:'published',item_id:body.id,actor:auth.actor,details:{message_id:messageId,revision:claim.revision,trace_id:trace}});
   await recordDiagnostic(db,{trace_id:trace,item_id:body.id,component:'publication',operation:'send',severity:'info',outcome:'success',metadata:{revision:claim.revision}});
   return publishJson({ok:true,message_id:messageId,trace_id:trace,revision:claim.revision});
  }
  // Only an explicit Telegram rejection is a known non-send. Network errors,
  // invalid receipts and 5xx responses cannot be retried safely automatically.
  const explicitRejection=result?.ok===false&&response.status>=400&&response.status<500;
  if(explicitRejection){const retryable=response.status===429;await finish(retryable?'failed':'blocked','telegram_'+response.status,null,retryable,Number(result.parameters?.retry_after)||60);return publishJson({error:'telegram_'+response.status,trace_id:trace,retryable},retryable?429:422);}
  await finish('unknown','telegram_receipt_uncertain');
 }catch{await finish('unknown','telegram_network_uncertain');}
 await recordDiagnostic(db,{trace_id:trace,item_id:body.id,component:'publication',operation:'send',error_code:'publication_unknown'});
 return publishJson({ok:false,state:'unknown',error:'publication_unknown',trace_id:trace,retryable:false},202);
});
