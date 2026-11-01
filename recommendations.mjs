import {searchAudius,genreAudius,AudiusError} from './audius.mjs';
const cache=new Map(),feeds=new Map();
const FEED_TTL=12*3600000;
const normalized=value=>typeof value==='string'?value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim():'';
const tagSet=track=>new Set((Array.isArray(track.tags)?track.tags:[]).map(normalized).filter(Boolean));

// Titles intentionally never participate in taste matching or ranking.
export function styleSimilarity(track,previous){
  const genre=normalized(track.genre),mood=normalized(track.mood);
  if(!genre||genre!==normalized(previous.genre))return 0;
  let score=6;
  if(mood&&mood===normalized(previous.mood))score+=2;
  const tags=tagSet(track),other=tagSet(previous);
  const common=[...tags].filter(tag=>other.has(tag)).length;
  if(common)score+=2*common/new Set([...tags,...other]).size;
  if(Number.isFinite(track.bpm)&&track.bpm>0&&Number.isFinite(previous.bpm)&&previous.bpm>0){
    score+=Math.max(0,1-Math.abs(track.bpm-previous.bpm)/(previous.bpm*.2));
  }
  return score;
}
function mixTracks(ranked,artists){
  const selected=[],counts=new Map(),seen=new Set();
  function add(track){
    const artist=normalized(track.performer)||track.id;
    if(seen.has(track.id)||(counts.get(artist)||0)>=3)return;
    selected.push(track);seen.add(track.id);counts.set(artist,(counts.get(artist)||0)+1);
  }
  const familiar=ranked.filter(item=>artists.has(normalized(item.track.performer)));
  const discovery=ranked.filter(item=>!artists.has(normalized(item.track.performer)));
  // Reserve space for familiar artists, then alternate them with discoveries.
  while(selected.length<20&&(familiar.length||discovery.length)){
    const pool=selected.length%4===0&&familiar.length?familiar:discovery.length?discovery:familiar;
    add(pool.shift().track);
  }
  return selected;
}
function rankedTracks(feed,store){
  const excluded=new Set([...store.ids(feed.user),...store.recent(feed.user).map(track=>track.id),...feed.seen]);
  const ranked=[];
  for(const [id,track]of feed.pending){
    if(excluded.has(id)){feed.pending.delete(id);continue;}
    const artist=feed.artists.get(normalized(track.performer));
    const style=feed.history.reduce((score,previous,index)=>Math.max(score,styleSimilarity(track,previous)/Math.sqrt(index+1)),0);
    const score=style+(artist?Math.min(artist.weight,2)*.7:0);
    if(score>0)ranked.push({track,score});else feed.pending.delete(id);
  }
  return ranked.sort((a,b)=>b.score-a.score||a.track.id.localeCompare(b.track.id));
}
async function generatePage(env,feed,store,page){
  let ranked=rankedTracks(feed,store);
  for(let round=0;round<2&&mixTracks(ranked,feed.artists).length<20;round++){
    const sources=feed.sources.filter(source=>!source.done);if(!sources.length)break;
    const results=await Promise.allSettled(sources.map(async source=>{
      const items=source.kind==='genre'?await genreAudius(env,source.name,40,source.offset):(await searchAudius(env,{query:source.name,count:40,offset:source.offset})).items;
      source.offset+=40;source.done=items.length<40;
      for(const track of items)if(track.playable&&!feed.seen.has(track.id))feed.pending.set(track.id,track);
    }));
    if(!ranked.length&&results.every(result=>result.status==='rejected'))throw results[0].reason;
    ranked=rankedTracks(feed,store);
  }
  const items=mixTracks(ranked,feed.artists);
  for(const track of items){feed.seen.add(track.id);feed.pending.delete(track.id);}
  const hasMore=items.length>0&&(feed.pending.size>0||feed.sources.some(source=>!source.done));
  const result={items,personalized:true,history_count:feed.history.length,feed_id:feed.id,next_cursor:hasMore?`${feed.id}:${page+1}`:null,reason:!items.length?'Пока не нашли новые доступные треки по вашим предпочтениям. Попробуйте послушать других исполнителей.':feed.hasStyles?'Знакомые исполнители и похожие жанры. Настроение, теги и темп учитываются, когда они указаны.':'Пока по знакомым исполнителям: у прослушанных треков не указан жанр.'};
  feed.pages.set(page,result);feed.generated=page;feed.expires=Date.now()+FEED_TTL;
  while(feed.pages.size>3)feed.pages.delete(feed.pages.keys().next().value);
  return result;
}
async function feedPage(env,feed,store,page){
  if(feed.pages.has(page))return feed.pages.get(page);
  if(feed.loading){await feed.loading;return feedPage(env,feed,store,page);}
  if(page!==feed.generated+1)throw new AudiusError(400,'Обновите коллекцию и попробуйте снова.');
  feed.loading=generatePage(env,feed,store,page);
  try{return await feed.loading;}finally{feed.loading=null;}
}
export async function recommendations(env,user,store,{cursor=null,refresh=false,previousFeed=null,exclude=[]}={}){
  if(cursor!==null&&cursor!==0){
    if(typeof cursor!=='string'||!/^[-a-f0-9]{36}:\d{1,6}$/.test(cursor))throw new AudiusError(400,'Некорректная страница.');
    const [id,index]=cursor.split(':'),feed=feeds.get(id);
    if(!feed||feed.user!==user||feed.key!==env.AUDIUS_API_KEY||feed.expires<Date.now())throw new AudiusError(401,'Обновите коллекцию и попробуйте снова.');
    return feedPage(env,feed,store,Number(index));
  }
  if(typeof refresh!=='boolean'||!Array.isArray(exclude)||exclude.length>300||exclude.some(id=>typeof id!=='string'||id.length>128))throw new AudiusError(400,'Некорректная страница.');
  const previous=refresh&&typeof previousFeed==='string'?feeds.get(previousFeed):null;
  if(previous&&(previous.user!==user||previous.key!==env.AUDIUS_API_KEY))throw new AudiusError(403,'Нет доступа к этой композиции.');
  const history=store.recent(user);
  if(!history.length)return {items:[],personalized:false,reason:'Послушайте несколько треков в WAVE — здесь появятся рекомендации.',history_count:0,next_cursor:null};
  const fingerprint=JSON.stringify([history,store.ids(user).sort()]);
  const key=`${env.AUDIUS_API_KEY}:${user}`,cached=cache.get(key);
  if(!refresh&&cached?.fingerprint===fingerprint&&cached.expires>Date.now()&&feeds.get(cached.id)?.generated===0)return cached.result;
  const artists=new Map(),genres=new Map();
  history.forEach((track,index)=>{
    const weight=1/Math.sqrt(index+1);
    for(const [map,value]of [[artists,track.performer],[genres,track.genre]]){
      const id=normalized(value);if(!id)continue;
      const current=map.get(id)||{name:value,weight:0};current.weight+=weight;map.set(id,current);
    }
  });
  const topArtists=[...artists.values()].sort((a,b)=>b.weight-a.weight);
  const topGenres=[...genres.values()].sort((a,b)=>b.weight-a.weight).slice(0,2);
  const sources=topGenres.map(genre=>({kind:'genre',name:genre.name,offset:0,done:false}));
  for(const artist of topArtists.slice(0,3-sources.length))sources.push({kind:'artist',name:artist.name,offset:0,done:false});
  if(!sources.length)return {items:[],personalized:false,reason:'Для рекомендаций пока недостаточно данных об исполнителях и жанрах.',history_count:history.length,next_cursor:null};
  if(previous)for(const source of sources){const old=previous.sources.find(item=>item.kind===source.kind&&normalized(item.name)===normalized(source.name));if(old){source.offset=old.offset;source.done=old.done;}}
  const feed={id:crypto.randomUUID(),key:env.AUDIUS_API_KEY,user,history,artists,hasStyles:topGenres.length>0,sources,seen:new Set([...(previous?.seen||[]),...(refresh?exclude:[])]),pending:new Map(previous?.pending||[]),pages:new Map(),generated:-1,expires:Date.now()+FEED_TTL,loading:null};
  for(const [id,value]of feeds)if(value.expires<Date.now())feeds.delete(id);
  while(feeds.size>=500)feeds.delete(feeds.keys().next().value);
  feeds.set(feed.id,feed);
  const result=await feedPage(env,feed,store,0);
  while(cache.size>=500)cache.delete(cache.keys().next().value);
  cache.set(key,{fingerprint,id:feed.id,result,expires:Date.now()+5*60000});return result;
}
