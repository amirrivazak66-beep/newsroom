-- Forwarded publication repair; preserves existing content and cancellation states.
CREATE OR REPLACE FUNCTION public.seal_editorial_version(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare n public.news_items%rowtype;p jsonb;h text;body_text text;
begin
 select * into n from public.news_items where id=p_item_id for update;
 if not found then return null;end if;
 if n.final_payload is not null then return jsonb_build_object('revision',n.editorial_revision,'payload',n.final_payload,'trace_id',n.trace_id);end if;
 body_text:=case when n.telegram_caption_edited or n.telegram_translation_language is not null then coalesce(nullif(n.rewritten_text,''),nullif(n.original_summary,''),nullif(n.summary,''),n.title,'') else coalesce(nullif(n.original_summary,''),nullif(n.summary,''),nullif(n.rewritten_text,''),n.title,'') end;
 if n.source_type='telegram' then body_text:=trim(regexp_replace(regexp_replace(body_text,'https?://[^[:space:]<>]+|(?:www\.)?t\.me/[^[:space:]<>]+|telegram\.me/[^[:space:]<>]+','','gi'),'(^|[[:space:]])@[a-z0-9_]+',' ','gi'));end if;
 p:=jsonb_build_object('title',coalesce(nullif(n.rewritten_title,''),n.title),'body',body_text,'category',n.category,'source_name',n.source_name,'source_type',n.source_type,'pub_date',n.pub_date,'graphic_url',coalesce(n.graphic_image_url,''),'original_image_url',coalesce(n.original_image_url,''),'video_file_id',n.video_file_id);
 h:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 insert into public.editorial_versions(item_id,revision,payload,payload_hash) values(n.id,n.editorial_revision,p,h);
 update public.news_items set final_payload=p,final_payload_hash=h where id=n.id;
 return jsonb_build_object('revision',n.editorial_revision,'payload',p,'trace_id',n.trace_id);
end;$function$
;
CREATE OR REPLACE FUNCTION public.claim_editorial_publication_v2(p_item_id uuid, p_actor text, p_scheduled boolean, p_expected_revision integer, p_immediate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 if p_scheduled and (s.auto_publish is not true or n.scheduled_at is null or n.scheduled_at>now()) then return jsonb_build_object('error','schedule_not_due','status',409);end if;
 if not p_scheduled and not p_immediate and n.scheduled_at>now() then return jsonb_build_object('error','cancel_schedule_first','status',409);end if;
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
end;$function$
;
CREATE OR REPLACE FUNCTION public.fill_radin_publish_queue(p_admin_chat_ids bigint[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare settings public.bot_settings%rowtype; slots integer; scheduled_count integer:=0;
  cursor_time timestamptz; item record; step_minutes integer; position integer:=0;
  old_slots timestamptz[]; selected_ids uuid[]:='{}'; next_time timestamptz;
  protected_before timestamptz:=now()+interval '2 minutes';
begin
  perform pg_catalog.pg_advisory_xact_lock(728194207);
  select * into settings from public.bot_settings where id='main' for update;
  if not found or settings.auto_publish is not true then return 0; end if;
  step_minutes:=greatest(5,least(coalesce(settings.schedule_interval_minutes,60),1440));
  -- Freeze near-due/publishing stories. Reuse future time slots so refills do
  -- not keep postponing publication, while newest receipts take the first slot.
  perform 1 from public.news_items where not published and review_status='approved'
    and scheduled_at>protected_before and source_type in ('telegram','website')
    and telegram_chat_id=any(p_admin_chat_ids) for update;
  select array_agg(scheduled_at order by scheduled_at,id) into old_slots from public.news_items
    where not published and review_status='approved' and scheduled_at>protected_before
      and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids);
  select greatest(0,least(coalesce(settings.queue_limit,10),50)-count(*)),greatest(now(),coalesce(max(scheduled_at),now()))
    into slots,cursor_time from public.news_items
    where not published and scheduled_at is not null and review_status in ('approved','publishing')
      and not (review_status='approved' and scheduled_at>protected_before
        and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids));
  for item in select id,coalesce(nullif(rewritten_title,''),title) as title,scheduled_at from public.news_items
    where not published and telegram_message_id is null and publication_state='idle' and source_type in ('telegram','website')
      and telegram_chat_id=any(p_admin_chat_ids)
      and ((review_status='pending' and scheduled_at is null) or (review_status='approved' and scheduled_at>protected_before))
      and graphic_image_url~'^https?://' and original_image_url~'^https?://'
      and telegram_preview_message_id is not null
      and (source_type<>'telegram' or length(trim(coalesce(rewritten_title,'')))>0)
    order by coalesce((select max(a.created_at) from public.bot_activity a where a.item_id=news_items.id and a.event_type='received'),created_at) desc,id desc limit slots for update skip locked
  loop
    perform public.seal_editorial_version(item.id);
    if not public.editorial_policy_allows(item.id) then continue; end if;
    position:=position+1;
    next_time:=case when old_slots[position]>cursor_time then old_slots[position] else cursor_time+make_interval(mins=>step_minutes) end;
    cursor_time:=next_time;
    selected_ids:=array_append(selected_ids,item.id);
    if item.scheduled_at is distinct from next_time then
      update public.news_items set scheduled_at=next_time,review_status='approved',updated_at=now() where id=item.id;
      if item.scheduled_at is null then
        insert into public.bot_activity(event_type,item_id,actor,details) values('scheduled',item.id,'bot_queue',jsonb_build_object('title',item.title,'scheduled_at',next_time,'source','bot_queue'));
        scheduled_count:=scheduled_count+1;
      end if;
    end if;
  end loop;
  -- Older stories stay available for a later refill when the configured queue
  -- capacity is full; they are not deleted, published, or rejected.
  update public.news_items set scheduled_at=null,review_status='pending',updated_at=now()
    where not published and review_status='approved' and scheduled_at>protected_before
      and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids)
      and not (id=any(selected_ids));
  return scheduled_count;
end;
$function$
;
revoke all on function public.claim_editorial_publication_v2(uuid,text,boolean,integer,boolean) from public,anon,authenticated;
grant execute on function public.claim_editorial_publication_v2(uuid,text,boolean,integer,boolean) to service_role;
