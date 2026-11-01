import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={};vm.runInNewContext(readFileSync(new URL('../docs/i18n.js',import.meta.url),'utf8'),context);
const {resolveLanguage,translate}=context.WaveI18n;
test('automatic language prefers Telegram, falls back to device and uses English for unsupported languages',()=>{
 assert.equal(resolveLanguage('ru','en-US'),'ru');assert.equal(resolveLanguage('ru-RU','en'),'ru');assert.equal(resolveLanguage('en','ru'),'en');
 assert.equal(resolveLanguage(undefined,'ru-RU'),'ru');assert.equal(resolveLanguage('','en-GB'),'en');assert.equal(resolveLanguage('de','ru'),'en');assert.equal(resolveLanguage(undefined,undefined),'en');
});
test('UI, server errors and recommendation explanations translate without translating unknown track data',()=>{
 assert.equal(translate('en','Моя музыка'),'My music');assert.equal(translate('ru','Моя музыка'),'Моя музыка');
 assert.equal(translate('en','Открыть {track}',{track:'Мало — Группа'}),'Open Мало — Группа');
 assert.equal(translate('en','Сессия истекла. Закройте и заново откройте WAVE.'),'Your session expired. Close and reopen WAVE.');
 assert.equal(translate('en','Пока по знакомым исполнителям: у прослушанных треков не указан жанр.'),'Based on familiar artists for now: your played tracks have no genre information.');
 assert.equal(translate('en','Найдено {total}. Показано {loaded}.',{total:42,loaded:20}),'Found 42. Showing 20.');
 assert.equal(translate('en','Оригинальная песня'),'Оригинальная песня');
 assert.equal(translate('ru','My music'),'Моя музыка');assert.equal(translate('en','constructor'),'constructor');
});
