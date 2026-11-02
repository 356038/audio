// Telegram API service. BOT_TOKEN is a server secret, never a browser setting.
import {AudiusError,registerAudiusTrack,serveAudiusMedia,describeAudiusTrack} from './audius.mjs';
import {searchCatalogueAudius} from './catalogue-search.mjs';
import {trackVersions} from './track-versions.mjs';
import {recommendations} from './recommendations.mjs';
const encoder = new TextEncoder();
const MAX_FILE = 20 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const fileCache = new Map();
const FILE_TTL = 15 * 60 * 1000;
const CACHE_LIMIT = 400;
const profileDescriptors=new Map(),avatarFiles=new Map();

// Cache only Telegram file metadata, not private audio bytes. A bot token change
// creates a separate namespace; simultaneous Range requests share one lookup.
export function clearFileCache() { fileCache.clear();avatarFiles.clear(); }
async function getFile(env, fileId) {
  const cacheKey = `${env.BOT_TOKEN}:${fileId}`;
  const cached = fileCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const entry = {expires: Date.now()+FILE_TTL};
  entry.pending = telegram(env, 'getFile', {file_id: fileId}).catch(error => {
    if (fileCache.get(cacheKey) === entry) fileCache.delete(cacheKey);
    throw error;
  });
  fileCache.delete(cacheKey);
  fileCache.set(cacheKey, entry);
  while (fileCache.size > CACHE_LIMIT) fileCache.delete(fileCache.keys().next().value);
  return entry.pending;
}

async function profileAvatarFile(env,user){
  const cacheKey=`${env.BOT_TOKEN}:${user}`,cached=avatarFiles.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.pending;
  const entry={expires:Date.now()+10*60000};
  entry.pending=telegram(env,'getUserProfilePhotos',{user_id:user,offset:0,limit:1}).then(result=>{
    const sizes=Array.isArray(result.photos?.[0])?result.photos[0]:[];
    const photo=sizes.filter(item=>typeof item.file_id==='string'&&(!item.file_size||item.file_size<=1024*1024)).sort((a,b)=>Math.abs(Math.max(a.width||0,a.height||0)-160)-Math.abs(Math.max(b.width||0,b.height||0)-160))[0];
    if(!photo)entry.expires=Date.now()+60000;
    return photo?.file_id||null;
  }).catch(error=>{if(avatarFiles.get(cacheKey)===entry)avatarFiles.delete(cacheKey);throw error;});
  while(avatarFiles.size>=400)avatarFiles.delete(avatarFiles.keys().next().value);
  avatarFiles.set(cacheKey,entry);return entry.pending;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function key(secret, usages) {
  return crypto.subtle.importKey('raw', typeof secret === 'string' ? encoder.encode(secret) : secret,
    {name: 'HMAC', hash: 'SHA-256'}, false, usages);
}
async function sign(secret, value) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), encoder.encode(value)));
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const base64 = value => btoa(String.fromCharCode(...encoder.encode(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unbase64 = value => new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4-value.length%4)%4)), c => c.charCodeAt(0)));
function bytesFromHex(value) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new ApiError(401, 'Недействительная подпись. Откройте приложение заново.');
  return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
}

export async function authenticate(initData, token) {
  if (typeof initData !== 'string' || initData.length > 16384) throw new ApiError(401, 'Откройте WAVE кнопкой приложения в Telegram.');
  const params = new URLSearchParams(initData);
  if ([...params.keys()].length !== new Set(params.keys()).size) throw new ApiError(401, 'Некорректная авторизация.');
  const hash = bytesFromHex(params.get('hash') || '');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = await sign('WebAppData', token);
  if (!await crypto.subtle.verify('HMAC', await key(secret, ['verify']), hash, encoder.encode(check))) {
    throw new ApiError(401, 'Подпись Telegram не прошла проверку.');
  }
  const date = Number(params.get('auth_date'));
  if (!Number.isInteger(date) || date < now()-3600 || date > now()+30) throw new ApiError(401, 'Сессия истекла. Закройте и заново откройте WAVE.');
  let user;
  try { user = JSON.parse(params.get('user')); } catch { /* rejected below */ }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new ApiError(401, 'Не удалось определить пользователя.');
  return user;
}

