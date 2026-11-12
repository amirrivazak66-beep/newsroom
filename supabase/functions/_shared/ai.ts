import { PipelineError } from './diagnostics.ts';
export async function budgetedAiFetch(db:any,itemId:string,url:string,options:RequestInit):Promise<Response>{
 const kind=url.includes('/images/')?'image':'text';
 const reserve=await db.rpc('reserve_ai_operation',{p_item_id:itemId,p_kind:kind});
 if(reserve.error||reserve.data?.allowed!==true)throw new PipelineError('ai_budget_or_daily_limit_reached',402);
 try{return await fetch(url,options);}catch{throw new PipelineError('ai_provider_timeout',503);}
}
