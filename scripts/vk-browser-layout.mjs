// Self-contained DOM readers, serialized into the already authenticated page.
// This module may be refreshed without restarting Chrome or copying credentials.
export function readTrackRows(query,doc=document){
  const normalize=value=>String(value||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const clean=value=>String(value||'').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,180);
  const roots=[doc];
  for(let index=0;index<roots.length&&roots.length<8;index++){
    let count=0;for(const element of roots[index].querySelectorAll('*')){
      if(++count>5000||roots.length>=8)break;
      if(element.shadowRoot)roots.push(element.shadowRoot);
      if(element.tagName==='IFRAME')try{const url=new URL(element.src,doc.location?.href);if(url.origin===doc.location?.origin&&/^\/(audio|music)/.test(url.pathname)&&element.contentDocument)roots.push(element.contentDocument);}catch{}
    }
  }
  const selector='.audio_row, .audio_item, [data-audio], [class*="AudioRow" i], [class*="AudioItem" i], [class*="TrackRow" i], [class*="MusicTrack" i], [data-testid*="AudioRow" i], [data-testid*="AudioItem" i], [data-testid*="TrackRow" i], [data-testid*="MusicTrack" i], [data-testid*="audio-row" i], [data-testid*="audio_row" i], [data-testid*="audio-track" i], [data-testid*="track-row" i]';
  const nodes=[];for(const root of roots){for(const node of root.querySelectorAll(selector)){nodes.push(node);if(nodes.length===300)break;}if(nodes.length===300)break;}
  const artistSelector='.audio_row__performers, ._audio_row__performers, .audio_item__performer, .audio_row__performer, [class*="performer" i], [class*="artist" i], [data-testid*="performer" i], [data-testid*="artist" i], [data-testid*="subtitle" i], [class*="subtitle" i]';
  const titleSelector='.audio_row__title_inner, ._audio_row__title_inner, .audio_item__title, .audio_row__title, [class*="title" i]:not([class*="subtitle" i]), [data-testid*="title" i]:not([data-testid*="subtitle" i])';
  const durationSelector='.audio_row__duration, .audio_item__duration, [class*="duration" i], [data-testid*="duration" i]';
  const find=(node,selector)=>node.matches?.(selector)?node:node.querySelector(selector);
  const tracks=[];let parsed=0,blank=0,missingArtist=0;const seen=new Set();
  for(const node of nodes){
    const titleNode=find(node,titleSelector);let scope=node;
    // A testid may label only the title, not its complete card. Find the nearest
    // group with that title and a performer/subtitle; never cross another song.
    if(titleNode?.parentElement){
      let parent=titleNode,best;
      for(let depth=0;depth<6&&parent;depth++,parent=parent.parentElement){
        if(parent.getAttribute('data-testid')?.startsWith('TopAudioPlayer'))break;
        const otherTitles=[...parent.querySelectorAll(titleSelector)].filter(other=>other!==titleNode&&!other.contains(titleNode)&&!titleNode.contains(other));
        if(otherTitles.length)break;
        if(find(parent,artistSelector)){best=parent;if(find(parent,durationSelector))break;}
      }
      if(best)scope=best;
    }
    let artist=find(scope,artistSelector)?.textContent||'';
    let title=titleNode?.textContent||'';
    let duration=0,id=scope.getAttribute('data-full-id')||node.getAttribute('data-full-id');
    for(const key of ['data-audio-id','data-track-id','data-id']){
      const value=scope.getAttribute(key);if(!id&&/^-?\d+_\d+$/.test(value||''))id=value;
    }
    const time=(find(scope,durationSelector)?.textContent||'').trim();
    if(/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time))duration=time.split(':').reduce((seconds,part)=>seconds*60+Number(part),0);
    let data;try{const raw=scope.getAttribute('data-audio')||node.getAttribute('data-audio');if(raw&&raw.length<32768)data=JSON.parse(raw);}catch{}
    if(Array.isArray(data)){
      if(!title&&typeof data[3]==='string')title=data[3].replace(/<[^>]*>/g,'');
      if(!artist&&typeof data[4]==='string')artist=data[4].replace(/<[^>]*>/g,'');
      if(!duration&&Number.isFinite(data[5]))duration=data[5];
      if(!id&&Number.isSafeInteger(data[0])&&Number.isSafeInteger(data[1]))id=data[1]+'_'+data[0];
    }else if(data&&typeof data==='object'){
      if(!title&&typeof data.title==='string')title=data.title;
      if(!artist&&typeof data.artist==='string')artist=data.artist;
      if(!duration&&Number.isFinite(data.duration))duration=data.duration;
    }
    artist=clean(artist);title=clean(title);if(!artist&&!title)continue;parsed++;
    if(!title){blank++;continue;}
    if(!artist){missingArtist++;continue;}
    const key=artist+'\0'+title;if(seen.has(key))continue;seen.add(key);
    const q=normalize(query),artistName=normalize(artist),titleName=normalize(title);
    const matches=text=>(' '+text+' ').includes(' '+q+' ');
    if(!matches(artistName)&&!matches(titleName))continue;
    const rank=artistName===q?3:matches(artistName)?2:1;
    tracks.push({artist,title,duration:duration>0&&duration<86400?duration:0,...(/^-?\d+_\d+$/.test(id||'')?{id}:{}),rank});
  }
  tracks.sort((a,b)=>b.rank-a.rank);
  return {received:nodes.length,parsed_rows:parsed,blank_titles:blank,missing_artist:missingArtist,matched:tracks.length,
    ...(!tracks.length&&missingArtist?{code:'incomplete_track_metadata'}:{}),
    tracks:tracks.slice(0,8).map(({rank,...track})=>track)};
}

