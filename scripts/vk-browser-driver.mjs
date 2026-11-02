// Admin-only browser probe. Chrome control travels over inherited pipes, not TCP.
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export const CONTROL_SOCKET='/run/wave-vk-browser/control.sock';
export const chromeArgs=profile=>['--user-data-dir='+profile,'--remote-debugging-pipe',
  '--no-first-run','--no-default-browser-check','--disable-dev-shm-usage','--start-maximized','https://vk.ru/audio'];

export class PipeRpc extends EventEmitter {
  constructor(input,output){
    super();this.input=input;this.pending=new Map();this.sequence=0;this.buffer=Buffer.alloc(0);this.closed=false;
    output.on('data',chunk=>{
      this.buffer=Buffer.concat([this.buffer,chunk]);
      if(this.buffer.length>8*1024*1024){this.close();return;}
      let end;
      while((end=this.buffer.indexOf(0))>=0){
        const frame=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);
        let message;try{message=JSON.parse(frame.toString());}catch{this.close();return;}
        if(message.id){const item=this.pending.get(message.id);if(!item)continue;clearTimeout(item.timer);this.pending.delete(message.id);
          if(message.error)item.reject(new Error('browser_command_failed'));else item.resolve(message.result||{});
        }else this.emit('event',message);
      }
    });
    for(const stream of [input,output])stream.on('error',()=>this.close());
    output.on('end',()=>this.close());
  }
  call(method,params={},sessionId,timeout=15000){
    if(this.closed)return Promise.reject(new Error('browser_unavailable'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('browser_timeout'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.input.write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
    });
  }
  close(){if(this.closed)return;this.closed=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('browser_unavailable'));}this.pending.clear();this.emit('closed');}
}

export function isMusicPage(raw){
  try{const url=new URL(raw);return url.protocol==='https:'&&['vk.ru','vk.com'].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&/^\/(audio(?:s\d+)?|music)(?:\/|$)/.test(url.pathname);}catch{return false;}
}

export function observation(params){
  const response=params?.response;if(!response)return null;
  let url;try{url=new URL(response.url);}catch{return null;}
  if(url.protocol!=='https:'||!Number.isInteger(response.status))return null;
  const mime=String(response.mimeType||'').toLowerCase();
  if(/(?:^|\.)(?:vk\.ru|vk\.com|vkuseraudio\.net|useraudio\.com|userapi\.com|vk-cdn\.net|vkuser\.net)$/.test(url.hostname)
      &&(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','application/vnd.apple.mpegurl','application/x-mpegurl'].includes(mime)
         ||params.type==='Media'&&mime==='application/octet-stream')){
    return {kind:'media',status:response.status,mime};
  }
  if(['vk.ru','vk.com','api.vk.ru','api.vk.com'].includes(url.hostname)){
    const match=/^\/method\/((?:audio|catalog|search)\.[A-Za-z]{1,50}|execute)$/.exec(url.pathname);
    if(match||url.pathname==='/al_audio.php')return {kind:'api',method:match?.[1]||'al_audio.php',status:response.status};
  }
  return null;
}

// Runs within the user's already authenticated page. Never reads/exports cookies.
export async function pageSearch(query,userId){
  if(location.protocol!=='https:'||!['vk.ru','vk.com'].includes(location.hostname))return {ok:false,code:'vk_page_required'};
  const current=Number(window.vk?.id);
  if(current===0)return {ok:false,code:'login_required'};
  if(Number.isSafeInteger(current)&&current>0&&current!==userId)return {ok:false,code:'different_account'};
  const response=await fetch('/al_audio.php',{method:'POST',credentials:'same-origin',redirect:'error',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},
    body:new URLSearchParams({al:'1',act:'section',claim:'0',is_layer:'0',owner_id:String(userId),section:'search',q:query}),signal:AbortSignal.timeout(12000)});
  if(response.status!==200){await response.body?.cancel();return {ok:false,code:'provider_http_error',status:response.status};}
  const reader=response.body.getReader();const chunks=[];let total=0;
  while(true){const item=await reader.read();if(item.done)break;total+=item.value.length;if(total>2*1024*1024){await reader.cancel();return {ok:false,code:'response_too_large'};}chunks.push(item.value);}
  const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  let value;try{value=JSON.parse(new TextDecoder().decode(data).trim().replace(/^<!--/,''));}catch{return {ok:false,code:'unexpected_response'};}
  const payload=value?.payload;
  const rawCode=Array.isArray(payload)?payload[0]:null;
  const code=typeof rawCode==='number'&&Number.isInteger(rawCode)&&Math.abs(rawCode)<100000?rawCode:
    typeof rawCode==='string'&&/^-?\d{1,5}$/.test(rawCode)?Number(rawCode):null;
  if(code!==0)return {ok:false,code:'provider_web_error',payload_code:code};
  const playlist=payload?.[1]?.[1]?.playlist;
  if(playlist===undefined||playlist!==null&&!Array.isArray(playlist.list))return {ok:false,code:'unexpected_response'};
  const clean=raw=>{const field=document.createElement('textarea');field.innerHTML=String(raw||'').replace(/<[^>]*>/g,'');return field.value.replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,180);};
  const rows=playlist?.list||[];const tracks=[];
  for(const row of rows){if(!Array.isArray(row)||typeof row[3]!=='string'||typeof row[4]!=='string')continue;
    tracks.push({artist:clean(row[4]),title:clean(row[3]),duration:Number.isFinite(row[5])&&row[5]>0?row[5]:0});if(tracks.length===8)break;}
  if(rows.length&&!tracks.length)return {ok:false,code:'unexpected_response'};
  return {ok:true,received:rows.length,tracks,playback_verified:false};
}

