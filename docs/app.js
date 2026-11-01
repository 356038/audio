'use strict';
const $ = selector => document.querySelector(selector);
const player = $('#player');
const telegram = window.Telegram?.WebApp;
const apiBase = (window.WAVE_API_BASE || '').replace(/\/$/, '');
const halloween = window.WAVE_THEME !== 'default';
document.documentElement.dataset.theme = halloween ? 'halloween' : 'default';
let tracks = [], current = -1, nextOffset = null, busy = false, seeking = false;
let actuallyPlaying = false;
let warmController = null;
const prepared = new Set();
telegram?.ready();
telegram?.expand();
try {
  telegram?.setHeaderColor('#111110');
  telegram?.setBackgroundColor('#111110');
  telegram?.setBottomBarColor?.('#111110');
} catch { /* Theme controls are optional on older Telegram clients. */ }
if (halloween) {
  $('#hero-title').replaceChildren(document.createTextNode('Звучит'), document.createElement('br'));
  const accent = document.createElement('span'); accent.textContent = 'до мурашек.'; $('#hero-title').append(accent);
  $('.hero-description').textContent = 'Твоя музыка. Тёмная сторона. Включай — эта ночь на повторе.';
  $('.edition').textContent = 'Halloween edition / 01';
  $('#play-all').lastChild.textContent = 'Включить ночь';
  document.title = 'WAVE — звучит до мурашек';
}
function duration(seconds) {
  seconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
}
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#'+id); svg.append(use); svg.setAttribute('aria-hidden','true'); return svg;
}
function equalizer() {
  const bars = document.createElement('span'); bars.className = 'equalizer track-current'; bars.setAttribute('aria-hidden','true');
  for (let i=0;i<4;i++) bars.append(document.createElement('i'));
  return bars;
}
function addArtwork(holder, track) {
  if (!track?.artwork_url) return;
  const image = document.createElement('img');
  image.src = track.artwork_url; image.alt = ''; image.loading = holder.id === 'full-artwork' ? 'eager' : 'lazy';
  image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.className = 'album-image';
  image.onerror = () => { image.remove(); holder.classList.remove('has-artwork'); };
  image.onload = () => holder.classList.add('has-artwork');
  holder.append(image);
}
function render() {
  const query = $('#search').value.toLocaleLowerCase();
  $('#tracks').replaceChildren();
  let visibleCount = 0;
  const covers = halloween ? ['#674129','#494333','#53394b','#384d49','#584130','#42445d'] : ['#3c5847','#50513a','#41475b','#5e4540','#47534e','#5d4b59'];
  tracks.forEach((track, index) => {
    if (!`${track.title} ${track.performer}`.toLocaleLowerCase().includes(query)) return;
    visibleCount++;
    const li = document.createElement('li'), button = document.createElement('button'), detail = document.createElement('small');
    li.className = `track-row${current === index ? ' selected' : ''}`;
    li.dataset.index = index;
    button.type = 'button'; button.className = `track${current === index ? ' active' : ''}`;
    button.disabled = !track.playable;
    button.setAttribute('aria-label', `Открыть ${track.title}${track.performer ? ' — '+track.performer : ''}`);
    const art = document.createElement('span'); art.className = 'track-art'; art.style.setProperty('--cover', covers[index % covers.length]); art.setAttribute('aria-hidden','true');
    art.append(icon('i-note')); addArtwork(art, track);
    const copy = document.createElement('span'); copy.className = 'track-copy';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    detail.className = 'track-detail'; detail.textContent = [track.performer || 'Неизвестный исполнитель', track.playable ? '' : 'Файл превышает лимит Telegram'].filter(Boolean).join(' · ');
    const time = document.createElement('span'); time.className = 'track-duration'; time.textContent = duration(track.duration);
    copy.append(title, detail); button.append(art, copy, time, equalizer());
    button.onclick = () => { if (current !== index) select(index, true); openPlayer(); };
    const toggle = document.createElement('button'); toggle.type='button'; toggle.className='row-play icon-button'; toggle.dataset.index = index;
    toggle.disabled = !track.playable;
    toggle.onclick = () => current === index ? togglePlayback() : select(index, true);
    li.append(button, toggle); $('#tracks').append(li);
  });
  $('#track-count').textContent = String(tracks.length);
  $('#play-all').disabled = !tracks.some(track => track.playable);
  $('#empty-state').hidden = visibleCount > 0 || busy;
  $('#empty-message').textContent = query ? 'Ничего не нашлось. Попробуй другой запрос.' : 'Здесь будут треки из твоего профиля Telegram.';
  $('#more').hidden = nextOffset === null;
  $('#more').disabled = busy;
  $('#profile').disabled = busy;
  $('#profile').classList.toggle('busy', busy);
  syncControls();
}
function syncSelection() {
  document.querySelectorAll('.track-row').forEach(row => {
    const selected = Number(row.dataset.index) === current;
    row.classList.toggle('selected', selected);
    row.querySelector('.track').classList.toggle('active', selected);
  });
  syncControls();
}
function prepareNext() {
  if (current < 0 || navigator.connection?.saveData || document.visibilityState === 'hidden') return;
  let index = tracks.findIndex((track,i) => i>current && track.playable);
  if (index < 0 && $('#repeat').checked) index = tracks.findIndex(track => track.playable);
  const track = tracks[index];
  if (!track?.stream_url || index === current || prepared.has(track.stream_url)) return;
  const url = new URL(track.stream_url);
  if (url.pathname !== '/api/stream') return;
  warmController?.abort();warmController = new AbortController();
  const controller = warmController;
  const timer = setTimeout(()=>controller.abort(),20000);
  url.pathname = '/api/prepare';
  prepared.add(track.stream_url);
  fetch(url,{signal:controller.signal,cache:'no-store'}).then(response=>{
    if(!response.ok)prepared.delete(track.stream_url);
  }).catch(()=>prepared.delete(track.stream_url)).finally(()=>clearTimeout(timer));
}
function syncControls() {
  const playing = current >= 0 && !player.paused && !player.ended;
  document.documentElement.classList.toggle('is-playing', actuallyPlaying && playing);
  for (const id of ['#play','#full-play']) {
    const button = $(id); button.replaceChildren(icon(playing ? 'i-pause' : 'i-play'));
    button.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    button.disabled = current < 0;
  }
  document.querySelectorAll('.row-play').forEach(button => {
    const active = Number(button.dataset.index) === current && playing;
    button.replaceChildren(icon(active ? 'i-pause' : 'i-play'));
    button.setAttribute('aria-label', `${active ? 'Пауза' : 'Воспроизвести'}: ${tracks[Number(button.dataset.index)].title}`);
  });
  $('#full-repeat').setAttribute('aria-pressed', String($('#repeat').checked));
}
async function play() {
  if (current < 0) return;
  try { await player.play(); }
  catch { $('#status').textContent = 'Не удалось запустить трек. Попробуйте ещё раз или обновите коллекцию.'; }
  syncControls();
}
function togglePlayback() {
  if (player.paused) play();
  else { player.pause(); actuallyPlaying=false; syncControls(); }
}
function select(index, autoplay) {
  const track = tracks[index];
  if (!track?.playable) return;
  actuallyPlaying = false; current = index; player.src = track.stream_url;
  $('.player-dock').classList.add('has-track');
  $('#title').textContent = track.title; $('#performer').textContent = track.performer || 'Музыка профиля';
  $('#full-title').textContent = track.title; $('#full-performer').textContent = track.performer || 'Неизвестный исполнитель';
  $('.now-art').querySelectorAll('img').forEach(image=>image.remove()); $('.now-art').classList.remove('has-artwork');
  $('#full-artwork').querySelectorAll('img').forEach(image=>image.remove()); $('#full-artwork').classList.remove('has-artwork');
  addArtwork($('.now-art'), track);
  if ($('#now-playing-dialog').open) addArtwork($('#full-artwork'), track);
  $('#open-player').disabled = false; $('#next').disabled = false;
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: track.performer || 'WAVE', artwork: track.artwork_url ? [{src:track.artwork_url}] : []});
  }
  updateProgress(); syncSelection(); if (autoplay) play();
}
function next(manual = true) {
  for (let step=1;step<=tracks.length;step++) {
    const candidate = current+step;
    if (!manual && !$('#repeat').checked && candidate >= tracks.length) break;
    const index = candidate % tracks.length;
    if (tracks[index].playable) { select(index, true); return; }
  }
  $('#status').textContent = nextOffset === null ? 'Очередь завершена' : 'Загруженная очередь завершена. Нажмите «Загрузить ещё».';
}
function previous() {
  if (player.currentTime > 3) { player.currentTime = 0; updateProgress(); return; }
  for (let i=current-1;i>=0;i--) if(tracks[i].playable) {select(i,true);return;}
  if(current>=0) {player.currentTime=0;updateProgress();}
}
function openPlayer() {
  if (current < 0 || $('#now-playing-dialog').open) return;
  $('#now-playing-dialog').showModal(); document.body.classList.add('player-open');
  if (!$('#full-artwork').querySelector('img')) addArtwork($('#full-artwork'), tracks[current]);
  telegram?.BackButton?.show();
}
function closePlayer() { if ($('#now-playing-dialog').open) $('#now-playing-dialog').close(); }
$('#now-playing-dialog').addEventListener('close',()=>{document.body.classList.remove('player-open');telegram?.BackButton?.hide();});
telegram?.BackButton?.onClick(closePlayer);
function updateProgress() {
  const total = Number.isFinite(player.duration) ? player.duration : tracks[current]?.duration || 0;
  const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  $('#elapsed').textContent = duration(position); $('#total-time').textContent = duration(total);
  $('#seek').disabled = !(Number.isFinite(player.duration) && player.duration>0);
  $('#seek').max = String(total || 1);
  if (!seeking) $('#seek').value = String(position);
  const progress = `${total>0 ? Math.min(100,position/total*100) : 0}%`;
  $('#seek').style.setProperty('--progress', progress);
  $('.dock-progress').style.setProperty('--progress', progress);
}
function reset() {
  warmController?.abort();prepared.clear();
  closePlayer(); player.pause(); player.removeAttribute('src'); player.load(); tracks=[]; current=-1; nextOffset=null; actuallyPlaying=false;
  $('#title').textContent = 'Поймай свою волну'; $('#performer').textContent = 'Выбери трек из коллекции';
  $('#next').disabled=true; $('#open-player').disabled=true; $('#search').value='';
  $('.now-art').querySelectorAll('img').forEach(image=>image.remove()); $('.now-art').classList.remove('has-artwork');
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  $('#status').textContent='Готов к воспроизведению'; $('.player-dock').classList.remove('has-track'); render();
}
async function loadProfile(append=false) {
  if (busy) return;
  if (!append) reset();
  if (!apiBase) {$('#library-status').textContent='Коллекция временно недоступна. Попробуйте позже.';return;}
  if (!telegram?.initData) {$('#library-status').textContent='Откройте WAVE кнопкой приложения у @wave_audio_player_bot.';return;}
  busy=true;render();$('#library-status').textContent='Собираем твою коллекцию…';
  try {
    const response=await fetch(`${apiBase}/api/profile-audios`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:telegram.initData,offset:append?nextOffset:0}),signal:AbortSignal.timeout(30000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Не удалось загрузить музыку.');
    if(!Array.isArray(result.tracks))throw new Error('Не удалось прочитать коллекцию.');
    tracks.push(...result.tracks);nextOffset=result.next_offset;
    $('#library-status').textContent=result.total_count?`Загружено ${tracks.length} из ${result.total_count}. Поиск — по загруженным трекам.`:'Добавь музыку в свой профиль Telegram и обнови коллекцию.';
  }catch(error){$('#library-status').textContent=error instanceof TypeError||error.name==='TimeoutError'?'Сервис недоступен. Попробуйте ещё раз.':error.message;}
  finally{busy=false;render();}
}
$('#profile').onclick=()=>loadProfile();
$('#play-all').onclick=()=>{const first=tracks.findIndex(track=>track.playable);if(first>=0){select(first,true);openPlayer();}};
$('#more').onclick=()=>loadProfile(true);
$('#search').oninput=render;
$('#play').onclick=togglePlayback;
$('#full-play').onclick=togglePlayback;
$('#next').onclick=()=>next();
$('#full-next').onclick=()=>next();
$('#previous').onclick=previous;
$('#open-player').onclick=openPlayer;
$('#close-player').onclick=closePlayer;
$('#full-repeat').onclick=()=>{$('#repeat').checked=!$('#repeat').checked;syncControls();};
$('#repeat').onchange=syncControls;
$('#seek').oninput=()=>{seeking=true;$('#elapsed').textContent=duration(Number($('#seek').value));};
$('#seek').onchange=()=>{if(Number.isFinite(player.duration))player.currentTime=Math.min(player.duration,Number($('#seek').value));seeking=false;updateProgress();};
for(const event of ['timeupdate','loadedmetadata','durationchange','seeked','emptied'])player.addEventListener(event,updateProgress);
for(const event of ['play','playing','pause','ended','waiting','stalled','error']) {
  player.addEventListener(event,()=>{
    if(event==='playing'){actuallyPlaying=true;$('#status').textContent='Воспроизводится';prepareNext();}
    if(['pause','ended','waiting','stalled','error'].includes(event))actuallyPlaying=false;
    if(event==='pause')$('#status').textContent='Пауза';
    if(event==='waiting')$('#status').textContent='Загружаем трек…';
    if(event==='error'&&current>=0)$('#status').textContent='Не удалось загрузить трек. Обновите коллекцию и попробуйте снова.';
    syncControls();if(event==='ended')next(false);
  });
}
if('mediaSession'in navigator){
  for(const[action,handler]of Object.entries({play,pause:()=>player.pause(),nexttrack:()=>next(),previoustrack:previous})){
    try{navigator.mediaSession.setActionHandler(action,handler);}catch{/* Optional client capability. */}
  }
}
loadProfile();
