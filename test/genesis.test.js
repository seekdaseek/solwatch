// /genesis/mint payment verification on mocks only: no RPC, no Firestore, no mint. The parsed transactions are
// shaped like getParsedTransaction(..., 'finalized') answers for the app's own payment (one System transfer).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeDb } = require('./fakeFirestore');
const { genesisMint, checkPayment, claimSignature, findFinalized, makePending, POLL_DELAYS_MS } = require('../src/genesisPayment');
const { makeRateLimiter } = require('../src/rateLimit');

const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const ALICE = '4UcxKrEt2RTRqXhPhGjKt4LBFYKGdKXkesQtosFB2Qn7', BOB = '3pxVaH5o275FjxxK1NDAoUULSSBqTE7GDHkTnBju64MF';
const SIG = n => '5' + String(n).repeat(87).slice(0, 87).replace(/0/g, 'A');
const ptx = ({ signers = [ALICE], transfers = [{ source: ALICE, destination: TREASURY, lamports: 100_000_000 }], err = null } = {}) => ({
  slot: 380000000, blockTime: 1791300000, meta: { err },
  transaction: { message: {
    accountKeys: [...new Set([...signers, ...transfers.flatMap(t => [t.source, t.destination])])].map(k => ({ pubkey: k, signer: signers.includes(k), writable: true })),
    instructions: transfers.map(t => ({ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: t } })),
  } },
});

function rig(chain, { owed = false, conn = null, pending = makePending() } = {}) {
  const db = fakeDb();
  const mints = [];
  const calls = [];
  const deps = {
    getDb: () => db, treasury: TREASURY, wait: { waitMs: 0 }, pending,
    conn: conn || { getParsedTransaction: async (sig, o) => { calls.push(sig); assert.strictEqual(o.commitment, 'finalized'); return chain[sig] || null; } },
    mintReward: async item => {
      mints.push(item);
      if (owed) return { owed: true };
      const number = (await db.collection('genesisMints').get()).size + 1;
      await db.collection('genesisMints').add({ walletAddress: item.walletAddress, number, txSignature: item.paymentTx });
      return { minted: true, number };
    },
  };
  return { db, mints, calls, deps, call: body => genesisMint(body, deps) };
}

