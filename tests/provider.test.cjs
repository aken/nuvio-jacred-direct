'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'jacred-direct.js'), 'utf8');
const HASH_A = '0123456789abcdef0123456789abcdef01234567';
const HASH_B = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH_C = 'fedcba9876543210fedcba9876543210fedcba98';
function sample(title = 'The Matrix (1999) 1080p', hash = HASH_A, seeders = 8, extra = {}) {
  return { Title: title, MagnetUri: 'magnet:?xt=urn:btih:' + hash + '&dn=video', Seeders: seeders, Size: 8589934592, Tracker: 'rutracker', ...extra };
}
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
function scriptInstance(fetchMock, env = {}) {
  const logs = [];
  const sandbox = {
    module: { exports: {} },
    console: { warn: (...args) => logs.push(args.join(' ')) },
    fetch: fetchMock,
    SCRAPER_SETTINGS: env.settings || {}, TMDB_API_KEY: env.tmdbKey || '',
    encodeURIComponent, decodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 1000, filename: 'jacred-direct.js' });
  return { plugin: sandbox.module.exports, logs };
}
function stub(answers, env = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (answers.length === 0) throw Error('Unexpected fetch');
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return response(next.data, next.status === undefined ? 200 : next.status);
  };
  return { ...scriptInstance(fetch, env), calls };
}
const pack = rows => ({ data: { Results: rows } });
const movieMeta = { data: { title: '\u041c\u0430\u0442\u0440\u0438\u0446\u0430', original_title: 'The Matrix', release_date: '1999-03-31' } };
const showMeta = { data: { name: '\u0421\u0435\u0440\u0438\u0430\u043b', original_name: 'Series', first_air_date: '2020-06-01' } };
async function run(answers, tmdbId = '603', kind = 'movie', season, episode, env = {}) {
  const subject = stub(answers, env);
  subject.found = await subject.plugin.getStreams(tmdbId, kind, season, episode);
  return subject;
}
function query(call) { return new URL(call.url); }

