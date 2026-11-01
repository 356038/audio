import {searchAudius} from './audius.mjs';
const cache=new Map();
export async function recommendations(env,user,store){
  const history=store.recent(user);
  if(!history.length)return {items:[],personalized:false,reason:'Послушайте несколько треков в WAVE — здесь появятся рекомендации.',history_count:0};
  const savedIds=store.ids(user);
  const fingerprint=JSON.stringify([history.map(t=>[t.id,t.played_at]),savedIds.sort()]);
  const key=`${env.AUDIUS_API_KEY}:${user}`;
  const cached=cache.get(key);
  if(cached?.fingerprint===fingerprint&&cached.expires>Date.now())return cached.result;
  const artists=new Map(),genres=new Map();
  history.forEach((track,index)=>{const weight=1/(index+1);if(track.performer)artists.set(track.performer,(artists.get(track.performer)||0)+weight);if(track.genre)genres.set(track.genre,(genres.get(track.genre)||0)+weight);});
  const artistQueries=[...artists].sort((a,b)=>b[1]-a[1]).map(([name])=>name);
  const genreQueries=[...genres].sort((a,b)=>b[1]-a[1]).map(([name])=>name);
  const queries=[...new Set([artistQueries[0],genreQueries[0]||artistQueries[1]].filter(Boolean))].slice(0,2);
  if(!queries.length)return {items:[],personalized:false,reason:'Для рекомендаций нужны треки с указанным исполнителем.',history_count:history.length};
  const results=await Promise.allSettled(queries.map(query=>searchAudius(env,{query,count:30})));
  const valid=results.filter(result=>result.status==='fulfilled');
  if(!valid.length)throw results[0].reason;
  const excluded=new Set([...history.map(t=>t.id),...savedIds]),unique=new Map();
  for(const result of valid)for(const track of result.value.items)if(track.playable&&!excluded.has(track.id))unique.set(track.id,track);
  const items=[...unique.values()].map(track=>({track,score:(artists.get(track.performer)||0)*3+(genres.get(track.genre)||0)})).sort((a,b)=>b.score-a.score).slice(0,20).map(t=>t.track);
  const result={items,personalized:true,history_count:history.length,reason:items.length?'На основе последних треков, которые играли в WAVE.':'Пока не нашли новые доступные треки по вашим предпочтениям. Попробуйте послушать других исполнителей.'};
  while(cache.size>=1000)cache.delete(cache.keys().next().value);
  cache.set(key,{fingerprint,result,expires:Date.now()+5*60000});return result;
}
