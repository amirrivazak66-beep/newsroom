-- Additive hardening. Existing story data is preserved; approvals become
-- revision-bound and must not be inferred from the legacy review_status field.
alter table public.news_items add column if not exists trace_id uuid not null default gen_random_uuid();
alter table public.news_items add column if not exists editorial_revision integer not null default 1;
alter table public.news_items add column if not exists final_payload jsonb;
alter table public.news_items add column if not exists final_payload_hash text;
alter table public.news_items add column if not exists approved_revision integer;
alter table public.news_items add column if not exists approved_at timestamptz;
alter table public.news_items add column if not exists approved_by text;
alter table public.news_items add column if not exists publication_state text not null default 'idle';
alter table public.news_items add column if not exists publication_retry_at timestamptz;
alter table public.news_items add column if not exists expires_at timestamptz;
alter table public.news_items add column if not exists importance integer not null default 50;
create index if not exists news_items_trace_idx on public.news_items(trace_id);
create index if not exists news_items_due_idx on public.news_items(scheduled_at) where not published and review_status='approved';
create table public.editorial_versions(
 item_id uuid not null references public.news_items(id) on delete cascade,revision integer not null,
 payload jsonb not null,payload_hash text not null,created_at timestamptz not null default now(),
 primary key(item_id,revision)
);
create table public.publication_attempts(
 id uuid primary key default gen_random_uuid(),item_id uuid not null references public.news_items(id),
 revision integer not null,trace_id uuid not null,destination text not null,actor text not null,
 state text not null check(state in('claimed','sending','sent','unknown','failed','blocked')),
 retryable boolean not null default false,attempt_no integer not null,telegram_message_id bigint,
 error_code text,error_message text,started_at timestamptz not null default now(),finished_at timestamptz,
 foreign key(item_id,revision) references public.editorial_versions(item_id,revision)
);
create unique index publication_one_unresolved on public.publication_attempts(item_id,revision,destination) where state in('claimed','sending','unknown','sent');
create index publication_attempts_trace_idx on public.publication_attempts(trace_id,started_at desc);
alter table public.editorial_versions enable row level security;
alter table public.publication_attempts enable row level security;
revoke all on public.editorial_versions,public.publication_attempts from public,anon,authenticated;
grant select,insert,update on public.editorial_versions,public.publication_attempts to service_role;
create policy "Editorial versions service role" on public.editorial_versions for all to service_role using(true) with check(true);
create policy "Publication attempts service role" on public.publication_attempts for all to service_role using(true) with check(true);

create function public.invalidate_editorial_version() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if row(new.title,new.summary,new.original_summary,new.rewritten_title,new.rewritten_text,new.graphic_image_url,new.original_image_url,new.telegram_translation_language,new.telegram_caption_edited,new.telegram_headline_edited,new.sensitivity,new.category,new.source_name,new.source_type,new.pub_date,new.video_file_id,new.graphic_quality_status)
   is distinct from row(old.title,old.summary,old.original_summary,old.rewritten_title,old.rewritten_text,old.graphic_image_url,old.original_image_url,old.telegram_translation_language,old.telegram_caption_edited,old.telegram_headline_edited,old.sensitivity,old.category,old.source_name,old.source_type,old.pub_date,old.video_file_id,old.graphic_quality_status)
   or (old.published and not new.published) then
   if old.publication_state in('claimed','sending','unknown') then raise exception 'Publication must be reconciled before editing';end if;
   new.editorial_revision:=old.editorial_revision+1;new.final_payload:=null;new.final_payload_hash:=null;
   new.approved_revision:=null;new.approved_by:=null;new.approved_at:=null;new.scheduled_at:=null;
   new.publication_state:='idle';new.publication_retry_at:=null;new.telegram_preview_message_id:=null;
   if new.review_status<>'rejected' then new.review_status:='pending';end if;
 end if;
 if new.review_status='rejected' then new.approved_revision:=null;new.approved_at:=null;new.approved_by:=null;end if;
 return new;
end;$$;
create trigger news_editorial_invalidation before update on public.news_items for each row execute function public.invalidate_editorial_version();

