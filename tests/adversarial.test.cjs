'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'jacred-direct.js'), 'utf8');
const HASH = 'a'.repeat(40);

function createHarness() {
  let rows = [];
  const scope = {
    module: { exports: {} },
    SCRAPER_SETTINGS: {},
    TMDB_API_KEY: '',
    encodeURIComponent,
    decodeURIComponent,
    console: { warn() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ Results: rows }) })
  };
  vm.createContext(scope);
  vm.runInContext(source, scope, { filename: 'jacred-direct.js', timeout: 1000 });
  return { getStreams: scope.module.exports.getStreams, setRows(value) { rows = value; } };
}

// Deterministic, dependency-free input fuzzing. Designed to rerun identically
// in CI on Node 20/22/24. It does not claim to model all possible input types.
test('malformed JacRed rows cannot crash a provider or corrupt a magnet', async () => {
  const harness = createHarness();
  let state = 113;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const values = [null, 0, 1, -1, '', '0', '1', 'foo', {}, [], [1], true,
    12345, '\n\u202eSafe', 'A'.repeat(600),
    'magnet:?xt=urn:btih:' + HASH,
    'udp://printer:6969/announce', 'http://localhost:7777'];
  const pick = () => values[random() % values.length];
  for (let iteration = 0; iteration < 1200; iteration++) {
    const rows = [];
    for (let j = random() % 50; j > 0; j--) {
      rows.push({ Title: pick(), MagnetUri: pick(), Size: pick(),
        Seeders: pick(), Peers: pick(), Tracker: pick(), languages: pick(), info: pick() });
    }
    harness.setRows(rows);
    const result = await harness.getStreams('603', 'movie');
    assert.ok(Array.isArray(result));
    assert.ok(result.length <= 80);
    for (const row of result) {
      assert.match(row.url, /^magnet:\?xt=urn:btih:[a-f0-9]{40}(?:&|$)/);
      assert.ok(row.url.length <= 4096);
      assert.match(row.infoHash, /^[a-f0-9]{40}$/);
      assert.deepEqual(Object.keys(row).sort(), ['infoHash', 'name', 'quality', 'title', 'url'].sort());
    }
  }
});

test('responses longer than a provider page are bounded and deduplicated', async () => {
  const harness = createHarness();
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    rows.push({ Title: 'Movie 1080p ' + i, MagnetUri: 'magnet:?xt=urn:btih:' + HASH,
      Seeders: i, Size: 1024, Tracker: 'tracker' });
  }
  harness.setRows(rows);
  const results = await harness.getStreams('603', 'movie');
  assert.equal(results.length, 1);
  assert.equal(results[0].infoHash, HASH);
});
