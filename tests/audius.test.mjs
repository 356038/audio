import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import api from '../telegram-api.mjs';
import {searchAudius,genreAudius,audiusFetch,isPublicAddress} from '../audius.mjs';
const base='https://wave.example',bot='123:bot-test-only';
const basic={BOT_TOKEN:bot,AUDIUS_API_KEY:'public-fixture',AUDIUS_BEARER_TOKEN:'bearer-fixture'};
const song={id:'Ab12',title:'Fixture track',duration:42,user:{name:'Fixture artist'},is_streamable:true,is_stream_gated:false};
function signed(user=42){const data=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:user})});const value=[...data.entries()].sort().map(([k,v])=>`${k}=${v}`).join('\n');const key=createHmac('sha256','WebAppData').update(bot).digest();data.set('hash',createHmac('sha256',key).update(value).digest('hex'));return data.toString();}
const query=(body={})=>new Request(base+'/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:signed(),query:'electronic',...body})});
const ok=items=>Response.json({data:items});

test('authorized search returns opaque playable URLs and honest unavailable tracks',async()=>{
 const env={...basic,AUDIUS_HTTP:async(url,headers)=>{
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