create function public.seal_editorial_version(p_item_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare n public.news_items%rowtype;p jsonb;h text;body_text text;
begin
 select * into n from public.news_items where id=p_item_id for update;
 if not found then return null;end if;
 if n.final_payload is not null then return jsonb_build_object('revision',n.editorial_revision,'payload',n.final_payload,'trace_id',n.trace_id);end if;
 body_text:=case when n.telegram_caption_edited or n.telegram_translation_language is not null then coalesce(n.rewritten_text,'') else coalesce(nullif(n.original_summary,''),nullif(n.summary,''),n.rewritten_text,'') end;
 if n.source_type='telegram' then body_text:=trim(regexp_replace(regexp_replace(body_text,'https?://[^[:space:]<>]+|(?:www\.)?t\.me/[^[:space:]<>]+|telegram\.me/[^[:space:]<>]+','','gi'),'(^|[[:space:]])@[a-z0-9_]+',' ','gi'));end if;
 p:=jsonb_build_object('title',coalesce(nullif(n.rewritten_title,''),n.title),'body',body_text,'category',n.category,'source_name',n.source_name,'source_type',n.source_type,'pub_date',n.pub_date,'graphic_url',coalesce(n.graphic_image_url,''),'original_image_url',coalesce(n.original_image_url,''),'video_file_id',n.video_file_id);
 h:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 insert into public.editorial_versions(item_id,revision,payload,payload_hash) values(n.id,n.editorial_revision,p,h);
 update public.news_items set final_payload=p,final_payload_hash=h where id=n.id;
 return jsonb_build_object('revision',n.editorial_revision,'payload',p,'trace_id',n.trace_id);
end;$$;

create function public.editorial_policy_allows(p_item_id uuid) returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.news_items n cross join public.bot_settings s where n.id=p_item_id and s.id='main' and not n.published and n.review_status<>'rejected'
   and n.final_payload is not null and (n.expires_at is null or n.expires_at>now()) and n.publication_state not in('claimed','sending','unknown','sent','blocked')
   and (n.approved_revision=n.editorial_revision or (s.review_required=false and s.default_review_mode<>'all' and coalesce(n.sensitivity,'normal')='normal' and n.graphic_quality_status is distinct from 'review')));
$$;