test('native manifest matches the expected Nuvio shape and paths', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'JacRed Direct');
  assert.equal(manifest.version, '0.0.5');
  assert.equal(manifest.scrapers.length, 1);
  assert.equal(manifest.scrapers[0].filename, 'jacred-direct.js');
  assert.equal(manifest.scrapers[0].version, manifest.version);
  assert.ok(manifest.scrapers[0].supportedTypes.includes('series'));
  assert.ok(manifest.scrapers[0].supportedTypes.includes('movie'));
});
test('exports exactly the getStreams runtime entrypoint', () => {
  assert.deepEqual(Object.keys(scriptInstance(async () => {}).plugin), ['getStreams']);
});
test('invalid content identifiers are rejected before network access', async () => {
  const invalid = ['tt0123456', '1e4', '12/../34', ' ', '-1', '0xFF', 'NaN', '12345678901'];
  for (const id of invalid) {
    const x = await run([], id);
    assert.equal(x.found.length, 0, id);
  }
});
test('invalid media types are rejected', async () => {
  assert.equal((await run([], '603', 'random')).found.length, 0);
});
test('series require a positive integer season and episode', async () => {
  for (const [s,e] of [[undefined,1],[1,undefined],[-1,1],[1,0],[1.3,4],[2,-1],[null,null],[100,1]]) {
    const x = await run([], '111','series',s,e);
    assert.equal(x.found.length, 0);
  }
});
test('fetches localized movie metadata and searches both names and year', async () => {
  const x = await run([movieMeta, pack([sample()])], '603','movie',null,null,{tmdbKey:'TMDB_KEY'});
  assert.equal(x.calls.length,2);
  assert.equal(query(x.calls[0]).pathname, '/3/movie/603');
  assert.equal(query(x.calls[0]).searchParams.get('language'), 'ru-RU');
  assert.equal(query(x.calls[1]).searchParams.get('title'), '\u041c\u0430\u0442\u0440\u0438\u0446\u0430');
  assert.equal(query(x.calls[1]).searchParams.get('title_original'), 'The Matrix');
  assert.equal(query(x.calls[1]).searchParams.get('year'), '1999');
  assert.equal(query(x.calls[1]).searchParams.get('is_serial'), '1');
  assert.equal(query(x.calls[1]).searchParams.get('limit'), '100');
  assert.equal(x.found[0].url.startsWith('magnet:?'), true);
  assert.equal(x.found[0].infoHash, HASH_A);
});
test('all torrent requests go to the fixed HTTPS JacRed endpoint', async () => {
  const x = await run([pack([sample()])],'603','movie',null,null,{settings:{baseUrl:'https://evil.example',jacredUrl:'https://evil.example',apiKey:'SECRET'}});
  assert.equal(query(x.calls[0]).origin, 'https://jacred.su');
  assert.equal(query(x.calls[0]).pathname,'/api/v2.0/indexers/all/results');
  assert.ok(!x.calls[0].url.includes('SECRET'));
  assert.ok(!JSON.stringify(x.calls[0].options).includes('SECRET'));
  assert.equal(x.found.length,1);
});
test('without TMDB key uses JacRed native TMDB resolver', async () => {
  const x = await run([pack([sample('Any title')])]);
  assert.equal(x.found.length, 1);
  assert.equal(x.calls.length,1);
  assert.equal(query(x.calls[0]).searchParams.get('query'), 'tmdb603');
});
test('failed TMDB fetch falls back to an ID query', async () => {
  const x = await run([{status:401,data:{}},pack([sample()])], '603','movie',null,null,{tmdbKey:'TMDB_KEY'});
  assert.equal(x.calls.length,2);
  assert.equal(x.found.length,1);
  assert.equal(query(x.calls[1]).searchParams.get('query'),'tmdb603');
  assert.ok(x.logs[0].includes('TMDB lookup failed'));
  assert.ok(!x.logs.join('|').includes('TMDB_KEY'));
});
test('unexpected TMDB JSON falls back to ID query', async () => {
  assert.equal((await run([{data:{unexpected:1}},pack([sample()])],'603','movie',null,null,{tmdbKey:'KEY'})).found.length,1);
});
test('invalid JacRed response fails safely', async () => {
  const x = await run([{data:{Error:'unknown'}}]);
  assert.equal(x.found.length,0);
  assert.equal(x.calls.length,1);
});
test('non-JSON JacRed response fails safely', async () => {
  const x = await run([{data:null}]);
  assert.equal(x.found.length,0);
});
test('network failure fails safely and emits no raw URL', async () => {
  const x = await run([new Error('Network down')]);
  assert.equal(x.found.length,0);
  assert.ok(x.logs[0].includes('network/format error'));
});
for (const status of [401,403,429]) test('JacRed HTTP '+status+' is not retried', async () => {
  const x = await run([{status,data:{}}],'603','movie');
  assert.equal(x.calls.length,1);
  assert.equal(x.found.length,0);
});
test('an empty metadata card search retries titles without the year once', async () => {
  const x = await run([movieMeta,pack([]),pack([sample()])],'603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
  assert.equal(x.calls.length,3);
  assert.equal(query(x.calls[2]).searchParams.get('year'),null);
  assert.equal(query(x.calls[2]).searchParams.get('title_original'),'The Matrix');
});
test('a useful card search never makes a fallback request', async () => {
  const x = await run([movieMeta,pack([sample()])],'603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.calls.length,2);
});
test('an invalid card result can trigger the ID fallback', async () => {
  const x = await run([movieMeta,pack([{Title:'bad',MagnetUri:'http://bad'}]),pack([sample()])],'603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.calls.length,3);
  assert.equal(x.found.length,1);
});
test('no valid magnet is emitted for an HTTP .torrent URL', async () => {
  const x = await run([pack([sample('x',HASH_A,1,{MagnetUri:'https://example.com/a.torrent'})])]);
  assert.equal(x.found.length,0);
});
test('rejects malformed, truncated, and invalid BTIH hashes', async () => {
  const bad = ['magnet:?xt=urn:btih:123', 'magnet:?xt=urn:btih:'+'g'.repeat(40), 'magnet:?dn=withoutxt', 'magnet:?xt=urn:btmh:1220'+HASH_A, 'javascript:alert(1)', 'magnet:?xt=urn:btih:'+HASH_A+'z'];
  const x = await run([pack(bad.map((magnet,i) => sample('Film'+i,HASH_A,2,{MagnetUri:magnet})).concat([sample()]))]);
  assert.equal(x.found.length,1);
});
test('handles percent-encoded xt values', async () => {
  const x = await run([pack([sample('Movie',HASH_A,1,{MagnetUri:'magnet:?dn=film&xt=urn%3Abtih%3A'+HASH_A})])]);
  assert.equal(x.found[0].infoHash,HASH_A);
});
test('normalizes base32 BTIH to its canonical hex hash', async () => {
  const x = await run([pack([sample('Film',HASH_A,1,{MagnetUri:'magnet:?xt=urn:btih:'+'A'.repeat(32)})])]);
  assert.equal(x.found[0].infoHash,'0'.repeat(40));
});
test('ignores malformed xt percent encoding without crashing', async () => {
  const x = await run([pack([sample('Film',HASH_A,1,{MagnetUri:'magnet:?xt=%E0%A4%A'})])]);
  assert.equal(x.found.length,0);
});
test('excessively long magnets are rejected', async () => {
  const x = await run([pack([sample('Film',HASH_A,1,{MagnetUri:'magnet:?xt=urn:btih:'+HASH_A+'&dn='+'X'.repeat(9000)})])]);
  assert.equal(x.found.length,0);
});
test('duplicate hashes prefer higher seed count', async () => {
  const x = await run([pack([sample('720p first',HASH_A,1),sample('1080p second',HASH_A,18),sample('4K third',HASH_B,5)])]);
  assert.equal(x.found.length,2);
  assert.equal(x.found[0].infoHash,HASH_A);
  assert.equal(x.found[0].quality,'1080p');
});
test('deduplication picks a standalone episode over a season pack', async () => {
  const x = await run([pack([sample('TV S01 complete 4K',HASH_A,40),sample('TV S01E02 1080p',HASH_A,1)])], '42','series',1,2);
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].quality,'1080p');
  assert.ok(!x.found[0].name.includes('Episode selection not verified'));
});
test('sorts standalone episodes first, then seed count', async () => {
  const x = await run([pack([sample('Show S01E02 720p',HASH_A,2),sample('Show S01 1080p',HASH_B,100),sample('Show S01E02 1080p',HASH_C,20)])], '42','series',1,2);
  assert.deepEqual(Array.from(x.found,(r)=>r.infoHash),[HASH_C,HASH_A,HASH_B]);
});
test('reports size and unknown seed count accurately', async () => {
  const x = await run([pack([sample('Film 1080p',HASH_A,undefined,{Size:1073741824,Seeders:null})])]);
  assert.match(x.found[0].title,/1.0 GiB/);
  assert.match(x.found[0].name,/Seeders unknown/);
});
test('known zero seeders remain visible by default', async () => {
  const x = await run([pack([sample('Film',HASH_A,0)])]);
  assert.equal(x.found.length,1);
});
test('minimum seeders rejects unverified counts as well as weak known counts', async () => {
  const x = await run([pack([sample('Film',HASH_A,0),sample('Film2',HASH_B,3),sample('Film3',HASH_C,undefined,{Seeders:null})])],'603','movie',null,null,{settings:{minSeeders:2}});
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].infoHash,HASH_B);
});
test('strict year gate skips wrong movie, accepts exact year', async () => {
  const x = await run([movieMeta,pack([sample('The Matrix 2024 1080p'),sample('The Matrix 1999 1080p',HASH_B)])], '603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found[0].infoHash,HASH_B);
  assert.equal(x.found.length,1);
});
test('server release-year metadata takes precedence over title year', async () => {
  const x = await run([movieMeta,pack([sample('The Matrix 2024 Remaster 1080p',HASH_A,1,{info:{relased:1999}})])], '603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
});
test('unknown release year does not cause a false-negative movie result', async () => {
  const x = await run([movieMeta,pack([sample('The Matrix 1080p')])], '603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
});
test('1920x1080 video dimensions are not mistaken for release years', async () => {
  const x = await run([movieMeta,pack([sample('The Matrix 1920x1080 BDRip')])], '603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
});
test('series search sets season/ep and series type', async () => {
  const x = await run([showMeta,pack([sample('Series S02E05')])], '221','series',2,5,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
  assert.equal(query(x.calls[1]).searchParams.get('season'),'2');
  assert.equal(query(x.calls[1]).searchParams.get('ep'),'5');
  assert.equal(query(x.calls[1]).searchParams.get('is_serial'),'2');
  assert.equal(query(x.calls[0]).pathname,'/3/tv/221');
});
test('wrong episode is filtered', async () => {
  const x = await run([pack([sample('Show S02E04',HASH_A),sample('Show S02E05',HASH_B)])], '42','tv',2,5);
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].infoHash,HASH_B);
});
test('wrong season is filtered', async () => {
  const x = await run([pack([sample('Show S01E05'),sample('Show S02E05',HASH_B)])], '42','series',2,5);
  assert.equal(x.found.length,1);
});
test('season zero specials are supported', async () => {
  const x = await run([pack([sample('Show S00E05')])], '42','series',0,5);
  assert.equal(x.found.length,1);
});
test('episode ranges are matched and flagged for file selection', async () => {
  const x = await run([pack([sample('Show S01E01-E10',HASH_A),sample('Show S01E11-E14',HASH_B)])], '42','series',1,7);
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].infoHash,HASH_A);
  assert.match(x.found[0].title,/Episode selection not verified/);
});
test('numeric season x episode notation is supported', async () => {
  const x = await run([pack([sample('Show 2x05',HASH_A),sample('Show 1x05',HASH_B)])], '42','tv',2,5);
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].infoHash,HASH_A);
});
test('localized season/episode labels are supported', async () => {
  const x = await run([pack([sample('\u0421\u0435\u0440\u0438\u0430\u043b \u0441\u0435\u0437\u043e\u043d 2 \u0441\u0435\u0440\u0438\u044f 5',HASH_A)])], '42','series',2,5);
  assert.equal(x.found.length,1);
});
test('adjacent S01E02E03 markers include episode 3 without claiming file accuracy', async () => {
  const x = await run([pack([sample('Show S01E02E03',HASH_A)])], '42','series',1,3);
  assert.equal(x.found.length,1);
  assert.match(x.found[0].title,/Episode selection not verified/);
});
test('multi-episode releases obey the optional pack restriction', async () => {
  const x = await run([pack([sample('Show S01E01-E10',HASH_A)])], '42','series',1,7,{settings:{allowSeasonPacks:false}});
  assert.equal(x.found.length,0);
});
test('season-only packs are surfaced and marked as unverified', async () => {
  const x = await run([pack([sample('Show S01 Complete',HASH_A)])], '42','series',1,3);
  assert.equal(x.found.length,1);
  assert.match(x.found[0].title,/Episode selection not verified/);
});
test('season packs can be disabled explicitly', async () => {
  const x = await run([pack([sample('Show S01 Complete',HASH_A)])],'42','series',1,3,{settings:{allowSeasonPacks:false}});
  assert.equal(x.found.length,0);
});
test('multi-season pack ranges include intermediate seasons', async () => {
  const x = await run([pack([sample('Show S01-S04 Complete')])], '42','series',3,4);
  assert.equal(x.found.length,1);
});
test('multi-season pack ranges exclude out-of-range seasons', async () => {
  const x = await run([pack([sample('Show S01-S04 Complete')])], '42','series',5,4);
  assert.equal(x.found.length,0);
});
test('JacRed info.seasons permits a pack when explicit season is absent', async () => {
  const x = await run([pack([sample('Show Complete',HASH_A,1,{info:{seasons:[2]}})])], '42','series',2,5);
  assert.equal(x.found.length,1);
  assert.match(x.found[0].title,/Episode selection not verified/);
});
test('no season/episode evidence is excluded by default', async () => {
  const x = await run([pack([sample('Show 1080p')])], '42','series',1,1);
  assert.equal(x.found.length,0);
});
test('ambiguous episode can be enabled explicitly', async () => {
  const x = await run([pack([sample('Show 1080p')])], '42','series',1,1,{settings:{allowUnknownEpisode:true}});
  assert.equal(x.found.length,1);
  assert.match(x.found[0].title,/Episode selection not verified/);
});
test('standalone E05 without season is excluded by default', async () => {
  const x = await run([pack([sample('Show E05')])], '42','series',2,5);
  assert.equal(x.found.length,0);
});
test('metadata card series fallback omits server filter to recover different title formats', async () => {
  const x = await run([showMeta,pack([]),pack([sample('\u0421\u0435\u0440\u0438\u0430\u043b \u0441\u0435\u0437\u043e\u043d 2 \u0441\u0435\u0440\u0438\u044f 5')])], '42','series',2,5,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
  assert.equal(x.calls.length,3);
  assert.equal(query(x.calls[2]).searchParams.get('season'),null);
  assert.equal(query(x.calls[2]).searchParams.get('title'),'\u0421\u0435\u0440\u0438\u0430\u043b');
});
test('result output limit respects user settings', async () => {
  const x = await run([pack([sample('A',HASH_A),sample('B',HASH_B),sample('C',HASH_C)])], '603','movie',null,null,{settings:{maxResults:2}});
  assert.equal(x.found.length,2);
});
test('invalid output limit settings are ignored', async () => {
  const x = await run([pack([sample()])], '603','movie',null,null,{settings:{maxResults:'1e99'}});
  assert.equal(x.found.length,1);
});
test('malicious control characters are removed from returned labels', async () => {
  const x = await run([pack([sample('Film\u202etitle\u0000text',HASH_A,1,{Tracker:'R\u0000T'})])]);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u202a-\u202e]/.test(x.found[0].title));
  assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(x.found[0].name));
});
test('unexpected response row types and invalid torrent fields do not crash', async () => {
  const x = await run([pack([null,0,'oops',[],{},sample()])]);
  assert.equal(x.found.length,1);
});
test('returns Nuvio-supported primitive property types', async () => {
  const x = await run([pack([sample()])]);
  const result=x.found[0];
  assert.deepEqual(Object.keys(result).sort(),['infoHash','name','quality','title','url'].sort());
  assert.ok(Object.values(result).every(v => typeof v === 'string'));
});
test('display labels use clear language for torrent availability', async () => {
  const x = await run([pack([sample('Film',HASH_A,1),sample('Film 1080p',HASH_B,0)])]);
  assert.match(x.found[0].name,/1 seed/);
  assert.match(x.found[1].name,/0 seeds/);
  assert.ok(x.found.every(r => !r.name.includes('PACK -')));
});
test('no external packages, backend requirements or unwanted secret-bearing code', () => {
  assert.ok(!source.includes('require('));
  assert.ok(!source.includes('eval('));
  assert.ok(!source.includes('X-Api-Key\u0027]'));
  assert.ok(!source.includes('http://'));
  assert.ok(!source.includes('http://localhost'));
  assert.ok(!source.includes('https://localhost')); 
});

