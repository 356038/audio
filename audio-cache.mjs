// Private, bounded disk cache. Readers can consume bytes while a file downloads.
import {mkdir, readdir, readFile, writeFile, open, rename, unlink, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

export class AudioCache {
  constructor(directory, {fetcher=(...args)=>fetch(...args), maxBytes=256*1024*1024, maxFile=20*1024*1024, ttl=2*3600*1000, maxDownloads=3, maxEntries=64}={}) {
    this.directory=directory;this.fetcher=fetcher;this.maxBytes=maxBytes;this.maxFile=maxFile;this.ttl=ttl;this.maxDownloads=maxDownloads;
    this.maxEntries=maxEntries;this.entries=new Map();this.reserved=0;this.downloads=0;this.closed=false;
    this.ready=this.initialize();
    // Initialization errors are handled at the request boundary, never unhandled.
    this.ready.catch(()=>{});
    this.sweeper=setInterval(()=>this.ready.then(()=>this.makeRoom(0)).catch(()=>{}),60000);
    this.sweeper.unref();
  }
  hash(key) {return createHash('sha256').update(key).digest('hex');}
  path(id,suffix) {return join(this.directory,`${id}.${suffix}`);}
  async initialize() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    for(const name of await readdir(this.directory)) {
      if(/^[a-f0-9]{64}\.part$/.test(name)) {await unlink(join(this.directory,name)).catch(()=>{});continue;}
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const id=name.slice(0,-5);
      try {
        const meta=JSON.parse(await readFile(this.path(id,'json'),'utf8'));
        const info=await stat(this.path(id,'bin'));
        if(!Number.isSafeInteger(meta.size)||meta.size<1||meta.size>this.maxFile||info.size!==meta.size||!Number.isFinite(meta.created)||meta.created+this.ttl<=Date.now())throw Error('expired');
        const entry={id,size:meta.size,reserved:meta.size,created:meta.created,touched:meta.created,bytes:meta.size,complete:true,users:0,waiters:new Set(),mime:typeof meta.mime==='string'?meta.mime:'application/octet-stream'};
        entry.handle=await open(this.path(id,'bin'),'r');entry.ready=Promise.resolve();
        this.entries.set(id,entry);this.reserved+=entry.reserved;
      }catch{await unlink(this.path(id,'json')).catch(()=>{});await unlink(this.path(id,'bin')).catch(()=>{});}
    }
    // Remove orphaned completed files only from this app-owned directory.
    for(const name of await readdir(this.directory))if(/^[a-f0-9]{64}\.bin$/.test(name)&&!this.entries.has(name.slice(0,-4)))await unlink(join(this.directory,name)).catch(()=>{});
    await this.makeRoom(0);
  }
  async remove(entry) {
    if(entry.removing)return entry.removing;
    if(this.entries.get(entry.id)!==entry||entry.users||(!entry.complete&&!entry.error))return false;
    // Keep a tombstone until cleanup finishes; a retry must not create a new
    // file while the previous writer is still deleting the same path.
    entry.removing=(async()=>{
      await entry.handle?.close().catch(()=>{});
      for(const suffix of ['bin','part','json'])await unlink(this.path(entry.id,suffix)).catch(()=>{});
      if(this.entries.get(entry.id)===entry){this.entries.delete(entry.id);this.reserved-=entry.reserved;}
      return true;
    })();
    return entry.removing;
  }
  async makeRoom(bytes,reserveSlot=false) {
    const candidates=[...this.entries.values()].sort((a,b)=>a.touched-b.touched);
    for(const entry of candidates) {
      if(entry.created+this.ttl<=Date.now()||this.reserved+bytes>this.maxBytes||this.entries.size+(reserveSlot?1:0)>this.maxEntries)await this.remove(entry);
    }
    if(this.reserved+bytes>this.maxBytes||this.entries.size+(reserveSlot?1:0)>this.maxEntries)throw Error('Audio cache is busy');
  }
  notify(entry) {for(const callback of entry.waiters)callback();entry.waiters.clear();}
  async find(key) {
    await this.ready;
    const entry=this.entries.get(this.hash(key));
    if(!entry)return null;
    if(entry.error) {await this.remove(entry);return null;}
    if(entry.complete&&entry.created+this.ttl<=Date.now()&&!entry.users){await this.remove(entry);return null;}
    entry.touched=Date.now();return entry;
  }
  async start(key,url,fileSize) {
    const existing=await this.find(key);if(existing)return existing;
    if(this.closed||this.downloads>=this.maxDownloads)throw Error('Audio cache is busy');
    const reserved=Number.isSafeInteger(fileSize)&&fileSize>0?fileSize:this.maxFile;
    if(reserved>this.maxFile)throw Error('File too big');
    await this.makeRoom(reserved,true);
    // Recheck after asynchronous cleanup so parallel requests share one writer.
    const id=this.hash(key), raced=this.entries.get(id);if(raced)return raced;
    if(this.downloads>=this.maxDownloads||this.reserved+reserved>this.maxBytes||this.entries.size>=this.maxEntries)throw Error('Audio cache is busy');
    const entry={id,url,reserved,size:reserved,created:Date.now(),touched:Date.now(),bytes:0,complete:false,users:0,waiters:new Set(),controller:new AbortController()};
    this.entries.set(id,entry);this.reserved+=reserved;this.downloads++;
    let readyResolve,readyReject;
    entry.ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});entry.ready.catch(()=>{});
    entry.task=(async()=>{
      const timer=setTimeout(()=>entry.controller.abort(),120000);
      try {
        const response=await this.fetcher(url,{headers:{'Accept-Encoding':'identity'},redirect:'error',signal:entry.controller.signal});
        if(response.status!==200||!response.body)throw Error('Audio download failed');
        const length=Number(response.headers.get('Content-Length'))||fileSize;
        if(!Number.isSafeInteger(length)||length<1||length>this.maxFile||length>reserved)throw Error('Invalid audio length');
        entry.size=length;entry.mime=response.headers.get('Content-Type')||'application/octet-stream';
        entry.handle=await open(this.path(id,'part'),'wx+',0o600);readyResolve();
        for await(const chunk of response.body) {
          if(entry.bytes+chunk.length>entry.size)throw Error('Audio length mismatch');
          let written=0;
          while(written<chunk.length){const result=await entry.handle.write(chunk,written,chunk.length-written,entry.bytes+written);if(!result.bytesWritten)throw Error('Disk write failed');written+=result.bytesWritten;}
          entry.bytes+=chunk.length;this.notify(entry);
        }
        if(entry.bytes!==entry.size)throw Error('Truncated audio');
        await rename(this.path(id,'part'),this.path(id,'bin'));
        await writeFile(this.path(id,'json'),JSON.stringify({size:entry.size,mime:entry.mime,created:entry.created}),{mode:0o600});
        entry.complete=true;this.reserved-=entry.reserved-entry.size;entry.reserved=entry.size;this.notify(entry);
      } catch(error) {
        entry.controller.abort();
        entry.error=new Error('Audio cache download failed');readyReject(entry.error);this.notify(entry);
        if(!entry.users)await this.remove(entry);
      } finally {clearTimeout(timer);this.downloads--;}
    })();
    return entry;
  }
  async prepare(key,url,size) {
    const entry=await this.start(key,url,size);
    // Start a bounded download; never hold the request until the whole song arrives.
    return {ready:entry.complete,downloading:!entry.complete};
  }
  async responseIfPresent(key,range) {
    const entry=await this.find(key);return entry?this.response(entry,range):null;
  }
  async stream(key,url,size,range) {return this.response(await this.start(key,url,size),range);}
  async response(entry,range) {
    // Pin before waiting for headers, so eviction cannot close a reader's file.
    entry.users++;
    if(this.entries.get(entry.id)!==entry){entry.users--;throw Error('Cache entry evicted');}
    try{await entry.ready;if(entry.error)throw entry.error;}catch(error){entry.users--;await this.remove(entry);throw error;}
    let start=0,end=entry.size-1;
    if(range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2])){entry.users--;return this.invalidRange(entry.size);}
      if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      else{const suffix=Number(match[2]);start=Math.max(0,entry.size-suffix);if(!suffix)start=entry.size;}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=entry.size){entry.users--;return this.invalidRange(entry.size);}
    }
    // M4A and some other formats need metadata from the end of the file.
    // Do not force that small request to wait for a sequential full download.
    if(range&&!entry.complete&&entry.url&&start>entry.bytes+64*1024) {
      try {
        const upstream=await this.fetcher(entry.url,{headers:{Range:`bytes=${start}-${end}`,'Accept-Encoding':'identity'},redirect:'error',signal:AbortSignal.timeout(30000)});
        if(upstream.status===206&&upstream.headers.get('Content-Range')===`bytes ${start}-${end}/${entry.size}`) {
          entry.users--;
          return new Response(upstream.body,{status:206,headers:{'Content-Type':entry.mime,'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${entry.size}`,'Accept-Ranges':'bytes','X-Wave-Cache':'RANGE','Cache-Control':'no-store'}});
        }
        await upstream.body?.cancel();
      }catch{/* A server without usable ranges keeps the sequential path. */}
    }
    const headers=new Headers({'Content-Type':entry.mime,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','X-Wave-Cache':entry.complete?'HIT':'FILL','Cache-Control':'no-store'});
    if(range)headers.set('Content-Range',`bytes ${start}-${end}/${entry.size}`);
    let position=start,released=false;
    const release=()=>{if(!released){released=true;entry.users--;if(entry.error)this.remove(entry).catch(()=>{});}};
    const body=new ReadableStream({
      pull:async controller=>{
        try {
          while(!released&&entry.bytes<=position&&!entry.error&&!entry.complete)await new Promise(resolve=>entry.waiters.add(resolve));
          if(released)return;
          if(entry.error)throw entry.error;
          const available=Math.min(64*1024,entry.bytes-position,end-position+1);
          if(available<=0){if(position>end){release();controller.close();return;}throw Error('Incomplete audio');}
          const bytes=new Uint8Array(available);const result=await entry.handle.read(bytes,0,available,position);
          if(!result.bytesRead)throw Error('Audio read failed');
          position+=result.bytesRead;controller.enqueue(bytes.subarray(0,result.bytesRead));
          if(position>end){release();controller.close();}
        }catch(error){release();controller.error(new Error('Audio stream interrupted'));}
      },
      cancel:()=>{release();this.notify(entry);},
    });
    return new Response(body,{status:range?206:200,headers});
  }
  invalidRange(size){return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`,'X-Wave-Cache':'HIT'}});}
  async close() {
    this.closed=true;clearInterval(this.sweeper);await this.ready.catch(()=>{});
    for(const entry of this.entries.values())if(!entry.complete)entry.controller?.abort();
    await Promise.all([...this.entries.values()].map(entry=>entry.task).filter(Boolean));
    for(const entry of this.entries.values())await entry.handle?.close().catch(()=>{});
    this.entries.clear();this.reserved=0;
  }
}
