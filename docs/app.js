'use strict';
const $ = selector => document.querySelector(selector);
const player = $('#player');
const telegram = window.Telegram?.WebApp;
const apiBase = (window.WAVE_API_BASE || '').replace(/\/$/, '');
const halloween = window.WAVE_THEME !== 'default';
$('#tab-catalog').hidden=window.WAVE_SEARCH_CONFIGURED!==true;
document.documentElement.dataset.theme = halloween ? 'halloween' : 'default';
let tracks = [], queue = [], current = -1, nextOffset = null, busy = false, seeking = false;
let view='profile', requestVersion=0, requestController=null, searchTimer=null, viewError='';
const libraries={profile:{tracks:[],next:null,query:'',total:0,loaded:false},catalog:{tracks:[],next:null,query:'',total:0,loaded:false}};
function selectedTrack(){return queue[current];}
function sameTrack(track){return Boolean(track && selectedTrack() && track.id===selectedTrack().id);}

let actuallyPlaying = false;
let selectionVersion=0, playAttempt=0, errorController=null;
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
  const query = view==='profile' ? $('#search').value.toLocaleLowerCase() : '';
  $('#tracks').replaceChildren();
  let visibleCount = 0;
  const covers = halloween ? ['#674129','#494333','#53394b','#384d49','#584130','#42445d'] : ['#3c5847','#50513a','#41475b','#5e4540','#47534e','#5d4b59'];
  tracks.forEach((track, index) => {
    if (!`${track.title} ${track.performer}`.toLocaleLowerCase().includes(query)) return;
    visibleCount++;
    const li = document.createElement('li'), button = document.createElement('button'), detail = document.createElement('small');
    li.className = `track-row${sameTrack(track) ? ' selected' : ''}`;
    li.dataset.index = index;
    button.type = 'button'; button.className = `track${sameTrack(track) ? ' active' : ''}`;
    button.disabled = !track.playable;
    button.setAttribute('aria-label', `Открыть ${track.title}${track.performer ? ' — '+track.performer : ''}`);
    const art = document.createElement('span'); art.className = 'track-art'; art.style.setProperty('--cover', covers[index % covers.length]); art.setAttribute('aria-hidden','true');
    art.append(icon('i-note')); addArtwork(art, track);
    const copy = document.createElement('span'); copy.className = 'track-copy';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    detail.className = 'track-detail'; detail.textContent = [track.performer || 'Неизвестный исполнитель', track.playable ? '' : track.unavailable_reason || 'Файл превышает лимит Telegram'].filter(Boolean).join(' · ');
    const time = document.createElement('span'); time.className = 'track-duration'; time.textContent = duration(track.duration);
    copy.append(title, detail); button.append(art, copy, time, equalizer());
    button.onclick = () => { if (!sameTrack(track)||player.error) select(index, true); openPlayer(); };
    const toggle = document.createElement('button'); toggle.type='button'; toggle.className='row-play icon-button'; toggle.dataset.index = index;
    toggle.disabled = !track.playable;
    toggle.onclick = () => sameTrack(track)&&!player.error ? togglePlayback() : select(index, true);
    li.append(button, toggle); $('#tracks').append(li);
  });
  $('#track-count').textContent = String(tracks.length);
  $('#play-all').disabled = !tracks.some(track => track.playable);
  $('#empty-state').hidden = visibleCount > 0 || busy;
  $('#empty-message').textContent = viewError || (view==='catalog' ? (libraries.catalog.loaded ? 'По этому запросу ничего не найдено.' : 'Введи название трека или исполнителя.') : query ? 'Ничего не нашлось. Попробуй другой запрос.' : 'Здесь будут треки из твоего профиля Telegram.');
  $('#more').hidden = nextOffset === null;
  $('#more').disabled = busy;
  $('#profile').disabled = busy;
  $('#profile').classList.toggle('busy', busy);
  syncControls();
}
function syncSelection() {
  document.querySelectorAll('.track-row').forEach(row => {
    const selected = sameTrack(tracks[Number(row.dataset.index)]);
    row.classList.toggle('selected', selected);
    row.querySelector('.track').classList.toggle('active', selected);
  });
  syncControls();
}
function prepareTrack(index,collection=queue) {
  if (navigator.connection?.saveData || document.visibilityState === 'hidden') return;
  const track = collection[index];
  if (!track?.stream_url || sameTrack(track) || prepared.has(track.stream_url)) return;
  const url = new URL(track.stream_url);
  if (url.pathname !== '/api/stream') return;
  warmController?.abort();warmController = new AbortController();
  const controller = warmController;
  const timer = setTimeout(()=>controller.abort(),20000);
  url.pathname = '/api/prepare';
  prepared.add(track.stream_url);
  fetch(url,{signal:controller.signal,cache:'no-store'}).then(async response=>{
    if(!response.ok){prepared.delete(track.stream_url);return;}
    const state=await response.json();
    if(state.ready===false&&!state.downloading)prepared.delete(track.stream_url);
  }).catch(()=>prepared.delete(track.stream_url)).finally(()=>clearTimeout(timer));
}
function prepareNext() {
  if(current<0)return;
  let index=queue.findIndex((track,i)=>i>current&&track.playable);
  if(index<0&&$('#repeat').checked)index=queue.findIndex(track=>track.playable);
  prepareTrack(index);
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
    const active = sameTrack(tracks[Number(button.dataset.index)]) && playing;
    button.replaceChildren(icon(active ? 'i-pause' : 'i-play'));
    button.setAttribute('aria-label', `${active ? 'Пауза' : 'Воспроизвести'}: ${tracks[Number(button.dataset.index)].title}`);
  });
  $('#full-repeat').setAttribute('aria-pressed', String($('#repeat').checked));
}
function statusElement() {return $('#status');}
function setStatus(message) {statusElement().textContent=message;}
new MutationObserver(()=>{$('#full-status').textContent=$('#status').textContent;}).observe($('#status'),{childList:true,characterData:true,subtree:true});
async function showMediaError(version=selectionVersion) {
  if(current<0||version!==selectionVersion)return;
  const code=player.error?.code;
  setStatus('Проверяем доступность трека…');
  errorController?.abort();const controller=new AbortController();errorController=controller;
  const timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(selectedTrack().stream_url,{headers:{Range:'bytes=0-1'},cache:'no-store',signal:controller.signal});
    let message;
    if(!response.ok&&response.headers.get('Content-Type')?.includes('application/json')) {
      const result=await response.json();message=result.error;
    }else {
      await response.body?.cancel();
      if(!response.ok)message=`Не удалось загрузить трек (HTTP ${response.status}). Попробуйте ещё раз.`;
      else if(code===4)message='Формат этого трека не поддерживается плеером на вашем устройстве.';
      else if(code===3)message='Не удалось декодировать этот аудиофайл.';
      else message='Загрузка аудио прервалась. Нажмите Play, чтобы повторить.';
    }
    if(version===selectionVersion&&player.paused)setStatus(message||'Трек сейчас недоступен. Попробуйте позже.');
  }catch {
    if(version===selectionVersion&&player.paused)setStatus('Не удалось проверить трек. Проверьте подключение и попробуйте ещё раз.');
  }finally{clearTimeout(timer);}
}
async function play() {
  if(current<0)return;
  const version=selectionVersion,attempt=++playAttempt;
  try {await player.play();}
  catch(error) {
    if(version!==selectionVersion||attempt!==playAttempt||error.name==='AbortError')return;
    if(error.name==='NotAllowedError')setStatus('Нажмите Play, чтобы начать воспроизведение.');
    else if(!errorController||errorController.signal.aborted)await showMediaError(version);
  }
  if(version===selectionVersion)syncControls();
}
function togglePlayback() {
  if (player.paused) play();
  else { playAttempt++;player.pause(); actuallyPlaying=false; syncControls(); }
}
function select(index, autoplay,collection=tracks) {
  const track = collection[index];
  if (!track?.playable) return;
  selectionVersion++;playAttempt++;errorController?.abort();errorController=null;seeking=false;
  actuallyPlaying = false; queue=collection;current = index; player.src = track.stream_url;
  setStatus('Загружаем трек…');
  $('.player-dock').classList.add('has-track');
  $('#title').textContent = track.title; $('#performer').textContent = track.performer || 'Музыка профиля';
  $('#full-queue-title').textContent=track.source==='audius'?'Результаты поиска Audius':'Моя коллекция';
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
  for (let step=1;step<=queue.length;step++) {
    const candidate = current+step;
    if (!manual && !$('#repeat').checked && candidate >= queue.length) break;
    const index = candidate % queue.length;
    if (queue[index].playable) { select(index, true,queue); return; }
  }
  const more=queue===libraries.profile.tracks?libraries.profile.next:queue===libraries.catalog.tracks?libraries.catalog.next:null;
  statusElement().textContent = more === null ? 'Очередь завершена' : 'Загруженная очередь завершена. Нажмите «Загрузить ещё».';
}
function previous() {
  if (player.currentTime > 3) { player.currentTime = 0; updateProgress(); return; }
  for (let i=current-1;i>=0;i--) if(queue[i].playable) {select(i,true,queue);return;}
  if(current>=0) {player.currentTime=0;updateProgress();}
}
function openPlayer() {
  if (current < 0 || $('#now-playing-dialog').open) return;
  $('#now-playing-dialog').showModal(); document.body.classList.add('player-open');
  if (!$('#full-artwork').querySelector('img')) addArtwork($('#full-artwork'), selectedTrack());
  telegram?.BackButton?.show();
}
function closePlayer() { if ($('#now-playing-dialog').open) $('#now-playing-dialog').close(); }
$('#now-playing-dialog').addEventListener('close',()=>{document.body.classList.remove('player-open');telegram?.BackButton?.hide();});
telegram?.BackButton?.onClick(closePlayer);
function updateProgress() {
  const total = Number.isFinite(player.duration) ? player.duration : selectedTrack()?.duration || 0;
  const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  $('#elapsed').textContent = duration(position); $('#total-time').textContent = duration(total);
  $('#seek').disabled = !(Number.isFinite(player.duration) && player.duration>0);
  $('#seek').max = String(total || 1);
  if (!seeking) $('#seek').value = String(position);
  const progress = `${total>0 ? Math.min(100,position/total*100) : 0}%`;
  $('#seek').style.setProperty('--progress', progress);
  $('.dock-progress').style.setProperty('--progress', progress);
}
function cancelRequests() {
  requestVersion++;requestController?.abort();requestController=null;clearTimeout(searchTimer);busy=false;
}
function describeLibrary() {
  const library=libraries[view];
  $('#library-status').textContent=library.loaded
    ? (view==='catalog' ? (Number.isInteger(library.total)?`Найдено ${library.total}. Показано ${library.tracks.length}.`:`Показано ${library.tracks.length} результатов Audius.`)
      : `Загружено ${library.tracks.length} из ${library.total}. Поиск — по загруженным трекам.`)
    : view==='catalog'?'Поиск треков и исполнителей в Audius.':'Собираем твою коллекцию…';
}
function switchView(target) {
  if(target===view)return;
  libraries[view].query=$('#search').value;
  cancelRequests();view=target;viewError='';
  const library=libraries[view];tracks=library.tracks;nextOffset=library.next;
  $('#search').value=library.query;
  $('#library-title').textContent=view==='catalog'?'Найти музыку':'Моя коллекция';
  $('#search').placeholder=view==='catalog'?'Название трека или исполнитель':'Трек или исполнитель';
  $('#search').setAttribute('aria-label',view==='catalog'?'Поиск музыки в Audius':'Поиск по загруженной музыке');
  $('#search-submit').hidden=view!=='catalog';
  $('#tab-profile').setAttribute('aria-selected',String(view==='profile'));
  $('#tab-catalog').setAttribute('aria-selected',String(view==='catalog'));
  $('#profile').setAttribute('aria-label',view==='catalog'?'Повторить поиск':'Обновить мою музыку');
  $('#tracks').setAttribute('aria-label',view==='catalog'?'Результаты поиска Audius':'Музыка профиля');
  describeLibrary();render();
  if(view==='profile'&&!library.loaded)loadProfile();
  else if(view==='catalog'&&library.query.trim()&&!library.loaded)loadSearch();
}
async function loadLibrary(source,append=false) {
  if(source!==view)return;
  const query=$('#search').value.trim();
  if(source==='catalog'&&!query){viewError='';$('#library-status').textContent='Введи название трека или исполнителя.';render();return;}
  cancelRequests();viewError='';
  const version=requestVersion,controller=new AbortController();requestController=controller;
  const library=libraries[source];
  if(!append){library.tracks=[];library.next=null;library.loaded=false;library.query=source==='catalog'?query:$('#search').value;tracks=library.tracks;nextOffset=null;}
  if(!apiBase||!telegram?.initData){viewError=!apiBase?'Сервис пока недоступен.':'Откройте WAVE кнопкой приложения у @wave_audio_player_bot.';$('#library-status').textContent=viewError;render();return;}
  busy=true;render();$('#library-status').textContent=source==='catalog'?'Ищем музыку в Audius…':'Собираем твою коллекцию…';
  const timer=setTimeout(()=>controller.abort(),30000);
  try {
    const response=await fetch(`${apiBase}${source==='catalog'?'/api/search':'/api/profile-audios'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:telegram.initData,offset:append?library.next:0,...(source==='catalog'?{query}:{})}),signal:controller.signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Не удалось загрузить музыку.');
    if(!Array.isArray(result.tracks))throw new Error('Не удалось прочитать результаты.');
    if(version!==requestVersion)return;
    library.tracks.push(...result.tracks);library.next=result.next_offset;library.total=result.total_count;library.loaded=true;
    tracks=library.tracks;nextOffset=library.next;describeLibrary();
  }catch(error){
    if(version!==requestVersion)return;
    viewError=error.name==='AbortError'?'Сервис не успел ответить. Попробуйте ещё раз.':error instanceof TypeError?'Сервис недоступен. Попробуйте ещё раз.':error.message;
    $('#library-status').textContent=viewError;
  }finally{
    clearTimeout(timer);
    if(version===requestVersion){busy=false;render();if(current<0&&source==='profile')prepareTrack(tracks.findIndex(track=>track.playable),tracks);}
  }
}
function loadProfile(append=false){return loadLibrary('profile',append);}
function loadSearch(append=false){return loadLibrary('catalog',append);}
$('#profile').onclick=()=>view==='catalog'?loadSearch():loadProfile();
$('#tab-profile').onclick=()=>switchView('profile');
$('#tab-catalog').onclick=()=>switchView('catalog');
$('#search-form').onsubmit=event=>{event.preventDefault();if(view==='catalog')loadSearch();};
$('#play-all').onclick=()=>{const first=tracks.findIndex(track=>track.playable);if(first>=0){select(first,true);openPlayer();}};
$('#more').onclick=()=>view==='catalog'?loadSearch(true):loadProfile(true);
$('#search').oninput=()=>{
  libraries[view].query=$('#search').value;
  if(view==='profile'){render();return;}
  cancelRequests();
  if(!$('#search').value.trim()){libraries.catalog={tracks:[],next:null,query:'',total:0,loaded:false};tracks=[];nextOffset=null;viewError='';describeLibrary();render();return;}
  libraries.catalog.tracks=[];libraries.catalog.next=null;libraries.catalog.loaded=false;tracks=[];nextOffset=null;viewError='';
  $('#library-status').textContent='Ищем музыку в Audius…';render();
  searchTimer=setTimeout(()=>loadSearch(),450);
};
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
    if(event==='playing'){errorController?.abort();errorController=null;actuallyPlaying=true;statusElement().textContent='Воспроизводится';prepareNext();}
    if(['pause','ended','waiting','stalled','error'].includes(event))actuallyPlaying=false;
    if(event==='pause')statusElement().textContent='Пауза';
    if(event==='waiting')statusElement().textContent='Загружаем трек…';
    if(event==='error'&&current>=0)showMediaError();
    syncControls();if(event==='ended')next(false);
  });
}
if('mediaSession'in navigator){
  for(const[action,handler]of Object.entries({play,pause:()=>player.pause(),nexttrack:()=>next(),previoustrack:previous})){
    try{navigator.mediaSession.setActionHandler(action,handler);}catch{/* Optional client capability. */}
  }
}
loadProfile();