test('public JacRed requests do not transmit API credentials', async () => {
  const x = await run([pack([sample()])]);
  assert.equal(x.found.length, 1);
  for (const request of x.calls) {
    const url = query(request);
    if (url.hostname !== 'jacred.su') continue;
    assert.equal(url.searchParams.has('apikey'), false);
    assert.equal(url.searchParams.has('api_key'), false);
    const headers = (request.options && request.options.headers) || {};
    assert.ok(!Object.keys(headers).some(k => /^(x-api-key|authorization)$/i.test(k)));
  }
});


test('native source card preserves the release name and includes availability details', async () => {
  const x = await run([pack([sample('The Matrix 1999 1080p WEB-DL HDR10+ HEVC',HASH_A,7,{Peers:0})])]);
  const item = x.found[0];
  assert.match(item.name,/JacRed.*1080p.*7 seeds/);
  assert.match(item.title,/^The Matrix 1999 1080p WEB-DL HDR10\+ HEVC\n/);
  assert.match(item.title,/rutracker.*8.0 GiB.*0 peers.*WEB-DL.*HDR10\+.*HEVC/);
  assert.ok(!Object.hasOwn(item, 'size'), 'Nuvio must use release title rather than size for description');
});
test('peers are reported as peers without guessing a leecher count', async () => {
  const x=await run([pack([sample('The Matrix 1999 1080p',HASH_A,0),sample('The Matrix 1999 720p',HASH_B,1,{Peers:1})])]);
  const byHash = new Map(x.found.map(v=>[v.infoHash,v]));
  assert.ok(!byHash.get(HASH_A).title.includes('peer'));
  assert.match(byHash.get(HASH_B).title,/1 peer/);
});
test('short DV voice metadata is not mistaken for Dolby Vision on old AVI releases', async () => {
  const x=await run([pack([sample('The Matrix 1999 DV AVI 1080p',HASH_A,4)])]);
  assert.ok(!x.found[0].title.includes('\u00b7 DV'));
});
test('Cyrillic K in explicit 4K quality label is supported', async () => {
  const x=await run([pack([sample('The Matrix 1999 4\u041a HDR',HASH_A,4)])]);
  assert.match(x.found[0].name,/2160p/);
  assert.match(x.found[0].title,/HDR/);
});
test('movie fallback retries the localized card without a server-side year', async () => {
  const x=await run([movieMeta, pack([]), pack([sample('The Matrix 1999 1080p')])], '603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
  assert.equal(x.calls.length,3);
  assert.equal(query(x.calls[1]).searchParams.get('year'),'1999');
  assert.equal(query(x.calls[2]).searchParams.get('year'),null);
  assert.equal(query(x.calls[2]).searchParams.get('title_original'),'The Matrix');
  assert.equal(query(x.calls[2]).searchParams.get('query'),null);
});
test('fallback does not accept unrelated release or mismatched year', async () => {
  const x=await run([movieMeta, pack([]), pack([
    sample('The Matrix 1999 WEB-DL', HASH_A),
    sample('Italian Film 1999', HASH_B),
    sample('The Matrix 2015 1080p', HASH_C)
  ])], '603','movie',null,null,{tmdbKey:'KEY'});
  // A release containing the full title and year can legitimately include extra words.
  assert.equal(x.found.length,1);
  assert.match(x.found[0].title,/The Matrix 1999 WEB-DL/);
});
test('a short movie title cannot match part of a longer word', async () => {
  const x=await run([{data:{title:'It',original_title:'It',release_date:'2017-09-08'}},pack([
    sample('Italian 2017 1080p',HASH_A),sample('It (2017) 1080p',HASH_B)
  ])], '346364','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
  assert.match(x.found[0].title,/^It \(2017\)/);
});
test('release matching rejects unrelated results before deciding whether to fallback', async () => {
  const x=await run([movieMeta,pack([sample('Unrelated 1999 1080p')]),pack([sample('The Matrix 1999 1080p')])], '603','movie',null,null,{tmdbKey:'KEY'});
  assert.equal(x.found.length,1);
  assert.equal(x.calls.length,3);
});


test('source cards include only explicitly reported language and voice metadata', async () => {
  const row=sample('The Matrix 1999 1080p',HASH_A,7,{languages:['ru','en','ru','xx'],info:{voices:['LostFilm','NewStudio','LostFilm']}});
  const x=await run([pack([row])]);
  assert.match(x.found[0].title,/Languages: RU\/EN/);
  assert.match(x.found[0].title,/Voice: LostFilm \/ NewStudio/);
  assert.ok(!x.found[0].title.includes('xx'));
});
test('tracker names do not imply an audio language', async () => {
  const x=await run([pack([sample('The Matrix 1999 1080p',HASH_A,3,{Tracker:'Russian Tracker'})])]);
  assert.ok(!x.found[0].title.includes('Languages:'));
});

test('manifest allows the host to determine platform availability', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const provider = manifest.scrapers[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(provider, 'supportedPlatforms'));
  assert.ok(!Object.prototype.hasOwnProperty.call(provider, 'disabledPlatforms'));
  assert.ok(['movie', 'series', 'tv', 'anime'].every(kind => provider.supportedTypes.includes(kind)));
  assert.equal(provider.version, manifest.version);
});

test('Android TV, webOS and Tizen use the same platform-independent provider API', async () => {
  const id = '42';
  const title = 'Example S02E05 1080p';
  for (const mediaType of ['tv', 'series', 'anime']) {
    const result = await run([pack([sample(title)])], id, mediaType, 2, 5);
    assert.equal(result.found.length, 1, mediaType);
    assert.equal(result.found[0].infoHash, HASH_A, mediaType);
    assert.equal(query(result.calls[0]).searchParams.get('is_serial'), '2');
    assert.equal(query(result.calls[0]).searchParams.get('season'), '2');
    assert.equal(query(result.calls[0]).searchParams.get('ep'), '5');
  }
  const movie = await run([pack([sample()])], '603', 'movie');
  assert.equal(movie.found.length, 1);
  assert.equal(query(movie.calls[0]).searchParams.get('is_serial'), '1');
});

test('result labels use universally available characters', async () => {
  const result = await run([pack([sample()])]);
  assert.equal(result.found.length, 1);
  assert.ok(result.found[0].name.startsWith('JacRed'));
  assert.ok(!/[\uD835][\uDC00-\uDFFF]/.test(result.found[0].name));
});

test('provider does not assume a browser DOM or a TV-specific global API', () => {
  assert.ok(!/\b(?:document|navigator|location|tizen|webOS|webos|Android)\./.test(source));
  assert.ok(!/\brequire\s*\(/.test(source));
  assert.ok(!/\bprocess\./.test(source));
});


test('canonical magnet is compatible with Tizen BTIH extraction', async () => {
  const b32 = 'A'.repeat(32);
  const x = await run([pack([sample('Movie',HASH_A,7,{MagnetUri:'magnet:?dn=x&xt=urn%3Abtih%3A'+b32})])]);
  assert.equal(x.found[0].infoHash,'0'.repeat(40));
  assert.match(x.found[0].url,/^magnet:\?xt=urn:btih:[a-f0-9]{40}(?:&|$)/);
});
test('duplicate torrent hashes retain distinct public trackers', async () => {
  const one='udp://tracker.one.example:6969/announce';
  const two='https://tracker.two.example/announce';
  const x = await run([pack([
    sample('Movie 720p',HASH_A,2,{MagnetUri:'magnet:?xt=urn:btih:'+HASH_A+'&tr='+encodeURIComponent(one)}),
    sample('Movie 1080p',HASH_A,8,{MagnetUri:'magnet:?xt=urn:btih:'+HASH_A+'&tr='+encodeURIComponent(two)})
  ])]);
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].quality,'1080p');
  assert.equal((x.found[0].url.match(/&tr=/g)||[]).length,2);
  assert.ok(x.found[0].url.includes(encodeURIComponent(one)));
  assert.ok(x.found[0].url.includes(encodeURIComponent(two)));
});
test('private, local, malformed and credentialed trackers are excluded', async () => {
  const trackers = [
    'http://127.0.0.1:80/announce','http://192.168.1.5/announce',
    'http://localhost/announce','udp://10.2.3.4:80/announce',
    'https://user:password@tracker.example/announce',
    'udp://tracker.example.com:6969/announce', 'https://tracker.example.org/announce'
  ];
  const magnet='magnet:?xt=urn:btih:'+HASH_A+trackers.map(x=>'&tr='+encodeURIComponent(x)).join('');
  const x=await run([pack([sample('Movie',HASH_A,2,{MagnetUri:magnet})])]);
  assert.equal(x.found.length,1);
  assert.equal((x.found[0].url.match(/&tr=/g)||[]).length,2);
  assert.ok(!x.found[0].url.includes(encodeURIComponent('http://127.0.0.1')));
  assert.ok(!x.found[0].url.includes('password'));
});
test('malformed tracker encoding never invalidates the valid BTIH', async () => {
  const x=await run([pack([sample('Movie',HASH_A,2,{MagnetUri:'magnet:?xt=urn:btih:'+HASH_A+'&tr=%E0%A4%A'})])]);
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].url,'magnet:?xt=urn:btih:'+HASH_A);
});
test('recognizes 4K UHD, frame rates and explicit raster dimensions', async () => {
  const titles = [
    ['Show 2160p60', '2160p'],['Show 1920x1080','1080p'],
    ['Show 2560x1440','1440p'],['Show 3840x2160','2160p'],
    ['Show 1080p60','1080p'],['Show 8K','4320p']
  ];
  for (const [title,expected] of titles) {
    const x=await run([pack([sample(title)])]);
    assert.equal(x.found[0].quality, expected, title);
  }
});
test('numeric TMDB IDs from native runtimes are accepted', async () => {
  const x=await run([pack([sample()])],603);
  assert.equal(x.found.length,1);
  assert.equal(query(x.calls[0]).searchParams.get('query'),'tmdb603');
});
test('custom maxResults still yields at most the configured cap after deduplication', async () => {
  const x=await run([pack([sample('Movie A',HASH_A,1), sample('Movie B',HASH_A,2), sample('Movie C',HASH_B,3)])], '603','movie',null,null,{settings:{maxResults:1}});
  assert.equal(x.found.length,1);
  assert.equal(x.found[0].infoHash,HASH_B);
});

