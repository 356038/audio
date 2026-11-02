import test from 'node:test';
import assert from 'node:assert/strict';
import {trackVersions} from '../track-versions.mjs';

test('observed Audius titles retain explicit AI, cover, remix and demo labels',()=>{
  const examples=[
    ['Queen - Who Wants To Live Forever (AI Trump Cover)',['ai','cover']],
    ['Queen - Another One Bites the Dust (JAMØ Remix)',['remix']],
    ['Кишлак - Музыка(TheSadFox Remix DEMO)',['remix','demo']],
    ['Caribbean Queen-Venus Remix Mashup',['remix','mashup']],
    ['Dancing Queen [Wukileak]',[]],
    ['korol__i_shut_-_lesnik_muzati.net',[]],
  ];
  for(const [title,expected]of examples)assert.deepEqual(trackVersions({title}),expected,title);
});

test('ordinary titles do not become AI, cover, live or remix versions through substrings',()=>{
  for(const title of ['Ai Se Eu Te Pego','Under Cover','Cover Me','Live Forever','Who Wants To Live Forever','Live and Let Die','Alive','Demolition','Remixology','Cover Story','A.I. Theme','Renaissance'])assert.deepEqual(trackVersions({title}),[],title);
});

test('explicit cover contexts include bracketed credits, version suffixes and structured metadata',()=>{
  for(const title of ['Song (Alice Cover)','Song [Piano Cover by Alice]','Artist - Song - Cover','Artist - Piano Cover','Song (Cover Version)','Song (Piano Cover (Alice))'])assert.ok(trackVersions({title}).includes('cover'),title);
  assert.deepEqual(trackVersions({title:'Unlabelled song',cover_original_artist:'Queen'}),['cover']);
  assert.deepEqual(trackVersions({title:'Unlabelled song',cover_original_song_title:'Another One Bites the Dust'}),['cover']);
  assert.deepEqual(trackVersions({title:'Unlabelled song',cover_original_artist:'  '}),[]);
});

test('AI requires explicit generation, voice or cover wording',()=>{
  for(const title of ['Song (AI cover)','Song — AI-generated','AI voice version','Song [A.I. Trump Cover]','Песня (ИИ кавер)','Песня (нейрокавер)'])assert.ok(trackVersions({title}).includes('ai'),title);
  assert.deepEqual(trackVersions({title:'AI-generated instrumental'}),['ai']);
});

test('live labels use version context instead of the word live inside a title',()=>{
  for(const title of ['Song (Live)','Song [Live at Wembley 1986]','Song - Live','Song (Wembley Live)','Song (Live Aid 1985)','Песня (лайв)'])assert.deepEqual(trackVersions({title}),['live'],title);
  assert.deepEqual(trackVersions({title:'Song (Live Forever)'}),[]);
});

test('multiple labels are deduplicated and returned in a fixed order, including Unicode markers',()=>{
  assert.deepEqual(trackVersions({title:'Песня (LIVE REMIX / DEMO / AI Cover / Mash-up / Sped-Up / Slowed + reverb)'}),['ai','cover','remix','mashup','demo','live','sped-up','slowed']);
  assert.deepEqual(trackVersions({title:'Песня (ремикс, демо, кавер)'}),['cover','remix','demo']);
  assert.deepEqual(trackVersions({title:'Song (Remix) [REMIX]'}),['remix']);
  assert.deepEqual(trackVersions({title:'Song_Sped_Up'}),['sped-up']);
});

test('missing metadata gives no version or original claim',()=>{
  for(const track of [undefined,null,{}, {title:123},{title:'Unlabelled recording'}])assert.deepEqual(trackVersions(track),[]);
});
