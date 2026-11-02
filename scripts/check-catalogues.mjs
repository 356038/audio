// Read-only provider check. No credentials are required for Internet Archive.
// VPS: node --env-file=/etc/wave.env scripts/check-catalogues.mjs --audio
import {searchCatalogueAudius} from '../catalogue-search.mjs';
import {serveArchiveMedia} from '../archive.mjs';
const env={...process.env,WAVE_ARCHIVE_ENABLED:process.env.WAVE_ARCHIVE_ENABLED??'1'};
const queries=process.argv.slice(2).filter(arg=>arg!=='--audio');
const secrets=['BOT_TOKEN','AUDIUS_API_KEY','AUDIUS_BEARER_TOKEN'].map(name=>env[name]).filter(value=>typeof value==='string'&&value.length>3);
const safe=value=>{let s=String(value??'');for(const secret of secrets)s=s.replaceAll(secret,'[скрыто]');return s.slice(0,300);};
let selected=null;
for(const query of (queries.length?queries:['Queen','король и шут','Kevin MacLeod']).slice(0,5)){
 console.log('\nЗапрос:',safe(query));
 try{
  const start=performance.now(),r=await searchCatalogueAudius(env,{query,refresh:true});
  console.log(JSON.stringify({tracks:r.items.length,more:r.next_offset!==null,ms:Math.round(performance.now()-start),sources:r.diagnostics.rows}));
  for(const t of r.items.slice(0,8))console.log(JSON.stringify({source:t.source||'audius',artist:safe(t.performer),title:safe(t.title),duration:t.duration,license:t.source==='archive'?t.license_url:undefined}));
  selected??=r.items.find(t=>t.source==='archive');
  for(const s of r.diagnostics.sources)if(s.error)console.log('Ошибка источника:',JSON.stringify({kind:s.kind,...s.error}));
 }catch(error){console.log('Проверка не завершена:',safe(error.message));process.exitCode=1;}
}
if(process.argv.includes('--audio')){
 if(!selected){console.log('Нет записи архива для проверки потока.');process.exitCode=1;}
 else try{
  const r=await serveArchiveMedia(new Request('https://wave.invalid/api/stream',{headers:{Range:'bytes=0-1023'}}),env,{type:'audio'},selected);
  const reader=r.body?.getReader();let bytes=0;
  try{while(reader&&bytes<1024){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;}}finally{await reader?.cancel();}
  console.log('Аудио:',JSON.stringify({status:r.status,mime:r.headers.get('Content-Type'),range:r.headers.get('Content-Range'),bytes}));
  if(![200,206].includes(r.status)||bytes===0)process.exitCode=1;
 }catch(error){console.log('Поток не подтверждён:',safe(error.message));process.exitCode=1;}
}
