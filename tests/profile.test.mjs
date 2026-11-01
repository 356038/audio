import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import api, {authenticate} from '../telegram-api.mjs';

const BOT_TOKEN = '123456:unit-test-only';
const origin = 'https://wave.example';
const env = {BOT_TOKEN, FRONTEND_ORIGIN: origin};
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});

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
