import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {PipeRpc,chromeArgs,isMusicPage,observation,requestObservation,readTrackRows,inspectMusicLayout,pageSearch,probeInput,createControl} from '../scripts/vk-browser-driver.mjs';

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

function row(artist,title,duration='3:20',id='1_2'){
 return {querySelector:selector=>({textContent:selector.includes('performer')?artist:selector.includes('title')?title:duration}),getAttribute:key=>key==='data-full-id'?id:null};
}
function evaluate(query,rows,user=42,urlQuery=query){
 const context=vm.createContext({location:{protocol:'https:',hostname:'vk.ru',href:'https://vk.ru/audios42?q='+encodeURIComponent(urlQuery)},window:{vk:{id:user}},
  document:{querySelectorAll:()=>rows},URL});
 return JSON.parse(JSON.stringify(vm.runInContext(`(${pageSearch.toString()})(${JSON.stringify(query)},42,${readTrackRows.toString()})`,context)));
}
test('native-page search keeps Cyrillic titles, prioritizes the artist, and rejects the observed unrelated chart',()=>{
 const result=evaluate('Queen',[row('ABBA','Dancing Queen','3:50','1_3'),row('Queen','The Show Must Go On','4:23'),row('INSTASAMKA','AGENT GIRL')]);
 assert.equal(result.ok,true);assert.equal(result.matched,2);assert.equal(result.tracks[0].artist,'Queen');assert.equal(result.tracks[0].duration,263);
 const cyrillic=evaluate('Король и Шут',[row('Король и Шут','Кукла колдуна')]);
 assert.equal(cyrillic.tracks[0].title,'Кукла колдуна');
 const chart=evaluate('Queen',[row('INSTASAMKA','AGENT GIRL'),row('Markul',''),row('shadowraze, genjutsu','1000-7')]);
 assert.equal(chart.ok,false);assert.equal(chart.code,'query_not_reflected');assert.equal(chart.tracks.length,0);assert.equal(chart.blank_titles,1);
 assert.equal(evaluate('Queen',[row('Queen','Song')],42,'Rammstein').code,'query_not_reflected');
 assert.equal(evaluate('Queen',[],0).code,'login_required');assert.equal(evaluate('Queen',[],99).code,'different_account');
 assert.equal(evaluate('Queen',[]).code,'music_rows_not_found');
});

test('native request discovery exports field names and fixed action names without credentials or search values',()=>{
 const result=requestObservation({request:{url:'https://vk.ru/al_audio.php?token=PRIVATE',method:'POST',headers:{Cookie:'PRIVATE'},postData:'act=section&section=search&search_q=PRIVATE&hash=PRIVATE&owner_id=123'}});
 assert.deepEqual(result,{kind:'request',method:'al_audio.php',http_method:'POST',fields:['act','section','owner_id','search_q','hash'],action:'section',section:'search'});
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 assert.equal(requestObservation({request:{url:'https://login.vk.ru',postData:'password=PRIVATE'}}),null);
 const malicious='Queen "); throw Error("PRIVATE"); //';assert.equal(evaluate(malicious,[]).ok,false);
 for(const data of [{query:'Queen',user_id:0},{query:'\nQueen',user_id:42},{query:'Queen',user_id:'42'}])assert.throws(()=>probeInput(data));
});

test('frame and testid diagnostics expose music structure without iframe credentials or login fields',()=>{
 const doc={readyState:'complete',body:{},location:{href:'https://vk.ru/audios42',origin:'https://vk.ru'},
  createTreeWalker:()=>({nextNode:()=>null}),
  querySelectorAll:selector=>selector==='iframe'?[{src:'https://music.vk.com/?access_token=PRIVATE#PRIVATE',contentDocument:null}]:
   selector==='[data-testid]'?['TopAudioPlayer_Title','AudioRow_Title','LoginForm_Password','AudioRow_?token=PRIVATE'].map(value=>({getAttribute:()=>value})):[]};
 const result=inspectMusicLayout(doc);
 assert.deepEqual(result.music_testids,['TopAudioPlayer_Title','AudioRow_Title']);
 assert.deepEqual(result.frames,[{host:'music.vk.com',path_kind:'other',readable_document:false,same_origin:false}]);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 assert.ok(!JSON.stringify(result).includes('Password'));
});

test('admin control socket is private and offers fixed probes rather than arbitrary evaluation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wave-vk-control-')),socket=join(dir,'control.sock');
 const rpc=new EventEmitter();rpc.closed=false;const calls=[];
 rpc.call=async(method,params,session)=>{calls.push({method,params,session});
  if(method==='Target.getTargets')return {targetInfos:[{type:'page',url:'https://vk.ru/audio',targetId:'page'}]};
  if(method==='Target.attachToTarget')return {sessionId:'session'};
  if(method==='Runtime.evaluate')return {result:{value:{ok:true,received:1,matched:1,tracks:[{artist:'Queen',title:'Song'}],playback_verified:false}}};
  return {};
 };
 let server;
 const request=body=>new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path:'/probe',method:'POST'},res=>{let data='';res.on('data',chunk=>{data+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end(JSON.stringify(body));});
 try{
  server=await createControl(rpc,socket);assert.equal((await stat(socket)).mode&0o777,0o600);
  assert.equal((await request({expression:'document.cookie'})).status,400);assert.equal(calls.length,0);
  const response=await request({query:'Queen',user_id:42,expression:'document.cookie'});assert.equal(response.body.ok,true);
  const expression=calls.find(call=>call.method==='Runtime.evaluate').params.expression;
  assert.ok(expression.includes('function pageSearch'));assert.ok(!expression.includes('document.cookie'));
  const navigation=calls.find(call=>call.method==='Page.navigate');assert.equal(navigation.params.url,'https://vk.ru/audios42?q=Queen');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('an already opened native search page is read without reloading it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wave-vk-warm-')),socket=join(dir,'control.sock');
 const rpc=new EventEmitter();rpc.closed=false;let navigated=false;
 rpc.call=async(method)=>{
  if(method==='Target.getTargets')return {targetInfos:[{type:'page',url:'https://vk.ru/audios42?q=Queen',targetId:'page'}]};
  if(method==='Target.attachToTarget')return {sessionId:'session'};
  if(method==='Page.navigate'){navigated=true;return {};}
  if(method==='Runtime.evaluate')return {result:{value:{ok:true,matched:1,tracks:[{artist:'Queen',title:'Song'}]}}};
  return {};
 };
 let server;
 try{
  server=await createControl(rpc,socket);
  const response=await new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path:'/probe',method:'POST'},res=>{let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve(JSON.parse(text)));});req.on('error',reject);req.end(JSON.stringify({query:'Queen',user_id:42}));});
  assert.equal(response.ok,true);assert.equal(navigated,false);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