async function telegram(env, method, body) {
  let response, data;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    data = await response.json();
  } catch { throw new ApiError(502, 'Telegram временно недоступен. Попробуйте ещё раз.'); }
  if (!response.ok || !data.ok) {
    if (data.error_code === 429) throw new ApiError(429, 'Слишком много запросов. Подождите немного.');
    if (method === 'getFile' && /too big/i.test(data.description || '')) throw new ApiError(413, 'Этот файл превышает лимит скачивания Telegram Bot API.');
    throw new ApiError(502, method === 'getUserProfileAudios'
      ? 'Telegram не вернул музыку профиля. Нажмите Start у бота, проверьте доступность музыки профиля и попробуйте снова.'
      : 'Не удалось получить аудиофайл из Telegram.');
  }
  return data.result;
}

async function ticketFor(env, userId, audio, type = 'audio', source = 'telegram') {
  const payload = base64(JSON.stringify({user: userId, file: audio.file_id, type,
    source, mime: type==='audio' ? audioMime(audio.mime_type,audio.file_name) : null, exp: now()+7200}));
  return `${payload}.${hex(await sign(env.BOT_TOKEN, `wave-stream:${payload}`))}`;
}
function audioMime(value,path='') {
  const aliases={'audio/mpeg':'audio/mpeg','audio/mp3':'audio/mpeg','audio/x-mp3':'audio/mpeg',
    'audio/mp4':'audio/mp4','audio/m4a':'audio/mp4','audio/x-m4a':'audio/mp4',
    'audio/aac':'audio/aac','audio/ogg':'audio/ogg','application/ogg':'audio/ogg',
    'audio/flac':'audio/flac','audio/x-flac':'audio/flac','audio/wav':'audio/wav','audio/x-wav':'audio/wav'};
  const mime=typeof value==='string'?value.split(';')[0].trim().toLowerCase():'';
  const extension=typeof path==='string'?path.split('.').pop().toLowerCase():'';
  const extensions={mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',aac:'audio/aac',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',flac:'audio/flac',wav:'audio/wav'};
  return Object.hasOwn(aliases,mime)?aliases[mime]:Object.hasOwn(extensions,extension)?extensions[extension]:null;
}
function correctAudioType(response,ticket,path='') {
  const mime=audioMime(ticket.mime)||audioMime(response.headers.get('Content-Type'),path);
  if(mime)response.headers.set('Content-Type',mime);
  return response;
}
async function readTicket(env, value) {
  if (!value || value.length > 4096) throw new ApiError(401, 'Ссылка воспроизведения недействительна.');
  const [payload, signature, extra] = value.split('.');
  if (extra || !payload) throw new ApiError(401, 'Ссылка воспроизведения недействительна.');
  const valid = await crypto.subtle.verify('HMAC', await key(env.BOT_TOKEN, ['verify']), bytesFromHex(signature || ''), encoder.encode(`wave-stream:${payload}`));
  if (!valid) throw new ApiError(401, 'Ссылка воспроизведения недействительна.');
  let data;
  try { data = JSON.parse(unbase64(payload)); } catch { throw new ApiError(401, 'Некорректная ссылка.'); }
  if (!Number.isSafeInteger(data.user) || typeof data.file !== 'string' || !data.file || !Number.isInteger(data.exp) || data.exp <= now()) {
    throw new ApiError(401, 'Ссылка истекла. Обновите список музыки.');
  }
  return data;
}

