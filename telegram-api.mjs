// Telegram API service. BOT_TOKEN is a server secret, never a browser setting.
const encoder = new TextEncoder();
const MAX_FILE = 20 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function key(secret, usages) {
  return crypto.subtle.importKey('raw', typeof secret === 'string' ? encoder.encode(secret) : secret,
    {name: 'HMAC', hash: 'SHA-256'}, false, usages);
}
async function sign(secret, value) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), encoder.encode(value)));
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const base64 = value => btoa(String.fromCharCode(...encoder.encode(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unbase64 = value => new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4-value.length%4)%4)), c => c.charCodeAt(0)));
function bytesFromHex(value) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new ApiError(401, 'Недействительная подпись. Откройте приложение заново.');
  return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
}

export async function authenticate(initData, token) {
  if (typeof initData !== 'string' || initData.length > 16384) throw new ApiError(401, 'Откройте WAVE кнопкой приложения в Telegram.');
  const params = new URLSearchParams(initData);
  if ([...params.keys()].length !== new Set(params.keys()).size) throw new ApiError(401, 'Некорректная авторизация.');
  const hash = bytesFromHex(params.get('hash') || '');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = await sign('WebAppData', token);
  if (!await crypto.subtle.verify('HMAC', await key(secret, ['verify']), hash, encoder.encode(check))) {
    throw new ApiError(401, 'Подпись Telegram не прошла проверку.');
  }
  const date = Number(params.get('auth_date'));
  if (!Number.isInteger(date) || date < now()-3600 || date > now()+30) throw new ApiError(401, 'Сессия истекла. Закройте и заново откройте WAVE.');
  let user;
  try { user = JSON.parse(params.get('user')); } catch { /* rejected below */ }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new ApiError(401, 'Не удалось определить пользователя.');
  return user;
}

async function telegram(env, method, body) {
  let response, data;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    data = await response.json();
  } catch { throw new ApiError(502, 'Telegram временно недоступен. Попробуйте ещё раз.'); }
  if (!response.ok || !data.ok) {
    if (data.error_code === 429) throw new ApiError(429, 'Слишком много запросов. Подождите немного.');
    if (method === 'getFile' && /too big/i.test(data.description || '')) throw new ApiError(413, 'Этот файл превышает лимит скачивания Telegram Bot API.');
    throw new ApiError(502, method === 'getUserProfileAudios'
      ? 'Telegram не вернул музыку профиля. Нажмите Start у бота, проверьте доступность музыки профиля и попробуйте снова.'
      : 'Не удалось получить аудиофайл из Telegram.');
  }
  return data.result;
}

async function ticketFor(env, userId, audio) {
  const payload = base64(JSON.stringify({user: userId, file: audio.file_id, exp: now()+7200}));
  return `${payload}.${hex(await sign(env.BOT_TOKEN, `wave-stream:${payload}`))}`;
}
async function readTicket(env, value) {
  if (!value || value.length > 4096) throw new ApiError(401, 'Ссылка воспроизведения недействительна.');
  const [payload, signature, extra] = value.split('.');
  if (extra || !payload) throw new ApiError(401, 'Ссылка воспроизведения недействительна.');
  const valid = await crypto.subtle.verify('HMAC', await key(env.BOT_TOKEN, ['verify']), bytesFromHex(signature || ''), encoder.encode(`wave-stream:${payload}`));
  if (!valid) throw new ApiError(401, 'Ссылка воспроизведения недействительна.');
  let data;
  try { data = JSON.parse(unbase64(payload)); } catch { throw new ApiError(401, 'Некорректная ссылка.'); }
  if (!Number.isSafeInteger(data.user) || typeof data.file !== 'string' || !data.file || !Number.isInteger(data.exp) || data.exp <= now()) {
    throw new ApiError(401, 'Ссылка истекла. Обновите список музыки.');
  }
  return data;
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ok: true, configured: Boolean(env.BOT_TOKEN)});
  if (!env.BOT_TOKEN) throw new ApiError(503, 'Сервис музыки ещё не подключён.');
  if (url.pathname === '/api/profile-audios' && request.method === 'POST') {
    const bodyText = await request.text();
    if (bodyText.length > 20000) throw new ApiError(413, 'Слишком большой запрос.');
    let body;
    try { body = JSON.parse(bodyText); } catch { throw new ApiError(400, 'Некорректный запрос.'); }
    const user = await authenticate(body?.init_data, env.BOT_TOKEN);
    const offset = body.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'Некорректная страница.');
    // Always use the authenticated identity; never accept a client-supplied user_id.
    const result = await telegram(env, 'getUserProfileAudios', {user_id: user.id, offset, limit: 100});
    if (!Array.isArray(result?.audios) || !Number.isInteger(result.total_count)) throw new ApiError(502, 'Неожиданный ответ Telegram.');
    const tracks = await Promise.all(result.audios.map(async audio => ({
      id: audio.file_unique_id, title: audio.title || audio.file_name || 'Без названия',
      performer: audio.performer || '', duration: audio.duration || 0,
      playable: !audio.file_size || audio.file_size <= MAX_FILE,
      stream_url: !audio.file_size || audio.file_size <= MAX_FILE
        ? `${url.origin}/api/stream?ticket=${encodeURIComponent(await ticketFor(env, user.id, audio))}` : null,
    })));
    return Response.json({tracks, total_count: result.total_count,
      next_offset: tracks.length && offset+tracks.length < result.total_count ? offset+tracks.length : null});
  }
  if (url.pathname === '/api/stream' && request.method === 'GET') {
    const ticket = await readTicket(env, url.searchParams.get('ticket'));
    const file = await telegram(env, 'getFile', {file_id: ticket.file});
    if (file.file_size > MAX_FILE) throw new ApiError(413, 'Файл превышает лимит Telegram Bot API.');
    if (typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.includes('..') || file.file_path.startsWith('/')) {
      throw new ApiError(502, 'Telegram не предоставил путь аудиофайла.');
    }
    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range) || range === 'bytes=-') throw new ApiError(416, 'Некорректный диапазон.');
      headers.set('Range', range);
    }
    let upstream;
    try { upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`, {headers, redirect: 'error', signal: AbortSignal.timeout(30000)}); }
    catch { throw new ApiError(502, 'Не удалось загрузить аудио из Telegram.'); }
    if (![200, 206, 416].includes(upstream.status)) throw new ApiError(502, 'Аудиофайл сейчас недоступен.');
    const out = new Headers();
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      if (upstream.headers.has(name)) out.set(name, upstream.headers.get(name));
    }
    out.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    return new Response(upstream.body, {status: upstream.status, headers: out});
  }
  throw new ApiError(404, 'Не найдено.');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = env.FRONTEND_ORIGIN || 'https://356038.github.io';
    if (origin && origin !== allowed) return new Response('Forbidden', {status: 403});
    let response;
    try {
      response = request.method === 'OPTIONS' ? new Response(null, {status: 204}) : await route(request, env);
    } catch (error) {
      response = Response.json({error: error instanceof ApiError ? error.message : 'Внутренняя ошибка сервиса.'}, {status: error instanceof ApiError ? error.status : 500});
    }
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
    headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    headers.set('Vary', 'Origin');
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {status: response.status, headers});
  },
};
