// Read-only VPS diagnostic. Use: node --env-file=/etc/wave.env scripts/check-search.mjs
import {searchAudius} from '../audius.mjs';
import {searchCatalogueAudius} from '../catalogue-search.mjs';

const queries=process.argv.slice(2).length?process.argv.slice(2):['король и шут','queen'];
const secrets=['BOT_TOKEN','AUDIUS_API_KEY','AUDIUS_BEARER_TOKEN'].map(name=>process.env[name]).filter(value=>typeof value==='string'&&value.length>3);
function safe(value){let text=String(value??'');for(const secret of secrets)text=text.replaceAll(secret,'[скрыто]');return text.slice(0,300);}
if(!process.env.AUDIUS_API_KEY||!process.env.AUDIUS_BEARER_TOKEN){console.error('Нет ключей Audius. Запустите на VPS: node --env-file=/etc/wave.env scripts/check-search.mjs');process.exitCode=1;}
else for(const query of queries.slice(0,5)){
  console.log('\nЗапрос:',safe(query));
  let raw;
  try{raw=await searchAudius(process.env,{query,count:20});console.log('Обычный индекс, первая страница:',raw.items.length);}
  catch(error){console.log('Обычный индекс:',safe(error.message));}
  const start=performance.now();
  try{
    const result=await searchCatalogueAudius(process.env,{query});
    console.log('Объединённый поиск, первая страница:',result.items.length);
    console.log('Ещё страницы:',result.next_offset!==null?'да':'нет');
    console.log('Варианты:',result.diagnostics.variants.map(safe).join(' / '));
    console.log('Получено строк по источникам:',JSON.stringify(result.diagnostics.rows));
    console.log('Часть источников недоступна:',result.diagnostics.partial?'да':'нет');
    console.log('Время:',Math.round(performance.now()-start),'мс');
    for(const track of result.items.slice(0,5))console.log(JSON.stringify({artist:safe(track.performer),title:safe(track.title),playable:track.playable}));
    if(!result.items.length)console.log('В ответивших индексах Audius нет результатов. Улучшение поиска не добавляет отсутствующие записи в каталог.');
  }catch(error){console.log('Проверка поиска не завершена:',safe(error.message));process.exitCode=1;}
}
