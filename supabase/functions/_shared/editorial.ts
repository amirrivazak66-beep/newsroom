export type EditorialPayload = { title: string; body: string; category: string; source_name: string; source_type: string; pub_date: string | null; graphic_url: string; original_image_url: string; video_file_id: string | null };
export function editorialText(value: unknown): string { return String(value ?? '').normalize('NFKC').replace(/\u0000/g,'').trim(); }
export function cleanEditorialBody(value: unknown, sourceType: string): string {
  const text=editorialText(value);
  return sourceType==='telegram'?text.replace(/https?:\/\/[^\s<>]+|(?:www\.)?t\.me\/[^\s<>]+|telegram\.me\/[^\s<>]+/gi,'').replace(/(?:^|\s)@[a-z0-9_]+/gi,' ').split(/\r?\n/).filter(line=>/[\p{L}\p{N}]/u.test(line)).join('\n').replace(/\n{3,}/g,'\n\n').trim():text;
}
export function canonicalEditorial(item: Record<string, any>): EditorialPayload {
  const source=editorialText(item.source_type);
  const translated=!!item.telegram_translation_language;
  return {title:editorialText(item.rewritten_title||item.title),body:cleanEditorialBody((item.telegram_caption_edited||translated)?item.rewritten_text:(item.original_summary||item.summary||item.rewritten_text),source),category:editorialText(item.category),source_name:editorialText(item.source_name),source_type:source,pub_date:item.pub_date||null,graphic_url:editorialText(item.graphic_image_url),original_image_url:editorialText(item.original_image_url),video_file_id:item.video_file_id||null};
}
export function editorialEscape(value: unknown): string { return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!)); }
export function editorialCaption(payload: EditorialPayload, channel: string, preview=false): string {
  const title=preview||payload.source_type!=='telegram'?'<b>'+editorialEscape(payload.title)+'</b>':'';
  const category=payload.category&&!(payload.source_type==='telegram'&&payload.category==='عمومی')?'🏷️ '+editorialEscape(payload.category):'';
  // Source URLs/names are intentionally omitted from the public caption.
  // The source remains stored internally for audit and traceability.
  const source='';
  return [preview?'پیش‌نمایش — هنوز منتشر نشده':'',title,category,payload.body?editorialEscape(payload.body):'',source,preview?'':'📣 '+editorialEscape(channel)].filter(Boolean).join('\n\n');
}
export function editorialPlainPreview(payload: EditorialPayload): string {
  return ['پیش‌نمایش — هنوز منتشر نشده',payload.title,payload.body].filter(Boolean).join('\n\n');
}
export function editorialPublishError(payload: EditorialPayload, channel: string): string | null {
  if(!payload.title||!payload.body)return 'editorial_text_missing';
  if(!/^https:\/\//i.test(payload.graphic_url)||!/^https?:\/\//i.test(payload.original_image_url))return 'editorial_graphic_missing';
  if(editorialCaption(payload,channel).replace(/<[^>]+>/g,'').replace(/&(?:amp|lt|gt|quot|#39);/g,'x').length>1024)return 'caption_too_long';
  return null;
}