create function public.claim_editorial_publication(p_item_id uuid,p_actor text,p_scheduled boolean,p_expected_revision integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare n public.news_items%rowtype;s public.bot_settings%rowtype;snapshot jsonb;attempt uuid;seq integer;reason text;
begin
 select * into n from public.news_items where id=p_item_id for update;
 if not found then return jsonb_build_object('error','story_not_found','status',404);end if;
 select * into s from public.bot_settings where id='main';
 if n.published or n.telegram_message_id is not null then return jsonb_build_object('error','already_published','status',409);end if;
 if n.publication_state in('claimed','sending','unknown') then return jsonb_build_object('error','publication_'||n.publication_state,'status',409);end if;
 if n.review_status='rejected' then return jsonb_build_object('error','story_rejected','status',409);end if;
 if n.expires_at<=now() then return jsonb_build_object('error','story_expired','status',409);end if;
 if p_expected_revision is null or p_expected_revision<>n.editorial_revision then return jsonb_build_object('error','stale_preview','status',409);end if;
 if p_scheduled and (s.auto_publish is not true or n.scheduled_at is null or n.scheduled_at>now() or n.video_file_id is not null) then return jsonb_build_object('error','schedule_not_due','status',409);end if;
 if not p_scheduled and n.scheduled_at>now() then return jsonb_build_object('error','cancel_schedule_first','status',409);end if;
 snapshot:=public.seal_editorial_version(n.id);
 if p_scheduled and not public.editorial_policy_allows(n.id) then
   update public.news_items set scheduled_at=null,review_status='pending',publication_state='blocked' where id=n.id;
   return jsonb_build_object('error','human_review_required','status',409);
 end if;
 select count(*)+1 into seq from public.publication_attempts where item_id=n.id and revision=n.editorial_revision and destination=s.channel_username;
 if seq>3 then return jsonb_build_object('error','publication_attempt_limit','status',409);end if;
 insert into public.publication_attempts(item_id,revision,trace_id,destination,actor,state,attempt_no)
 values(n.id,n.editorial_revision,n.trace_id,s.channel_username,left(p_actor,200),'claimed',seq) returning id into attempt;
 update public.news_items set publication_state='claimed',review_status='publishing',approved_revision=n.editorial_revision,approved_at=now(),approved_by=left(p_actor,200) where id=n.id;
 return snapshot||jsonb_build_object('attempt_id',attempt,'destination',s.channel_username);
end;$$;

create function public.start_publication_send(p_attempt uuid) returns boolean language plpgsql security invoker set search_path='' as $$
declare item uuid;
begin
 update public.publication_attempts set state='sending' where id=p_attempt and state='claimed' returning item_id into item;
 if item is null then return false;end if;
 update public.news_items set publication_state='sending' where id=item;return true;
end;$$;
create function public.finish_publication_send(p_attempt uuid,p_message_id bigint default null,p_state text default 'sent',p_error text default null,p_retryable boolean default false,p_retry_seconds integer default 60)
returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.publication_attempts%rowtype;
begin
 if p_state not in('sent','unknown','failed','blocked') then raise exception 'Invalid publication outcome';end if;
 select * into a from public.publication_attempts where id=p_attempt for update;
 if not found or a.state not in('claimed','sending') then return false;end if;
 if p_state='sent' and (a.state<>'sending' or p_message_id is null) then raise exception 'Send receipt required';end if;
 update public.publication_attempts set state=p_state,telegram_message_id=p_message_id,error_code=left(p_error,100),retryable=p_retryable,finished_at=now() where id=a.id;
 if p_state='sent' then
  update public.news_items set published=true,review_status='approved',publication_state='sent',telegram_message_id=p_message_id,processed_at=now(),updated_at=now(),publication_retry_at=null where id=a.item_id;
 elsif p_state='unknown' then
  update public.news_items set publication_state='unknown',review_status='publishing',publication_retry_at=null where id=a.item_id;
 else
  update public.news_items set publication_state=case when p_retryable and a.attempt_no<3 then 'idle' else 'blocked' end,
    review_status=case when p_retryable and a.attempt_no<3 then 'approved' else 'pending' end,
    scheduled_at=case when p_retryable and a.attempt_no<3 then greatest(coalesce(scheduled_at,now()),now()+make_interval(secs=>greatest(30,least(p_retry_seconds,3600)))) else null end,
    publication_retry_at=case when p_retryable and a.attempt_no<3 then now()+make_interval(secs=>greatest(30,least(p_retry_seconds,3600))) else null end where id=a.item_id;
 end if;return true;
end;$$;

create function public.recover_stale_publications() returns integer language plpgsql security invoker set search_path='' as $$
declare a record;n integer:=0;
begin
 for a in select id,state from public.publication_attempts where state in('claimed','sending') and started_at<now()-interval '5 minutes' for update skip locked loop
  perform public.finish_publication_send(a.id,null,case when a.state='sending' then 'unknown' else 'failed' end,'publication_lease_expired',false);n:=n+1;
 end loop;return n;
end;$$;

create function public.resolve_publication_attempt(p_attempt uuid,p_actor text,p_message_id bigint default null,p_confirm_not_sent boolean default false) returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.publication_attempts%rowtype;
begin
 select * into a from public.publication_attempts where id=p_attempt for update;
 if not found or a.state<>'unknown' then return false;end if;
 if p_message_id is not null then
  update public.publication_attempts set state='sent',telegram_message_id=p_message_id,finished_at=now() where id=a.id;
  update public.news_items set published=true,telegram_message_id=p_message_id,publication_state='sent',review_status='approved',processed_at=now() where id=a.item_id;
 elsif p_confirm_not_sent then
  update public.publication_attempts set state='failed',error_code='manually_confirmed_not_sent',finished_at=now() where id=a.id;
  update public.news_items set publication_state='idle',review_status='pending',scheduled_at=null where id=a.item_id;
 else return false;end if;
 insert into public.bot_activity(event_type,item_id,actor,details) values('publication_reconciled',a.item_id,left(p_actor,200),jsonb_build_object('attempt_id',a.id,'message_id',p_message_id,'confirmed_not_sent',p_confirm_not_sent));return true;
end;$$;

revoke all on function public.invalidate_editorial_version(),public.seal_editorial_version(uuid),public.editorial_policy_allows(uuid),public.claim_editorial_publication(uuid,text,boolean,integer),public.start_publication_send(uuid),public.finish_publication_send(uuid,bigint,text,text,boolean,integer),public.recover_stale_publications(),public.resolve_publication_attempt(uuid,text,bigint,boolean) from public,anon,authenticated;
grant execute on function public.invalidate_editorial_version(),public.seal_editorial_version(uuid),public.editorial_policy_allows(uuid),public.claim_editorial_publication(uuid,text,boolean,integer),public.start_publication_send(uuid),public.finish_publication_send(uuid,bigint,text,text,boolean,integer),public.recover_stale_publications(),public.resolve_publication_attempt(uuid,text,bigint,boolean) to service_role;

create function public.approve_editorial_revision(p_item_id uuid,p_revision integer,p_actor text) returns boolean language plpgsql security invoker set search_path='' as $$
declare n public.news_items%rowtype;snapshot jsonb;
begin
 select * into n from public.news_items where id=p_item_id for update;
 if not found or n.published or n.review_status='rejected' or n.editorial_revision<>p_revision or n.publication_state in('claimed','sending','unknown') then return false;end if;
 snapshot:=public.seal_editorial_version(n.id);
 if coalesce(snapshot->'payload'->>'graphic_url','')!~'^https://' or coalesce(snapshot->'payload'->>'body','')='' then return false;end if;
 update public.news_items set approved_revision=p_revision,approved_by=left(p_actor,200),approved_at=now(),publication_state='idle',review_status='approved' where id=n.id;
 insert into public.bot_activity(event_type,item_id,actor,details) values('editorial_approved',n.id,left(p_actor,200),jsonb_build_object('revision',p_revision,'trace_id',n.trace_id));return true;
end;$$;
revoke all on function public.approve_editorial_revision(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.approve_editorial_revision(uuid,integer,text) to service_role;
alter table public.news_items add column if not exists graphic_mode text not null default 'ai';
alter table public.news_items add column if not exists pending_graphic_prompt text;
-- Authenticated browsers edit content; publication receipts and approvals are
-- exclusively written through the authenticated backend and atomic RPCs.
revoke insert,update on public.news_items from authenticated;
grant update(title,summary,rewritten_title,rewritten_text,telegram_caption_edited,telegram_headline_edited,scheduled_at,review_status,updated_at) on public.news_items to authenticated;
