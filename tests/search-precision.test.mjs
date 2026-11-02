import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {searchCatalogueAudius,clearArtistSearchCache} from '../catalogue-search.mjs';
import {trackVersions} from '../track-versions.mjs';

const credentials={AUDIUS_API_KEY:'precision-public-fixture',AUDIUS_BEARER_TOKEN:'precision-private-fixture'};
const song=(id,title,name,extra={})=>({id,title,duration:200,is_streamable:true,user:{name,id:'Uploader'+id},...extra});
function fixture(rows){
  return {...credentials,AUDIUS_HTTP:async url=>{
    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||40);
    if(url.pathname==='/v1/search/full')return Response.json({data:{tracks:rows.slice(offset,offset+limit)}});
    return Response.json({data:[]});
  }};
}
afterEach(clearArtistSearchCache);

test('observed Король и Шут filenames survive while fuzzy КиШ → Кишлак is rejected',async()=>{
  const rows=[
    song('K1','korol__i_shut_-_kukla_kolduna_muzati.net','enot'),
    song('K2','korol__i_shut_-_lesnik_muzati.net','enot'),
    song('K3','korol__i_shut_-_dagon_muzati.net','enot'),
    song('K4','korol_i_shut_kish_-_kukla_kolduna_(z2.fm)','Vitinbrat'),
    song('K5','Korol i shut','Ivan'),
    song('Wrong','Кишлак - Музыка(TheSadFox Remix DEMO)','TheSadFox'),
  ];
  const result=await searchCatalogueAudius(fixture(rows),{query:'король и шут'});
  assert.deepEqual(new Set(result.items.map(track=>track.track_id)),new Set(['K1','K2','K3','K4','K5']));
  assert.ok(!result.items.some(track=>track.track_id==='Wrong'));
  assert.equal(result.items.find(track=>track.track_id==='K2').performer,'enot');
  assert.equal(result.next_offset,null);
});

test('observed Queen artist-prefix versions rank ahead of incidental title words and remix precedes AI cover',async()=>{
  const rows=[
    song('AI','Queen - Who Wants To Live Forever (AI Trump Cover)','Euphoryn',{play_count:468,user:{id:'AiUploader',name:'Euphoryn',is_verified:true}}),
    song('Remix','Queen - Another One Bites the Dust (JAMØ Remix)','JAMØ',{play_count:969}),
    song('SheWho','She Who Would Be Queen - Zunapalooza','Zunapalooza',{play_count:63784}),
    song('James','James and The Queen Of Sodor - Custom Opening','NorrambyBranch',{play_count:1680}),
    song('Dalen','DALEN & Kara Queen - You','DALEN',{play_count:762}),
    song('King','King & Queen - Big Sister','Big Sister',{play_count:674}),
    song('Caribbean','Caribbean Queen-Venus Remix Mashup','Kennedi',{play_count:423}),
    song('Dancing','Dancing Queen [Wukileak]','wuki',{play_count:13845,user:{id:'Wuki',name:'wuki',is_verified:true}}),
    song('Dreams','Queen of Dreams','Kevin Dellinger',{play_count:1304,user:{id:'Kevin',name:'Kevin Dellinger',is_verified:true}}),
    song('Neptune','QUEEN OF NEPTUNE','Kronie',{play_count:36203}),
  ];
  const result=await searchCatalogueAudius(fixture(rows),{query:'queen'}),ids=result.items.map(track=>track.track_id);
  assert.deepEqual(ids.slice(0,2),['Remix','AI']);
  for(const id of ['SheWho','James','Dalen','King','Caribbean','Dancing','Dreams','Neptune'])assert.ok(ids.indexOf(id)>ids.indexOf('AI'),id);
  assert.equal(result.items[0].performer,'JAMØ');
  assert.deepEqual(trackVersions(result.items[0]),['remix']);
  assert.deepEqual(trackVersions(result.items[1]),['ai','cover']);
  for(const track of result.items){assert.equal(track.official,undefined);assert.equal(track.original,undefined);}
});

test('artist-prefix parsing preserves an intraname hyphen such as Jay-Z',async()=>{
  const rows=[song('Mention','A tribute to Jay-Z','Someone',{play_count:1000000}),song('Prefix','Jay-Z - Different song','Uploader')];
  const result=await searchCatalogueAudius(fixture(rows),{query:'Jay-Z'});
  assert.deepEqual(result.items.map(track=>track.track_id),['Prefix','Mention']);
});

test('title — uploader reversal cannot acquire artist-prefix priority',async()=>{
  const rows=[song('Reversed','Queen - Uploader','Uploader',{play_count:100000000}),song('Prefix','Queen - Different song','Some other uploader')];
  const result=await searchCatalogueAudius(fixture(rows),{query:'queen'});
  assert.deepEqual(result.items.map(track=>track.track_id),['Prefix','Reversed']);
});

test('accepted artist metadata ranks before title mentions without inventing identity or recording origin',async()=>{
  const rows=[song('Mention','Queen of Dreams','Other artist',{play_count:100000000}),song('Metadata','A different song title','Queen')];
  const result=await searchCatalogueAudius(fixture(rows),{query:'queen'});
  assert.deepEqual(result.items.map(track=>track.track_id),['Metadata','Mention']);
  assert.equal(result.items[0].performer,'Queen');
  assert.equal(result.items[0].official,undefined);assert.equal(result.items[0].original,undefined);assert.deepEqual(trackVersions(result.items[0]),[]);
});

test('empty locally filtered batches preserve a valid session and continuation until a later match',async()=>{
  const offsets=[];
  const env={...credentials,AUDIUS_HTTP:async url=>{
    if(url.pathname!=='/v1/search/full')return Response.json({data:[]});
    const offset=Number(url.searchParams.get('offset')||0);offsets.push(offset);
    const tracks=offset<160?Array.from({length:40},(_,i)=>song('No'+(offset+i),'Unrelated song '+(offset+i),'Unrelated uploader')):offset===160?[song('Later','Queen - A later matching record','Uploader')]:[];
    return Response.json({data:{tracks}});
  }};
  const initial=await searchCatalogueAudius(env,{query:'queen'});
  assert.deepEqual(initial.items,[]);assert.equal(initial.next_offset,0);assert.equal(typeof initial.search_session,'string');
  assert.deepEqual(offsets,[0,40,80,120]);
  const next=await searchCatalogueAudius(env,{query:'queen',offset:initial.next_offset,session:initial.search_session});
  assert.deepEqual(next.items.map(track=>track.track_id),['Later']);assert.equal(next.search_session,initial.search_session);assert.equal(next.next_offset,null);
});

test('an explicit Queen remix query preserves the requested version and excludes unlabelled/cover-only records',async()=>{
  const rows=[
    song('Unlabelled','Different song','Queen'),
    song('Cover','Queen - Who Wants To Live Forever (AI Trump Cover)','Euphoryn'),
    song('Remix','Queen - Another One Bites the Dust (JAMØ Remix)','JAMØ'),
    song('UnrelatedRemix','A different artist song (Remix)','Other performer'),
  ];
  const result=await searchCatalogueAudius(fixture(rows),{query:'Queen remix'});
  assert.deepEqual(result.items.map(track=>track.track_id),['Remix']);assert.deepEqual(trackVersions(result.items[0]),['remix']);
});
