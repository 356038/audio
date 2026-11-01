'use strict';
const $ = selector => document.querySelector(selector);
const player = $('#player');
const telegram = window.Telegram?.WebApp;
const apiBase = (window.WAVE_API_BASE || '').replace(/\/$/, '');
let tracks = [], current = -1, nextOffset = null, mode = 'profile', busy = false, records = [], generation = 0;
telegram?.ready();
telegram?.expand();

function log(event) {
  records.push({at: new Date().toISOString(), event, position: +player.currentTime.toFixed(2), visibility: document.visibilityState});
  records = records.slice(-300);
  // Never export initData, profile details, file IDs or signed streaming URLs.
  $('#log').textContent = records.slice(-30).map(r => `${r.at} | ${r.event} | ${r.position}с | ${r.visibility}`).join('\n');
}
function duration(seconds) { return `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`; }
function render() {
  const query = $('#search').value.toLocaleLowerCase();
  $('#tracks').replaceChildren();
  tracks.forEach((track, index) => {
    if (!`${track.title} ${track.performer}`.toLocaleLowerCase().includes(query)) return;
    const li = document.createElement('li'), button = document.createElement('button'), detail = document.createElement('small');
    button.type = 'button'; button.className = `track${current === index ? ' active' : ''}`;
    button.textContent = track.title; button.disabled = !track.playable;
    detail.textContent = [track.performer, duration(track.duration), track.playable ? '' : 'Файл превышает лимит Telegram'].filter(Boolean).join(' · ');
    button.append(detail); button.onclick = () => select(index, true); li.append(button); $('#tracks').append(li);
  });
  $('#more').hidden = nextOffset === null || mode !== 'profile';
  $('#more').disabled = busy;
  $('#profile').disabled = busy;
}
async function play() {
  if (current < 0) return;
  try { await player.play(); }
  catch (error) { $('#status').textContent = 'Не удалось запустить трек. Нажмите «Слушать»; если не помогает — обновите «Мою музыку».'; log(`play rejected: ${error.name}`); }
}
function select(index, autoplay) {
  const track = tracks[index];
  if (!track?.playable) return;
  current = index; player.src = track.stream_url;
  $('#title').textContent = track.title; $('#performer').textContent = track.performer || (mode === 'demo' ? 'Синтезированная тестовая мелодия' : 'Музыка профиля');
  $('#play').disabled = false; $('#next').disabled = false;
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: track.performer || 'WAVE'});
  }
  render(); log('selected'); if (autoplay) play();
}
function next(manual = true) {
  for (let step = 1; step <= tracks.length; step++) {
    const candidate = current+step;
    if (!manual && !$('#repeat').checked && candidate >= tracks.length) break;
    const index = candidate % tracks.length;
    if (tracks[index].playable) { select(index, true); return; }
  }
  $('#status').textContent = nextOffset === null ? 'Очередь завершена' : 'Загруженная очередь завершена. Нажмите «Загрузить ещё».';
}
function reset() {
  player.pause(); player.removeAttribute('src'); player.load(); tracks = []; current = -1; nextOffset = null;
  $('#title').textContent = 'Ваш плеер'; $('#performer').textContent = 'Выберите композицию';
  $('#play').disabled = true; $('#next').disabled = true; $('#search').value = '';
  $('#status').textContent = 'Готов к запуску'; render();
}
async function loadProfile(append = false) {
  if (busy) return;
  if (!append) { generation++; mode = 'profile'; reset(); }
  const requestGeneration = generation;
  if (!apiBase) { $('#library-status').textContent = 'Личная музыка ещё не подключена. Пока доступны тестовые мелодии.'; return; }
  if (!telegram?.initData) { $('#library-status').textContent = 'Откройте WAVE кнопкой приложения у @wave_audio_player_bot.'; return; }
  busy = true; render(); $('#library-status').textContent = 'Загружаем музыку профиля…';
  try {
    const response = await fetch(`${apiBase}/api/profile-audios`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({init_data: telegram.initData, offset: append ? nextOffset : 0}), signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось загрузить музыку.');
    if (!Array.isArray(result.tracks)) throw new Error('Сервис вернул некорректный ответ.');
    if (requestGeneration !== generation) return;
    tracks.push(...result.tracks); nextOffset = result.next_offset;
    $('#library-status').textContent = result.total_count
      ? `Загружено ${tracks.length} из ${result.total_count}. Поиск — по загруженным трекам.`
      : 'В доступной музыке профиля пока нет треков. Добавьте аудио в профиль Telegram и нажмите «Моя музыка».';
  } catch (error) {
    if (requestGeneration === generation) $('#library-status').textContent = error instanceof TypeError || error.name === 'TimeoutError' ? 'Сервис недоступен. Попробуйте ещё раз.' : error.message;
  } finally { busy = false; render(); }
}
$('#demo').onclick = () => {
  generation++; mode = 'demo'; reset();
  tracks = [0,1].map(i => ({title: `Мелодия ${i+1}`, performer: 'WAVE', duration: 12, playable: true, stream_url: new URL(`./audio/${i}.wav`, location.href).href}));
  $('#library-status').textContent = 'Две тестовые мелодии. Это не музыка вашего профиля.'; render(); select(0, false);
};
$('#profile').onclick = () => loadProfile();
$('#more').onclick = () => loadProfile(true);
$('#search').oninput = render;
$('#play').onclick = () => player.paused ? play() : player.pause();
$('#next').onclick = () => next();
for (const event of ['play','playing','pause','ended','waiting','stalled','error','seeking','seeked']) {
  player.addEventListener(event, () => {
    log(event); $('#play').textContent = player.paused ? 'Слушать' : 'Пауза';
    if (event === 'playing') $('#status').textContent = 'Воспроизводится';
    if (event === 'pause') $('#status').textContent = 'Пауза';
    if (event === 'error' && current >= 0) $('#status').textContent = 'Не удалось загрузить аудио. Обновите «Мою музыку» и попробуйте снова.';
    if (event === 'ended') next(false);
  });
}
document.addEventListener('visibilitychange', () => log('visibilitychange'));
window.addEventListener('pagehide', () => log('pagehide'));
if ('mediaSession' in navigator) {
  for (const [action, handler] of Object.entries({play, pause: () => player.pause(), nexttrack: () => next(), previoustrack: () => {for(let i=current-1;i>=0;i--)if(tracks[i].playable){select(i,true);break;}}})) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* optional capability */ }
  }
}
$('#save').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({userAgent: navigator.userAgent, mode, records}, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'wave-playback-test.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
loadProfile();
