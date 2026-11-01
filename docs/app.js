'use strict';
const $ = selector => document.querySelector(selector);
const player = $('#player');
const telegram = window.Telegram?.WebApp;
const languageStorageKey='wave-language:'+(telegram?.initDataUnsafe?.user?.id||'guest');
let languagePreference='auto';
try{const saved=localStorage.getItem(languageStorageKey);if(['auto','ru','en'].includes(saved))languagePreference=saved;}catch{/* Storage is optional. */}
let language=languagePreference==='auto'?WaveI18n.resolveLanguage(telegram?.initDataUnsafe?.user?.language_code,navigator.language):languagePreference;
const t=(source,params)=>WaveI18n.translate(language,source,params);
WaveI18n.localizeDocument(language,document);
const apiBase = (window.WAVE_API_BASE || '').replace(/\/$/, '');
const halloween = window.WAVE_THEME !== 'default';
$('#tab-catalog').hidden=window.WAVE_SEARCH_CONFIGURED!==true;
document.documentElement.dataset.theme = halloween ? 'halloween' : 'default';
let tracks = [], queue = [], current = -1, nextOffset = null, busy = false, seeking = false;
let view='saved', requestVersion=0, requestController=null, searchTimer=null, viewError='';
const libraries={saved:{tracks:[],next:null,query:'',total:0,loaded:false},'for-you':{tracks:[],next:null,query:'',total:0,loaded:false},profile:{tracks:[],next:null,query:'',total:0,loaded:false},catalog:{tracks:[],next:null,query:'',total:0,loaded:false}};
const savedIds=new Set(),savedOverrides=new Map(),saving=new Set();
const saveNotices=new Map();
let toastTimer=null,listenSession=null,recommendationQueue=null;
const feedRequests=new WeakMap();
let libraryLayoutFrame=0,libraryLayoutTimer=null;
let lastHaptic=-Infinity,playerPage=null,accountSavedCount=null;
// One short native tick per deliberate control press, never for automatic events.
document.addEventListener('click',event=>{
  if(!event.isTrusted)return;
  const control=event.target.closest('.source-tabs button,.hero-dot,.hero-action,.row-play,.row-save,.track,.repeat-label,#play,#full-play,#next,#full-next,#previous,#full-save,#full-repeat,#open-player,#close-player,#profile,#account,#close-account,#account-library,#fullscreen,#hero-pause,#more');
  if(!control||control.disabled||control.getAttribute('aria-selected')==='true'||control.getAttribute('aria-current')==='true')return;
  const haptics=telegram?.HapticFeedback;
  if(!haptics||telegram.isVersionAtLeast&&!telegram.isVersionAtLeast('6.1'))return;
  const time=performance.now();if(time-lastHaptic<100)return;lastHaptic=time;
  try{
    if(control.matches('.source-tabs button,.hero-dot')&&haptics.selectionChanged)haptics.selectionChanged();
    else if(haptics.impactOccurred)haptics.impactOccurred('light');
    else haptics.selectionChanged?.();
  }catch{/* Haptics are optional and must not interrupt playback or navigation. */}
},{capture:true});
function selectedTrack(){return queue[current];}
function sameTrack(track){return Boolean(track && selectedTrack() && track.id===selectedTrack().id);}