export function inspectMusicLayout(doc=document){
  const samples=[];const known=['bohemian rhapsody','the show must go on','love of my life','queen'];
  const roots=[doc];
  for(let index=0;index<roots.length&&roots.length<8;index++){
    let count=0;for(const element of roots[index].querySelectorAll('*')){
      if(++count>5000||roots.length>=8)break;
      if(element.shadowRoot)roots.push(element.shadowRoot);
      if(element.tagName==='IFRAME')try{const url=new URL(element.src,doc.location?.href);if(url.origin===doc.location?.origin&&/^\/(audio|music)/.test(url.pathname)&&element.contentDocument)roots.push(element.contentDocument);}catch{}
    }
  }
  let count=0;
  for(const root of roots){
   const walker=doc.createTreeWalker(root.body||root,4);let text;
   while((text=walker.nextNode())&&count++<15000&&samples.length<20){
    const value=String(text.textContent||'').trim().toLowerCase();
    if(value.length>200)continue;
    const match=known.find(title=>value===title||title!=='queen'&&value.startsWith(title+' ('));
    if(!match)continue;
    const chain=[];let element=text.parentElement;
    for(let depth=0;depth<5&&element;depth++,element=element.parentElement){
      const classes=[...element.classList].filter(value=>/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(value)).slice(0,5);
      const testid=element.getAttribute('data-testid');const role=element.getAttribute('role');
      chain.push({tag:element.tagName.toLowerCase().slice(0,40),classes,
        ...(testid&&/^[A-Za-z][A-Za-z0-9:_-]{0,79}$/.test(testid)?{testid}:{}),
        ...(['button','link','listitem','list','grid','row'].includes(role)?{role}:{})});
    }
    samples.push({sample:match,chain});
   }
  }
  samples.sort((a,b)=>Number(a.sample==='queen')-Number(b.sample==='queen'));
  const testids=new Set(),tags=new Set();
  for(const root of roots){
    for(const element of root.querySelectorAll('[data-testid]')){
      const value=element.getAttribute('data-testid');
      if(value&&/^[A-Za-z][A-Za-z0-9:_-]{0,79}$/.test(value)&&/audio|track|music/i.test(value)&&testids.size<40)testids.add(value);
    }
    for(const element of root.querySelectorAll('*')){
      const tag=String(element.tagName||'').toLowerCase();
      if(/^[a-z][a-z0-9-]{0,59}$/.test(tag)&&tag.includes('-')&&/audio|track|music/.test(tag)&&tags.size<20)tags.add(tag);
    }
  }
  const frames=[];
  for(const frame of [...doc.querySelectorAll('iframe')].slice(0,8)){
    const item={host:'other',path_kind:'other',readable_document:false};
    try{const url=new URL(frame.src,doc.location.href);
      if(['vk.ru','vk.com','music.vk.ru','music.vk.com','m.vk.ru','m.vk.com','login.vk.ru','login.vk.com','id.vk.ru','id.vk.com'].includes(url.hostname))item.host=url.hostname;
      item.same_origin=url.origin===doc.location.origin;
      item.path_kind=/^\/(audio|music)/.test(url.pathname)?'music':url.pathname==='/q_frame.html'?'notifications':url.protocol==='about:'?'blank':'other';
    }catch{}
    try{item.readable_document=Boolean(frame.contentDocument);}catch{}
    frames.push(item);
  }
  return {ready_state:['loading','interactive','complete'].includes(doc.readyState)?doc.readyState:'unknown',
    inspected_roots:roots.length,
    iframe_count:doc.querySelectorAll('iframe').length,
    frames,music_testids:[...testids],music_custom_tags:[...tags],
    legacy_row_count:doc.querySelectorAll('.audio_row, .audio_item, [data-audio]').length,
    samples:samples.slice(0,6)};
}
