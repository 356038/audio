// Internet Archive's public catalogue. No account, borrowed API key or login.
import {createHash} from 'node:crypto';
import {AudiusError,publicRequest} from './audius.mjs';

const LIMIT=20*1024*1024,metadataCache=new Map();
const scalar=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(v=>typeof v==='string').join(', '):'';
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,149}$/.test(value);
export function archiveLicense(value){
  for(const raw of Array.isArray(value)?value:[value]){
    try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||!['creativecommons.org','www.creativecommons.org'].includes(u.hostname)||u.username||u.password||u.port)continue;
      if(/^\/licenses\/(?:by|by-sa)\/(?:1\.0|2\.0|2\.5|3\.0|4\.0)\/$/.test(u.pathname)||/^\/publicdomain\/(?:zero\/1\.0|mark\/1\.0)\/$/.test(u.pathname))return 'https://creativecommons.org'+u.pathname;
    }catch{}
  }
  return null;
}
function target(raw){
  let u;try{u=new URL(raw);}catch{throw new AudiusError(502,'Некорректный адрес архива.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!(u.hostname==='archive.org'||/^[a-z0-9.-]+\.archive\.org$/.test(u.hostname))||u.hash)throw new AudiusError(502,'Неподдерживаемый адрес архива.');
  return u;
}
export async function archiveFetch(raw,{headers={},signal=AbortSignal.timeout(15000)}={},env={}){
  let url=target(raw);
  for(let hop=0;hop<5;hop++){
    // Only our Range is forwarded, never user cookies or credentials.
    const out={'User-Agent':'WAVE/1.0','Accept-Encoding':'identity'};
    const range=new Headers(headers).get('Range');if(range)out.Range=range;
    const r=await (env.ARCHIVE_HTTP||publicRequest)(url,out,signal);
    if(![301,302,303,307,308].includes(r.status))return r;
    const location=r.headers.get('Location');await r.body?.cancel();
    if(!location)throw new AudiusError(502,'Архив не вернул адрес аудио.');
    url=target(new URL(location,url).href);
  }
  throw new AudiusError(502,'Слишком много перенаправлений архива.');
}
async function json(env,url,signal){
  const r=await archiveFetch(url,{signal},env);
  if(!r.ok){await r.body?.cancel();throw new AudiusError(r.status===429?429:502,'Архив временно недоступен.',{code:'http_error',upstreamStatus:r.status});}
  const reader=r.body?.getReader(),decoder=new TextDecoder();let text='',bytes=0;
  try{if(reader)for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw Error();}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  catch{throw new AudiusError(502,'Не удалось прочитать каталог архива.');}finally{reader?.releaseLock();}
}
function duration(value){const s=String(value||'');if(/^\d+(?:\.\d+)?$/.test(s))return Number(s);return /^\d+:\d{2}(?::\d{2})?$/.test(s)?s.split(':').reduce((n,v)=>n*60+Number(v),0):0;}
function filename(value){return typeof value==='string'&&value.length>0&&value.length<1000&&!/[\\\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');}
function audioUrl(item,file){if(!identifier(item)||!filename(file))throw new AudiusError(400,'Некорректная запись архива.');return `https://archive.org/download/${item}/${file.split('/').map(encodeURIComponent).join('/')}`;}
export function archiveTracks(item,data){
  if(!identifier(item)||!data||typeof data!=='object')return [];
  const m=data.metadata||{},license=archiveLicense(m.licenseurl);
  if(!license||m.mediatype!=='audio'||data.is_dark||data.is_restricted||m['access-restricted-item']==='true'||m['access-restricted-item']===true||m['no-preview']==='true')return [];
  const files=Array.isArray(data.files)?data.files:[],tracks=[];
  for(const f of files){
    if(tracks.length>=100)break;
    if(!f||!filename(f.name)||!f.name.toLowerCase().endsWith('.mp3')||f.private===true||f.private==='true'||f.name.toLowerCase().endsWith('_sample.mp3'))continue;
    const size=Number(f.size);if(!Number.isSafeInteger(size)||size<=0||size>LIMIT)continue;
    const length=duration(f.length);if(!Number.isFinite(length)||length<30||length>3600)continue;
    const performer=(scalar(f.creator)||scalar(m.creator)).slice(0,1000);
    tracks.push({id:'archive:'+createHash('sha256').update(item+'\0'+f.name).digest('hex').slice(0,40),source:'archive',archive_item:item,archive_file:f.name,
      title:(scalar(f.title)||f.name.replace(/\.mp3$/i,'').replaceAll('_',' ')).slice(0,1000),performer,artist_names:[performer],artist_handle:'',verified:false,
      duration:length,playable:true,mime:'audio/mpeg',artwork_url:null,genre:scalar(m.genre).slice(0,100),tags:(Array.isArray(m.subject)?m.subject:scalar(m.subject).split(';')).filter(v=>typeof v==='string').slice(0,20),
      license_url:license,source_url:'https://archive.org/details/'+item,size});
  }
  return tracks;
}
async function metadata(env,item,signal){
  const key=JSON.stringify([env.ARCHIVE_CACHE_NAMESPACE||'',item]),old=metadataCache.get(key);
  if(old?.expires>Date.now())return old.promise;
  const entry={expires:Date.now()+5*60000};entry.promise=json(env,'https://archive.org/metadata/'+item,signal).then(data=>archiveTracks(item,data)).catch(error=>{if(metadataCache.get(key)===entry)metadataCache.delete(key);throw error;});
  while(metadataCache.size>=128)metadataCache.delete(metadataCache.keys().next().value);metadataCache.set(key,entry);return entry.promise;
}
export function clearArchiveCache(){metadataCache.clear();}
export async function searchArchive(env,{query,offset=0,count=5,signal=AbortSignal.timeout(12000)}){
  if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(offset)||offset<0||!Number.isInteger(count)||count<1||count>10)throw new AudiusError(400,'Введите название трека или исполнителя (до 200 символов).');
  // Literal words only: user input cannot inject Lucene fields or operators.
  const terms=query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)||[];
  if(!terms.some(term=>term.length>=3))return {items:[],received:0,next_offset:null};
  const phrase=terms.map(word=>'"'+word+'"').join(' AND ');
  const q=`mediatype:audio AND licenseurl:* AND (creator:(${phrase}) OR title:(${phrase}))`;
  const url=new URL('https://archive.org/advancedsearch.php');url.search=new URLSearchParams({q,output:'json',rows:String(count),page:String(Math.floor(offset/count)+1),'fl[]':'identifier'});
  const data=await json(env,url,signal),docs=data?.response?.docs,total=data?.response?.numFound;
  if(!Array.isArray(docs)||!Number.isSafeInteger(total))throw new AudiusError(502,'Неожиданный ответ поиска архива.');
  const accepted=docs.filter(d=>identifier(d?.identifier));
  const result=await Promise.allSettled(accepted.map(doc=>metadata(env,doc.identifier,signal)));
  if(result.length&&result.every(r=>r.status==='rejected'))throw result[0].reason;
  return {items:result.filter(r=>r.status==='fulfilled').flatMap(r=>r.value),received:docs.length,next_offset:docs.length&&offset+count<total?offset+count:null};
}
export async function serveArchiveMedia(request,env,ticket,track){
  const path=new URL(request.url).pathname;
  if(ticket.type!=='audio'||path==='/api/artwork')throw new AudiusError(401,'Ссылка не подходит для этого файла.');
  if(path==='/api/prepare')return Response.json({ready:false,downloading:false});
  // Recheck provider metadata, availability and license even for persisted saves.
  const items=await metadata(env,track.archive_item,AbortSignal.timeout(12000));
  const current=items.find(item=>item.id===track.id&&item.archive_file===track.archive_file);
  if(!current)throw new AudiusError(404,'Трек больше не доступен в архиве.');
  const range=request.headers.get('Range');if(range&&(!/^bytes=\d*-\d*$/.test(range)||range==='bytes=-'))throw new AudiusError(416,'Некорректный диапазон.');
  const r=await archiveFetch(audioUrl(current.archive_item,current.archive_file),{headers:range?{Range:range}:{},signal:AbortSignal.timeout(30000)},env);
  if(r.status===416){await r.body?.cancel();return new Response(null,{status:416,headers:r.headers.has('Content-Range')?{'Content-Range':r.headers.get('Content-Range')}:{}});}
  if(![200,206].includes(r.status)){await r.body?.cancel();throw new AudiusError(502,'Архив не предоставил аудиофайл.');}
  const mime=(r.headers.get('Content-Type')||'').split(';')[0];
  if(!['audio/mpeg','audio/mp3','application/octet-stream','binary/octet-stream'].includes(mime)){await r.body?.cancel();throw new AudiusError(502,'Архив вернул неподдерживаемый формат аудио.');}
  const total=Number(r.headers.get('Content-Range')?.split('/')[1])||Number(r.headers.get('Content-Length'));
  if(total>LIMIT){await r.body?.cancel();throw new AudiusError(413,'Этот файл превышает лимит плеера.');}
  const reader=r.body?.getReader();let bytes=0;
  const body=reader?new ReadableStream({async pull(controller){try{const part=await reader.read();if(part.done){controller.close();return;}bytes+=part.value.length;if(bytes>LIMIT){await reader.cancel();throw Error();}controller.enqueue(part.value);}catch{controller.error(new Error('Загрузка аудио прервалась.'));}},cancel(){return reader.cancel();}}):null;
  const headers=new Headers({'Content-Type':'audio/mpeg','X-Accel-Buffering':'no','X-Wave-Cache':'BYPASS','Cache-Control':'private, no-store'});
  for(const name of ['Content-Length','Content-Range','Accept-Ranges'])if(r.headers.has(name))headers.set(name,r.headers.get(name));
  return new Response(body,{status:r.status,headers});
}
