-- Complete web-admin session lifecycle. The session id must exist in the
-- signed-in user's JWT and be revoked before sensitive operations.
create table if not exists public.web_admin_sessions(
 session_id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),
 expires_at timestamptz not null,revoked_at timestamptz,revoked_by text,ip_hash text,user_agent_hash text
);
create index if not exists web_admin_sessions_user_idx on public.web_admin_sessions(user_id,expires_at desc);
alter table public.web_admin_sessions enable row level security;
revoke all on public.web_admin_sessions from public,anon,authenticated;
grant select,insert,update on public.web_admin_sessions to service_role;
create policy "Admin sessions service role" on public.web_admin_sessions for all to service_role using(true) with check(true);
create or replace function public.validate_web_admin_session(p_user_id uuid,p_session_id text) returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.web_admin_sessions s where s.user_id=p_user_id and s.session_id::text=p_session_id and s.revoked_at is null and s.expires_at>now());
$$;
create or replace function public.revoke_web_admin_sessions(p_user_id uuid,p_actor text default 'admin') returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;begin update public.web_admin_sessions set revoked_at=now(),revoked_by=left(p_actor,200) where user_id=p_user_id and revoked_at is null;get diagnostics n=row_count;return n;end;$$;
revoke all on function public.validate_web_admin_session(uuid,text),public.revoke_web_admin_sessions(uuid,text) from public,anon,authenticated;
grant execute on function public.validate_web_admin_session(uuid,text),public.revoke_web_admin_sessions(uuid,text) to service_role;