async function presentTrack(env,user,item,origin){
  const saved=Boolean(env.PERSONAL_STORE?.has(user,item.id));
  if(item.source==='audius'||item.track_id){
    const reference=registerAudiusTrack(user,item,env),audio={file_id:reference,mime_type:item.mime};
    return {id:item.id,source:'audius',title:item.title,performer:item.performer,duration:item.duration,saved,version_labels:trackVersions(item),
      playable:item.playable,unavailable_reason:item.unavailable_reason,
      stream_url:item.playable?`${origin}/api/stream?ticket=${encodeURIComponent(await ticketFor(env,user,audio,'audio','audius'))}`:null,
      artwork_url:item.artwork_url?`${origin}/api/artwork?ticket=${encodeURIComponent(await ticketFor(env,user,audio,'artwork','audius'))}`:null};
  }
  const key=`${env.BOT_TOKEN}:${user}:${item.file_id}`;
  while(profileDescriptors.size>=6000)profileDescriptors.delete(profileDescriptors.keys().next().value);
  profileDescriptors.set(key,{item,expires:Date.now()+7200000});
  const audio={file_id:item.file_id,mime_type:item.mime};
  return {id:item.id,source:'telegram',title:item.title,performer:item.performer,duration:item.duration,saved,playable:item.playable,
    stream_url:item.playable?`${origin}/api/stream?ticket=${encodeURIComponent(await ticketFor(env,user,audio))}`:null,
    artwork_url:item.thumbnail_file_id?`${origin}/api/artwork?ticket=${encodeURIComponent(await ticketFor(env,user,{file_id:item.thumbnail_file_id},'artwork'))}`:null};
}
async function descriptorFromRequest(env,user,raw,origin){
  let link;try{link=new URL(raw);}catch{throw new ApiError(400,'Выберите композицию заново.');}
  if(link.origin!==origin||link.pathname!=='/api/stream')throw new ApiError(400,'Недействительная ссылка трека.');
  const ticket=await readTicket(env,link.searchParams.get('ticket'));
  if(ticket.user!==user||ticket.type!=='audio')throw new ApiError(403,'Нет доступа к этой композиции.');
  if(ticket.source==='audius')return describeAudiusTrack(user,ticket,env);
  if(ticket.source&&ticket.source!=='telegram')throw new ApiError(400,'Неизвестный источник.');
  const ref=profileDescriptors.get(`${env.BOT_TOKEN}:${user}:${ticket.file}`);
  if(!ref||ref.expires<Date.now())throw new ApiError(401,'Обновите коллекцию и попробуйте снова.');
  return ref.item;
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ok: true, configured: Boolean(env.BOT_TOKEN)});
  if (!env.BOT_TOKEN) throw new ApiError(503, 'Сервис музыки ещё не подключён.');
  if(['/api/library','/api/library/save','/api/history','/api/recommendations','/api/account'].includes(url.pathname)&&request.method==='POST'){
    const text=await request.text();if(text.length>20000)throw new ApiError(413,'Слишком большой запрос.');
    let body;try{body=JSON.parse(text);}catch{throw new ApiError(400,'Некорректный запрос.');}
    const user=await authenticate(body?.init_data,env.BOT_TOKEN),store=env.PERSONAL_STORE;
    if(!store)throw new ApiError(503,'Личная библиотека пока недоступна.');
    if(url.pathname==='/api/account'){
      const text=value=>typeof value==='string'?value.slice(0,200):'';
      return Response.json({user:{id:user.id,first_name:text(user.first_name),last_name:text(user.last_name),username:text(user.username)},saved_count:store.count(user.id),avatar_url:`${url.origin}/api/avatar?ticket=${encodeURIComponent(await ticketFor(env,user.id,{file_id:String(user.id)},'avatar'))}`});
    }
    if(url.pathname==='/api/library'){
      const offset=body.offset??0;if(!Number.isInteger(offset)||offset<0||offset>100000)throw new ApiError(400,'Некорректная страница.');
      const items=store.list(user.id,offset),total=store.count(user.id);
      return Response.json({tracks:await Promise.all(items.map(item=>presentTrack(env,user.id,item,url.origin))),saved_ids:store.ids(user.id),total_count:total,next_offset:offset+items.length<total?offset+items.length:null});
    }
    if(url.pathname==='/api/recommendations'){
      const result=await recommendations(env,user.id,store,{cursor:body.offset??null,refresh:body.refresh??false,previousFeed:body.previous_feed??null,exclude:body.exclude_ids??[]});
      return Response.json({tracks:await Promise.all(result.items.map(item=>presentTrack(env,user.id,item,url.origin))),total_count:null,next_offset:result.next_cursor,feed_id:result.feed_id??null,reason:result.reason,personalized:result.personalized,history_count:result.history_count});
    }
    const item=await descriptorFromRequest(env,user.id,body.stream_url,url.origin);
    if(url.pathname==='/api/library/save'){
      if(typeof body.saved!=='boolean')throw new ApiError(400,'Укажите действие сохранения.');
      store.save(user.id,item,body.saved);return Response.json({id:item.id,saved:body.saved});
    }
    if(typeof body.play_id!=='string'||!/^[-a-z0-9]{16,80}$/i.test(body.play_id)||!Number.isFinite(body.seconds)||body.seconds<0||body.seconds>86400)throw new ApiError(400,'Некорректное событие воспроизведения.');
    const minimum=item.duration>0?Math.min(15,item.duration/2):15;
    const recorded=body.seconds>=minimum&&store.record(user.id,item,body.play_id,Math.min(body.seconds,item.duration||86400));
    return Response.json({recorded:Boolean(recorded)});
  }
  if(url.pathname==='/api/search'&&request.method==='POST') {
    const text=await request.text();if(text.length>20000)throw new ApiError(413,'Слишком большой запрос.');
    let body;try{body=JSON.parse(text);}catch{throw new ApiError(400,'Некорректный запрос.');}
    const user=await authenticate(body?.init_data,env.BOT_TOKEN);
    const result=await searchCatalogueAudius(env,{query:body.query,offset:body.offset??0,count:20,session:body.search_session??null,refresh:body.refresh??false});
    const tracks=await Promise.all(result.items.map(item=>presentTrack(env,user.id,item,url.origin)));
    return Response.json({tracks,total_count:result.total_count,next_offset:result.next_offset,search_session:result.search_session});
  }
  if (url.pathname === '/api/profile-audios' && request.method === 'POST') {
    const bodyText = await request.text();
    if (bodyText.length > 20000) throw new ApiError(413, 'Слишком большой запрос.');
    let body;
    try { body = JSON.parse(bodyText); } catch { throw new ApiError(400, 'Некорректный запрос.'); }
    const user = await authenticate(body?.init_data, env.BOT_TOKEN);
    const offset = body.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'Некорректная страница.');
    // Always use the authenticated identity; never accept a client-supplied user_id.
    const result = await telegram(env, 'getUserProfileAudios', {user_id: user.id, offset, limit: 100});
    if (!Array.isArray(result?.audios) || !Number.isInteger(result.total_count)) throw new ApiError(502, 'Неожиданный ответ Telegram.');
    const tracks = await Promise.all(result.audios.map(audio=>presentTrack(env,user.id,{
      id:audio.file_unique_id,source:'telegram',file_id:audio.file_id,mime:audioMime(audio.mime_type,audio.file_name),
      title:audio.title||audio.file_name||'Без названия',performer:audio.performer||'',duration:audio.duration||0,
      playable:!audio.file_size||audio.file_size<=MAX_FILE,thumbnail_file_id:audio.thumbnail?.file_id||null,
    },url.origin)));
    return Response.json({tracks, total_count: result.total_count,
      next_offset: tracks.length && offset+tracks.length < result.total_count ? offset+tracks.length : null});
  }
  if(url.pathname==='/api/avatar'&&request.method==='GET'){
    const ticket=await readTicket(env,url.searchParams.get('ticket'));
    if(ticket.type!=='avatar'||ticket.source!=='telegram'||ticket.file!==String(ticket.user))throw new ApiError(401,'Ссылка не подходит для этого файла.');
    const file=await profileAvatarFile(env,ticket.user);
    if(!file)throw new ApiError(404,'Аватар недоступен.');
    return route(new Request(`${url.origin}/api/artwork?ticket=${encodeURIComponent(await ticketFor(env,ticket.user,{file_id:file},'artwork'))}`),env);
  }
  if (['/api/stream', '/api/artwork', '/api/prepare'].includes(url.pathname) && request.method === 'GET') {
    const prepare = url.pathname === '/api/prepare';
    const artwork = url.pathname === '/api/artwork';
    const ticket = await readTicket(env, url.searchParams.get('ticket'));
    if(ticket.source==='audius')return serveAudiusMedia(request,env,ticket);
    if(ticket.source&&ticket.source!=='telegram')throw new ApiError(410,'Источник больше не поддерживается.');
    if ((ticket.type || 'audio') !== (artwork ? 'artwork' : 'audio')) throw new ApiError(401, 'Ссылка не подходит для этого файла.');
    const audioCache = artwork ? null : env.AUDIO_CACHE;
    const cacheKey = `${env.BOT_TOKEN}:${ticket.file}`;
    const range = request.headers.get('Range');
    if (!prepare && audioCache) {
      const started=performance.now();
      try {
        const cached=await audioCache.responseIfPresent(cacheKey,range);
        if(cached) {
          cached.headers.set('Server-Timing',`telegram_file;dur=0, cache_headers;dur=${(performance.now()-started).toFixed(1)}`);
          cached.headers.set('X-Accel-Buffering','no');
          return correctAudioType(cached,ticket);
        }
      }catch{/* A cache failure falls back to the authenticated Telegram route. */}
    }
    const lookupStart = performance.now();
    const file = await getFile(env, ticket.file);
    const lookupMs = performance.now()-lookupStart;
    if (file.file_size > (artwork ? 1024 * 1024 : MAX_FILE)) throw new ApiError(413, 'Файл превышает лимит загрузки.');
    if (typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.includes('..') || file.file_path.startsWith('/')) {
      throw new ApiError(502, 'Telegram не предоставил путь аудиофайла.');
    }
    const fileUrl=`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
    if (prepare) {
      if(audioCache) {
        try {return Response.json(await audioCache.prepare(cacheKey,fileUrl,file.file_size));}
        catch{return Response.json({ready:false,downloading:false});}
      }
      return Response.json({ready:true});
    }
    if(audioCache) {
      const started=performance.now();
      try {
        const response=await audioCache.stream(cacheKey,fileUrl,file.file_size,range);
        response.headers.set('Server-Timing',`telegram_file;dur=${lookupMs.toFixed(1)}, cache_headers;dur=${(performance.now()-started).toFixed(1)}`);
        response.headers.set('X-Accel-Buffering','no');
        return correctAudioType(response,ticket,file.file_path);
      }catch{/* Keep playback available if disk caching cannot be used. */}
    }
    const headers = new Headers();
    headers.set('Accept-Encoding','identity');
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range) || range === 'bytes=-') throw new ApiError(416, 'Некорректный диапазон.');
      headers.set('Range', range);
    }
    let upstream;
    const streamStart = performance.now();
    try { upstream = await fetch(fileUrl, {headers, redirect: 'error', signal: AbortSignal.timeout(30000)}); }
    catch { throw new ApiError(502, 'Не удалось загрузить аудио из Telegram.'); }
    if (![200, 206, 416].includes(upstream.status)) throw new ApiError(502, 'Аудиофайл сейчас недоступен.');
    const out = new Headers();
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      if (upstream.headers.has(name)) out.set(name, upstream.headers.get(name));
    }
    out.set('Content-Type', artwork ? 'image/jpeg' : audioMime(ticket.mime)||audioMime(upstream.headers.get('Content-Type'),file.file_path)||'application/octet-stream');
    out.set('Server-Timing', `telegram_file;dur=${lookupMs.toFixed(1)}, telegram_headers;dur=${(performance.now()-streamStart).toFixed(1)}`);
    out.set('X-Accel-Buffering','no');
    if(!artwork)out.set('X-Wave-Cache','BYPASS');
    if (artwork && upstream.status === 200) out.set('Cache-Control', `private, max-age=${Math.min(60, Math.max(0, ticket.exp-now()))}`);
    return new Response(upstream.body, {status: upstream.status, headers: out});
  }
  throw new ApiError(404, 'Не найдено.');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = env.FRONTEND_ORIGIN || 'https://356038.github.io';
    if (origin && origin !== allowed) return new Response('Forbidden', {status: 403});
    let response;
    try {
      response = request.method === 'OPTIONS' ? new Response(null, {status: 204}) : await route(request, env);
    } catch (error) {
      const known=error instanceof ApiError||error instanceof AudiusError;
      response = Response.json({error: known ? error.message : 'Внутренняя ошибка сервиса.'}, {status: known ? error.status : 500});
    }
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
    headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    headers.set('Vary', 'Origin');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {status: response.status, headers});
  },
};
