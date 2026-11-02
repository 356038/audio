import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import api from '../telegram-api.mjs';
import {searchAudius,genreAudius,audiusFetch,isPublicAddress} from '../audius.mjs';
import {searchCatalogueAudius,clearArtistSearchCache} from '../catalogue-search.mjs';
const base='https://wave.example',bot='123:bot-test-only';
const basic={BOT_TOKEN:bot,AUDIUS_API_KEY:'public-fixture',AUDIUS_BEARER_TOKEN:'bearer-fixture'};
const song={id:'Ab12',title:'Fixture track',genre:'Electronic',duration:42,user:{name:'Fixture artist'},is_streamable:true,is_stream_gated:false};
function signed(user=42){const data=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:user})});const value=[...data.entries()].sort().map(([k,v])=>`${k}=${v}`).join('\n');const key=createHmac('sha256','WebAppData').update(bot).digest();data.set('hash',createHmac('sha256',key).update(value).digest('hex'));return data.toString();}
const query=(body={})=>new Request(base+'/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:signed(),query:'electronic',...body})});
const ok=items=>Response.json({data:items});
afterEach(clearArtistSearchCache);

test('authorized search returns opaque playable URLs and honest unavailable tracks',async()=>{
 const env={...basic,AUDIUS_HTTP:async(url,headers)=>{
  if(url.pathname==='/v1/users/search')return ok([]);
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
  assert.equal(url.hostname,'api.audius.co');assert.equal(url.pathname,'/v1/tracks/search');assert.equal(url.searchParams.get('query'),'electronic');
  assert.equal(new Headers(headers).get('Authorization'),'Bearer '+basic.AUDIUS_BEARER_TOKEN);
  return ok([song,{...song,id:'Cd34',is_stream_gated:true},{...song,id:'Ef56',is_streamable:false}]);
 }};
 const response=await api.fetch(query(),env);assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.total_count,null);assert.equal(result.next_offset,null);assert.equal(result.tracks.length,3);
 assert.equal(result.tracks[0].playable,true);assert.equal(result.tracks[1].playable,false);assert.equal(result.tracks[1].stream_url,null);
 assert.ok(result.tracks[0].stream_url.startsWith(base+'/api/stream?ticket='));
 for(const secret of [basic.AUDIUS_API_KEY,basic.AUDIUS_BEARER_TOKEN,'api.audius.co'])assert.ok(!JSON.stringify(result).includes(secret));
});
test('authentication, missing keys, invalid queries and provider errors are distinct',async()=>{
 assert.equal((await api.fetch(query({init_data:''}),basic)).status,401);
 assert.equal((await api.fetch(query(),{BOT_TOKEN:bot})).status,503);
 const env={...basic,AUDIUS_HTTP:async()=>new Response('fixture private upstream',{status:403})};
 const forbidden=await api.fetch(query(),env);assert.equal(forbidden.status,503);assert.ok(!(await forbidden.text()).includes('fixture private'));
 await assert.rejects(searchAudius(env,{query:''}),error=>error.status===400);
 await assert.rejects(searchAudius(env,{query:'q',offset:-1}),error=>error.status===400);
 assert.equal((await api.fetch(query(),{...basic,AUDIUS_HTTP:async()=>new Response(null,{status:429})})).status,429);
});
test('redirects never receive the bearer token, and private targets are rejected',async()=>{
 const requests=[];const env={...basic,AUDIUS_HTTP:async(url,headers)=>{
  requests.push({url,headers:new Headers(headers)});
  if(url.hostname==='api.audius.co')return new Response(null,{status:302,headers:{Location:'https://creatornode.audius.co/audio'}});
  return new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'audio/mpeg'}});
 }};
 const response=await audiusFetch('https://api.audius.co/v1/tracks/Ab12/stream',{headers:{Range:'bytes=0-1',Authorization:'bad',Cookie:'bad'}},env);
 assert.equal(response.status,200);assert.equal(requests.length,2);
 assert.equal(requests[0].headers.get('Authorization'),'Bearer '+basic.AUDIUS_BEARER_TOKEN);
 assert.equal(requests[1].headers.get('Authorization'),null);assert.equal(requests[1].headers.get('Cookie'),null);assert.equal(requests[1].headers.get('Range'),'bytes=0-1');
 await response.body.cancel();
 let calls=0;
 await assert.rejects(audiusFetch('https://api.audius.co/v1/tracks/Ab12/stream',{}, {...basic,AUDIUS_HTTP:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});}}));
 assert.equal(calls,1);
 for(const ip of ['127.0.0.1','10.1.2.3','100.102.118.114','169.254.169.254','::1','::ffff:127.0.0.1','fd00::1','fe80::1'])assert.equal(isPublicAddress(ip),false);
 assert.equal(isPublicAddress('8.8.8.8'),true);
});
test('audio bytes, MIME and ranges are preserved and credentials never leave the server',async()=>{
 const seen=[];const env={...basic,AUDIUS_HTTP:async(url,headers)=>{
  if(url.pathname==='/v1/users/search')return ok([]);
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
  if(url.pathname.endsWith('/search'))return ok([song]);
  seen.push(new Headers(headers));return new Response(new Uint8Array([7,8]),{status:206,headers:{'Content-Type':'application/octet-stream','Content-Range':'bytes 0-1/200','Content-Length':'2'}});
 }};
 const result=await(await api.fetch(query(),env)).json();const stream=result.tracks[0].stream_url;
 const response=await api.fetch(new Request(stream,{headers:{Range:'bytes=0-1'}}),env);
 assert.equal(response.status,206);assert.equal(response.headers.get('Content-Type'),'audio/mpeg');assert.equal(response.headers.get('Content-Range'),'bytes 0-1/200');
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[7,8]);assert.equal(seen[0].get('Range'),'bytes=0-1');
 assert.ok(!JSON.stringify([...response.headers]).includes(basic.AUDIUS_BEARER_TOKEN));
 assert.equal((await api.fetch(new Request(stream.replace('/api/stream','/api/artwork')),env)).status,401);
});
test('pagination does not invent a total, and JSON/HTML/HLS do not become MP3',async()=>{
 const items=Array.from({length:20},(_,i)=>({...song,id:'A'+i}));
 const result=await searchAudius({...basic,AUDIUS_HTTP:async()=>ok(items)},{query:'q',offset:20});
 assert.equal(result.total_count,null);assert.equal(result.next_offset,40);
 for(const type of ['application/json','text/html','application/vnd.apple.mpegurl']) {
  await assert.rejects(audiusFetch('https://api.audius.co/v1/tracks/Ab12/stream',{}, {...basic,AUDIUS_HTTP:async()=>new Response('not audio',{headers:{'Content-Type':type}})}),error=>error.status===409);
 }
});


