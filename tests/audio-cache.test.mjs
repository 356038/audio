import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AudioCache} from '../audio-cache.mjs';

async function fixture(options,run) {
  const directory=await mkdtemp(join(tmpdir(),'wave-cache-check-'));
  const cache=new AudioCache(directory,options);
  try{await cache.ready;await run(cache,directory);}finally{await cache.close();await rm(directory,{recursive:true,force:true});}
}
const bytes=Uint8Array.from({length:12},(_,i)=>i);
const audio=()=>new Response(bytes,{headers:{'Content-Type':'audio/mpeg','Content-Length':'12'}});
async function complete(cache){await Promise.all([...cache.entries.values()].map(entry=>entry.task).filter(Boolean));}

test('starts playback before the entire file arrives, then serves ranges without another download',async()=>{
  let upstream,downloads=0;
  await fixture({fetcher:async()=>{downloads++;return new Response(new ReadableStream({start(c){upstream=c;c.enqueue(bytes.slice(0,4));}}),{headers:{'Content-Length':'12','Content-Type':'audio/mpeg'}});}},async cache=>{
    const first=await cache.stream('private-key','https://example.invalid/song',12,'bytes=0-1');
    assert.equal(first.status,206);assert.equal(first.headers.get('X-Wave-Cache'),'FILL');
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())],[0,1]);
    assert.equal([...cache.entries.values()][0].complete,false);
    upstream.enqueue(bytes.slice(4));upstream.close();await complete(cache);
    const response=await cache.responseIfPresent('private-key','bytes=4-7');
    assert.equal(response.headers.get('X-Wave-Cache'),'HIT');
    assert.equal(response.headers.get('Content-Range'),'bytes 4-7/12');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[4,5,6,7]);
    const suffix=await cache.responseIfPresent('private-key','bytes=-3');
    assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())],[9,10,11]);
    assert.equal((await cache.responseIfPresent('private-key','bytes=100-')).status,416);
    assert.equal((await cache.responseIfPresent('private-key','bytes=-0')).status,416);
    assert.equal(downloads,1);
  });
});
test('simultaneous readers share one download and cancelled readers do not cancel it',async()=>{
  let downloads=0;
  await fixture({fetcher:async()=>{downloads++;return audio();}},async cache=>{
    const responses=await Promise.all([1,2,3].map(()=>cache.stream('same','https://example.invalid/audio',12,'bytes=0-3')));
    await responses[0].body.cancel();
    for(const response of responses.slice(1))assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,1,2,3]);
    await complete(cache);assert.equal(downloads,1);
    const full=await cache.responseIfPresent('same');assert.deepEqual([...new Uint8Array(await full.arrayBuffer())],[...bytes]);
  });
});
test('preparation downloads the next file and persistence survives service restart',async()=>{
  let downloads=0;
  await fixture({fetcher:async()=>{downloads++;return audio();}},async(cache,directory)=>{
    const state=await cache.prepare('next','https://example.invalid/next',12);
    assert.equal(typeof state.downloading,'boolean');await complete(cache);
    await cache.close();
    const restored=new AudioCache(directory,{fetcher:()=>{throw Error('must not download');}});
    try {
      const response=await restored.responseIfPresent('next','bytes=0-1');
      assert.equal(response.headers.get('X-Wave-Cache'),'HIT');
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,1]);
      const names=await readdir(directory);assert.ok(names.every(name=>/^[a-f0-9]{64}\.(bin|json)$/.test(name)));
      assert.equal((await stat(join(directory,names[0]))).mode&0o777,0o600);
    }finally{await restored.close();}
    assert.equal(downloads,1);
  });
});
test('disk usage is bounded and large files are rejected before download',async()=>{
  let downloads=0;
  await fixture({maxBytes:12,maxFile:12,fetcher:async()=>{downloads++;return audio();}},async cache=>{
    const first=await cache.stream('first','https://example.invalid/1',12);await first.arrayBuffer();await complete(cache);
    const second=await cache.stream('second','https://example.invalid/2',12);await second.arrayBuffer();await complete(cache);
    assert.equal(await cache.responseIfPresent('first'),null);assert.equal(cache.reserved,12);
    await assert.rejects(cache.stream('big','https://example.invalid/3',13));assert.equal(downloads,2);
  });
});
test('expired files are discarded and failed downloads can be retried',async()=>{
  let downloads=0;
  await fixture({ttl:15,fetcher:async()=>{downloads++;return audio();}},async cache=>{
    const response=await cache.stream('expires','https://example.invalid/audio',12);await response.arrayBuffer();await complete(cache);
    await new Promise(resolve=>setTimeout(resolve,25));assert.equal(await cache.responseIfPresent('expires'),null);
  });
  await fixture({fetcher:async()=>{downloads++;return downloads===2?new Response(bytes.slice(0,3),{headers:{'Content-Length':'12'}}):audio();}},async cache=>{
    await assert.rejects(async()=>{
      const broken=await cache.stream('retry','https://example.invalid/audio',12);
      await broken.arrayBuffer();
    });await complete(cache);
    const retry=await cache.stream('retry','https://example.invalid/audio',12);
    assert.deepEqual([...new Uint8Array(await retry.arrayBuffer())],[...bytes]);
  });
});
test('metadata cannot exceed the disk reservation and concurrency is bounded',async()=>{
  let upstream;
  await fixture({maxDownloads:1,fetcher:async()=>new Response(new ReadableStream({start(c){upstream=c;c.enqueue(bytes.slice(0,2));}}),{headers:{'Content-Length':'12'}})},async cache=>{
    const first=await cache.stream('one','https://example.invalid/1',12,'bytes=0-1');await first.arrayBuffer();
    await assert.rejects(cache.prepare('two','https://example.invalid/2',12));
    upstream.enqueue(bytes.slice(2));upstream.close();await complete(cache);
  });
});
test('tail metadata requests do not wait for the full sequential audio download',async()=>{
  const content=new Uint8Array(200000).fill(7);let writer,rangeCalls=0;
  await fixture({fetcher:async(url,options)=>{
    if(options.headers.Range){
      rangeCalls++;assert.equal(options.headers.Range,'bytes=199000-199999');
      return new Response(content.slice(199000),{status:206,headers:{'Content-Range':'bytes 199000-199999/200000'}});
    }
    return new Response(new ReadableStream({start(c){writer=c;c.enqueue(content.slice(0,2000));}}),{headers:{'Content-Length':'200000','Content-Type':'audio/mp4'}});
  }},async cache=>{
    const tail=await cache.stream('tail','https://example.invalid/song.m4a',content.length,'bytes=199000-199999');
    assert.equal(tail.headers.get('X-Wave-Cache'),'RANGE');
    assert.equal((await tail.arrayBuffer()).byteLength,1000);
    assert.equal([...cache.entries.values()][0].complete,false);
    assert.equal(rangeCalls,1);
    writer.enqueue(content.slice(2000));writer.close();await complete(cache);
  });
});