test('tracker URL validation rejects noncanonical private IP spellings', async () => {
  const bad = ['http://0177.0.0.1/announce','udp://0x7f.0.0.1:80/announce',
    'https://2130706433/announce', 'https://tracker.example:0/announce',
    'udp://tracker.example:65536/announce','https://router.home.arpa/announce'];
  const good = 'udp://tracker.open.example:6969/announce';
  const magnet = 'magnet:?xt=urn:btih:' + HASH_A + bad.concat([good]).map(url => '&tr='+encodeURIComponent(url)).join('');
  const x = await run([pack([sample('Movie', HASH_A, 6, {MagnetUri: magnet})])]);
  assert.equal((x.found[0].url.match(/&tr=/g) || []).length, 1);
  assert.ok(x.found[0].url.includes(encodeURIComponent(good)));
});
test('sensitive tracker query credentials are never forwarded', async () => {
  const bad='https://tracker.example/announce?passkey=SENSITIVE123';
  const good='udp://tracker.safe.example:6969/announce';
  const magnet='magnet:?xt=urn:btih:'+HASH_A+'&tr='+encodeURIComponent(bad)+'&tr='+encodeURIComponent(good);
  const x=await run([pack([sample('Movie',HASH_A,4,{MagnetUri:magnet})])]);
  assert.ok(!x.found[0].url.includes('SENSITIVE123'));
  assert.equal((x.found[0].url.match(/&tr=/g)||[]).length,1);
});
test('network tracker lists are bounded when duplicates are merged', async () => {
  const rows=[];
  for(let i=0;i<28;i++){
    const url='udp://tracker'+i+'.example:6969/announce';
    rows.push(sample('Movie',HASH_A,i,{MagnetUri:'magnet:?xt=urn:btih:'+HASH_A+'&tr='+encodeURIComponent(url)}));
  }
  const x=await run([pack(rows)]);
  assert.equal(x.found.length,1);
  assert.ok((x.found[0].url.match(/&tr=/g)||[]).length<=24);
  assert.ok(x.found[0].url.length<=4096);
});