test('genre discovery uses a genre filter and preserves available style metadata',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>{
  assert.equal(url.pathname,'/v1/tracks/trending');assert.equal(url.searchParams.get('genre'),'Electronic');assert.equal(url.searchParams.get('time'),'week');assert.equal(url.searchParams.has('query'),false);
  return ok([{...song,genre:'Electronic',mood:'Chill',bpm:128,tags:' house,deep,house,  '},{...song,id:'B1',bpm:'not-a-number'}]);
 }};
 const items=await genreAudius(env,'Electronic');
 assert.equal(items[0].mood,'Chill');assert.equal(items[0].bpm,128);assert.deepEqual(items[0].tags,['house','deep']);assert.equal(items[1].bpm,null);
 await assert.rejects(genreAudius(env,''),error=>error.status===400);
});


test('artist catalogue precedes title matches and pagination neither repeats nor skips rows',async()=>{
 let lookups=0,titleCalls=0;
 const own=Array.from({length:4},(_,i)=>({...song,id:'Q'+i,title:'Different title '+i,user:{id:'Qx',name:'Queen',handle:'queen'}}));
 const titles=[...own,{...song,id:'T1',title:'Queen of hearts'},{...song,id:'T2',title:'Queen of the night'}];
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
  if(url.pathname==='/v1/users/search'){lookups++;return ok([{id:'Nx',name:'Unrelated artist'},{id:'Qx',name:'Queen',handle:'queen',is_verified:true}]);}
  if(url.pathname==='/v1/users/Qx/tracks')return ok(own);
  assert.equal(url.pathname,'/v1/tracks/search');titleCalls++;assert.equal(url.searchParams.get('query'),'Queen');
  return ok(titles.slice(Number(url.searchParams.get('offset'))));
 }};
 const first=await searchCatalogueAudius(env,{query:'Queen',count:2});assert.deepEqual(first.items.map(t=>t.id),['audius:Q0','audius:Q1']);assert.equal(titleCalls,1);
 const second=await searchCatalogueAudius(env,{query:'Queen',count:2,offset:first.next_offset});
 const third=await searchCatalogueAudius(env,{query:'Queen',count:2,offset:second.next_offset});
 assert.deepEqual([...first.items,...second.items,...third.items].map(t=>t.id),['audius:Q0','audius:Q1','audius:Q2','audius:Q3','audius:T1','audius:T2']);
 assert.equal(third.next_offset,null);assert.equal(first.total_count,null);assert.equal(lookups,1);assert.equal(titleCalls,1);
});

