// These are explicit version labels, not proof of the recording's origin.
// In particular, an unlabelled upload must never be called an original.
const order=['ai','cover','remix','mashup','demo','live','sped-up','slowed'];
const word=(text,pattern)=>new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`,'iu').test(text);
const clean=value=>typeof value==='string'?value.normalize('NFKC').replaceAll('_',' ').replace(/\s+/gu,' ').trim():'';

function bracketContexts(title){
  const contexts=[],stack=[];
  for(let i=0;i<title.length;i++){
    if('([{'.includes(title[i]))stack.push(i);
    else if(')]}'.includes(title[i])&&stack.length)contexts.push(title.slice(stack.pop()+1,i));
  }
  return contexts;
}
function coverContext(text){
  const context=text.replace(/\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}/gu,' ').trim();
  return word(context,'(?:cover|кавер)(?:\\s+(?:by|of|version|версия))')||/(?:^|[^\p{L}\p{N}])(?:cover|кавер)$/iu.test(context);
}
function liveContext(text){
  return /^(?:live|лайв)(?:$|\s+(?:at|in|from|on|version|recording|session|performance|edit|remix|acoustic|aid|\d{4})\b)/iu.test(text.trim())||/(?:^|\s)(?:live|лайв)$/iu.test(text.trim());
}

export function trackVersions(track){
  const title=clean(track?.title).slice(0,1000),flags=new Set();
  const brackets=bracketContexts(title),parts=title.split(/\s+[-–—]\s+/u);
  // "AI Trump Cover" and "AI-generated" are explicit. "Ai Se Eu Te Pego"
  // merely contains a word spelled Ai and does not provide this evidence.
  const ai=word(title,'(?:a\\.?i\\.?|ии)(?:[-\\s]+(?:generated|voice|cover|кавер|голос)|\\s+[^()\\[\\]{}]{0,60}?\\s+(?:cover|кавер))')||word(title,'(?:нейро[-\\s]?кавер|сгенерировано\\s+ии)');
  if(ai)flags.add('ai');
  const structuredCover=clean(track?.cover_original_artist)||clean(track?.cover_original_song_title);
  const cover=structuredCover||brackets.some(coverContext)||parts.slice(2).some(coverContext)||parts.slice(1).some(text=>/^(?:(?:piano|acoustic|guitar|vocal|instrumental|metal|rock|jazz|violin|orchestral)\s+)*(?:cover|кавер)(?:$|\s+(?:by|of|version))/iu.test(text.trim()))||word(title,'(?:cover\\s+(?:by|version)|кавер[-\\s]версия)')||(ai&&word(title,'cover|кавер'));
  if(cover)flags.add('cover');
  if(word(title,'remix(?:ed)?|ремикс'))flags.add('remix');
  if(word(title,'mash[-\\s]?up|м[эе]шап'))flags.add('mashup');
  if(word(title,'demo|демо'))flags.add('demo');
  if([...brackets,...parts.slice(1)].some(liveContext))flags.add('live');
  if(word(title,'sped[-\\s]?up|speed[-\\s]?up|ускоренная\\s+версия'))flags.add('sped-up');
  if(word(title,'slowed(?:[-\\s]+down)?|замедленная\\s+версия'))flags.add('slowed');
  return order.filter(code=>flags.has(code));
}
