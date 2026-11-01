import {searchAudius,genreAudius} from './audius.mjs';
const cache=new Map();
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
export async function recommendations(env,user,store){
  const history=store.recent(user);
  if(!history.length)return {items:[],personalized:false,reason:'Послушайте несколько треков в WAVE — здесь появятся рекомендации.',history_count:0};
  const savedIds=store.ids(user);
  const fingerprint=JSON.stringify([history,savedIds.sort()]);
  const key=`${env.AUDIUS_API_KEY}:${user}`,cached=cache.get(key);
  if(cached?.fingerprint===fingerprint&&cached.expires>Date.now())return cached.result;
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
  const requests=topGenres.map(genre=>genreAudius(env,genre.name));
  // Artist results are still checked against the actual artist field below.
  for(const artist of topArtists.slice(0,3-requests.length))requests.push(searchAudius(env,{query:artist.name,count:40}).then(result=>result.items));
  if(!requests.length)return {items:[],personalized:false,reason:'Для рекомендаций пока недостаточно данных об исполнителях и жанрах.',history_count:history.length};
  const results=await Promise.allSettled(requests),valid=results.filter(result=>result.status==='fulfilled');
  if(!valid.length)throw results[0].reason;
  const excluded=new Set([...history.map(t=>t.id),...savedIds]),unique=new Map();
  for(const result of valid)for(const track of result.value)if(track.playable&&!excluded.has(track.id))unique.set(track.id,track);
  const ranked=[...unique.values()].map(track=>{
    const artist=artists.get(normalized(track.performer));
    const style=history.reduce((score,previous,index)=>Math.max(score,styleSimilarity(track,previous)/Math.sqrt(index+1)),0);
    return {track,score:style+(artist?Math.min(artist.weight,2)*.7:0)};
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.track.id.localeCompare(b.track.id));
  const items=mixTracks(ranked,artists),hasStyles=topGenres.length>0;
  const result={items,personalized:true,history_count:history.length,reason:!items.length?'Пока не нашли новые доступные треки по вашим предпочтениям. Попробуйте послушать других исполнителей.':hasStyles?'Знакомые исполнители и похожие жанры. Настроение, теги и темп учитываются, когда они указаны.':'Пока по знакомым исполнителям: у прослушанных треков не указан жанр.'};
  while(cache.size>=1000)cache.delete(cache.keys().next().value);
  cache.set(key,{fingerprint,result,expires:Date.now()+5*60000});return result;
}