test('track fallback ranks actual performer matches ahead of title-only results and survives artist lookup failure',async()=>{
 for(const failed of [false,true]){
  clearArtistSearchCache();
  const env={...basic,AUDIUS_HTTP:async url=>{
   if(url.pathname==='/v1/users/search')return failed?new Response(null,{status:503}):ok([]);
   return ok([{...song,id:'T1',title:'Queen',user:{name:'Someone else'}},{...song,id:'Q1',title:'Bohemian Rhapsody',user:{name:'Queen'}}]);
  }};
  const result=await searchCatalogueAudius(env,{query:'queen'});assert.deepEqual(result.items.map(t=>t.id),['audius:Q1','audius:T1']);assert.equal(result.next_offset,null);
 }
});

test('full search contributes tracks missing from the legacy index, and duplicates are merged',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full'){assert.equal(url.searchParams.get('kind'),'tracks');assert.equal(url.searchParams.get('sort_method'),'relevant');return Response.json({data:{users:[],tracks:[{...song,id:'Modern',title:'Queen — Live'}]}});}
  if(url.pathname==='/v1/users/search')return ok([]);
  return ok([{...song,id:'Modern',title:'Queen — Live'},{...song,id:'Legacy',title:'Queen — Studio'}]);
 }};
 const result=await searchCatalogueAudius(env,{query:'Queen'});assert.equal(result.items.length,2);assert.equal(new Set(result.items.map(t=>t.id)).size,2);assert.ok(result.diagnostics.rows.full>0);assert.ok(result.diagnostics.rows.legacy>0);
});

test('Король и Шут searches Cyrillic, transliteration and the familiar abbreviation',async()=>{
 const queries=[];
 const env={...basic,AUDIUS_HTTP:async url=>{
  queries.push(url.searchParams.get('query'));
  if(url.pathname==='/v1/users/search')return ok([]);
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:url.searchParams.get('query')==='korol i shut'?[{id:'Kx',name:"Korol' i Shut"}]:[]}});
  if(url.pathname==='/v1/users/Kx/tracks')return ok([{...song,id:'Lesnik',title:'Лесник',user:{id:'Kx',name:"Korol' i Shut"}}]);
  return ok([]);
 }};
 const result=await searchCatalogueAudius(env,{query:'король и шут'});assert.deepEqual(result.items.map(t=>t.title),['Лесник']);assert.ok(queries.includes('король и шут'));assert.ok(queries.includes('korol i shut'));assert.ok(queries.includes('КиШ'));
});

test('artist matching tolerates accents, punctuation and small typos without requiring the artist in the song title',async()=>{
 for(const [query,name]of [['Beyonce','Beyoncé'],['ACDC','AC/DC'],['Quuen','Queen']]){
  clearArtistSearchCache();const env={...basic,AUDIUS_HTTP:async url=>{
   if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
   if(url.pathname==='/v1/users/search')return ok([{id:'Artist',name}]);
   if(url.pathname==='/v1/users/Artist/tracks')return ok([{...song,title:'Different title',user:{id:'Artist',name}}]);
   return ok([]);
  }};
  const result=await searchCatalogueAudius(env,{query});assert.equal(result.items.length,1,query);assert.equal(result.items[0].performer,name);
 }
});

