// Dependency-free Node.js 22.13+ server. Serves the Mini App and its Telegram API.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import api from './telegram-api.mjs';
import {AudioCache} from './audio-cache.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {audiusFetch} from './audius.mjs';
import {PersonalStore} from './personal-store.mjs';

export function createServer(env = process.env) {
  const publicOrigin = env.FRONTEND_ORIGIN;
  if (!publicOrigin || !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('Set FRONTEND_ORIGIN to the public HTTPS origin (without a trailing slash).');
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
    ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ]);
  const cache = env.WAVE_CACHE_DISABLED === '1' ? null : new AudioCache(
    env.WAVE_CACHE_DIR || join(env.STATE_DIRECTORY || tmpdir(), 'wave-audio-cache'),{
      fetcher:(url,options)=>new URL(url).hostname==='api.telegram.org'?fetch(url,options):audiusFetch(url,options,env),
    });
  const personal=new PersonalStore(join(env.WAVE_DATA_DIR||env.STATE_DIRECTORY||join(tmpdir(),'wave-personal'),'library.sqlite'));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, publicOrigin);
      if (url.origin !== publicOrigin) {res.writeHead(400); res.end(); return;}
      if (req.method === 'GET' && url.pathname === '/config.js') {
        res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
        const theme = env.WAVE_THEME === 'default' ? 'default' : 'halloween';
        res.end(`window.WAVE_API_BASE = ${JSON.stringify(publicOrigin)};window.WAVE_THEME = ${JSON.stringify(theme)};window.WAVE_SEARCH_CONFIGURED = ${Boolean(env.AUDIUS_API_KEY&&env.AUDIUS_BEARER_TOKEN)};`); return;
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [name, type] = staticFiles.get(url.pathname);
        const data = await readFile(fileURLToPath(new URL(`./docs/${name}`, import.meta.url)));
        res.writeHead(200, {'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer'});
        res.end(data); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20000) {res.writeHead(413); res.end(); return;}
        chunks.push(chunk);
      }
      const response = await api.fetch(new Request(url, {
        method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      }), {...env, FRONTEND_ORIGIN: publicOrigin, AUDIO_CACHE:cache, PERSONAL_STORE:personal});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch {
      if (res.headersSent) {res.destroy();return;}
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Сервис временно недоступен.'}));
    }
  });
  server.once('close',()=>{cache?.close().catch(()=>{});personal.close();});
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8000);
  createServer().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`WAVE listening on port ${port}`));
}