// Inputs that exposed incorrect season-pack matching in the initial release.
for (const format of ['Show Season 1-3 1080p', 'Show S01-03 1080p', 'Show Season 1, 2, 3 1080p', 'Show 1-3 seasons 1080p']) {
  test('explicit season span includes the requested third season: ' + format, async () => {
    const x = await run([pack([sample(format)])], '42', 'series', 3, 5);
    assert.equal(x.found.length, 1);
    assert.match(x.found[0].title, /Episode selection not verified/);
  });
}
test('separate season lists do not imply missing intermediate seasons', async () => {
  const x = await run([pack([sample('Show S01, S03')]), pack([sample('Show S01, S03')])], '42', 'series', 2, 5);
  assert.equal(x.found.length, 0);
});
test('reversed season span is not evidence for a requested season', async () => {
  const x = await run([pack([sample('Show Season 5-3')]), pack([sample('Show Season 5-3')])], '42', 'series', 4, 5);
  assert.equal(x.found.length, 0);
});
test('overlong season and episode numbers cannot match partial digit prefixes', async () => {
  for (const label of ['Show S01E1000', 'Show 1x1000', 'Show Season 100']) {
    const x = await run([pack([sample(label)]), pack([sample(label)])], '42', 'series', 1, 100);
    assert.equal(x.found.length, 0, label);
  }
});
test('reserved documentation and benchmarking tracker addresses are stripped', async () => {
  const blocked = ['198.18.1.2', '198.19.1.2', '198.51.100.1', '203.0.113.6', '192.0.2.9', '192.0.0.1'];
  const good = 'udp://tracker.example.net:6969/announce';
  const magnet = 'magnet:?xt=urn:btih:' + HASH_A + blocked.map(h => '&tr=' + encodeURIComponent('http://' + h + ':80/announce')).join('') + '&tr=' + encodeURIComponent(good);
  const x = await run([pack([sample('Movie', HASH_A, 5, { MagnetUri: magnet })])]);
  assert.equal((x.found[0].url.match(/&tr=/g) || []).length, 1);
  assert.ok(x.found[0].url.includes(encodeURIComponent(good)));
});
test('Android other media kind uses the TV/series provider contract', async () => {
  const x = await run([pack([sample('Show S02E03')])], '42', 'other', 2, 3);
  assert.equal(x.found.length, 1);
});

test('comma-separated episode lists match only the numbered episodes', async () => {
  const title='Show S01E02,E04 1080p';
  const valid=await run([pack([sample(title)])], '42','series',1,4);
  assert.equal(valid.found.length,1);
  assert.match(valid.found[0].title,/Episode selection not verified/);
  const invalid=await run([pack([sample(title)]),pack([sample(title)])], '42','series',1,3);
  assert.equal(invalid.found.length,0);
});
test('plugin metadata and package version remain synchronized', () => {
  const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'), 'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'..','manifest.json'),'utf8'));
  assert.equal(manifest.version,pkg.version);
  assert.equal(manifest.scrapers[0].version,pkg.version);
  assert.match(pkg.version,/^0\.0\.5$/);
});
