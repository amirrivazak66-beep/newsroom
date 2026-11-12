-- Atomic RSS ingestion: accepts a JSON array of normalized rows, preserves
-- pending/review state and counts only genuinely inserted source URLs.
create or replace function public.ingest_rss_batch(p_rows jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare row jsonb;inserted integer:=0;source text;affected integer;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'invalid_ingest_batch';end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  source:=nullif(trim(row->>'source_url'),'');if source is null or source!~*'^https?://' then continue;end if;
  insert into public.news_items(feed_id,category,title,summary,image_url,source_url,source_name,pub_date,published,review_status,source_type,original_title,original_summary)
  values((row->>'feed_id')::uuid,coalesce(nullif(row->>'category',''),'عمومی'),left(row->>'title',500),left(row->>'summary',4000),nullif(row->>'image', ''),source,left(row->>'source_name',200),coalesce((row->>'pubDate')::timestamptz,now()),false,'pending','rss',left(row->>'title',500),left(row->>'summary',4000)) on conflict(source_url) do nothing;
  get diagnostics affected=ROW_COUNT;if affected=1 then inserted:=inserted+1;end if;
 end loop;return jsonb_build_object('inserted',inserted);
end;$$;
revoke all on function public.ingest_rss_batch(jsonb) from public,anon,authenticated;
grant execute on function public.ingest_rss_batch(jsonb) to service_role;
