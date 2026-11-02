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

export function requestObservation(params){
  const request=params?.request;if(!request)return null;
  const entry=observation({response:{url:request.url,status:0,mimeType:'application/json'}});
  if(entry?.kind!=='api')return null;
  const allowed=['al','act','section','owner_id','q','search_q','search_query','query','offset','count','limit','start_from','section_id','ids','access_token','v','hash','audio_id','context','query_id'];
  let parameters;try{const url=new URL(request.url);parameters=new URLSearchParams(url.search);
    if(typeof request.postData==='string'&&request.postData.length<=32768)for(const [key,value]of new URLSearchParams(request.postData))parameters.append(key,value);
  }catch{return null;}
  const result={kind:'request',method:entry.method,http_method:request.method==='POST'?'POST':'GET',fields:allowed.filter(key=>parameters.has(key))};
  const actions=['section','load_section','load_catalog_section','reload_audio','search','search_audio','search_suggestions','get_suggestions'];
  if(actions.includes(parameters.get('act')))result.action=parameters.get('act');
  const sections=['search','all','my','general','recoms','explore','search_audio','audio','playlist','trends','top'];
  if(sections.includes(parameters.get('section')))result.section=parameters.get('section');
  return result;
}

// Reads rendered music rows rather than assuming a legacy API returned a search.
export function readTrackRows(query,doc=document){
  const normalize=value=>String(value||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const clean=value=>String(value||'').replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,180);
  const nodes=[...doc.querySelectorAll('.audio_row, .audio_item, [data-audio]')].slice(0,200);
  const tracks=[];let parsed=0,blank=0;const seen=new Set();
  for(const node of nodes){
    const text=selector=>node.querySelector(selector)?.textContent||'';
    let artist=text('.audio_row__performers, ._audio_row__performers, .audio_item__performer, .audio_row__performer');
    let title=text('.audio_row__title_inner, ._audio_row__title_inner, .audio_item__title, .audio_row__title');
    let duration=0,id=node.getAttribute('data-full-id');
    const time=text('.audio_row__duration, .audio_item__duration').trim();
    if(/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time))duration=time.split(':').reduce((seconds,part)=>seconds*60+Number(part),0);
    let data;try{const raw=node.getAttribute('data-audio');if(raw&&raw.length<32768)data=JSON.parse(raw);}catch{}
    if(Array.isArray(data)){
      if(!title&&typeof data[3]==='string')title=data[3].replace(/<[^>]*>/g,'');
      if(!artist&&typeof data[4]==='string')artist=data[4].replace(/<[^>]*>/g,'');
      if(!duration&&Number.isFinite(data[5]))duration=data[5];
      if(!id&&Number.isSafeInteger(data[0])&&Number.isSafeInteger(data[1]))id=data[1]+'_'+data[0];
    }else if(data&&typeof data==='object'){
      if(!title&&typeof data.title==='string')title=data.title;
      if(!artist&&typeof data.artist==='string')artist=data.artist;
      if(!duration&&Number.isFinite(data.duration))duration=data.duration;
    }
    artist=clean(artist);title=clean(title);if(!artist&&!title)continue;parsed++;
    if(!title){blank++;continue;}
    const key=artist+'\0'+title;if(seen.has(key))continue;seen.add(key);
    const q=normalize(query),artistName=normalize(artist),titleName=normalize(title);
    const matches=text=>(' '+text+' ').includes(' '+q+' ');
    if(!matches(artistName)&&!matches(titleName))continue;
    const rank=artistName===q?3:matches(artistName)?2:1;
    tracks.push({artist,title,duration:duration>0&&duration<86400?duration:0,...(/^-?\d+_\d+$/.test(id||'')?{id}:{}),rank});
  }
  tracks.sort((a,b)=>b.rank-a.rank);
  return {received:nodes.length,parsed_rows:parsed,blank_titles:blank,matched:tracks.length,
    tracks:tracks.slice(0,8).map(({rank,...track})=>track)};
}

// Runs on the native search page. Never reads/exports cookies or web API bodies.
export function pageSearch(query,userId,readRows){
  if(location.protocol!=='https:'||!['vk.ru','vk.com'].includes(location.hostname))return {ok:false,code:'vk_page_required'};
  const current=Number(window.vk?.id);
  if(current===0)return {ok:false,code:'login_required'};
  if(Number.isSafeInteger(current)&&current>0&&current!==userId)return {ok:false,code:'different_account'};
  if(new URL(location.href).searchParams.get('q')!==query)return {ok:false,code:'query_not_reflected'};
  const result=readRows(query);
  return {ok:result.matched>0,...(result.matched>0?{}:{code:result.parsed_rows?'query_not_reflected':'music_rows_not_found'}),
    query,mode:'native_search_page',...result,playback_verified:false};
}

export function probeInput(body){
  if(!body||typeof body.query!=='string'||!body.query.trim()||body.query.length>200||/[\p{Cc}\p{Cf}]/u.test(body.query)
    ||!Number.isSafeInteger(body.user_id)||body.user_id<=0||body.user_id>=1e15)throw new Error('invalid_request');
  return {query:body.query.trim(),user_id:body.user_id};
}

export async function createControl(rpc,socketPath=CONTROL_SOCKET){
  const sessions=new Map();const recent=[];let busy=false;let scanning=false;
  rpc.on('event',message=>{
    if(message.method==='Network.requestWillBeSent'){
      const entry=requestObservation(message.params);if(entry){recent.push(entry);while(recent.length>20)recent.shift();}
    }
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
        const origin=new URL(targets[0].url).origin;
        const navigation=await rpc.call('Page.navigate',{url:origin+'/audios'+input.user_id+'?q='+encodeURIComponent(input.query)},sessionId,5000);
        if(navigation.errorText){json(502,{ok:false,code:'native_page_navigation_failed',observed:recent});return;}
        let value={ok:false,code:'native_page_not_ready'};
        const deadline=Date.now()+11000;
        for(let attempt=0;attempt<24&&Date.now()<deadline;attempt++){
          await new Promise(resolve=>setTimeout(resolve,500));
          let result;try{result=await rpc.call('Runtime.evaluate',{expression:`(${pageSearch.toString()})(${JSON.stringify(input.query)},${input.user_id},${readTrackRows.toString()})`,returnByValue:true},sessionId,Math.max(100,Math.min(2000,deadline-Date.now())));}catch{continue;}
          if(result.exceptionDetails)continue;value=result.result?.value||value;
          if(value.ok||value.code==='login_required'||value.code==='different_account')break;
        }
        json(200,{...value,observed:recent});
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
