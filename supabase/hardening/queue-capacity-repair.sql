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
  perform 1 from public.news_items where not published and telegram_message_id is null and publication_state='idle' and review_status='approved'
    and scheduled_at>protected_before and source_type in ('telegram','website')
    and telegram_chat_id=any(p_admin_chat_ids) for update;
  select array_agg(scheduled_at order by scheduled_at,id) into old_slots from public.news_items
    where not published and telegram_message_id is null and publication_state='idle' and review_status='approved' and scheduled_at>protected_before
      and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids);
  select greatest(0,least(coalesce(settings.queue_limit,10),50)-count(*)),greatest(now(),coalesce(max(scheduled_at),now()))
    into slots,cursor_time from public.news_items
    where not published and telegram_message_id is null and publication_state in ('idle','claimed','sending','unknown') and scheduled_at is not null and review_status in ('approved','publishing')
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
    where not published and telegram_message_id is null and publication_state='idle' and review_status='approved' and scheduled_at>protected_before
      and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids)
      and not (id=any(selected_ids));
  return scheduled_count;
end;
$function$;