test('valid payment: finalized, signed by the caller, caller -> treasury 0.1 SOL: minted, signature claimed', async () => {
  const { db, mints, call } = rig({ [SIG(1)]: ptx() });
  const r = await call({ walletAddress: ALICE, txSignature: SIG(1) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual({ success: r.body.success, number: r.body.number, remaining: r.body.remaining }, { success: true, number: 1, remaining: 99 });
  assert.strictEqual(mints.length, 1);
  assert.strictEqual(db.dump('genesisPayments')[SIG(1)].walletAddress, ALICE);
  assert.strictEqual(db.dump('genesisPayments')[SIG(1)].lamports, 100_000_000);
});

test("someone else's payment: 403, nothing minted, signature NOT burned for its owner", async () => {
  const { db, mints, call } = rig({ [SIG(2)]: ptx() });           // Alice paid
  const r = await call({ walletAddress: BOB, txSignature: SIG(2) });
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /not signed by this wallet/);
  assert.strictEqual(mints.length, 0);
  assert.deepStrictEqual(db.dump('genesisPayments'), {});
  assert.strictEqual((await call({ walletAddress: ALICE, txSignature: SIG(2) })).status, 200, 'the real payer can still use it');
  // Co-signed by Bob but the money came from Alice: still not Bob's payment.
  const { call: call2 } = rig({ [SIG(3)]: ptx({ signers: [ALICE, BOB] }) });
  const r2 = await call2({ walletAddress: BOB, txSignature: SIG(3) });
  assert.deepStrictEqual([r2.status, /did not come from this wallet/.test(r2.body.error)], [403, true]);
});

test('replayed signature: a racing second request is refused (429, the wallet is already verifying), the claim is atomic, a legacy-used signature 409s', async () => {
  const { mints, call } = rig({ [SIG(4)]: ptx() });
  const [a, b] = await Promise.all([call({ walletAddress: ALICE, txSignature: SIG(4) }), call({ walletAddress: ALICE, txSignature: SIG(4) })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 429]);
  assert.strictEqual(mints.length, 1, 'one signature, one Genesis');
  // The claim itself is first-wins even for two processes racing past every check.
  const db = fakeDb();
  const claims = await Promise.all([claimSignature(db, SIG(40), { walletAddress: ALICE }), claimSignature(db, SIG(40), { walletAddress: ALICE })]);
  assert.deepStrictEqual(claims.map(c => c.ok ? 'ok' : c.status).sort(), [409, 'ok']);
  const legacy = rig({ [SIG(5)]: ptx({ signers: [BOB], transfers: [{ source: BOB, destination: TREASURY, lamports: 100_000_000 }] }) });
  await legacy.db.collection('genesisMints').add({ walletAddress: ALICE, number: 7, txSignature: SIG(5) });   // used before genesisPayments existed
  const r = await legacy.call({ walletAddress: BOB, txSignature: SIG(5) });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(legacy.mints.length, 0);
});

test('underpaid: 400 with the shortfall, nothing minted or claimed', async () => {
  const { db, mints, call } = rig({ [SIG(6)]: ptx({ transfers: [{ source: ALICE, destination: TREASURY, lamports: 99_999_999 }] }) });
  const r = await call({ walletAddress: ALICE, txSignature: SIG(6) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Insufficient payment: 99999999 lamports, the Genesis price is 100000000/);
  assert.deepStrictEqual([mints.length, Object.keys(db.dump('genesisPayments')).length], [0, 0]);
});

test('wrong recipient: 400, nothing minted or claimed', async () => {
  const { mints, call } = rig({ [SIG(7)]: ptx({ transfers: [{ source: ALICE, destination: BOB, lamports: 500_000_000 }] }) });
  const r = await call({ walletAddress: ALICE, txSignature: SIG(7) });
  assert.deepStrictEqual([r.status, r.body.error], [400, 'Payment not sent to treasury']);
  assert.strictEqual(mints.length, 0);
});

test('not finalized (or unknown): 400 "retry", and the same signature works once it finalizes', async () => {
  const chain = {};
  const { mints, call } = rig(chain);
  const r = await call({ walletAddress: ALICE, txSignature: SIG(8) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not found at finalized commitment yet/);
  chain[SIG(8)] = ptx();
  assert.strictEqual((await call({ walletAddress: ALICE, txSignature: SIG(8) })).status, 200);
  assert.strictEqual(mints.length, 1);
});

test('a payment that failed on chain is rejected; split transfers from the caller add up', () => {
  assert.deepStrictEqual(checkPayment(ptx({ err: { InstructionError: [0, 'Custom'] } }), { walletAddress: ALICE, treasury: TREASURY }).status, 400);
  const two = ptx({ transfers: [{ source: ALICE, destination: TREASURY, lamports: 60_000_000 }, { source: ALICE, destination: TREASURY, lamports: 40_000_000 }] });
  assert.strictEqual(checkPayment(two, { walletAddress: ALICE, treasury: TREASURY }).ok, true);
});

test('payer cannot cover the mint: 202 queued, and the message is in .error because the app shows only that', async () => {
  const { db, call } = rig({ [SIG(9)]: ptx() }, { owed: true });
  const r = await call({ walletAddress: ALICE, txSignature: SIG(9) });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.queued, true);
  assert.match(r.body.error, /Payment received\. Your Genesis badge is queued/);
  assert.ok(db.dump('genesisPayments')[SIG(9)], 'claimed: a replay of a queued payment is also refused');
});

test('malformed input is refused before any RPC call', async () => {
  const { call } = rig({});
  assert.strictEqual((await call({ walletAddress: 'not-a-key', txSignature: SIG(1) })).status, 400);
  assert.strictEqual((await call({ walletAddress: ALICE })).status, 400);
});

test('an already-claimed signature is refused with 409 BEFORE any RPC call', async () => {
  const { db, calls, call } = rig({ [SIG(11)]: ptx() });
  await db.collection('genesisPayments').doc(SIG(11)).create({ walletAddress: ALICE });
  const r = await call({ walletAddress: BOB, txSignature: SIG(11) });
  assert.deepStrictEqual([r.status, calls.length], [409, 0]);
});

// A conn whose answers we release by hand, to hold verifications "in flight".
function heldConn() {
  const waiting = [];
  return { waiting, conn: { getParsedTransaction: () => new Promise(res => waiting.push(res)) } };
}
const WALLETS = ['4UcxKrEt2RTRqXhPhGjKt4LBFYKGdKXkesQtosFB2Qn7', '3pxVaH5o275FjxxK1NDAoUULSSBqTE7GDHkTnBju64MF', '3Mpy5gQbSbR2bXZ8ubDS6PTSb5TjjXZedvQ3diMUmqqx',
  'BTuCQWNNR5REcLonaCuvmPF7qDgPNWGDYsTvc1gWRUpb', 'VCkQgQL9VF4HQYV5tUXoKmkAV9kzqgnGjBNwKfSsiLj', 'AHwBcDv9WXtpGq5p7ZuGUcxZUaKPACEHVytRZwpL8GzV'];
const tick = () => new Promise(r => setImmediate(r));

test('cap: at most 5 verifications in flight globally; the 6th gets 429; a slot frees when one finishes', async () => {
  const h = heldConn();
  const { call, deps } = rig({}, { conn: h.conn });
  const inflight = WALLETS.slice(0, 5).map((w, i) => call({ walletAddress: w, txSignature: SIG(20 + i) }));
  for (let i = 0; i < 20 && h.waiting.length < 5; i++) await tick();
  assert.strictEqual(deps.pending.size, 5);
  const sixth = await call({ walletAddress: WALLETS[5], txSignature: SIG(26) });
  assert.strictEqual(sixth.status, 429);
  assert.match(sixth.body.error, /Too many payment verifications in progress \(5\)/);
  h.waiting.forEach(res => res(null));                          // all five come back "not found"
  const done = await Promise.all(inflight);
  assert.ok(done.every(r => r.status === 400));
  assert.strictEqual(deps.pending.size, 0, 'every slot released');
});

test('per wallet: a second request while that wallet is verifying gets 429; another wallet does not', async () => {
  const h = heldConn();
  const { call } = rig({}, { conn: h.conn });
  const first = call({ walletAddress: ALICE, txSignature: SIG(30) });
  for (let i = 0; i < 20 && h.waiting.length < 1; i++) await tick();
  const again = await call({ walletAddress: ALICE, txSignature: SIG(31) });
  assert.deepStrictEqual([again.status, /already in progress/.test(again.body.error)], [429, true]);
  const other = call({ walletAddress: BOB, txSignature: SIG(32) });
  for (let i = 0; i < 20 && h.waiting.length < 2; i++) await tick();
  assert.strictEqual(h.waiting.length, 2, 'Bob is verifying alongside Alice');
  h.waiting.forEach(res => res(null));
  await Promise.all([first, other]);
});

test('rate limit: 6 per window per IP, the 7th is 429 with Retry-After; other IPs and the next window are free', () => {
  let t = 0;
  const rl = makeRateLimiter({ windowMs: 600000, max: 6, now: () => t });
  for (let i = 0; i < 6; i++) assert.strictEqual(rl.check('1.2.3.4').ok, true);
  const no = rl.check('1.2.3.4');
  assert.deepStrictEqual([no.ok, no.retryAfterSec], [false, 600]);
  assert.strictEqual(rl.check('5.6.7.8').ok, true);
  t += 600000;
  assert.strictEqual(rl.check('1.2.3.4').ok, true);
  // as Express middleware
  const out = {};
  const res = { set: (k, v) => { out[k] = v; }, status: c => ({ json: b => { out.status = c; out.body = b; } }) };
  let nexted = 0;
  for (let i = 0; i < 7; i++) rl.middleware({ ip: '9.9.9.9' }, res, () => nexted++);
  assert.deepStrictEqual([nexted, out.status, out['Retry-After']], [6, 429, '600']);
});

test('backoff: about 10 RPC calls across the 60 s window (was 30), and a real payment finalizing at ~14 s still verifies', async () => {
  let t = 0, calls = 0;
  const clock = { now: () => t, sleep: async ms => { t += ms; } };
  const never = { getParsedTransaction: async () => { calls++; return null; } };
  assert.strictEqual(await findFinalized(never, SIG(50), clock), null);
  assert.strictEqual(calls, 10);
  assert.ok(t <= 60000, `stopped inside the window (${t} ms)`);
  assert.deepStrictEqual(POLL_DELAYS_MS.length, 9);
  // The app POSTs right after sendRawTransaction; the payment reaches finalized ~14 s later.
  t = 0; calls = 0;
  const finalizesAt14s = { getParsedTransaction: async () => { calls++; return t >= 14000 ? ptx() : null; } };
  const { call } = rig({}, { conn: finalizesAt14s });
  const r = await genesisMint({ walletAddress: ALICE, txSignature: SIG(51) }, { ...rig({}).deps, conn: finalizesAt14s, wait: clock });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([calls, t], [6, 15500], 'found on the 6th call, 15.5 s in');
});
