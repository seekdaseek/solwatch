// Daily cNFT mint: a provably-unlanded send (Blockhash not found / expired) is retried with a fresh builder up
// to 2 times, retries log to stdout only, and nothing else is ever retried. Mocks only: no RPC, no Firestore.
'use strict';
process.env.MERKLE_TREE_ADDRESS = process.env.MERKLE_TREE_ADDRESS || '11111111111111111111111111111111';
process.env.METADATA_BASE_URL = process.env.METADATA_BASE_URL || 'https://example.test';
const test = require('node:test');
const assert = require('node:assert');
const { fakeDb, captureConsole } = require('./fakeFirestore');
const bg = require('../src/bubblegumService');
const { RETRYABLE } = require('../src/blockhashRetry');

const WALLET = 'BTuCQWNNR5REcLonaCuvmPF7qDgPNWGDYsTvc1gWRUpb';
// The exact failure from the 2026-10-05 error log.
const BLOCKHASH = 'Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found. \nLogs: \n[]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.';

function rig(plan) {
  const db = fakeDb();
  const calls = [];
  bg._deps.getDb = () => db;
  bg._deps.getUmi = () => ({ identity: { publicKey: 'Payer1111111111111111111111111111111111111' } });
  bg._deps.retry = { sleep: async () => {}, delayMs: 0 };
  bg._deps.mintV1 = (umi, args) => {
    const n = calls.length;
    calls.push(args);                                   // a NEW builder per attempt = a fresh blockhash on send
    return { sendAndConfirm: async () => { const step = plan[n]; if (step instanceof Error) throw step; return { signature: new Uint8Array([7, 7, n]) }; } };
  };
  return { db, calls };
}

test('the retry rule matches the logged failure and the expiry forms, and nothing else', () => {
  assert.ok(RETRYABLE.test(BLOCKHASH));
  assert.ok(RETRYABLE.test('Signature 5x has expired: block height exceeded.'));
  assert.ok(RETRYABLE.test('TransactionExpiredBlockheightExceededError'));
  assert.ok(!RETRYABLE.test('Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.'));
  assert.ok(!RETRYABLE.test('Transfer: insufficient lamports 873768, need 3008760'));
});

test('Blockhash not found, then success: one retry, the badge is recorded, stdout only', async () => {
  const { db, calls } = rig([new Error(BLOCKHASH), 'ok']);
  const c = captureConsole();
  let r;
  try { r = await bg.mintDailyCheckinCNFT(WALLET, 3); } finally { c.restore(); }
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(r.success, true);
  const today = new Date().toISOString().slice(0, 10);
  const rec = db.dump('cnftMints')[`${WALLET}_${today}`];
  assert.strictEqual(rec.streakDay, 3);
  assert.strictEqual(rec.txSignature, Buffer.from([7, 7, 1]).toString('base64'), 'the record carries the signature of the attempt that landed');
  assert.strictEqual(c.err.length, 0, 'nothing on stderr');
  assert.strictEqual(c.out.filter(l => /Blockhash not found.*fresh blockhash, retry 1\/2/.test(l)).length, 1);
});

test('three blockhash failures: gives up after 2 retries, throws the last error, writes nothing, never touches stderr', async () => {
  const { db, calls } = rig([new Error(BLOCKHASH), new Error(BLOCKHASH), new Error(BLOCKHASH)]);
  const c = captureConsole();
  try { await assert.rejects(bg.mintDailyCheckinCNFT(WALLET, 4), /Blockhash not found/); } finally { c.restore(); }
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(db.dump('cnftMints'), {});
  assert.strictEqual(c.err.length, 0, 'the caller (handleCheckin) logs the final failure, once');
  assert.strictEqual(c.out.length, 2);
});

test('a confirmation timeout is NOT retried: it may still land, and a retry could mint twice', async () => {
  const { calls } = rig([new Error('Transaction was not confirmed in 30.00 seconds.'), 'ok']);
  const c = captureConsole();
  try { await assert.rejects(bg.mintDailyCheckinCNFT(WALLET, 5), /not confirmed/); } finally { c.restore(); }
  assert.strictEqual(calls.length, 1);
});
