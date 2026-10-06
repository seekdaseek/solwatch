// /genesis/mint payment verification on mocks only: no RPC, no Firestore, no mint. The parsed transactions are
// shaped like getParsedTransaction(..., 'finalized') answers for the app's own payment (one System transfer).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeDb } = require('./fakeFirestore');
const { genesisMint, checkPayment } = require('../src/genesisPayment');

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

function rig(chain, { owed = false } = {}) {
  const db = fakeDb();
  const mints = [];
  const deps = {
    getDb: () => db, treasury: TREASURY, wait: { waitMs: 0 },
    conn: { getParsedTransaction: async (sig, o) => { assert.strictEqual(o.commitment, 'finalized'); return chain[sig] || null; } },
    mintReward: async item => {
      mints.push(item);
      if (owed) return { owed: true };
      const number = (await db.collection('genesisMints').get()).size + 1;
      await db.collection('genesisMints').add({ walletAddress: item.walletAddress, number, txSignature: item.paymentTx });
      return { minted: true, number };
    },
  };
  return { db, mints, call: body => genesisMint(body, deps) };
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

test('replayed signature: 409 for a racing second request, a legacy-used signature, and after a mint', async () => {
  const { mints, call } = rig({ [SIG(4)]: ptx() });
  const [a, b] = await Promise.all([call({ walletAddress: ALICE, txSignature: SIG(4) }), call({ walletAddress: ALICE, txSignature: SIG(4) })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
  assert.strictEqual(mints.length, 1, 'one signature, one Genesis');
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
