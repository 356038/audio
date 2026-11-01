import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AudioCache} from '../audio-cache.mjs';
import api, {authenticate, clearFileCache} from '../telegram-api.mjs';

const BOT_TOKEN = '123456:unit-test-only';
const origin = 'https://wave.example';
const env = {BOT_TOKEN, FRONTEND_ORIGIN: origin};
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;clearFileCache();});

function initData(overrides = {}) {
  const data = new URLSearchParams({auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({id:42, first_name:'Test'}), ...overrides});
  const check = [...data.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  data.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return data.toString();
}
const request = body => new Request(`${origin}/api/profile-audios`, {method:'POST', headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
const ok = result => Response.json({ok:true,result});

test('valid Telegram signature authenticates the user', async () => {
  assert.equal((await authenticate(initData(), BOT_TOKEN)).id,42);
});
test('forged, stale, future and duplicate initData are rejected', async () => {
  await assert.rejects(authenticate(initData().replace('Test','Other'),BOT_TOKEN));
  await assert.rejects(authenticate(initData({auth_date:'1'}),BOT_TOKEN));
  await assert.rejects(authenticate(initData({auth_date:String(Math.floor(Date.now()/1000)+300)}),BOT_TOKEN));
  await assert.rejects(authenticate(initData()+'&user=%7B%22id%22%3A99%7D',BOT_TOKEN));
});
test('unauthenticated requests never reach Telegram', async () => {
  globalThis.fetch = () => {throw new Error('must not call upstream');};
  assert.equal((await api.fetch(request({init_data:''}),env)).status,401);
});
test('profile uses authenticated user, returns pagination and playable tickets', async () => {
  globalThis.fetch = async (url, options) => {
    assert.match(url,/\/getUserProfileAudios$/);
    assert.deepEqual(JSON.parse(options.body),{user_id:42,offset:100,limit:100});
    return ok({total_count:102,audios:[{file_id:'allowed-file',file_unique_id:'unique',title:'Test',duration:12,file_size:1000}]});
  };
  const response = await api.fetch(request({init_data:initData(),user_id:99,offset:100}),env);
  assert.equal(response.status,200);
  const result = await response.json();
  assert.equal(result.next_offset,101);
  assert.equal(result.tracks[0].playable,true);
  assert.ok(result.tracks[0].stream_url.startsWith(`${origin}/api/stream?ticket=`));
  assert.ok(!JSON.stringify(result).includes(BOT_TOKEN));
});
test('empty profiles and oversized audio are represented honestly', async () => {
  globalThis.fetch = async () => ok({total_count:0,audios:[]});
  assert.deepEqual(await (await api.fetch(request({init_data:initData()}),env)).json(),{tracks:[],total_count:0,next_offset:null});
  globalThis.fetch = async () => ok({total_count:1,audios:[{file_id:'big',file_unique_id:'id',file_size:30*1024*1024}]});
  const result = await (await api.fetch(request({init_data:initData()}),env)).json();
  assert.equal(result.tracks[0].playable,false);
  assert.equal(result.tracks[0].stream_url,null);
});
test('stream delivers bytes and Range without exposing the bot token', async () => {
  globalThis.fetch = async () => ok({total_count:1,audios:[{file_id:'file',file_unique_id:'id'}]});
  const list = await (await api.fetch(request({init_data:initData()}),env)).json();
  const streamUrl = list.tracks[0].stream_url;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (url.endsWith('/getFile')) {
      assert.deepEqual(JSON.parse(options.body),{file_id:'file'});
      return ok({file_path:'music/file_1.mp3',file_size:100});
    }
    assert.ok(url.startsWith('https://api.telegram.org/file/bot'));
    assert.equal(options.headers.get('Range'),'bytes=0-2');
    return new Response(new Uint8Array([1,2,3]),{status:206,headers:{'Content-Type':'audio/mpeg','Content-Range':'bytes 0-2/100'}});
  };
  const response = await api.fetch(new Request(streamUrl,{headers:{Range:'bytes=0-2'}}),env);
  assert.equal(response.status,206);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);
  assert.equal(response.headers.get('Content-Range'),'bytes 0-2/100');
  assert.ok(!JSON.stringify([...response.headers]).includes(BOT_TOKEN));
  assert.equal(calls,2);
});
test('tampered and expired stream tickets cannot retrieve files', async () => {
  globalThis.fetch = () => {throw new Error('must not call upstream');};
  assert.equal((await api.fetch(new Request(`${origin}/api/stream?ticket=bad.abc`),env)).status,401);
  const payload = Buffer.from(JSON.stringify({user:42,file:'file',exp:1})).toString('base64url');
  const signature = createHmac('sha256',BOT_TOKEN).update(`wave-stream:${payload}`).digest('hex');
  assert.equal((await api.fetch(new Request(`${origin}/api/stream?ticket=${payload}.${signature}`),env)).status,401);
});
test('profile artwork is fetched privately and receives an image MIME type', async () => {
  globalThis.fetch = async () => ok({total_count:1,audios:[{file_id:'song',file_unique_id:'song-id',thumbnail:{file_id:'cover',file_unique_id:'cover-id'}}]});
  const result = await (await api.fetch(request({init_data:initData()}),env)).json();
  const artwork = result.tracks[0].artwork_url;
  assert.ok(artwork.startsWith(`${origin}/api/artwork?ticket=`));
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/getFile')) {
      assert.deepEqual(JSON.parse(options.body),{file_id:'cover'});
      return ok({file_path:'thumbnails/file_1.jpg',file_size:4});
    }
    return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'application/octet-stream'}});
  };
  const response = await api.fetch(new Request(artwork),env);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Type'),'image/jpeg');
  assert.equal((await response.arrayBuffer()).byteLength,4);
});
test('artwork and audio tickets cannot be interchanged', async () => {
  globalThis.fetch = async () => ok({total_count:1,audios:[{file_id:'song',file_unique_id:'id',thumbnail:{file_id:'cover'}}]});
  const {tracks} = await (await api.fetch(request({init_data:initData()}),env)).json();
  globalThis.fetch = () => {throw new Error('must not call Telegram');};
  assert.equal((await api.fetch(new Request(tracks[0].artwork_url.replace('/api/artwork','/api/stream')),env)).status,401);
  assert.equal((await api.fetch(new Request(tracks[0].stream_url.replace('/api/stream','/api/artwork')),env)).status,401);
});
test('Telegram failure is sanitised, CORS is restricted, missing config is explicit', async () => {
  globalThis.fetch = async () => Response.json({ok:false,error_code:400,description:`private ${BOT_TOKEN}`},{status:400});
  const response = await api.fetch(request({init_data:initData()}),env);
  assert.equal(response.status,502);assert.ok(!(await response.text()).includes(BOT_TOKEN));
  assert.equal((await api.fetch(new Request(`${origin}/api/profile-audios`,{method:'POST',headers:{Origin:'https://untrusted.example'}}),env)).status,403);
  assert.equal((await api.fetch(request({init_data:initData()}),{FRONTEND_ORIGIN:origin})).status,503);
});
test('preparing the next track coalesces lookups and reuses them for Range requests', async () => {
  globalThis.fetch = async () => ok({total_count:1,audios:[{file_id:'cached-song',file_unique_id:'id'}]});
  const {tracks} = await (await api.fetch(request({init_data:initData()}),env)).json();
  const stream = tracks[0].stream_url;
  let lookups=0, downloads=0;
  globalThis.fetch = async (url,options) => {
    if(url.endsWith('/getFile')) {
      lookups++;
      await new Promise(resolve=>setTimeout(resolve,30));
      return ok({file_path:'music/cached.mp3',file_size:100});
    }
    downloads++;
    assert.equal(options.headers.get('Range'),'bytes=0-2');
    return new Response(new Uint8Array([1,2,3]),{status:206,headers:{'Content-Range':'bytes 0-2/100','Content-Type':'audio/mpeg'}});
  };
  const prepares = await Promise.all([1,2,3].map(()=>api.fetch(new Request(stream.replace('/api/stream','/api/prepare')),env)));
  assert.ok(prepares.every(response=>response.status===200));
  assert.equal(lookups,1);assert.equal(downloads,0);
  for(let i=0;i<2;i++) {
    const response=await api.fetch(new Request(stream,{headers:{Range:'bytes=0-2'}}),env);
    assert.equal(response.status,206);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.match(response.headers.get('Server-Timing'),/telegram_file;dur=/);
    await response.arrayBuffer();
  }
  assert.equal(lookups,1);assert.equal(downloads,2);
});
test('failed file lookups are not cached and unsigned preparation is rejected', async () => {
  globalThis.fetch = async () => ok({total_count:1,audios:[{file_id:'retry-song',file_unique_id:'id'}]});
  const {tracks} = await (await api.fetch(request({init_data:initData()}),env)).json();
  const prepare=tracks[0].stream_url.replace('/api/stream','/api/prepare');
  let calls=0;
  globalThis.fetch = async () => ++calls===1
    ? Response.json({ok:false,error_code:400},{status:400})
    : ok({file_path:'music/retry.mp3',file_size:100});
  assert.equal((await api.fetch(new Request(prepare),env)).status,502);
  assert.equal((await api.fetch(new Request(prepare),env)).status,200);
  assert.equal(calls,2);
  assert.equal((await api.fetch(new Request(`${origin}/api/prepare`),env)).status,401);
  assert.equal(calls,2);
});
test('authenticated preparation fills the disk cache, and cached streams skip Telegram',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wave-api-cache-'));
  const cache=new AudioCache(directory);
  try {
    globalThis.fetch=async()=>ok({total_count:1,audios:[{file_id:'disk-song',file_unique_id:'id',file_size:4}]});
    const {tracks}=await(await api.fetch(request({init_data:initData()}),env)).json();
    let lookups=0,downloads=0;
    globalThis.fetch=async url=>{
      if(url.endsWith('/getFile')){lookups++;return ok({file_path:'music/disk.mp3',file_size:4});}
      downloads++;return new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'audio/mpeg','Content-Length':'4'}});
    };
    const configured={...env,AUDIO_CACHE:cache};
    const prepared=await api.fetch(new Request(tracks[0].stream_url.replace('/api/stream','/api/prepare')),configured);
    assert.equal(prepared.status,200);
    await Promise.all([...cache.entries.values()].map(entry=>entry.task).filter(Boolean));
    clearFileCache();
    const cached=await api.fetch(new Request(tracks[0].stream_url,{headers:{Range:'bytes=1-2'}}),configured);
    assert.equal(cached.status,206);assert.equal(cached.headers.get('X-Wave-Cache'),'HIT');
    assert.equal(cached.headers.get('X-Accel-Buffering'),'no');
    assert.deepEqual([...new Uint8Array(await cached.arrayBuffer())],[2,3]);
    assert.equal(lookups,1);assert.equal(downloads,1);
    assert.equal((await api.fetch(new Request(`${origin}/api/stream?ticket=invalid`),configured)).status,401);
  }finally{await cache.close();await rm(directory,{recursive:true,force:true});}
});
test('generic cached MP3 responses use signed profile metadata for their audio MIME',async()=>{
  globalThis.fetch=async()=>ok({total_count:1,audios:[{file_id:'mime-song',file_unique_id:'id',mime_type:'application/octet-stream',file_name:'song.MP3'}]});
  const {tracks}=await(await api.fetch(request({init_data:initData()}),env)).json();
  let reads=0;
  const cachedEnv={...env,AUDIO_CACHE:{responseIfPresent:async()=>{
    reads++;return new Response(new Uint8Array([1,2]),{status:206,headers:{'Content-Type':'application/octet-stream','Content-Range':'bytes 0-1/10'}});
  }}};
  globalThis.fetch=()=>{throw Error('must not contact Telegram for a cached file');};
  const response=await api.fetch(new Request(tracks[0].stream_url,{headers:{Range:'bytes=0-1'}}),cachedEnv);
  assert.equal(response.status,206);assert.equal(response.headers.get('Content-Type'),'audio/mpeg');
  assert.equal(response.headers.get('Content-Range'),'bytes 0-1/10');
  assert.equal((await response.arrayBuffer()).byteLength,2);assert.equal(reads,1);
});
test('generic uncached audio uses the Telegram file extension without changing bytes',async()=>{
  globalThis.fetch=async()=>ok({total_count:1,audios:[{file_id:'mime-m4a',file_unique_id:'id'}]});
  const {tracks}=await(await api.fetch(request({init_data:initData()}),env)).json();
  globalThis.fetch=async url=>url.endsWith('/getFile')?ok({file_path:'music/file.m4a',file_size:2}):new Response(new Uint8Array([3,4]),{headers:{'Content-Type':'application/octet-stream'}});
  const response=await api.fetch(new Request(tracks[0].stream_url),env);
  assert.equal(response.headers.get('Content-Type'),'audio/mp4');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[3,4]);
});
