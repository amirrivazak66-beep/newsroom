export function diagnosticSafeMessage(value: unknown): string {
  return String(value??'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(?:sk-|sb_secret_|sbp_)[A-Za-z0-9_-]+/g,'[redacted]').replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi,'https://api.telegram.org/bot[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted]').slice(0,500);
}
export async function recordDiagnostic(db: any, event: {trace_id?:string;component:string;operation:string;item_id?:string;user_id?:string;severity?:string;outcome?:string;error_code?:string;error_message?:unknown;duration_ms?:number;metadata?:Record<string,unknown>}) {
  const safe={...event,error_message:event.error_message?diagnosticSafeMessage(event.error_message):null};
  // Metadata is deliberately restricted to known numeric/status values.
  safe.metadata=Object.fromEntries(Object.entries(event.metadata||{}).filter(([key,value])=>/^(attempt|status|revision|retryable|source_commit|count)$/.test(key)&&['string','number','boolean'].includes(typeof value)));
  const {error}=await db.from('app_diagnostic_events').insert(safe);
  if(error)console.error('diagnostic_write_failed',event.component,event.operation);
}
export function classifyOperationError(status: number, code=''): {retryable:boolean;category:string} {
  if(status===429||status>=500||code==='timeout')return {retryable:true,category:status===429?'rate_limit':code==='timeout'?'timeout':'provider_unavailable'};
  return {retryable:false,category:status===401||status===403?'configuration':status===400||code==='content_policy'?'requires_review':'permanent'};
}
export class PipelineError extends Error {
  status: number; retryable: boolean;
  constructor(message:string,status=500){super(message);this.name='PipelineError';this.status=status;this.retryable=classifyOperationError(status).retryable;}
}
