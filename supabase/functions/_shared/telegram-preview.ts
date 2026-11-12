import { editorialPlainPreview, editorialPublishError } from './editorial.ts';
export function editorialPreviewKeyboard(itemId:string,revision:number,canPublish:boolean,quality:string|null=null){
 const rows:any[]=[
  [{text:'✏️ ویرایش تیتر',callback_data:'edit:headline:'+itemId},{text:'📝 ویرایش کپشن',callback_data:'edit:caption:'+itemId}],
  [{text:'🎨 ویرایش تصویر',callback_data:'edit:graphic:'+itemId}]
 ];
 if(canPublish){rows.push([{text:'✅ تأیید برای صف',callback_data:'approve:'+itemId+':'+revision}]);rows.push([{text:'✅ انتشار در کانال',callback_data:'publish:'+itemId+':'+revision},{text:'🗑 رد خبر',callback_data:'reject:'+itemId+':'+revision}]);}
 if(quality==='review')rows.unshift([{text:'🔄 بازتولید پوستر',callback_data:'regenerate:'+itemId}]);
 rows.push([{text:'📥 بسته اینستاگرام',callback_data:'insta:export:'+itemId}]);return {inline_keyboard:rows};
}
export async function deliverEditorialPreview(db:any,itemId:string,chatId:number|string,botToken:string,canPublish:boolean,existingMessageId:number|null=null){
 const {data:item,error}=await db.from('news_items').select('id,published,review_status,graphic_quality_status,telegram_preview_message_id').eq('id',itemId).maybeSingle();
 if(error||!item||item.published||item.review_status==='rejected')throw new Error('preview_story_unavailable');
 const sealed=await db.rpc('seal_editorial_version',{p_item_id:itemId});
 if(sealed.error||!sealed.data?.payload)throw new Error('preview_snapshot_unavailable');
 const {payload,revision,trace_id}=sealed.data;
 const invalid=editorialPublishError(payload,'@radinnews');
 const footer='\n\nنسخه '+revision+' • پیگیری '+String(trace_id).slice(0,8)+(item.graphic_quality_status==='review'?'\n⚠️ پوستر نیاز به تأیید کیفیت مدیر دارد.':'')+(invalid==='caption_too_long'?'\n⚠️ متن برای انتشار باید کوتاه‌تر شود.':'');
 const content=editorialPlainPreview(payload);const photo=!!payload.graphic_url;
 const limit=photo?950:3900;const text=(content.length>limit?content.slice(0,limit-45)+'\n… پیش‌نمایش کوتاه شده؛ متن را ویرایش کنید.':content)+footer;
 const markup=editorialPreviewKeyboard(itemId,revision,canPublish&&!invalid,item.graphic_quality_status);
 const post=async(method:string,body:any)=>{
  const response=await fetch('https://api.telegram.org/bot'+botToken+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const result=await response.json().catch(()=>({}));return {ok:response.ok&&result.ok===true,result};
 };
 let sent:any=null;const messageId=existingMessageId||item.telegram_preview_message_id;
 if(messageId&&photo)sent=await post('editMessageMedia',{chat_id:chatId,message_id:messageId,media:payload.video_file_id?{type:'video',media:payload.video_file_id,cover:payload.graphic_url,caption:text}:{type:'photo',media:payload.graphic_url,caption:text},reply_markup:markup});
 if(!sent?.ok)sent=await post(payload.video_file_id?'sendVideo':photo?'sendPhoto':'sendMessage',payload.video_file_id?{chat_id:chatId,video:payload.video_file_id,cover:payload.graphic_url,caption:text,reply_markup:markup}:photo?{chat_id:chatId,photo:payload.graphic_url,caption:text,reply_markup:markup}:{chat_id:chatId,text,reply_markup:markup,disable_web_page_preview:true});
 if(!sent.ok)throw new Error('telegram_preview_delivery_failed');
 const storedId=sent.result.result?.message_id||messageId;
 const saved=await db.from('news_items').update({telegram_preview_message_id:storedId}).eq('id',itemId).eq('editorial_revision',revision);
 if(saved.error)throw new Error('preview_receipt_persist_failed');
 await db.from('bot_activity').insert({event_type:'preview_sent',item_id:itemId,actor:'editorial_preview',details:{revision,trace_id,preview_message_id:storedId}});
 return {revision,payload,trace_id};
}
