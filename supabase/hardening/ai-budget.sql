alter table public.ai_usage_events add column if not exists trace_id uuid;
alter table public.ai_usage_events add column if not exists task_kind text;
create table if not exists public.ai_daily_budgets(day date primary key,request_limit integer not null default 300,estimated_usd_limit numeric(12,4) not null default 10,updated_at timestamptz not null default now());
create function public.reserve_ai_operation(p_item_id uuid,p_kind text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.ai_daily_budgets%rowtype;used integer;cost numeric;
begin
 insert into public.ai_daily_budgets(day) values(current_date) on conflict(day) do nothing;select * into d from public.ai_daily_budgets where day=current_date for update;
 select count(*),coalesce(sum(estimated_cost_usd),0) into used,cost from public.ai_usage_events where created_at>=current_date and created_at<current_date+1 and status in('started','succeeded');
 if used>=d.request_limit or cost>=d.estimated_usd_limit then return jsonb_build_object('allowed',false,'reason','daily_budget_exceeded');end if;
 insert into public.ai_usage_events(item_id,provider,model,task,status,cost_known,created_at,task_kind) values(p_item_id,'unknown','reserved',p_kind,'started',false,now(),p_kind);
 return jsonb_build_object('allowed',true,'remaining',greatest(0,d.request_limit-used-1));
end;$$;
revoke all on function public.reserve_ai_operation(uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_ai_operation(uuid,text) to service_role;
