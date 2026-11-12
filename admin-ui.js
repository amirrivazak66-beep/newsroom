/* All untrusted editorial values are assigned through DOM properties. */
(function(root){
  'use strict';
  function element(tag, props={}, children=[]){
    const node=document.createElement(tag);
    for(const [key,value] of Object.entries(props)){
      if(key==='text')node.textContent=String(value??'');
      else if(key==='dataset')Object.assign(node.dataset,value);
      else if(key==='style')Object.assign(node.style,value);
      else node[key]=value;
    }
    for(const child of children)node.append(child);
    return node;
  }
  function safeImageUrl(value,base=root.location?.href||'https://example.invalid/'){
    try{
      const url=new URL(String(value||''),base);
      if(!value||!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';
      const host=url.hostname.toLowerCase();
      if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.includes(':')||/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))return '';
      return url.href.replace(/['"()\\\s]/g,ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase());
    }catch{return '';}
  }
  function thumbnail(value){
    const node=element('div',{className:'thumb'});const safe=safeImageUrl(value);
    if(safe)node.style.backgroundImage='url("'+safe+'")';
    return node;
  }
  function newsCard(item,{pending=true,relativeTime=()=>''}={}){
    const row=element('div',{className:'recent-news-item'},[
      thumbnail(item.image_url),element('span',{className:'cat-tag',text:item.category||'عمومی'}),
      element('span',{className:'title',text:item.title||'بدون عنوان'}),
      element('span',{className:'time',text:relativeTime(new Date(item.pub_date))})
    ]);
    if(pending){for(const [action,text] of [['publish','انتشار با پوستر'],['publish_text','انتشار متنی بدون پوستر'],['reject','رد خبر']])row.append(element('button',{className:'unpub-btn',text,dataset:{action,id:String(item.id)}}));}
    else row.append(element('span',{className:'cat-tag',text:'منتشرشده'}));
    return row;
  }
  function inputRow(fields,index,prefix){
    const row=element('div',{className:'feed-row',style:{flexWrap:'wrap'}});
    for(const field of fields){
      const dataset=prefix==='source'?{si:String(index),sf:field.key}:{idx:String(index),field:field.key};
      let input;
      if(field.options){input=element('select',{dataset,className:field.key==='cat'?'cat':''});for(const [value,text] of field.options)input.append(element('option',{value,text,selected:value===field.value}));}
      else input=element('input',{dataset,type:field.type||'text',value:field.value??'',placeholder:field.label||'',title:field.label||''});
      if(field.type==='checkbox'){input.checked=!!field.value;row.append(element('label',{},[input,document.createTextNode(field.label||'')]));}
      else {if(field.min!==undefined)input.min=field.min;if(field.max!==undefined)input.max=field.max;input.style.maxWidth=field.width||'180px';row.append(input);}
    }
    row.append(element('button',{text:'✕',dataset:prefix==='source'?{sremove:String(index)}:{remove:String(index)}}));
    return row;
  }
  function renderNews(container,data,relativeTime){
    container.replaceChildren();
    const pending=data.filter(x=>!x.published&&x.review_status!=='rejected');const published=data.filter(x=>x.published);
    container.append(element('h4',{text:'صف بررسی ('+pending.length+')'}));
    for(const item of pending)container.append(newsCard(item,{relativeTime}));
    if(!pending.length)container.append(element('p',{text:'خبر تأییدنشده‌ای در این فهرست نیست.'}));
    container.append(element('h4',{text:'آخرین خبرهای منتشرشده ('+published.length+')'}));
    for(const item of published.slice(0,8))container.append(newsCard(item,{pending:false,relativeTime}));
  }
  root.RadinUI={element,safeImageUrl,thumbnail,newsCard,inputRow,renderNews};
})(globalThis);
