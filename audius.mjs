import https from 'node:https';
import dns from 'node:dns';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';

export class AudiusError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const API='https://api.audius.co';
const publicAgent=new https.Agent({keepAlive:true,maxSockets:16,maxFreeSockets:4,timeout:30000});
const references=new Map();
const LIMIT=20*1024*1024;
function configuration(env){
  for(const key of ['AUDIUS_API_KEY','AUDIUS_BEARER_TOKEN'])if(typeof env[key]!=='string'||!env[key]||env[key].length>8192||/[\s\x00-\x1f\x7f]/.test(env[key]))throw new AudiusError(503,'Поиск музыки ещё не подключён.');
}
export function isPublicAddress(address){
  if(isIP(address)===4){const[a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===198&&(b===18||b===19)));}
  if(isIP(address)===6){const a=address.toLowerCase();return !a.startsWith('::')&&!a.startsWith('fc')&&!a.startsWith('fd')&&!/^fe[89ab]/.test(a)&&!a.startsWith('ff')&&a!=='::1'&&!a.startsWith('2001:db8:');}
  return false;
}
function checkedUrl(raw){
  let url;try{url=new URL(raw);}catch{throw new AudiusError(502,'Сервис вернул некорректный адрес.');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hash||!url.hostname||url.href.length>12000)throw new AudiusError(502,'Сервис вернул неподдерживаемый адрес.');
  if(isIP(url.hostname.replace(/^\[|\]$/g,''))&&!isPublicAddress(url.hostname.replace(/^\[|\]$/g,'')))throw new AudiusError(502,'Неподдерживаемый адрес сервиса.');
  return url;
}
// Pin each socket to DNS-validated public addresses. The Authorization header
// is rebuilt for every hop and can never travel to a CDN host.
function publicRequest(url,headers,signal){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers,signal,agent:publicAgent,lookup(host,options,callback){
      dns.lookup(host,{all:true},(error,addresses)=>{
        if(error)return callback(error);
        if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))return callback(new Error('Non-public destination'));
        if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
      });
    }},incoming=>{
      try {
        const out=new Headers();for(const[k,v]of Object.entries(incoming.headers))if(v!==undefined)out.set(k,Array.isArray(v)?v.join(', '):v);
        const empty=[204,205,304].includes(incoming.statusCode);if(empty)incoming.resume();
        resolve(new Response(empty?null:Readable.toWeb(incoming),{status:incoming.statusCode,headers:out}));
      }catch{incoming.destroy();reject(new AudiusError(502,'Музыкальный сервис вернул некорректный ответ.'));}
    });
    req.on('error',()=>reject(new AudiusError(502,'Не удалось связаться с музыкальным сервисом.')));
  });
}
export async function audiusFetch(raw,options={},env={}){
  configuration(env);let url=checkedUrl(raw);
  const expectAudio=url.origin===API&&/^\/v1\/tracks\/[a-zA-Z0-9]+\/stream$/.test(url.pathname);
  const signal=options.signal||AbortSignal.timeout(30000);
  for(let hop=0;hop<6;hop++){
    const headers=new Headers(options.headers);headers.delete('Authorization');headers.delete('Cookie');headers.set('User-Agent','WAVE/1.0');headers.set('Accept-Encoding','identity');
    if(url.origin===API)headers.set('Authorization',`Bearer ${env.AUDIUS_BEARER_TOKEN}`);
    const request=env.AUDIUS_HTTP||publicRequest;
    const response=await request(url,Object.fromEntries(headers),signal);
    if(![301,302,303,307,308].includes(response.status)) {
      const mime=(response.headers.get('Content-Type')||'').split(';')[0].toLowerCase();
      if(expectAudio&&[200,206].includes(response.status)&&['text/html','application/json','application/vnd.apple.mpegurl','application/x-mpegurl'].includes(mime)) {
        await response.body?.cancel();throw new AudiusError(409,'Сервис не предоставил поддерживаемый аудиопоток.');
      }
      return response;
    }
    const location=response.headers.get('Location');await response.body?.cancel();
    if(!location)throw new AudiusError(502,'Не удалось получить аудиофайл.');
    url=checkedUrl(new URL(location,url).href);
  }
  throw new AudiusError(502,'Слишком много перенаправлений аудиофайла.');
}
function apiUrl(env,path,params={}){const url=new URL(API+'/v1'+path);url.search=new URLSearchParams({app_name:'WAVE',api_key:env.AUDIUS_API_KEY,...params});return url.href;}
function upstreamError(status){
  if([401,403].includes(status))return new AudiusError(503,'Музыкальный сервис отклонил подключение. Нужно проверить ключи и доступ.');
  if(status===429)return new AudiusError(429,'Достигнут лимит поиска. Попробуйте немного позже.');
  return new AudiusError(502,'Музыкальный сервис временно недоступен.');
}
async function dataResult(env,path,params){
  configuration(env);
  const response=await audiusFetch(apiUrl(env,path,params),{signal:env.AUDIUS_SEARCH_SIGNAL instanceof AbortSignal?env.AUDIUS_SEARCH_SIGNAL:undefined},env);
  if(!response.ok){await response.body?.cancel();throw upstreamError(response.status);}
  let result;try{const raw=await response.text();if(raw.length>2*1024*1024)throw Error();result=JSON.parse(raw);}catch{throw new AudiusError(502,'Не удалось прочитать результаты поиска.');}
  if(!result||typeof result!=='object')throw new AudiusError(502,'Сервис вернул некорректные результаты.');
  return result;
}
async function dataList(env,path,params){
  const result=await dataResult(env,path,params);
  if(!Array.isArray(result.data))throw new AudiusError(502,'Сервис вернул некорректные результаты.');
  return result;
}
function normalizeTracks(data,count){
  return data.slice(0,count).filter(t=>t&&typeof t.id==='string'&&/^[a-zA-Z0-9]+$/.test(t.id)).map(t=>{
    const gated=Boolean(t.is_stream_gated),playable=!gated&&t.is_streamable!==false;
    let artwork=null;for(const key of ['480x480','150x150','1000x1000']){try{if(t.artwork?.[key]){artwork=checkedUrl(t.artwork[key]).href;break;}}catch{}}
    const tags=typeof t.tags==='string'?[...new Set(t.tags.split(',').map(tag=>tag.trim().toLowerCase().slice(0,64)).filter(Boolean))].slice(0,20):[];
    return {id:'audius:'+t.id,track_id:t.id,artist_id:typeof t.user?.id==='string'?t.user.id:null,artist_handle:typeof t.user?.handle==='string'?t.user.handle:'',verified:Boolean(t.user?.is_verified),title:typeof t.title==='string'?t.title.slice(0,1000):'Без названия',performer:typeof t.user?.name==='string'?t.user.name.slice(0,1000):'',genre:typeof t.genre==='string'?t.genre.slice(0,100):'',mood:typeof t.mood==='string'?t.mood.slice(0,100):'',tags,bpm:Number.isFinite(t.bpm)&&t.bpm>=30&&t.bpm<=300?t.bpm:null,duration:Number.isFinite(t.duration)?Math.max(0,t.duration):0,playable,unavailable_reason:playable?null:gated?'Трек требует отдельного доступа в Audius.':'Трек недоступен для воспроизведения.',artwork_url:artwork,mime:'audio/mpeg'};
  });
}
async function trackList(env,path,params,count){
  const result=await dataList(env,path,params);
  const items=normalizeTracks(result.data,count);
  const total=Number.isSafeInteger(result.total)?result.total:Number.isSafeInteger(result.count)?result.count:null;
  return {items,total_count:total,received:result.data.length};
}
export async function searchAudius(env,{query,offset=0,count=20}={}){
  configuration(env);
  if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(offset)||offset<0||offset>10000)throw new AudiusError(400,'Введите название трека или исполнителя (до 200 символов).');
  const result=await trackList(env,'/tracks/search',{query:query.trim(),limit:String(count),offset:String(offset)},count);
  return {items:result.items,total_count:result.total_count,received:result.received,next_offset:result.received>=count?offset+result.received:null};
}
export async function searchFullAudius(env,{query,offset=0,count=40}){
  const result=await dataResult(env,'/search/full',{query,kind:'all',sort_method:'relevant',limit:String(count),offset:String(offset)});
  if(!Array.isArray(result.data?.tracks))throw new AudiusError(502,'Сервис вернул некорректные результаты.');
  return {items:normalizeTracks(result.data.tracks,count),users:Array.isArray(result.data.users)?result.data.users:[],received:result.data.tracks.length};
}
export async function searchAudiusUsers(env,query){return (await dataList(env,'/users/search',{query,limit:'15'})).data;}
export async function artistCatalogueAudius(env,id,{offset=0,count=40}={}){
  if(typeof id!=='string'||!/^[a-zA-Z0-9]{1,128}$/.test(id))throw new AudiusError(400,'Некорректный запрос.');
  return trackList(env,`/users/${id}/tracks`,{limit:String(count),offset:String(offset)},count);
}
export async function genreAudius(env,genre,count=40,offset=0){
  if(typeof genre!=='string'||!genre.trim()||genre.length>100)throw new AudiusError(400,'Некорректный жанр.');
  // Official genre-filtered discovery, not a free-text query containing the genre.
  return (await trackList(env,'/tracks/trending',{genre:genre.trim(),time:'week',limit:String(count),offset:String(offset)},count)).items;
}
export function registerAudiusTrack(user,track,env){
  const now=Date.now();for(const[id,r]of references)if(r.exp<=now)references.delete(id);
  while(references.size>=4000)references.delete(references.keys().next().value);
  const id=crypto.randomUUID();references.set(id,{user,track,key:env.AUDIUS_API_KEY,exp:now+2*3600*1000});return id;
}
export function describeAudiusTrack(user,ticket,env){
  const ref=references.get(ticket.file);
  if(!ref||ref.user!==user||ref.key!==env.AUDIUS_API_KEY||ref.exp<=Date.now())throw new AudiusError(401,'Результаты устарели. Повторите поиск.');
  return {...ref.track,source:'audius'};
}
export async function serveAudiusMedia(request,env,ticket){
  configuration(env);const resource=references.get(ticket.file);
  if(!resource||resource.user!==ticket.user||resource.key!==env.AUDIUS_API_KEY||resource.exp<=Date.now())throw new AudiusError(401,'Результаты устарели. Повторите поиск.');
  const path=new URL(request.url).pathname,artwork=path==='/api/artwork',prepare=path==='/api/prepare';
  if((ticket.type||'audio')!==(artwork?'artwork':'audio'))throw new AudiusError(401,'Недействительная ссылка.');
  const track=resource.track,range=request.headers.get('Range');
  if(range&&(!/^bytes=\d*-\d*$/.test(range)||range==='bytes=-'))throw new AudiusError(416,'Некорректный диапазон.');
  if(!artwork&&!track.playable)throw new AudiusError(409,track.unavailable_reason);
  const url=artwork?track.artwork_url:apiUrl(env,`/tracks/${track.track_id}/stream`);
  if(!url)throw new AudiusError(404,'Обложка недоступна.');
  const cache=artwork?null:env.AUDIO_CACHE,key=`audius:${resource.key}:${track.track_id}`;
  const stamp=response=>{const mime=response.headers.get('Content-Type')||'';response.headers.set('Content-Type',artwork?(['image/jpeg','image/png','image/webp'].includes(mime)?mime:'image/jpeg'):mime.startsWith('audio/')?mime:'audio/mpeg');response.headers.set('X-Accel-Buffering','no');return response;};
  if(prepare){try{return Response.json(cache?await cache.prepare(key,url):{ready:false,downloading:false});}catch{return Response.json({ready:false,downloading:false});}}
  if(cache){try{const existing=await cache.responseIfPresent(key,range);if(existing)return stamp(existing);return stamp(await cache.stream(key,url,undefined,range));}catch{/* keep direct stream fallback */}}
  const response=await audiusFetch(url,{headers:range?{Range:range}:{},signal:AbortSignal.timeout(30000)},env);
  if(![200,206,416].includes(response.status)){await response.body?.cancel();throw upstreamError(response.status);}
  const maximum=artwork?1024*1024:LIMIT;
  const total=Number(response.headers.get('Content-Range')?.split('/')[1])||Number(response.headers.get('Content-Length'));
  if(total>maximum){await response.body?.cancel();throw new AudiusError(413,'Этот файл превышает лимит плеера.');}
  const reader=response.body?.getReader();let bytes=0;
  const body=reader?new ReadableStream({async pull(controller){try{const item=await reader.read();if(item.done){controller.close();return;}bytes+=item.value.length;if(bytes>maximum){await reader.cancel();throw Error();}controller.enqueue(item.value);}catch{controller.error(new Error('Загрузка аудио прервалась.'));}},cancel(){return reader.cancel();}}):null;
  const headers=new Headers();for(const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges'])if(response.headers.has(name))headers.set(name,response.headers.get(name));headers.set('X-Wave-Cache','BYPASS');
  return stamp(new Response(body,{status:response.status,headers}));
}
