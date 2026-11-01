import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalStore} from '../personal-store.mjs';
import {recommendations,styleSimilarity} from '../recommendations.mjs';
import api from '../telegram-api.mjs';
const bot='123:personal-fixture',origin='https://wave.example';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
function signed(user=42,info={}){
 const data=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:user,...info})});
 const check=[...data.entries()].sort().map(([k,v])=>`${k}=${v}`).join('\n');
 const key=createHmac('sha256','WebAppData').update(bot).digest();
 data.set('hash',createHmac('sha256',key).update(check).digest('hex'));return data.toString();
}
const request=(path,body={},user=42)=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:signed(user),...body})});
const descriptor={id:'audius:A1',source:'audius',track_id:'A1',mime:'audio/mpeg',title:'Song',performer:'Artist',genre:'Electronic',duration:60,playable:true};
const song=(id,artist='Artist',genre='Electronic',extra={})=>({id,title:id,duration:60,genre,user:{name:artist},is_streamable:true,...extra});

test('personal saves persist, remain private, paginate, and history retains the last 15 distinct tracks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wave-personal-'));const path=join(dir,'library.sqlite');let store;
 try{
  store=new PersonalStore(path);store.save(42,descriptor,true);store.save(42,descriptor,true);
  assert.equal(store.count(42),1);assert.equal(store.count(99),0);assert.equal((await stat(path)).mode&0o777,0o600);
  for(let i=0;i<55;i++)store.save(42,{...descriptor,id:'saved-'+i},true);
  assert.equal(store.list(42).length,50);assert.equal(store.list(42,50).length,6);
  for(let i=0;i<110;i++){
   assert.equal(store.record(42,{...descriptor,id:'played-'+i},'session-'+i,15),true);
   store.db.prepare('UPDATE plays SET played_at=? WHERE session_id=?').run(i,'session-'+i);
  }
  assert.equal(store.record(42,descriptor,'session-109',15),false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM plays').get().n,100);
  assert.equal(store.recent(42).length,15);assert.equal(store.recent(42)[0].id,'played-109');assert.deepEqual(store.recent(99),[]);
  store.close();store=new PersonalStore(path);assert.equal(store.has(42,descriptor.id),true);assert.equal(store.recent(42)[0].id,'played-109');
  store.save(99,descriptor,false);assert.equal(store.has(42,descriptor.id),true);
  store.save(42,descriptor,false);assert.equal(store.has(42,descriptor.id),false);
 }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('library validates Telegram identity and signed track ownership; saving never writes to Telegram',async()=>{
 const store=new PersonalStore(':memory:');const env={BOT_TOKEN:bot,PERSONAL_STORE:store};let calls=0;
 globalThis.fetch=async url=>{
  calls++;assert.ok(url.endsWith('/getUserProfileAudios'));
  return Response.json({ok:true,result:{total_count:1,audios:[{file_id:'private-file',file_unique_id:'unique-personal',title:'Profile song',duration:60,mime_type:'audio/mpeg'}]}});
 };
 try{
  for(const path of ['/api/library','/api/library/save','/api/history','/api/recommendations'])assert.equal((await api.fetch(request(path,{init_data:''}),env)).status,401);
  const profile=await(await api.fetch(request('/api/profile-audios'),env)).json();const stream=profile.tracks[0].stream_url;
  assert.equal((await api.fetch(request('/api/library/save',{stream_url:stream,saved:true},99),env)).status,403);
  assert.equal((await api.fetch(request('/api/library/save',{stream_url:stream+'tampered',saved:true}),env)).status,401);
  assert.equal((await api.fetch(request('/api/library/save',{stream_url:'https://other.example/file',saved:true}),env)).status,400);
  assert.equal((await api.fetch(request('/api/library/save',{stream_url:stream,saved:'yes'}),env)).status,400);
  assert.equal((await api.fetch(request('/api/library/save',{stream_url:stream,saved:true}),env)).status,200);
  const own=await(await api.fetch(request('/api/library'),env)).json();assert.equal(own.total_count,1);assert.equal(own.tracks[0].saved,true);assert.ok(own.tracks[0].stream_url);
  assert.equal((await(await api.fetch(request('/api/library',{},99),env)).json()).total_count,0);
  assert.equal((await api.fetch(request('/api/library',{offset:-1}),env)).status,400);
  const play={stream_url:stream,play_id:'session-fixture-1234',seconds:14};
  assert.equal((await(await api.fetch(request('/api/history',play),env)).json()).recorded,false);
  assert.equal((await(await api.fetch(request('/api/history',{...play,seconds:15}),env)).json()).recorded,true);
  assert.equal((await(await api.fetch(request('/api/history',{...play,seconds:20}),env)).json()).recorded,false);
  assert.equal(store.recent(42).length,1);assert.equal(calls,1);
 }finally{store.close();}
});

test('saved Audius descriptors regenerate stream tickets after a process restart without another search',async()=>{
 const store=new PersonalStore(':memory:');let searches=0;
 const env={BOT_TOKEN:bot,PERSONAL_STORE:store,AUDIUS_API_KEY:'persistence-key',AUDIUS_BEARER_TOKEN:'fixture',AUDIUS_HTTP:async url=>{
  if(url.pathname==='/v1/users/search')return Response.json({data:[]});
  if(url.pathname.endsWith('/search')){searches++;return Response.json({data:[song('A1')]});}
  return new Response(new Uint8Array([1,2]),{status:206,headers:{'Content-Type':'audio/mpeg','Content-Range':'bytes 0-1/100'}});
 }};
 try{
  const search=await(await api.fetch(request('/api/search',{query:'artist'}),env)).json();
  await api.fetch(request('/api/library/save',{stream_url:search.tracks[0].stream_url,saved:true}),env);
  // Persisted descriptors must contain source IDs, never expired bearer links.
  assert.ok(!JSON.stringify(store.list(42)).includes('/api/stream'));
  const {spawnSync}=await import('node:child_process');
  const code=`import{PersonalStore}from'./personal-store.mjs';import api from'./telegram-api.mjs';const store=new PersonalStore(':memory:');store.save(42,${JSON.stringify(store.list(42)[0])},true);const r=await api.fetch(new Request(${JSON.stringify(origin+'/api/library')},{method:'POST',body:JSON.stringify({init_data:${JSON.stringify(signed())}})}),{BOT_TOKEN:${JSON.stringify(bot)},PERSONAL_STORE:store,AUDIUS_API_KEY:'persistence-key',AUDIUS_BEARER_TOKEN:'fixture'});console.log(JSON.stringify(await r.json()));store.close();`;
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.ifError(restarted.error);assert.equal(restarted.status,0,restarted.stderr);const restored=JSON.parse(restarted.stdout);
  assert.equal(restored.tracks[0].id,'audius:A1');assert.ok(restored.tracks[0].stream_url);assert.notEqual(restored.tracks[0].stream_url,search.tracks[0].stream_url);assert.equal(searches,1);
 }finally{store.close();}
});

test('recommendations use history, rank related artists, exclude heard/saved/gated tracks and invalidate after saving',async()=>{
 const store=new PersonalStore(':memory:');let calls=0;const queries=[];
 const env={AUDIUS_API_KEY:'recommendations-fixture',AUDIUS_BEARER_TOKEN:'fixture',AUDIUS_HTTP:async url=>{
  calls++;queries.push(url.pathname.endsWith('/trending')?'genre:'+url.searchParams.get('genre'):url.searchParams.get('query'));
  return Response.json({data:[song('A1'),song('A2'),song('A3'),song('A4','Other','Pop'),song('A5','Artist','Electronic',{is_stream_gated:true})]});
 }};
 try{
  const empty=await recommendations(env,42,store);assert.equal(empty.personalized,false);assert.equal(calls,0);
  store.record(42,descriptor,'session-123456789',20);store.save(42,{...descriptor,id:'audius:A2',track_id:'A2'},true);
  const result=await recommendations(env,42,store);assert.deepEqual(queries.sort(),['Artist','genre:Electronic']);assert.deepEqual(result.items.map(t=>t.id),['audius:A3']);assert.equal(result.history_count,1);
  await recommendations(env,42,store);assert.equal(calls,2);
  store.save(42,{...descriptor,id:'audius:A3',track_id:'A3'},true);
  const changed=await recommendations(env,42,store);assert.deepEqual(changed.items.map(t=>t.id),[]);assert.equal(calls,4);
  assert.equal((await recommendations(env,99,store)).personalized,false);assert.equal(calls,4);
 }finally{store.close();}
});


test('style recommendations mix familiar artists with related discoveries, never title-only matches',async()=>{
 const store=new PersonalStore(':memory:');const calls=[];
 const played={...descriptor,title:'Мало',performer:'Favourite band',genre:'Hip-Hop/Rap',mood:'Chill',tags:['lofi','jazzy'],bpm:90};
 const candidate=(id,artist,genre,extra={})=>song(id,artist,genre,extra);
 const similar=candidate('S1','New artist','Hip-Hop/Rap',{title:'Completely different title',mood:'Chill',tags:'lofi,jazzy',bpm:92});
 const lessSimilar=candidate('S2','Another artist','Hip-Hop/Rap',{mood:'Energetic',tags:'hardcore',bpm:150});
 const namedOnly=candidate('BAD','Unrelated artist','Rock',{title:'Мало'});
 const familiar=Array.from({length:8},(_,i)=>candidate('F'+i,'Favourite band','Pop',{title:'Different '+i}));
 const env={AUDIUS_API_KEY:'style-fixture',AUDIUS_BEARER_TOKEN:'fixture',AUDIUS_HTTP:async url=>{
  calls.push(url);
  if(url.pathname.endsWith('/trending')){
   assert.equal(url.searchParams.get('genre'),'Hip-Hop/Rap');assert.equal(url.searchParams.has('query'),false);
   return Response.json({data:[lessSimilar,similar,namedOnly]});
  }
  assert.equal(url.searchParams.get('query'),'Favourite band');return Response.json({data:[...familiar,namedOnly]});
 }};
 try{
  store.record(42,played,'style-session-123456',20);
  const result=await recommendations(env,42,store),ids=result.items.map(t=>t.id);
  assert.equal(calls.length,2);assert.ok(ids.includes('audius:F0'));assert.ok(ids.includes('audius:S1'));assert.ok(ids.includes('audius:S2'));assert.ok(!ids.includes('audius:BAD'));
  assert.ok(ids.indexOf('audius:S1')<ids.indexOf('audius:S2'),'mood/tags/tempo should improve style ranking');
  assert.equal(result.items.filter(t=>t.performer==='Favourite band').length,3,'one artist cannot fill the recommendation list');
  assert.equal(styleSimilarity({...played,title:'Other'},played),styleSimilarity(played,played),'titles cannot affect similarity');
  assert.equal(styleSimilarity({...played,genre:'Rock'},played),0);
 }finally{store.close();}
});

test('missing style metadata uses verified artist matches without inventing a genre',async()=>{
 const store=new PersonalStore(':memory:');const env={AUDIUS_API_KEY:'no-style-fixture',AUDIUS_BEARER_TOKEN:'fixture',AUDIUS_HTTP:async url=>{
  assert.ok(url.pathname.endsWith('/search'));
  return Response.json({data:[song('A3'),song('BAD','Other artist','Pop',{title:'Artist'})]});
 }};
 try{
  store.record(42,{...descriptor,genre:''},'no-style-session-1234',20);
  const result=await recommendations(env,42,store);
  assert.deepEqual(result.items.map(t=>t.id),['audius:A3']);assert.match(result.reason,/не указан жанр/);
 }finally{store.close();}
});


test('account uses only authenticated Telegram identity and its own saved count',async()=>{
 const store=new PersonalStore(':memory:'),env={BOT_TOKEN:bot,PERSONAL_STORE:store};
 globalThis.fetch=()=>{throw Error('account must not call Telegram');};
 try{
  store.save(42,descriptor,true);
  assert.equal((await api.fetch(request('/api/account',{init_data:''}),env)).status,401);
  const body={init_data:signed(42,{first_name:'Anna',last_name:'Wave',username:'annawave'}),user_id:99};
  const response=await api.fetch(request('/api/account',body),env),result=await response.json();
  assert.deepEqual(result,{user:{id:42,first_name:'Anna',last_name:'Wave',username:'annawave'},saved_count:1});
  assert.equal((await(await api.fetch(request('/api/account',{},99),env)).json()).saved_count,0);
 }finally{store.close();}
});
