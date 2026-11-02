import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {archiveLicense,archiveTracks,archiveFetch,searchArchive,clearArchiveCache} from '../archive.mjs';
import {clearArtistSearchCache,searchCatalogueAudius} from '../catalogue-search.mjs';
import {PersonalStore} from '../personal-store.mjs';
import {recommendations} from '../recommendations.mjs';
import api from '../telegram-api.mjs';
const bot='123:archive-fixture',origin='https://wave.example';
const metadata=(files=[{name:'song.mp3',title:'Example song',length:'3:15',size:'1000'}],extra={})=>({metadata:{mediatype:'audio',creator:'Example Artist',licenseurl:'https://creativecommons.org/licenses/by/4.0/',...extra},files});
function signed(user=42){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:user})});const check=[...p].sort().map(([k,v])=>`${k}=${v}`).join('\n'),secret=createHmac('sha256','WebAppData').update(bot).digest();p.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return p.toString();}
const post=(path,body={},user=42)=>new Request(origin+path,{method:'POST',body:JSON.stringify({init_data:signed(user),...body})});
function fixture({data=metadata(),http}={}){return {BOT_TOKEN:bot,WAVE_ARCHIVE_ENABLED:'1',ARCHIVE_HTTP:async(url,headers,signal)=>{
 if(http){const result=await http(url,headers,signal);if(result)return result;}
 if(url.pathname==='/advancedsearch.php')return Response.json({response:{numFound:1,docs:[{identifier:'example-album'}]}});
 if(url.pathname==='/metadata/example-album')return Response.json(data);
 if(url.pathname.startsWith('/download/'))return new Response(new Uint8Array([1,2]),{status:206,headers:{'Content-Type':'application/octet-stream','Content-Range':'bytes 0-1/1000','Content-Length':'2'}});
 throw Error('Unexpected Archive request');
 }};}
afterEach(()=>{clearArchiveCache();clearArtistSearchCache();});