let actuallyPlaying = false;
let selectionVersion=0, playAttempt=0, errorController=null;
let warmController = null;
const prepared = new Set();
telegram?.ready();
telegram?.expand();
// Disable Telegram's sheet drag from content, while retaining its native header gesture.
if(telegram?.disableVerticalSwipes&&(!telegram.isVersionAtLeast||telegram.isVersionAtLeast('7.7'))){
  try{telegram.disableVerticalSwipes();}catch{/* Unsupported clients retain their native gesture. */}
}
function applyTelegramAppearance(){
  const background=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('meta[name=theme-color]').content=background;
  for(const method of ['setHeaderColor','setBackgroundColor','setBottomBarColor']){
    try{telegram?.[method]?.(background);}catch{/* Optional on older clients. */}
  }
}
applyTelegramAppearance();
telegram?.onEvent?.('themeChanged',applyTelegramAppearance);
const fullscreenSupported=typeof telegram?.requestFullscreen==='function'&&(!telegram.isVersionAtLeast||telegram.isVersionAtLeast('8.0'));
function syncTelegramLayout(){
  document.documentElement.classList.toggle('is-fullscreen',Boolean(telegram?.isFullscreen));
  $('#fullscreen').hidden=!fullscreenSupported||Boolean(telegram?.isFullscreen);
  for(const [name,insets]of [['safe',telegram?.safeAreaInset],['content-safe',telegram?.contentSafeAreaInset]]){
    for(const edge of ['top','bottom','left','right']){
      const value=insets?.[edge];
      if(Number.isFinite(value)&&value>=0)document.documentElement.style.setProperty(`--tg-${name}-area-inset-${edge}`,`${value}px`);
    }
  }
  scheduleSearchLayout(true);
}
function requestAppFullscreen(manual=false){
  if(!fullscreenSupported||telegram.isFullscreen)return;
  try{telegram.requestFullscreen();}
  catch{if(manual)toast(t('Telegram не включил полный экран. Попробуйте обновить приложение Telegram.'));}
}
$('#fullscreen').onclick=()=>requestAppFullscreen(true);
for(const event of ['fullscreenChanged','safeAreaChanged','contentSafeAreaChanged'])telegram?.onEvent?.(event,syncTelegramLayout);
telegram?.onEvent?.('fullscreenFailed',()=>{$('#fullscreen').hidden=!fullscreenSupported;});
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
  holdLibraryLayout();
  const query = view!=='catalog'&&view!=='for-you' ? $('#search').value.toLocaleLowerCase() : '';
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
    button.setAttribute('aria-label', t('Открыть {track}',{track:track.title+(track.performer?' — '+track.performer:'')}));
    const art = document.createElement('span'); art.className = 'track-art'; art.style.setProperty('--cover', covers[index % covers.length]); art.setAttribute('aria-hidden','true');
    art.append(icon('i-note')); addArtwork(art, track);
    const copy = document.createElement('span'); copy.className = 'track-copy';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    detail.className = 'track-detail'; detail.textContent = [track.performer || t('Неизвестный исполнитель'), track.playable ? '' : t(track.unavailable_reason) || t('Файл превышает лимит Telegram')].filter(Boolean).join(' · ');
    const time = document.createElement('span'); time.className = 'track-duration'; time.textContent = duration(track.duration);
    copy.append(title, detail); button.append(art, copy, time, equalizer());
    button.onclick = () => { if (!sameTrack(track)||player.error) select(index, true); openPlayer(); };
    const toggle = document.createElement('button'); toggle.type='button'; toggle.className='row-play icon-button'; toggle.dataset.index = index;
    toggle.disabled = !track.playable;
    toggle.onclick = () => sameTrack(track)&&!player.error ? togglePlayback() : select(index, true);
    const save=document.createElement('button');save.type='button';save.className='row-save icon-button';save.dataset.index=index;save.onclick=()=>saveTrack(track);
    li.append(button, toggle,save); $('#tracks').append(li);renderSaveNotice(li,track);
  });
  $('#track-count').textContent = String(tracks.length);
  $('#empty-state').hidden = visibleCount > 0 || busy;
  $('#empty-message').textContent = t(viewError || (view==='catalog' ? (libraries.catalog.loaded ? t('По этому запросу ничего не найдено.') : t('Введи название трека или исполнителя.')) : query ? t('Ничего не нашлось. Попробуй другой запрос.') : view==='saved'?t('Пока нет треков.'):view==='for-you'?t('Пока нет рекомендаций.'):t('В профиле пока нет музыки.')));
  $('#more').hidden = nextOffset === null||view==='for-you';
  $('#more').disabled = busy;
  $('#profile').disabled = busy;
  $('#profile').classList.toggle('busy', busy);
  syncControls();animateLibraryLayout();
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
    button.setAttribute('aria-label', playing ? t('Пауза') : t('Воспроизвести'));
    button.disabled = current < 0;
  }
  document.querySelectorAll('.row-play').forEach(button => {
    const active = sameTrack(tracks[Number(button.dataset.index)]) && playing;
    button.replaceChildren(icon(active ? 'i-pause' : 'i-play'));
    button.setAttribute('aria-label', `${active ? t('Пауза') : t('Воспроизвести')}: ${tracks[Number(button.dataset.index)].title}`);
  });
  $('#full-repeat').setAttribute('aria-pressed', String($('#repeat').checked));
  syncSaveButtons();
}
function statusElement() {return $('#status');}
function setStatus(message) {statusElement().textContent=t(message);}
new MutationObserver(()=>{$('#full-status').textContent=$('#status').textContent;}).observe($('#status'),{childList:true,characterData:true,subtree:true});
async function showMediaError(version=selectionVersion) {
  if(current<0||version!==selectionVersion)return;
  const code=player.error?.code;
  setStatus(t('Проверяем доступность трека…'));
  errorController?.abort();const controller=new AbortController();errorController=controller;
  const timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(selectedTrack().stream_url,{headers:{Range:'bytes=0-1'},cache:'no-store',signal:controller.signal});
    let message;
    if(!response.ok&&response.headers.get('Content-Type')?.includes('application/json')) {
      const result=await response.json();message=result.error;
    }else {
      await response.body?.cancel();
      if(!response.ok)message=t('Не удалось загрузить трек (HTTP {status}). Попробуйте ещё раз.',{status:response.status});
      else if(code===4)message=t('Формат этого трека не поддерживается плеером на вашем устройстве.');
      else if(code===3)message=t('Не удалось декодировать этот аудиофайл.');
      else message=t('Загрузка аудио прервалась. Нажмите Play, чтобы повторить.');
    }
    if(version===selectionVersion&&player.paused)setStatus(message||t('Трек сейчас недоступен. Попробуйте позже.'));
  }catch {
    if(version===selectionVersion&&player.paused)setStatus(t('Не удалось проверить трек. Проверьте подключение и попробуйте ещё раз.'));
  }finally{clearTimeout(timer);}
}
async function play() {
  if(current<0)return;
  const version=selectionVersion,attempt=++playAttempt;
  try {await player.play();}
  catch(error) {
    if(version!==selectionVersion||attempt!==playAttempt||error.name==='AbortError')return;
    if(error.name==='NotAllowedError')setStatus(t('Нажмите Play, чтобы начать воспроизведение.'));
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
  if(collection===libraries['for-you'].tracks)recommendationQueue=libraries['for-you'];
  else if(collection!==recommendationQueue?.tracks)recommendationQueue=null;
  actuallyPlaying = false; queue=collection;current = index; player.src = track.stream_url;
  listenSession={id:crypto.randomUUID(),track,seconds:0,previousTime:0,previousWall:performance.now(),recorded:false,pending:false,attempts:0,retryAt:0};
  setStatus(t('Загружаем трек…'));
  $('.player-dock').classList.add('has-track');
  $('#title').textContent = track.title; $('#performer').textContent = track.performer || t('Музыка профиля');
  $('#full-queue-title').textContent=recommendationQueue?t('Для вас'):track.source==='audius'?t('Результаты поиска Audius'):t('Моя коллекция');
  $('#full-title').textContent = track.title; $('#full-performer').textContent = track.performer || t('Неизвестный исполнитель');
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
async function next(manual = true) {
  if(recommendationQueue?.tracks===queue){
    const context=recommendationQueue,version=selectionVersion,attempt=playAttempt;
    let index=queue.findIndex((track,i)=>i>current&&track.playable);
    if(index<0&&context.next!==null){
      setStatus(t('Загружаем…'));
      try{await loadMoreRecommendations(context);}catch{return;}
      if(version!==selectionVersion||attempt!==playAttempt)return;
      index=queue.findIndex((track,i)=>i>current&&track.playable);
    }
    if(index>=0){select(index,true,queue);return;}
    if(!$('#repeat').checked){setStatus(t('Новые рекомендации пока закончились.'));return;}
  }
  for (let step=1;step<=queue.length;step++) {
    const candidate = current+step;
    if (!manual && !$('#repeat').checked && candidate >= queue.length) break;
    const index = candidate % queue.length;
    if (queue[index].playable) { select(index, true,queue); return; }
  }
  const more=queue===libraries.profile.tracks?libraries.profile.next:queue===libraries.catalog.tracks?libraries.catalog.next:null;
  statusElement().textContent = more === null ? t('Очередь завершена') : t('Загруженная очередь завершена. Нажмите «Загрузить ещё».');
}
function previous() {
  if (player.currentTime > 3) { player.currentTime = 0; updateProgress(); return; }
  for (let i=current-1;i>=0;i--) if(queue[i].playable) {select(i,true,queue);return;}
  if(current>=0) {player.currentTime=0;updateProgress();}
}
function openPlayer() {
  if (current < 0 || $('#now-playing-dialog').open) return;
  $('#search').blur();
  playerPage={x:window.scrollX,y:window.scrollY};document.documentElement.style.setProperty('--player-page-top',`${-playerPage.y}px`);document.documentElement.classList.add('player-visible');
  $('#now-playing-dialog').showModal(); document.body.classList.add('player-open');requestAnimationFrame(fitPlayerArtwork);
  if (!$('#full-artwork').querySelector('img')) addArtwork($('#full-artwork'), selectedTrack());
  telegram?.BackButton?.show();
}
function closePlayer() { if ($('#now-playing-dialog').open) $('#now-playing-dialog').close(); }
$('#now-playing-dialog').addEventListener('close',()=>{document.body.classList.remove('player-open');document.documentElement.classList.remove('player-visible');document.documentElement.style.removeProperty('--player-page-top');if(playerPage){window.scrollTo(playerPage.x,playerPage.y);playerPage=null;}telegram?.BackButton?.hide();});
telegram?.BackButton?.onClick(()=>{if($('#account-dialog').open)$('#account-dialog').close();else closePlayer();});
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
function translatedViewNames(){return {saved:t('Моя музыка'),profile:t('Из профиля Telegram'),catalog:t('Найти музыку'),'for-you':t('Для вас')};}
let viewNames=translatedViewNames();
function holdLibraryLayout(){
  cancelAnimationFrame(libraryLayoutFrame);clearTimeout(libraryLayoutTimer);
  const stage=$('#library-stage'),height=stage.getBoundingClientRect().height;
  stage.classList.remove('is-resizing');stage.style.height=`${height}px`;
}
function animateLibraryLayout(){
  cancelAnimationFrame(libraryLayoutFrame);
  libraryLayoutFrame=requestAnimationFrame(()=>{
    const stage=$('#library-stage'),height=$('#library-content').getBoundingClientRect().height;
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||Math.abs(stage.getBoundingClientRect().height-height)<1){stage.style.removeProperty('height');return;}
    stage.classList.add('is-resizing');stage.style.height=`${height}px`;
    libraryLayoutTimer=setTimeout(()=>{stage.classList.remove('is-resizing');stage.style.removeProperty('height');},430);
  });
}
function setLibraryStatus(message=''){
  holdLibraryLayout();$('#library-status').textContent=t(message);$('#library-status').hidden=!message;animateLibraryLayout();
}
function updateViewLabels(){
  $('#library-title').textContent=viewNames[view];
  $('#search').placeholder=view==='catalog'?t('Название трека или исполнитель'):t('Трек или исполнитель');
  $('#search').setAttribute('aria-label',view==='catalog'?t('Поиск музыки в Audius'):t('Поиск по загруженной музыке'));
  $('#search-submit').hidden=view!=='catalog';
  $('#search-form').hidden=view==='for-you';
  for(const name of Object.keys(libraries))$('#tab-'+name).setAttribute('aria-selected',String(view===name));
  $('#profile').setAttribute('aria-label',view==='catalog'?t('Повторить поиск'):t('Обновить {section}',{section:viewNames[view]}));
  $('#tracks').setAttribute('aria-label',viewNames[view]);
}
function switchView(target){
  if(target===view)return;
  $('#search').blur();holdLibraryLayout();
  libraries[view].query=$('#search').value;cancelRequests();view=target;viewError='';
  const library=libraries[view];tracks=library.tracks;nextOffset=library.next;$('#search').value=library.query;
  updateViewLabels();setLibraryStatus();render();
  if((!library.loaded||library.stale)&&(view!=='catalog'||library.query.trim()))loadLibrary(view);
}
async function loadLibrary(source,append=false,{refresh=false}={}) {
  if(source!==view)return;
  const query=$('#search').value.trim();
  if(source==='catalog'&&!query){viewError='';setLibraryStatus();render();return;}
  cancelRequests();viewError='';
  const version=requestVersion,controller=new AbortController();requestController=controller;
  const previous=libraries[source];
  const refreshData=source==='for-you'&&refresh?{refresh:true,previous_feed:previous.feed||null,exclude_ids:previous.tracks.slice(-300).map(track=>track.id)}:{};
  const library=append?previous:{...previous,tracks:[],next:null,loaded:false,query:source==='catalog'?query:$('#search').value};
  if(!apiBase||!telegram?.initData){viewError=!apiBase?t('Сервис пока недоступен.'):t('Откройте WAVE кнопкой приложения у @wave_audio_player_bot.');setLibraryStatus(viewError);render();return;}
  busy=true;render();setLibraryStatus(previous.loaded&&tracks.length?'':source==='catalog'?t('Ищем…'):t('Загружаем…'));
  const timer=setTimeout(()=>controller.abort(),30000);
  try {
    const endpoints={catalog:'/api/search',profile:'/api/profile-audios',saved:'/api/library','for-you':'/api/recommendations'};
    const response=await fetch(`${apiBase}${endpoints[source]}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:telegram.initData,offset:append?library.next:0,...(source==='catalog'?{query}:{}),...refreshData}),signal:controller.signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||t('Не удалось загрузить музыку.'));
    if(!Array.isArray(result.tracks))throw new Error(t('Не удалось прочитать результаты.'));
    if(version!==requestVersion)return;
    if(!append)libraries[source]=library;
    library.tracks.push(...result.tracks);library.next=result.next_offset;library.total=result.total_count;library.feed=result.feed_id||null;library.loaded=true;library.stale=false;
    library.reason=result.reason||'';
    if(Array.isArray(result.saved_ids)){savedIds.clear();result.saved_ids.forEach(id=>savedIds.add(id));}
    for(const track of result.tracks)if(typeof track.saved==='boolean'){if(track.saved)savedIds.add(track.id);else savedIds.delete(track.id);}
    tracks=library.tracks;nextOffset=library.next;setLibraryStatus();
  }catch(error){
    if(version!==requestVersion)return;
    if(!append&&previous.loaded){libraries[source]=previous;previous.stale=true;}
    viewError=error.name==='AbortError'?t('Сервис не успел ответить. Попробуйте ещё раз.'):error instanceof TypeError?t('Сервис недоступен. Попробуйте ещё раз.'):error.message;
    setLibraryStatus(viewError);
  }finally{
    clearTimeout(timer);
    if(version===requestVersion){busy=false;render();if(current<0&&source!=='catalog')prepareTrack(tracks.findIndex(track=>track.playable),tracks);}
  }
}
function loadProfile(append=false){return loadLibrary('profile',append);}
function loadSearch(append=false){return loadLibrary('catalog',append);}
$('#profile').onclick=()=>loadLibrary(view,false,{refresh:view==='for-you'});
for(const name of Object.keys(libraries))$('#tab-'+name).onclick=()=>switchView(name);

$('#search-form').onsubmit=event=>{event.preventDefault();$('#search').blur();if(view==='catalog')loadSearch();};
$('#more').onclick=()=>loadLibrary(view,true);
$('#search').oninput=()=>{
  libraries[view].query=$('#search').value;
  if(view!=='catalog'){render();return;}
  cancelRequests();
  if(!$('#search').value.trim()){libraries.catalog={tracks:[],next:null,query:'',total:0,loaded:false};tracks=[];nextOffset=null;viewError='';setLibraryStatus();render();return;}
  libraries.catalog.tracks=[];libraries.catalog.next=null;libraries.catalog.loaded=false;tracks=[];nextOffset=null;viewError='';
  setLibraryStatus(t('Ищем…'));render();
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
    if(event==='playing'){errorController?.abort();errorController=null;actuallyPlaying=true;statusElement().textContent=t('Воспроизводится');prepareNext();if(recommendationQueue&&current>=queue.length-3&&recommendationQueue.next!==null)loadMoreRecommendations(recommendationQueue).catch(()=>{});}
    // A stalled download can still have buffered audio playing. Only a real
    // playback interruption should stop the indicators.
    if(['pause','ended','waiting','error'].includes(event))actuallyPlaying=false;
    if(event==='pause')statusElement().textContent=t('Пауза');
    if(event==='waiting')statusElement().textContent=t('Загружаем трек…');
    if(event==='error'&&current>=0)showMediaError();
    syncControls();if(event==='ended')next(false);
  });
}
if('mediaSession'in navigator){
  for(const[action,handler]of Object.entries({play,pause:()=>player.pause(),nexttrack:()=>next(),previoustrack:previous})){
    try{navigator.mediaSession.setActionHandler(action,handler);}catch{/* Optional client capability. */}
  }
}
loadLibrary('saved');

function isSaved(track){return track&&(savedOverrides.has(track.id)?savedOverrides.get(track.id):savedIds.has(track.id));}
function syncSaveButtons(){
  document.querySelectorAll('.row-save').forEach(button=>{const track=tracks[Number(button.dataset.index)],saved=isSaved(track);button.replaceChildren(icon(saved?'i-check':'i-plus'));button.disabled=!track?.stream_url||saving.has(track.id);button.setAttribute('aria-label',`${saved?t('Убрать из моей музыки'):t('Добавить в мою музыку')}: ${track.title}`);button.setAttribute('aria-pressed',String(Boolean(saved)));});
  const track=selectedTrack(),saved=isSaved(track);$('#full-save').replaceChildren(icon(saved?'i-check':'i-plus'));$('#full-save').disabled=!track?.stream_url||saving.has(track?.id);$('#full-save').setAttribute('aria-label',saved?t('Убрать из моей музыки'):t('Добавить в мою музыку'));$('#full-save').setAttribute('aria-pressed',String(Boolean(saved)));
}
function toast(message){const host=document.querySelector('dialog[open]')||document.body;if($('#toast').parentElement!==host)host.append($('#toast'));clearTimeout(toastTimer);$('#toast').textContent=t(message);$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3000);}
function renderSaveNotice(row,track){
  const notice=saveNotices.get(track.id);
  row.querySelector('.row-save-notice')?.remove();
  if(!notice||notice.expires<=Date.now())return;
  const message=document.createElement('span');message.className='row-save-notice';message.dataset.trackId=track.id;
  message.setAttribute('role','status');row.append(message);message.textContent=t('Добавлено в мою музыку');
}
function showSaveNotice(track){
  const rows=[...document.querySelectorAll('.track-row')].filter(row=>tracks[Number(row.dataset.index)]?.id===track.id);
  if(!rows.length||$('#now-playing-dialog').open)return false;
  clearTimeout(saveNotices.get(track.id)?.timer);
  const notice={expires:Date.now()+2800};saveNotices.set(track.id,notice);
  rows.forEach(row=>renderSaveNotice(row,track));
  notice.timer=setTimeout(()=>{
    if(saveNotices.get(track.id)!==notice)return;
    saveNotices.delete(track.id);
    document.querySelectorAll('.row-save-notice').forEach(element=>{if(element.dataset.trackId===track.id)element.remove();});
  },2800);
  return true;
}
async function personalRequest(path,body,timeout=20000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(apiBase+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:telegram?.initData,...body}),signal:controller.signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||t('Не удалось выполнить запрос.'));
    return result;
  }finally{clearTimeout(timer);}
}
async function saveTrack(track){
  if(!track?.stream_url||saving.has(track.id))return;
  const desired=!isSaved(track);saving.add(track.id);syncSaveButtons();
  try{
    const result=await personalRequest('/api/library/save',{stream_url:track.stream_url,saved:desired});
    savedOverrides.set(track.id,result.saved);if(result.saved)savedIds.add(track.id);else savedIds.delete(track.id);
    libraries.saved.loaded=false;libraries['for-you'].stale=true;
    if(!result.saved){
      clearTimeout(saveNotices.get(track.id)?.timer);saveNotices.delete(track.id);
      document.querySelectorAll('.row-save-notice').forEach(element=>{if(element.dataset.trackId===track.id)element.remove();});
      toast(t('Удалено из моей музыки'));
    }else if(!showSaveNotice(track))toast(t('Добавлено в мою музыку'));
    if(view==='saved')await loadLibrary('saved');
  }catch(error){toast(error.name==='AbortError'?t('Сервис не успел ответить. Попробуйте ещё раз.'):error instanceof TypeError?t('Нет связи с сервером. Попробуйте ещё раз.'):error.message);}
  finally{saving.delete(track.id);syncSaveButtons();}
}
$('#full-save').onclick=()=>saveTrack(selectedTrack());
function checkpoint(){if(listenSession){listenSession.previousTime=player.currentTime;listenSession.previousWall=performance.now();}}
function trackListening(){
  const session=listenSession;if(!session)return;
  const wall=performance.now(),position=player.currentTime,delta=position-session.previousTime,elapsed=(wall-session.previousWall)/1000;
  const advancing=!player.paused&&!player.ended&&!player.error&&!player.seeking&&!seeking&&delta>0&&elapsed>0&&delta<=elapsed*1.5+1;
  // Some WebViews resume media without delivering another `playing` event.
  if(advancing&&!actuallyPlaying){actuallyPlaying=true;setStatus(t('Воспроизводится'));syncControls();}
  if(advancing&&actuallyPlaying)session.seconds+=Math.min(delta,elapsed);
  session.previousTime=position;session.previousWall=wall;
  const threshold=session.track.duration>0?Math.min(15,session.track.duration/2):15;
  if(session.seconds>=threshold&&!session.recorded&&!session.pending&&session.attempts<3&&Date.now()>=session.retryAt){
    session.pending=true;session.attempts++;
    personalRequest('/api/history',{stream_url:session.track.stream_url,play_id:session.id,seconds:session.seconds},15000)
      .then(result=>{if(result.recorded){session.recorded=true;libraries['for-you'].stale=true;}})
      .catch(()=>{session.retryAt=Date.now()+30000;}).finally(()=>session.pending=false);
  }
}
player.addEventListener('timeupdate',trackListening);
for(const event of ['playing','pause','seeking','seeked'])player.addEventListener(event,checkpoint);
// Keep the WebView at one scale; 16px inputs also prevent iOS focus zoom.
for(const event of ['gesturestart','gesturechange','gestureend'])document.addEventListener(event,e=>e.preventDefault(),{passive:false});
document.addEventListener('touchmove',e=>{if(e.touches.length>1)e.preventDefault();},{passive:false});
document.addEventListener('dblclick',e=>{if(!e.target.closest('input,textarea'))e.preventDefault();});
let searchGesture=null,searchDismissTap=false;
document.addEventListener('pointerdown',event=>{
  searchGesture=null;searchDismissTap=false;
  const active=document.activeElement;
  // Keep controls under the finger and keep the keyboard open during playback actions.
  if(active===$('#search')&&event.target.closest('.player-dock')){
    event.preventDefault();return;
  }
  if(active===$('#search')&&event.isPrimary!==false&&!event.target.closest('input,textarea,label,.search-form,[contenteditable]')){
    searchGesture={id:event.pointerId,x:event.clientX,y:event.clientY,scrollX:window.scrollX,scrollY:window.scrollY,contentY:$('.shell').scrollTop,moved:false};
  }
},{capture:true});
document.addEventListener('pointermove',event=>{
  if(searchGesture?.id===event.pointerId&&Math.hypot(event.clientX-searchGesture.x,event.clientY-searchGesture.y)>8)searchGesture.moved=true;
},{capture:true,passive:true});
document.addEventListener('pointercancel',()=>{searchGesture=null;searchDismissTap=false;},{capture:true});
document.addEventListener('pointerup',event=>{
  const gesture=searchGesture;searchGesture=null;
  if(!gesture||gesture.id!==event.pointerId||gesture.moved)return;
  if(Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>8||Math.abs(window.scrollY-gesture.scrollY)>3||Math.abs(window.scrollX-gesture.scrollX)>3)return;
  if(Math.abs($('.shell').scrollTop-gesture.contentY)>3)return;
  searchDismissTap=true;
},{capture:true});
// Wait until click has a target before restoring the document scroll. Otherwise
// unlocking on pointerup can move the tapped row before its click is dispatched.
document.addEventListener('click',event=>{
  const dismiss=searchDismissTap;searchDismissTap=false;
  if(dismiss&&document.activeElement===$('#search')&&!event.target.closest('input,textarea,label,.search-form,[contenteditable]'))$('#search').blur();
},{capture:true});
// Desktop mouse focus should also wait until a tap is distinguished from a drag.
document.addEventListener('mousedown',event=>{
  if(document.activeElement===$('#search')&&!event.target.closest('input,textarea,label,.search-form,[contenteditable]'))event.preventDefault();
},{capture:true});

// Scroll content inside a locked viewport during search. The player is a sibling
// of the scroller, so iOS rubber-banding cannot carry it offscreen or jitter it.
let searchLayoutFrame=0,revealSearchField=false,searchSession=null;
function enterSearch(){
  if(!searchSession){
    searchSession={x:window.scrollX,y:window.scrollY};
    document.documentElement.classList.add('search-focused');
    window.scrollTo(0,0);$('.shell').scrollTop=searchSession.y;
  }
  scheduleSearchLayout(true);
}
function leaveSearch(){
  if(!searchSession)return;
  const y=$('.shell').scrollTop,x=searchSession.x;searchSession=null;
  document.documentElement.classList.remove('search-focused');
  document.documentElement.style.removeProperty('--search-viewport-height');
  window.scrollTo(x,y);
}
function scheduleSearchLayout(reveal=false){
  revealSearchField||=reveal===true;
  if(searchLayoutFrame)return;
  searchLayoutFrame=requestAnimationFrame(()=>{
    searchLayoutFrame=0;
    const shouldReveal=revealSearchField;revealSearchField=false;
    if(!searchSession||document.activeElement!==$('#search'))return;
    const viewport=window.visualViewport;
    document.documentElement.style.setProperty('--search-viewport-height',`${viewport?.height||window.innerHeight}px`);
    // Reveal on focus/keyboard resize, never pull the page back during scrolling.
    if(!shouldReveal)return;
    const field=$('#search').getBoundingClientRect();
    const visibleTop=$('.player-dock').getBoundingClientRect().bottom+12;
    const visibleBottom=(viewport?.height||window.innerHeight)-16;
    if(field.top<visibleTop)$('.shell').scrollTop+=field.top-visibleTop;
    else if(field.bottom>visibleBottom)$('.shell').scrollTop+=field.bottom-visibleBottom;
  });
}
$('#search').addEventListener('focus',enterSearch);
$('#search').addEventListener('blur',leaveSearch);
window.addEventListener('resize',()=>scheduleSearchLayout(true));
window.visualViewport?.addEventListener('resize',()=>scheduleSearchLayout(true));
syncTelegramLayout();
requestAppFullscreen();

$('#language-choice').value=languagePreference;
$('#account').onclick=async()=>{
  $('#search').blur();$('#account-dialog').showModal();telegram?.BackButton?.show();
  $('#account-status').textContent=t('Загружаем…');$('#account-name').textContent='';$('#account-username').textContent='';$('#account-saved').textContent='';
  try{
    const result=await personalRequest('/api/account',{}),user=result.user;
    const name=[user.first_name,user.last_name].filter(Boolean).join(' ');
    $('#account-name').textContent=name||t('Пользователь Telegram');
    $('#account-username').textContent=user.username?'@'+user.username:'';
    $('#account-avatar').textContent=[user.first_name,user.last_name].filter(Boolean).map(part=>Array.from(part)[0]).slice(0,2).join('')||'W';
    if(result.avatar_url){const image=document.createElement('img');image.src=result.avatar_url;image.alt='';image.decoding='async';image.referrerPolicy='no-referrer';image.onerror=()=>image.remove();$('#account-avatar').append(image);}
    accountSavedCount=result.saved_count;
    $('#account-saved').textContent=t('Сохранено треков: {count}',{count:result.saved_count});$('#account-status').textContent='';
  }catch(error){$('#account-status').textContent=t(error.name==='AbortError'?'Сервис не успел ответить. Попробуйте ещё раз.':error instanceof TypeError?'Нет связи с сервером. Попробуйте ещё раз.':error.message);}
};
$('#close-account').onclick=()=>$('#account-dialog').close();
$('#account-dialog').addEventListener('close',()=>{if(!$('#now-playing-dialog').open)telegram?.BackButton?.hide();});
$('#account-library').onclick=()=>{$('#account-dialog').close();switchView('saved');};

async function loadMoreRecommendations(context=libraries['for-you']){
  if(context.next===null)return;
  if(feedRequests.has(context))return feedRequests.get(context);
  const request=(async()=>{
    try{
      if(view==='for-you'&&context===libraries['for-you']&&!context.tracks.length)setLibraryStatus(t('Загружаем…'));
      const result=await personalRequest('/api/recommendations',{offset:context.next},30000);
      if(!Array.isArray(result.tracks))throw new Error(t('Не удалось прочитать результаты.'));
      const known=new Set(context.tracks.map(track=>track.id));
      for(const track of result.tracks)if(!known.has(track.id)){context.tracks.push(track);known.add(track.id);}
      context.next=result.next_offset??null;context.total=context.tracks.length;
      if(view==='for-you'&&context===libraries['for-you']){tracks=context.tracks;nextOffset=context.next;viewError='';setLibraryStatus();render();}
      if(recommendationQueue===context)prepareNext();
    }catch(error){
      const message=error.name==='AbortError'?t('Сервис не успел ответить. Попробуйте ещё раз.'):error instanceof TypeError?t('Нет связи с сервером. Попробуйте ещё раз.'):t(error.message);
      if(recommendationQueue===context)setStatus(message);
      if(view==='for-you'&&context===libraries['for-you']){viewError=message;setLibraryStatus(message);}
      throw error;
    }finally{feedRequests.delete(context);}
  })();
  feedRequests.set(context,request);return request;
}
function maybeLoadRecommendations(){
  if(view!=='for-you'||busy||!libraries['for-you'].loaded||libraries['for-you'].next===null)return;
  const sentinel=$('#feed-sentinel').getBoundingClientRect();
  if(sentinel.top<window.innerHeight+280)loadMoreRecommendations().catch(()=>{});
}
if('IntersectionObserver'in window)new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))maybeLoadRecommendations();},{rootMargin:'280px'}).observe($('#feed-sentinel'));
window.addEventListener('scroll',maybeLoadRecommendations,{passive:true});

const heroTrack=$('.hero-carousel-track'),heroSlides=[...document.querySelectorAll('.hero-slide')];
const heroClone=heroSlides[0].cloneNode(true);heroClone.inert=true;heroClone.setAttribute('aria-hidden','true');heroClone.querySelectorAll('button').forEach(button=>button.tabIndex=-1);heroTrack.append(heroClone);
let heroIndex=0,heroTimer=null,heroPaused=false,heroMoving=false;
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
function scheduleHero(){
  clearTimeout(heroTimer);
  if(heroMoving)return;
  if(heroPaused||document.hidden||reducedMotion.matches||($('.hero-carousel').contains(document.activeElement)&&document.activeElement!==$('#hero-pause')))return;
  heroTimer=setTimeout(()=>showHero((heroIndex+1)%heroSlides.length,true),5000);
}
function showHero(index,automatic=false){
  if(heroMoving)return;
  if(index===heroIndex){scheduleHero();return;}
  const wraps=automatic&&heroIndex===heroSlides.length-1&&index===0;
  heroIndex=index;heroMoving=true;
  heroTrack.style.transform=`translateX(-${(wraps?heroSlides.length:index)*100}%)`;
  heroSlides.forEach((slide,i)=>{slide.inert=i!==index;slide.setAttribute('aria-hidden',String(i!==index));slide.querySelectorAll('button').forEach(button=>button.tabIndex=i===index?0:-1);});
  document.querySelectorAll('.hero-dot').forEach((dot,i)=>dot.setAttribute('aria-current',String(i===index)));
  if(reducedMotion.matches)finishHero();
}
function finishHero(){
  if(heroIndex===0){heroTrack.style.transition='none';heroTrack.style.transform='translateX(0)';requestAnimationFrame(()=>requestAnimationFrame(()=>heroTrack.style.removeProperty('transition')));}
  heroMoving=false;scheduleHero();
}
heroTrack.addEventListener('transitionend',event=>{if(event.target===heroTrack&&event.propertyName==='transform')finishHero();});
for(const button of document.querySelectorAll('[data-hero-target]')){button.disabled=button.dataset.heroTarget==='catalog'&&window.WAVE_SEARCH_CONFIGURED!==true;button.onclick=()=>{switchView(button.dataset.heroTarget);button.blur();scheduleHero();};}
for(const dot of document.querySelectorAll('.hero-dot'))dot.onclick=()=>showHero(Number(dot.dataset.heroIndex));
$('#hero-pause').onclick=()=>{
  heroPaused=!heroPaused;$('#hero-pause').setAttribute('aria-pressed',String(heroPaused));$('#hero-pause').setAttribute('aria-label',t(heroPaused?'Продолжить карточки':'Приостановить карточки'));$('#hero-pause').replaceChildren(icon(heroPaused?'i-play':'i-pause'));scheduleHero();
};
$('.hero-carousel').addEventListener('focusin',()=>clearTimeout(heroTimer));
$('.hero-carousel').addEventListener('focusout',()=>setTimeout(scheduleHero,0));
document.addEventListener('visibilitychange',scheduleHero);
reducedMotion.addEventListener?.('change',()=>{heroMoving=false;scheduleHero();});
heroSlides.forEach((slide,i)=>{slide.inert=i!==0;slide.querySelectorAll('button').forEach(button=>button.tabIndex=i===0?0:-1);});
scheduleHero();

function fitPlayerArtwork(){
  if(!$('#now-playing-dialog').open)return;
  const area=$('.full-artwork-space').getBoundingClientRect();
  $('#full-artwork').style.setProperty('--full-cover-size',`${Math.max(0,Math.floor(Math.min(area.width,area.height)))}px`);
}
if('ResizeObserver'in window)new ResizeObserver(fitPlayerArtwork).observe($('.full-artwork-space'));
window.addEventListener('resize',fitPlayerArtwork);
$('#language-choice').onchange=()=>{
  languagePreference=$('#language-choice').value;
  try{localStorage.setItem(languageStorageKey,languagePreference);}catch{/* Storage is optional. */}
  language=languagePreference==='auto'?WaveI18n.resolveLanguage(telegram?.initDataUnsafe?.user?.language_code,navigator.language):languagePreference;
  const previousStatus=t($('#status').textContent),previousLibraryStatus=t($('#library-status').textContent);
  WaveI18n.localizeDocument(language,document);viewNames=translatedViewNames();updateViewLabels();viewError=t(viewError);render();setStatus(previousStatus);setLibraryStatus(previousLibraryStatus);
  $('#account-status').textContent=t($('#account-status').textContent);$('#toast').textContent=t($('#toast').textContent);
  if(accountSavedCount!==null)$('#account-saved').textContent=t('Сохранено треков: {count}',{count:accountSavedCount});
  if(selectedTrack()){$('#performer').textContent=selectedTrack().performer||t('Музыка профиля');$('#full-performer').textContent=selectedTrack().performer||t('Неизвестный исполнитель');$('#full-queue-title').textContent=recommendationQueue?t('Для вас'):selectedTrack().source==='audius'?t('Результаты поиска Audius'):t('Моя коллекция');}
  $('#hero-pause').setAttribute('aria-label',t(heroPaused?'Продолжить карточки':'Приостановить карточки'));
  const clone=heroSlides[0].cloneNode(true);heroClone.replaceChildren(...clone.childNodes);heroClone.inert=true;heroClone.querySelectorAll('button').forEach(button=>button.tabIndex=-1);
};