test('artist and song queries find the song without flooding the page with the whole artist catalogue',async()=>{
 for(const query of ['Queen — Bohemian Rhapsody','Queen Bohemian Rhapsody']){
  clearArtistSearchCache();const env={...basic,AUDIUS_HTTP:async url=>{
   if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
   if(url.pathname==='/v1/users/search')return ok([{id:'QueenId',name:'Queen'}]);
   if(url.pathname==='/v1/users/QueenId/tracks')return ok([{...song,id:'Desired',title:'Bohemian Rhapsody',user:{id:'QueenId',name:'Queen'}},{...song,id:'Other',title:'Another One Bites The Dust',user:{id:'QueenId',name:'Queen'}}]);
   return ok([]);
  }};
  const result=await searchCatalogueAudius(env,{query});assert.deepEqual(result.items.map(t=>t.id),['audius:Desired'],query);
 }
});

test('artist pagination continues beyond the first 40, stays deduplicated and reuses a stable session',async()=>{
 const offsets=[];const own=Array.from({length:120},(_,i)=>({...song,id:'Q'+i,user:{id:'Qx',name:'Queen'}}));
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
  if(url.pathname==='/v1/users/search')return ok([{id:'Qx',name:'Queen'}]);
  if(url.pathname==='/v1/users/Qx/tracks'){const offset=Number(url.searchParams.get('offset'));offsets.push(offset);return ok(own.slice(offset,offset+40));}
  return ok([]);
 }};
 let page=await searchCatalogueAudius(env,{query:'Queen'}),tracks=[...page.items];const session=page.search_session;
 while(page.next_offset!==null){page=await searchCatalogueAudius(env,{query:'Queen',offset:page.next_offset,session});tracks.push(...page.items);assert.ok(tracks.length<=120);}
 assert.equal(tracks.length,120);assert.equal(new Set(tracks.map(t=>t.id)).size,120);assert.ok(offsets.includes(80));
 await assert.rejects(searchCatalogueAudius(env,{query:'Other',offset:20,session}),error=>error.status===409);
});

test('search refresh fetches again while existing page sessions remain usable',async()=>{
 let generation=0;const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/users/search')return ok([]);
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[],users:[]}});
  return ok(Array.from({length:40},(_,i)=>({...song,id:'A'+i,title:'Song '+i+' generation '+generation})));
 }};
 const first=await searchCatalogueAudius(env,{query:'song'});generation=1;
 const refreshed=await searchCatalogueAudius(env,{query:'song',refresh:true});assert.notEqual(first.search_session,refreshed.search_session);assert.ok(refreshed.items[0].title.includes('generation 1'));
 const oldNext=await searchCatalogueAudius(env,{query:'song',offset:20,session:first.search_session});assert.ok(oldNext.items[0].title.includes('generation 0'));
});

test('a healthy empty user lookup cannot hide rate limits from both music indices',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>url.pathname==='/v1/users/search'?ok([]):new Response(null,{status:429})};
 await assert.rejects(searchCatalogueAudius(env,{query:'queen'}),error=>error.status===429);
});

test('a transient full-index gateway failure is retried once with a tracks-only query',async()=>{
 let attempts=0;const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full'){
   attempts++;assert.equal(url.searchParams.get('kind'),'tracks');
   return attempts===1?new Response(null,{status:503}):Response.json({data:{tracks:[song]}});
  }
  return ok([]);
 }};
 const result=await searchCatalogueAudius(env,{query:'fixture'});
 assert.equal(result.items.length,1);assert.equal(attempts,2);assert.equal(result.diagnostics.partial,false);assert.equal(result.diagnostics.sources[0].retries,1);
});

test('rate-limit diagnostics retain the exact source and status without retrying or exposing upstream bodies',async()=>{
 let attempts=0;const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full'){attempts++;return new Response('private upstream '+basic.AUDIUS_BEARER_TOKEN,{status:429});}
  return ok(url.pathname==='/v1/users/search'?[]:[song]);
 }};
 const result=await searchCatalogueAudius(env,{query:'fixture'});
 assert.equal(attempts,1);assert.equal(result.items.length,1);assert.equal(result.diagnostics.partial,true);
 assert.deepEqual(result.diagnostics.sources[0].error,{code:'http_error',http_status:429});
 assert.ok(!JSON.stringify(result.diagnostics).includes(basic.AUDIUS_BEARER_TOKEN));
});