export function probeInput(body){
  if(!body||typeof body.query!=='string'||!body.query.trim()||body.query.length>200||/[\p{Cc}\p{Cf}]/u.test(body.query)
    ||!Number.isSafeInteger(body.user_id)||body.user_id<=0||body.user_id>=1e15)throw new Error('invalid_request');
  return {query:body.query.trim(),user_id:body.user_id};
}

export async function createControl(rpc,socketPath=CONTROL_SOCKET){
  const sessions=new Map();const recent=[];let busy=false;let scanning=false;
  rpc.on('event',message=>{
    if(message.method==='Network.responseReceived'){
      const entry=observation(message.params);if(entry){recent.push(entry);while(recent.length>20)recent.shift();}
    }
    if(message.method==='Target.detachedFromTarget')for(const [id,session]of sessions)if(session===message.params?.sessionId)sessions.delete(id);
  });
  async function pages(){
    const result=await rpc.call('Target.getTargets');const targets=(result.targetInfos||[]).filter(item=>item.type==='page'&&isMusicPage(item.url));
    for(const target of targets){
      if(!sessions.has(target.targetId)){
        const {sessionId}=await rpc.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});sessions.set(target.targetId,sessionId);
        await rpc.call('Network.enable',{},sessionId);
      }
    }
    return targets;
  }
  const timer=setInterval(async()=>{if(scanning)return;scanning=true;try{await pages();}catch{}finally{scanning=false;}},2000);
  timer.unref();
  const server=http.createServer(async(req,res)=>{
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(req.method==='GET'&&req.url==='/status'){json(200,{browser_ready:!rpc.closed,observed:recent});return;}
      if(req.method!=='POST'||req.url!=='/probe'){json(404,{ok:false,code:'not_found'});return;}
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096){json(413,{ok:false,code:'request_too_large'});return;}chunks.push(chunk);}
      let input;try{input=probeInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{json(400,{ok:false,code:'invalid_request'});return;}
      if(busy){json(429,{ok:false,code:'probe_busy'});return;}busy=true;
      try{
        let targets=[];for(let i=0;i<20;i++){targets=await pages();if(targets.length)break;await new Promise(resolve=>setTimeout(resolve,250));}
        if(!targets.length){json(409,{ok:false,code:'open_vk_music_page',observed:recent});return;}
        const sessionId=sessions.get(targets[0].targetId);
        const result=await rpc.call('Runtime.evaluate',{expression:`(${pageSearch.toString()})(${JSON.stringify(input.query)},${input.user_id})`,awaitPromise:true,returnByValue:true},sessionId,16000);
        if(result.exceptionDetails){json(502,{ok:false,code:'browser_request_failed',observed:recent});return;}
        json(200,{...result.result?.value,observed:recent});
      }finally{busy=false;}
    }catch{if(!res.headersSent)json(503,{ok:false,code:'browser_unavailable'});else res.destroy();}
  });
  server.on('close',()=>clearInterval(timer));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  await chmod(socketPath,0o600);return server;
}

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='/var/lib/wave-vk/profile'||process.getuid()===0)throw new Error('invalid_launch');
  process.umask(0o077);
  const browser=spawn('google-chrome',chromeArgs(process.argv[2]),{stdio:['ignore','ignore','inherit','pipe','pipe']});
  const rpc=new PipeRpc(browser.stdio[3],browser.stdio[4]);let server;
  const stop=()=>{server?.close();browser.kill('SIGTERM');rpc.close();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  browser.on('error',()=>{console.error('Не запустился Chrome.');process.exitCode=1;rpc.close();});
  browser.on('exit',code=>{server?.close();rpc.close();process.exitCode=code||0;});
  try{await rpc.call('Browser.getVersion');server=await createControl(rpc);}catch{stop();console.error('Не готов защищённый канал браузера.');process.exitCode=1;}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Проверка браузера не запустилась.');process.exitCode=1;});