test('licenses accept explicit open grants and reject lookalikes, credentials and noncommercial/ND variants',()=>{
 for(const value of ['https://creativecommons.org/licenses/by/4.0/','http://creativecommons.org/licenses/by-sa/3.0/','https://creativecommons.org/publicdomain/zero/1.0/'])assert.ok(archiveLicense(value));
 for(const value of [null,'','https://creativecommons.org.evil.test/licenses/by/4.0/','https://user:pass@creativecommons.org/licenses/by/4.0/','https://creativecommons.org/licenses/by-nc/4.0/','https://creativecommons.org/licenses/by-nd/4.0/'])assert.equal(archiveLicense(value),null);
});
test('only declared available audio with bounded complete MP3 files enters the catalogue',()=>{
 const base={name:'song.mp3',length:'195.5',size:1000};
 const items=archiveTracks('example-album',metadata([base,{...base,name:'../file.mp3'},{...base,name:'tiny.mp3',length:10},{...base,name:'huge.mp3',size:30*1024*1024},{...base,name:'private.mp3',private:true},{...base,name:'song_sample.mp3'}]));
 assert.equal(items.length,1);assert.equal(items[0].source,'archive');assert.equal(items[0].duration,195.5);assert.ok(items[0].id.length<128);assert.equal(items[0].performer,'Example Artist');
 for(const extra of [{licenseurl:''},{mediatype:'movies'},{'access-restricted-item':'true'},{'no-preview':'true'}])assert.deepEqual(archiveTracks('example-album',metadata([base],extra)),[]);
 assert.deepEqual(archiveTracks('example-album',{...metadata([base]),is_dark:true}),[]);
});
test('search advances by archive objects rather than song count and coalesces metadata lookups',async()=>{
 let lookups=0;const env=fixture({http:async url=>{
  if(url.pathname.startsWith('/metadata/'))lookups++;
  if(url.pathname==='/advancedsearch.php'){assert.ok(!url.searchParams.get('q').includes('creator:admin'));return Response.json({response:{numFound:6,docs:[{identifier:'example-album'}]}});}
 }});
 const [a,b]=await Promise.all([searchArchive(env,{query:'Example creator:admin'}),searchArchive(env,{query:'Example creator:admin'})]);
 assert.equal(lookups,1);assert.equal(a.items.length,1);assert.equal(b.items.length,1);assert.equal(a.next_offset,5);assert.equal(a.received,1);
});
test('authenticated merged search and Range playback work without Audius credentials',async()=>{
 let bytesCalls=0;const env=fixture({http:async(url,headers)=>{assert.equal(new Headers(headers).get('Authorization'),null);assert.equal(new Headers(headers).get('Cookie'),null);if(url.pathname.startsWith('/download/')){bytesCalls++;assert.equal(new Headers(headers).get('Range'),'bytes=0-1');}}});
 const denied=await api.fetch(post('/api/search',{query:'Example',init_data:''}),env);assert.equal(denied.status,401);
 const response=await api.fetch(post('/api/search',{query:'Example'}),env);assert.equal(response.status,200);const result=await response.json(),track=result.tracks[0];
 assert.equal(track.source,'archive');assert.equal(track.performer,'Example Artist');assert.equal(track.source_url,'https://archive.org/details/example-album');assert.equal(track.license_url,'https://creativecommons.org/licenses/by/4.0/');assert.ok(track.stream_url.startsWith(origin+'/api/stream?ticket='));assert.ok(!JSON.stringify(result).includes('archive_file'));
 const streamed=await api.fetch(new Request(track.stream_url,{headers:{Range:'bytes=0-1'}}),env);assert.equal(streamed.status,206);assert.equal(streamed.headers.get('Content-Type'),'audio/mpeg');assert.equal(streamed.headers.get('Content-Range'),'bytes 0-1/1000');assert.deepEqual([...new Uint8Array(await streamed.arrayBuffer())],[1,2]);assert.equal(bytesCalls,1);
 const bad=await api.fetch(new Request(track.stream_url+'x'),env);assert.equal(bad.status,401);assert.equal(bytesCalls,1);
 const artwork=await api.fetch(new Request(track.stream_url.replace('/api/stream','/api/artwork')),env);assert.equal(artwork.status,401);
});
test('saved archive descriptors retain their source and regenerate user-bound playback tickets',async()=>{
 const store=new PersonalStore(':memory:'),env={...fixture(),PERSONAL_STORE:store};
 try{const results=await(await api.fetch(post('/api/search',{query:'Example'}),env)).json();const original=results.tracks[0];
  assert.equal((await api.fetch(post('/api/library/save',{stream_url:original.stream_url,saved:true},99),env)).status,403);
  assert.equal((await api.fetch(post('/api/library/save',{stream_url:original.stream_url,saved:true}),env)).status,200);const payload=store.list(42)[0];assert.equal(payload.source,'archive');assert.ok(!JSON.stringify(payload).includes('/api/stream'));
  const restored=await(await api.fetch(post('/api/library'),env)).json();assert.equal(restored.tracks[0].source,'archive');assert.notEqual(restored.tracks[0].stream_url,original.stream_url);assert.equal(restored.tracks[0].license_url,original.license_url);
  const played=await api.fetch(new Request(restored.tracks[0].stream_url,{headers:{Range:'bytes=0-1'}}),env);assert.equal(played.status,206);await played.body.cancel();
  const {spawnSync}=await import('node:child_process');
  const code=`import{PersonalStore}from'./personal-store.mjs';import api from'./telegram-api.mjs';const store=new PersonalStore(':memory:');store.save(42,${JSON.stringify(payload)},true);const env={BOT_TOKEN:${JSON.stringify(bot)},PERSONAL_STORE:store,ARCHIVE_HTTP:async url=>url.pathname.startsWith('/metadata/')?Response.json(${JSON.stringify(metadata())}):new Response(new Uint8Array([1,2]),{status:206,headers:{'Content-Type':'audio/mpeg','Content-Range':'bytes 0-1/1000','Content-Length':'2'}})};const r=await api.fetch(new Request(${JSON.stringify(origin+'/api/library')},{method:'POST',body:JSON.stringify({init_data:${JSON.stringify(signed())}})}),env);const data=await r.json();const stream=await api.fetch(new Request(data.tracks[0].stream_url),env);await stream.arrayBuffer();console.log(JSON.stringify({source:data.tracks[0].source,status:stream.status}));store.close();`;
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.ifError(restarted.error);assert.equal(restarted.status,0,restarted.stderr);assert.deepEqual(JSON.parse(restarted.stdout),{source:'archive',status:206});
 }finally{store.close();}
});
test('archive redirects are host-restricted and never forward credentials',async()=>{
 const calls=[];let env={ARCHIVE_HTTP:async(url,headers)=>{calls.push({url,headers});return url.hostname==='archive.org'?new Response(null,{status:302,headers:{Location:'https://dn710101.ca.archive.org/0/items/example/song.mp3'}}):new Response(new Uint8Array([1]));}};
 const r=await archiveFetch('https://archive.org/download/example/song.mp3',{headers:{Range:'bytes=0-1',Authorization:'secret',Cookie:'private'}},env);await r.body.cancel();assert.equal(calls.length,2);assert.ok(calls.every(c=>!new Headers(c.headers).has('Authorization')&&!new Headers(c.headers).has('Cookie')));
 let rejected=0;env={ARCHIVE_HTTP:async()=>{rejected++;return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});}};
 await assert.rejects(archiveFetch('https://archive.org/download/example/song.mp3',{},env));assert.equal(rejected,1);
 for(const url of ['http://archive.org/file','https://archive.org.evil.test/file','https://u:p@archive.org/file'])await assert.rejects(archiveFetch(url,{},env));
});
test('blocked files and HTML never become a successful audio response',async()=>{
 for(const error of [new Response('Forbidden',{status:403}),new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}})]){
  clearArtistSearchCache();clearArchiveCache();const env=fixture({http:async url=>url.pathname.startsWith('/download/')?error:null});const result=await(await api.fetch(post('/api/search',{query:'Example'}),env)).json();
  assert.equal((await api.fetch(new Request(result.tracks[0].stream_url),env)).status,502);
 }
});
test('takedowns and license changes are rechecked before streaming persisted results',async()=>{
 let removed=false,bytes=0;const env=fixture({http:async url=>{if(url.pathname.startsWith('/metadata/'))return Response.json(metadata(undefined,removed?{licenseurl:''}:{}));if(url.pathname.startsWith('/download/'))bytes++;}});
 const result=await(await api.fetch(post('/api/search',{query:'Example'}),env)).json();removed=true;clearArchiveCache();assert.equal((await api.fetch(new Request(result.tracks[0].stream_url),env)).status,404);assert.equal(bytes,0);
});
test('one failed provider does not disable the other search source',async()=>{
 const env={...fixture(),AUDIUS_API_KEY:'fixture',AUDIUS_BEARER_TOKEN:'fixture',AUDIUS_HTTP:async()=>new Response(null,{status:503})};const result=await searchCatalogueAudius(env,{query:'Example'});assert.equal(result.items[0].source,'archive');assert.equal(result.diagnostics.partial,true);
 clearArtistSearchCache();const other={...env,ARCHIVE_HTTP:async()=>new Response(null,{status:503}),AUDIUS_HTTP:async url=>url.pathname==='/v1/tracks/search'?Response.json({data:[{id:'A1',title:'Example song',duration:100,user:{name:'Example Artist'}}]}):Response.json(url.pathname==='/v1/users/search'?{data:[]}:{data:{tracks:[]}})};
 const fallback=await searchCatalogueAudius(other,{query:'Example'});assert.equal(fallback.items[0].id,'audius:A1');
});
test('recommendations can continue from archive listening without Audius credentials',async()=>{
 const store=new PersonalStore(':memory:'),env=fixture();try{const track=(await searchArchive(env,{query:'Example'})).items[0];store.record(42,{...track,id:'heard-archive-song'},'archive-session-1',30);const result=await recommendations(env,42,store,{});assert.equal(result.items[0].source,'archive');assert.equal(result.items[0].performer,'Example Artist');}finally{store.close();}
});