test('oversized full-index responses are cancelled while the legacy index stays usable',async()=>{
 let cancelled=false;
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled=true;}}));
  return ok(url.pathname==='/v1/users/search'?[]:[song]);
 }};
 const result=await searchCatalogueAudius(env,{query:'fixture'});
 assert.equal(cancelled,true);assert.equal(result.items.length,1);assert.equal(result.diagnostics.sources[0].error.code,'response_too_large');
});

test('invalid JSON is distinguishable from a provider HTTP error',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>url.pathname==='/v1/search/full'?new Response('<html>gateway</html>'):ok(url.pathname==='/v1/users/search'?[]:[song])};
 const result=await searchCatalogueAudius(env,{query:'fixture'});
 assert.deepEqual(result.diagnostics.sources[0].error,{code:'invalid_json',http_status:null});
});

test('popular results add missing candidates and generic namesake uploads no longer dominate Queen',async()=>{
 const junk=['1soundess','1sounds','1sound'].map((title,i)=>({...song,id:'J'+i,title,user:{id:'Namesake',name:'Queen'}}));
 const legacy=Array.from({length:40},(_,i)=>({...song,id:'T'+i,title:'Queen of hearts '+i}));
 const desired={...song,id:'Popular',title:'Queen — Bohemian Rhapsody (live cover)',play_count:100000,user:{name:'Live band'}};
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:url.searchParams.get('sort_method')==='popular'?[desired]:[]}});
  if(url.pathname==='/v1/users/search')return ok([{id:'Namesake',name:'Queen'}]);
  if(url.pathname==='/v1/users/Namesake/tracks')return ok(junk);
  return ok(legacy);
 }};
 const first=await searchCatalogueAudius(env,{query:'queen'});
 assert.equal(first.items[0].id,'audius:Popular');assert.ok(!first.items.some(track=>track.id.startsWith('audius:J')));assert.equal(first.diagnostics.rows.popular,1);
 const rest=await searchCatalogueAudius(env,{query:'queen',offset:20,count:100,session:first.search_session});
 assert.equal(rest.items.filter(track=>track.id.startsWith('audius:J')).length,3);
 assert.equal(first.items[0].performer,'Live band');assert.ok(first.items[0].title.includes('cover'));
});

test('verified matching artist ranks ahead of an embedded title mention without claiming official identity',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[{...song,id:'Title',title:'Queen — song',user:{name:'Uploader'}},{...song,id:'Artist',title:'Different song',user:{id:'ArtistId',name:'Queen',is_verified:true}}]}});
  return ok([]);
 }};
 const result=await searchCatalogueAudius(env,{query:'queen'});
 assert.deepEqual(result.items.map(track=>track.track_id),['Artist','Title']);assert.equal(result.items[0].verified,true);assert.equal(result.items[0].official,undefined);
});

test('accepted collaborators participate in artist matching and remain visible in performer metadata',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[{...song,id:'Title',title:'Muse'},{...song,id:'Collab',title:'Different song',user:{name:'Other artist'},collaborators:[{name:'Muse'}]}]}});
  return ok([]);
 }};
 const result=await searchCatalogueAudius(env,{query:'Muse'});
 assert.equal(result.items[0].track_id,'Collab');assert.equal(result.items[0].performer,'Other artist, Muse');
});

test('transliterated user lookup can find an artist even when both global track indices miss',async()=>{
 const env={...basic,AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:[]}});
  if(url.pathname==='/v1/users/search')return ok(url.searchParams.get('query')==='korol i shut'?[{id:'Kx',name:"Korol' i Shut"}]:[]);
  if(url.pathname==='/v1/users/Kx/tracks')return ok([{...song,id:'Lesnik',title:'Лесник',user:{id:'Kx',name:"Korol' i Shut"}}]);
  return ok([]);
 }};
 const result=await searchCatalogueAudius(env,{query:'король и шут'});assert.deepEqual(result.items.map(track=>track.title),['Лесник']);
});
