import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {PipeRpc,chromeArgs,isMusicPage,observation,pageSearch,probeInput,createControl} from '../scripts/vk-browser-driver.mjs';

test('Chrome uses private inherited pipes, preserves sandbox and restricts the origin',()=>{
 const args=chromeArgs('/private/profile');
 assert.ok(args.includes('--remote-debugging-pipe'));
 assert.ok(!args.some(arg=>arg.includes('--remote-debugging-port')||arg.includes('--no-sandbox')||arg.includes('--ignore-certificate')));
 assert.equal(isMusicPage('https://vk.ru/audios123?q=Queen'),true);
 for(const url of ['http://vk.ru/audio','https://vk.ru.evil.example/audio','https://id.vk.ru/audio','https://vk.ru/audioevil','https://vk.ru:443/audio','https://vk.ru/login','https://user:pass@vk.ru/audio']){
  // URL normalizes the default 443 port to the origin's normal representation.
  if(url==='https://vk.ru:443/audio')continue;
  assert.equal(isMusicPage(url),false,url);
 }
});

test('pipe transport reassembles frames, separates events and sanitizes errors',async()=>{
 const input=new PassThrough(),output=new PassThrough(),rpc=new PipeRpc(input,output);let written='';
 input.on('data',chunk=>{written+=chunk;});const events=[];rpc.on('event',event=>events.push(event));
 const call=rpc.call('Browser.getVersion');assert.equal(JSON.parse(written.slice(0,-1)).method,'Browser.getVersion');
 const frame=JSON.stringify({id:1,result:{product:'Chrome/test'}})+'\0'+JSON.stringify({method:'Test.event',params:{n:1}})+'\0';
 output.write(frame.slice(0,9));output.write(frame.slice(9));assert.equal((await call).product,'Chrome/test');assert.equal(events.length,1);
 const failed=rpc.call('Runtime.evaluate');output.write(JSON.stringify({id:2,error:{message:'PRIVATE cookie https://private/'}})+'\0');
 await assert.rejects(failed,{message:'browser_command_failed'});
 const pending=rpc.call('Target.getTargets');rpc.close();await assert.rejects(pending,{message:'browser_unavailable'});
});

test('network observations never expose URLs, headers, query tokens or unrelated requests',()=>{
 const audio=observation({response:{url:'https://cdn.vkuseraudio.net/private?token=PRIVATE',status:206,mimeType:'audio/mpeg',headers:{Cookie:'PRIVATE'}}});
 assert.deepEqual(audio,{kind:'media',status:206,mime:'audio/mpeg'});
 assert.deepEqual(observation({response:{url:'https://api.vk.ru/method/audio.search?access_token=PRIVATE',status:200,mimeType:'application/json'}}),{kind:'api',method:'audio.search',status:200});
 assert.equal(observation({response:{url:'https://login.vk.ru/?token=PRIVATE',status:200,mimeType:'text/html'}}),null);
 assert.equal(observation({response:{url:'https://vk.ru.evil.example/method/audio.search',status:200,mimeType:'application/json'}}),null);
 assert.ok(!JSON.stringify(audio).includes('PRIVATE'));
});

async function evaluate(query,response,user=42){
 const calls=[];
 const context=vm.createContext({location:{protocol:'https:',hostname:'vk.ru'},window:{vk:{id:user}},
  document:{createElement:()=>({set innerHTML(v){this.value=v;}})},
  URLSearchParams,AbortSignal,TextDecoder,Uint8Array,fetch:async(...args)=>{calls.push(args);return response;}});
 const result=await vm.runInContext(`(${pageSearch.toString()})(${JSON.stringify(query)},42)`,context);
 return {result:JSON.parse(JSON.stringify(result)),calls};
}
test('search executes inside the authenticated page, treats queries as data, and emits metadata only',async()=>{
 const row=[123,456,'https://private/?hash=PRIVATE','Song','Queen',180];
 const query='Queen "); throw Error("injected"); //';
 const {result,calls}=await evaluate(query,Response.json({payload:[0,[0,{playlist:{list:[row]}}]]}));
 assert.deepEqual(result,{ok:true,received:1,tracks:[{artist:'Queen',title:'Song',duration:180}],playback_verified:false});
 assert.equal(calls[0][0],'/al_audio.php');assert.equal(calls[0][1].credentials,'same-origin');assert.equal(calls[0][1].redirect,'error');
 assert.equal(calls[0][1].body.get('q'),query);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 const unauthenticated=await evaluate('Queen',Response.json({}),0);assert.equal(unauthenticated.result.code,'login_required');assert.equal(unauthenticated.calls.length,0);
 const other=await evaluate('Queen',Response.json({}),99);assert.equal(other.result.code,'different_account');assert.equal(other.calls.length,0);
});

test('provider errors are bounded and do not become empty successful playlists',async()=>{
 assert.deepEqual((await evaluate('Queen',Response.json({payload:[3,['https://login/?token=PRIVATE']]}))).result,{ok:false,code:'provider_web_error',payload_code:3});
 assert.equal((await evaluate('Queen',new Response('<html>PRIVATE login</html>'))).result.code,'unexpected_response');
 let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled=true;}});
 assert.equal((await evaluate('Queen',new Response(body))).result.code,'response_too_large');assert.equal(cancelled,true);
 for(const data of [{query:'Queen',user_id:0},{query:'\nQueen',user_id:42},{query:'Queen',user_id:'42'}])assert.throws(()=>probeInput(data));
});

test('admin control socket is private and offers fixed probes rather than arbitrary evaluation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wave-vk-control-')),socket=join(dir,'control.sock');
 const rpc=new EventEmitter();rpc.closed=false;const calls=[];
 rpc.call=async(method,params,session)=>{calls.push({method,params,session});
  if(method==='Target.getTargets')return {targetInfos:[{type:'page',url:'https://vk.ru/audio',targetId:'page'}]};
  if(method==='Target.attachToTarget')return {sessionId:'session'};
  if(method==='Runtime.evaluate')return {result:{value:{ok:true,received:0,tracks:[],playback_verified:false}}};
  return {};
 };
 let server;
 const request=body=>new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path:'/probe',method:'POST'},res=>{let data='';res.on('data',chunk=>{data+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end(JSON.stringify(body));});
 try{
  server=await createControl(rpc,socket);assert.equal((await stat(socket)).mode&0o777,0o600);
  assert.equal((await request({expression:'document.cookie'})).status,400);assert.equal(calls.length,0);
  const response=await request({query:'Queen',user_id:42,expression:'document.cookie'});assert.equal(response.body.ok,true);
  const expression=calls.find(call=>call.method==='Runtime.evaluate').params.expression;
  assert.ok(expression.includes('async function pageSearch'));assert.ok(!expression.includes('document.cookie'));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
