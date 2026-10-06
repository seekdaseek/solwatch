// Price fallback logging: Jupiter failing while DexScreener answers is ONE stdout info line; stderr only when
// every source fails. global.fetch is mocked; Firebase and FCM are stubbed in the require cache.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { captureConsole } = require('./fakeFirestore');
for (const m of ['firebase', 'fcm']) {
  const f = path.join(__dirname, '..', 'src', `${m}.js`);
  require.cache[f] = { id: f, filename: f, loaded: true, exports: { getDb: () => { throw new Error('no db in tests'); }, sendPush: async () => {} } };
}
const { fetchPrices } = require('../src/priceMonitor');

const SOL = 'So11111111111111111111111111111111111111112', BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function mockFetch({ jup, ds }) {
  global.fetch = async url => {
    if (url.startsWith('https://lite-api.jup.ag/')) return jup(url);
    if (url.startsWith('https://api.dexscreener.com/')) return ds(url);
    throw new Error('unexpected ' + url);
  };
}
const dsPairs = mints => json(200, { pairs: mints.map(m => ({ chainId: 'solana', baseToken: { address: m }, priceUsd: m === SOL ? '120.92' : '0.00002', liquidity: { usd: 5e6 } })) });

test('Jupiter 502 for SOL, DexScreener answers: price served, one stdout line, nothing on stderr', async () => {
  mockFetch({ jup: () => json(502, {}), ds: () => dsPairs([SOL]) });
  const c = captureConsole();
  let r;
  try { r = await fetchPrices([SOL]); } finally { c.restore(); }
  assert.deepStrictEqual(r, { [SOL]: 120.92 });
  assert.deepStrictEqual(c.err, []);
  assert.deepStrictEqual(c.out, ['[price] served by dexscreener: SOL 120.92 (jupiter Jupiter HTTP 502)']);
});

test('two mints served by the fallback in one poll: still ONE stdout line', async () => {
  mockFetch({ jup: () => json(502, {}), ds: () => dsPairs([SOL, BONK]) });
  const c = captureConsole();
  try { await fetchPrices([SOL, BONK]); } finally { c.restore(); }
  assert.strictEqual(c.out.length, 1);
  assert.deepStrictEqual(c.err, []);
});

test('every source fails: exactly one stderr line naming both reasons, nothing on stdout', async () => {
  mockFetch({ jup: () => json(502, {}), ds: () => json(503, {}) });
  const c = captureConsole();
  let r;
  try { r = await fetchPrices([SOL]); } finally { c.restore(); }
  assert.deepStrictEqual(r, {});
  assert.deepStrictEqual(c.out, []);
  assert.strictEqual(c.err.length, 1);
  assert.match(c.err[0], /^\[price\] DROPPED 1\/1 mint\(s\), no source could price: SOL \(jupiter Jupiter HTTP 502; dexscreener DexScreener HTTP 503\)$/);
});

test('Jupiter healthy: no log line at all', async () => {
  mockFetch({ jup: () => json(200, { swapUsdValue: '121.5' }), ds: () => { throw new Error('must not be called'); } });
  const c = captureConsole();
  try { assert.deepStrictEqual(await fetchPrices([SOL]), { [SOL]: 121.5 }); } finally { c.restore(); }
  assert.deepStrictEqual([c.out, c.err], [[], []]);
});
