import {AudiusError,searchAudius,searchFullAudius,searchAudiusUsers,artistCatalogueAudius} from './audius.mjs';

const cache=new Map(),sessions=new Map();
const PAGE=40,MAX_RESULTS=1000,TTL=10*60000;
const letters={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
export const normalizeSearch=value=>String(value||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function searchVariants(query){
  const variants=[query.trim().normalize('NFKC').replace(/\s+/g,' ')];
  if(/[а-яё]/i.test(query))variants.push(query.toLowerCase().replace(/[а-яё]/g,letter=>letters[letter]));
  if(['корольишут','киш','korolishut','kish'].includes(normalizeSearch(query).replaceAll(' ','')))variants.push('korol i shut','король и шут','КиШ');
  const clean=query.replace(/["“”«»‘’'()[\]]/g,'').replace(/\s+[—–-]\s+/g,' ').replace(/\s+/g,' ').trim();
  if(clean!==query)variants.push(clean);
  const seen=new Set();return variants.filter(value=>{const key=value.toLowerCase();if(!value||seen.has(key))return false;seen.add(key);return true;}).slice(0,3);
}
function distance(a,b){
  if(Math.abs(a.length-b.length)>2)return 3;
  const previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+Number(a[i-1]!==b[j-1]));
    previous.splice(0,previous.length,...row);
  }
  return previous[b.length];
}
function nameMatch(name,query){
  const value=normalizeSearch(name),q=normalizeSearch(query);if(!value||!q)return 0;
  const compact=value.replaceAll(' ',''),needle=q.replaceAll(' ','');
  if(compact===needle)return 4;if(value.startsWith(q+' '))return 3;
  if(compact.startsWith(needle)&&needle.length>=5)return 1;
  if((' '+value+' ').includes(' '+q+' '))return 2;
  if(needle.length>=5&&distance(compact,needle)<=(needle.length>=10?2:1))return 1;
  return 0;
}
function fraction(text,query){
  const words=normalizeSearch(query).split(' ').filter(Boolean),available=normalizeSearch(text).split(' ');
  if(!words.length)return 0;
  return words.filter(word=>available.some(value=>value===word||word.length>=5&&distance(value,word)<=1)).length/words.length;
}
function score(entry,state){
  const {track}=entry;let artist=0,title=0,combined=0;
  for(const [i,variant]of (state.artistQuery?searchVariants(state.artistQuery):state.variants).entries()){
    const weight=i===0?1:.85;
    artist=Math.max(artist,weight*Math.max(nameMatch(track.performer,variant),nameMatch(track.artist_handle,variant)));
    title=Math.max(title,weight*fraction(track.title,variant));combined=Math.max(combined,weight*fraction(`${track.performer} ${track.title}`,variant));
  }
  if(state.titleQuery&&fraction(track.title,state.titleQuery)<.75)return -1;
  if(!entry.global&&artist===0&&combined<.85)return -1;
  return (track.playable?1000:0)+artist*30+title*18+(title===1?5:0)+combined*12+(track.verified?3:0);
}
function addSource(state,kind,query,id=null){
  if(state.sources.some(source=>source.kind===kind&&source.query===query&&source.id===id))return;
  state.sources.push({kind,query,id,offset:0,done:false,failures:0});
}
function artistHints(state){
  const explicit=state.query.split(/\s+[—–-]\s+/);if(explicit.length>1){state.artistQuery=explicit[0];state.titleQuery=explicit.slice(1).join(' ');return [explicit[0],...state.variants];}
  const words=state.query.trim().split(/\s+/);
  return words.length>=3&&!/\s(?:и|and|i)\s/i.test(state.query)?[...state.variants,words[0]]:state.variants;
}
function collectArtists(state,users){
  for(const user of users){
    if(!user||typeof user.id!=='string'||!/^[a-zA-Z0-9]{1,128}$/.test(user.id))continue;
    const rank=Math.max(...state.hints.map(hint=>Math.max(nameMatch(user.name,hint),nameMatch(user.handle,hint))));
    if(rank>0)state.artists.set(user.id,{user,rank});
  }
}
function addCandidates(state,items,global){
  for(const track of items){
    const old=state.candidates.get(track.id);
    if(!old)state.candidates.set(track.id,{track,global,order:state.sequence++});else if(global)old.global=true;
  }
  collectArtists(state,items.filter(track=>track.artist_id).map(track=>({id:track.artist_id,name:track.performer,handle:track.artist_handle,is_verified:track.verified})));
}
async function readSource(env,state,source){
  try{
    let items,received;
    if(source.kind==='full'){
      const result=await searchFullAudius(env,{query:source.query,offset:source.offset,count:PAGE});items=result.items;received=result.received;collectArtists(state,result.users);
    }else if(source.kind==='artist'){
      const result=await artistCatalogueAudius(env,source.id,{offset:source.offset,count:PAGE});items=result.items.filter(track=>track.artist_id?track.artist_id===source.id:state.hints.some(hint=>nameMatch(track.performer,hint)>0));received=result.received;
    }else{
      const result=await searchAudius(env,{query:source.query,offset:source.offset,count:PAGE});items=result.items;received=result.received??(result.next_offset===null?items.length:result.next_offset-source.offset);
    }
    state.successes++;source.offset+=received;source.done=received<PAGE;source.failures=0;
    addCandidates(state,items,source.kind!=='artist');
    state.rows[source.kind]=(state.rows[source.kind]||0)+received;
  }catch(error){
    source.failures++;state.lastError=error;
    // Full search is optional on older deployments. Other sources stay usable.
    if(source.offset===0||source.failures>=2)source.done=true;
  }
}
async function readArtists(env,state){
  const selected=[...state.artists.values()].sort((a,b)=>b.rank-a.rank||Number(Boolean(b.user.is_verified))-Number(Boolean(a.user.is_verified))).slice(0,3);
  for(const {user}of selected)addSource(state,'artist',state.query,user.id);
  await Promise.all(state.sources.filter(source=>source.kind==='artist'&&source.offset===0&&!source.done).map(source=>readSource(env,state,source)));
}
function commitCandidates(state){
  const fresh=[...state.candidates.values()].filter(entry=>!state.seen.has(entry.track.id)).map(entry=>({entry,score:score(entry,state)})).filter(item=>item.score>=0).sort((a,b)=>b.score-a.score||a.entry.order-b.entry.order);
  for(const {entry}of fresh){if(state.items.length>=MAX_RESULTS)break;state.items.push(entry.track);state.seen.add(entry.track.id);}
  state.candidates.clear();
}
function requestEnv(env){const local=AbortSignal.timeout(7000);return {...env,AUDIUS_SEARCH_SIGNAL:env.AUDIUS_SEARCH_SIGNAL instanceof AbortSignal?AbortSignal.any([env.AUDIUS_SEARCH_SIGNAL,local]):local};}
async function initialize(env,state){
  const limited=requestEnv(env);
  addSource(state,'full',state.query);addSource(state,'legacy',state.query);
  await Promise.all([
    ...state.sources.map(source=>readSource(limited,state,source)),
    searchAudiusUsers(limited,state.titleQuery?state.hints[0]:state.query).then(users=>{collectArtists(state,users);}).catch(error=>{state.lastError=error;}),
  ]);
  await readArtists(limited,state);
  // Broaden sparse results and Cyrillic artist names; never substitute another catalogue.
  if(state.candidates.size<20||/[а-яё]/i.test(state.query)){
    for(const variant of state.variants.slice(1)){
      addSource(state,'full',variant);addSource(state,'legacy',variant);
      await Promise.all(state.sources.filter(source=>source.query===variant&&source.offset===0&&!source.done).map(source=>readSource(limited,state,source)));
    }
    await readArtists(limited,state);
  }
  if(!state.successes)throw state.lastError||new AudiusError(502,'Музыкальный сервис временно недоступен.');
  commitCandidates(state);state.initialized=true;
}
async function ensureResults(env,state,needed){
  if(state.pending){await state.pending;return ensureResults(env,state,needed);}
  if(state.initialized&&(state.items.length>=needed||state.sources.every(source=>source.done)||state.items.length>=MAX_RESULTS))return;
  state.pending=(async()=>{
    const bounded={...env,AUDIUS_SEARCH_SIGNAL:AbortSignal.timeout(20000)};
    if(!state.initialized)await initialize(bounded,state);
    for(let round=0;round<3&&state.items.length<needed&&state.items.length<MAX_RESULTS;round++){
      const sources=state.sources.filter(source=>!source.done);if(!sources.length)break;
      await Promise.all(sources.map(source=>readSource(requestEnv(bounded),state,source)));commitCandidates(state);
    }
  })();
  try{await state.pending;}finally{state.pending=null;}
}
function removeState(state){if(cache.get(state.key)===state)cache.delete(state.key);sessions.delete(state.id);}
export function clearArtistSearchCache(){cache.clear();sessions.clear();}
export async function searchCatalogueAudius(env,{query,offset=0,count=20,session=null,refresh=false}={}){
  if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(offset)||offset<0||offset>10000||!Number.isInteger(count)||count<1||count>100)throw new AudiusError(400,'Введите название трека или исполнителя (до 200 символов).');
  if(typeof refresh!=='boolean')throw new AudiusError(400,'Некорректный запрос.');
  query=query.trim().normalize('NFKC').replace(/\s+/g,' ');
  const key=JSON.stringify([env.AUDIUS_API_KEY,query.toLowerCase()]);
  for(const state of sessions.values())if(state.expires<Date.now())removeState(state);
  let state=session?sessions.get(session):(refresh?null:cache.get(key));
  if(session&&(!state||state.key!==key))throw new AudiusError(409,'Результаты устарели. Повторите поиск.');
  if(!state){
    while(sessions.size>=64)removeState(sessions.values().next().value);
    state={key,id:crypto.randomUUID(),query,variants:searchVariants(query),artists:new Map(),sources:[],candidates:new Map(),items:[],seen:new Set(),successes:0,sequence:0,rows:{},expires:Date.now()+TTL,initialized:false,pending:null};
    state.hints=artistHints(state);cache.set(key,state);sessions.set(state.id,state);
  }
  try{await ensureResults(env,state,offset+count);}catch(error){removeState(state);throw error;}
  state.expires=Date.now()+(state.items.length?TTL:15000);
  const items=state.items.slice(offset,offset+count),hasMore=offset+items.length<state.items.length||state.items.length<MAX_RESULTS&&state.sources.some(source=>!source.done);
  return {items,total_count:null,next_offset:items.length&&hasMore?offset+items.length:null,search_session:state.id,diagnostics:{variants:state.variants,rows:state.rows,artists:state.artists.size,candidates:state.items.length,partial:state.sources.some(source=>source.failures>0)}};
}
