// mpl-core rewards on mocks only (no RPC, no Firestore, no key): cost model, owed recording, the oldest-first
// hourly retry, push on success, idempotency, genuine failures, and the monthly plugin format.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeDb, captureConsole } = require('./fakeFirestore');
const { makeRewards, assetSize, shape, CORE_CREATE_FEE } = require('../src/coreRewards');

const MAINNET_RENT = n => (n + 128) * 5080;   // getMinimumBalanceForRentExemption on mainnet, measured 2026-10-06
const W1 = '4UcxKrEt2RTRqXhPhGjKt4LBFYKGdKXkesQtosFB2Qn7', W2 = '3pxVaH5o275FjxxK1NDAoUULSSBqTE7GDHkTnBju64MF';

function rig({ balance = 808768, createPlan = [] } = {}) {
  const db = fakeDb();
  const state = { balance, creates: [], pushes: [], n: 0 };
  const lines = { out: [], err: [] };
  const log = { log: s => lines.out.push(s), warn: s => lines.err.push(s), error: s => lines.err.push(s) };
  const r = makeRewards({
    env: { TREASURY_WALLET: 'TreasuryWa11et', METADATA_BASE_URL: 'https://seekdaseek.github.io/solwatch/cnft/monthly' },
    conn: { getBalance: async () => state.balance, getMinimumBalanceForRentExemption: async n => MAINNET_RENT(n) },
    payer: 'Payer', getUmi: () => ({}),
    generateSigner: () => ({ publicKey: `Asset${++state.n}` }),
    publicKey: x => x,
    create: (umi, args) => ({
      sendAndConfirm: async () => {
        const step = createPlan[state.creates.length];
        state.creates.push(args);
        if (step instanceof Error) throw step;
        state.balance -= MAINNET_RENT(assetSize(args.name, args.uri)) + CORE_CREATE_FEE + 10000;
        return { signature: new Uint8Array([1, 2, state.creates.length]) };
      },
    }),
    getDb: () => db,
    sendPush: async (token, title, body, data) => { state.pushes.push({ token, title, body, data }); return 'ok'; },
    log, retry: { sleep: async () => {}, delayMs: 0 },
  });
  return { r, db, state, lines };
}

test('cost model = the mainnet simulation of 2026-10-06, all six shapes', async () => {
  const sized = [
    [{ type: 'mythic', milestone: 30 }, 188],
    [{ type: 'crown', rank: 1, week: '2026-10-05' }, 199],
    [{ type: 'crown', rank: 2, week: '2026-10-05' }, 203],
    [{ type: 'crown', rank: 3, week: '2026-10-05' }, 202],
    [{ type: 'monthly', monthKey: '2026-10' }, 176],
    [{ type: 'genesis', number: 12 }, 183],
  ];
  const env = { METADATA_BASE_URL: 'https://seekdaseek.github.io/solwatch/cnft/monthly' };
  for (const [item, bytes] of sized) {
    const s = shape(item, env);
    if (item.type !== 'monthly') assert.strictEqual(assetSize(s.name, s.uri), bytes, JSON.stringify(item));
  }
  // The live "need" in the error log is the FIRST transfer only (base account, no plugin bytes): e.g. rank 1
  // "need 3008760" = (169 + 128) * 5080 + 1,500,000. Full cost adds the 30 plugin bytes, 2 signatures and the
  // payer's own rent reserve.
  const { r } = rig();
  assert.strictEqual(await r.needLamports({ type: 'mythic', milestone: 30 }), 1605280 + 1500000 + 10000 + 650240);
  assert.strictEqual(MAINNET_RENT(199 - 30) + CORE_CREATE_FEE, 3008760);
});

test('payer cannot cover it: nothing is built or sent, the reward is owed, one stdout line, no stderr', async () => {
  const { r, db, state, lines } = rig({ balance: 808768 });
  const res = await r.mintReward({ type: 'mythic', walletAddress: W1, milestone: 30 });
  assert.strictEqual(res.owed, true);
  assert.strictEqual(state.creates.length, 0);
  const o = db.dump('owedRewards')[`${W1}_mythic_30`];
  assert.strictEqual(o.status, 'owed');
  assert.strictEqual(o.type, 'mythic');
  assert.strictEqual(o.walletAddress, W1);
  assert.strictEqual(o.milestone, 30);
  assert.strictEqual(o.balanceLamports, 808768);
  assert.strictEqual(o.needLamports, 3765520);
  assert.ok(o.createdAt instanceof Date);
  assert.match(o.reason, /mint payer 808768 lamports < need 3765520/);
  assert.deepStrictEqual(lines.err, []);
  assert.strictEqual(lines.out.length, 1);
  assert.match(lines.out[0], /^\[owed\] mythic SBT day 30 -> 4Ucx.*recorded owedRewards\/4Ucx.*_mythic_30$/);
  assert.deepStrictEqual(db.dump('mythicSBTs'), {});
});

test('hourly retry: oldest first, stops at the first it cannot cover, mints + records + pushes, then the next', async () => {
  const { r, db, state, lines } = rig({ balance: 0 });
  await db.collection('checkins').doc(W1).set({ walletAddress: W1, fcmToken: 'tokW1' });
  await db.collection('checkins').doc(W2).set({ walletAddress: W2, fcmToken: 'tokW2' });
  await r.recordOwed({ type: 'crown', walletAddress: W2, rank: 1, week: '2026-10-05', createdAt: new Date('2026-10-05T09:00:00Z') }, { reason: 'x' });
  await r.recordOwed({ type: 'mythic', walletAddress: W1, milestone: 30, createdAt: new Date('2026-10-06T16:57:24Z') }, { reason: 'x' });
  await r.recordOwed({ type: 'crown', walletAddress: null, rank: 3, week: '2026-09-28', createdAt: new Date('2026-09-28T09:00:00Z') }, { reason: 'x', unknown: true });

  // Covers one Crown and not the mythic behind it.
  state.balance = (await r.needLamports({ type: 'crown', rank: 1, week: '2026-10-05' })) + 1000;
  let out = await r.processOwed();
  assert.deepStrictEqual({ minted: out.minted, unknown: out.unknown, blocked: out.blockedBy && out.blockedBy.id }, { minted: 1, unknown: 1, blocked: `${W1}_mythic_30` });
  assert.strictEqual(state.creates.length, 1);
  assert.strictEqual(state.creates[0].owner, W2);
  assert.strictEqual(state.creates[0].name, 'SolWatch Champion 2026-10-05');
  let owed = db.dump('owedRewards');
  assert.strictEqual(owed['crown_2026-10-05_rank1'].status, 'minted');
  assert.strictEqual(owed['crown_2026-10-05_rank1'].assetAddress, 'Asset1');
  assert.strictEqual(owed[`${W1}_mythic_30`].status, 'owed');
  assert.strictEqual(owed['unknown_mythic_30'], undefined);
  assert.strictEqual(owed['crown_2026-09-28_rank3'].status, 'owed', 'unknown wallet: never minted, kept listed');
  assert.deepStrictEqual(state.pushes.map(p => [p.token, p.title]), [['tokW2', 'Weekly Crown!']]);
  assert.match(state.pushes[0].body, /Champion Crown for the week of 2026-10-05 \(#1\) just landed/);

  // Funded: the mythic goes, with its canonical mythicSBTs record and a push.
  state.balance = 10_000_000;
  out = await r.processOwed();
  assert.strictEqual(out.minted, 1);
  owed = db.dump('owedRewards');
  assert.strictEqual(owed[`${W1}_mythic_30`].status, 'minted');
  assert.strictEqual(db.dump('mythicSBTs')[`${W1}_mythic_30`].figure, 'Hercules');
  assert.deepStrictEqual(state.creates[1].plugins, [{ type: 'PermanentFreezeDelegate', frozen: true, authority: { type: 'UpdateAuthority' } }]);
  assert.strictEqual(state.pushes[1].title, 'Mythic SBT landed');

  // Idempotent: nothing is minted twice, by the retry or by a live repeat of the event.
  const before = state.creates.length;
  await r.processOwed();
  const again = await r.mintReward({ type: 'mythic', walletAddress: W1, milestone: 30 });
  assert.strictEqual(again.alreadyMinted, true);
  assert.strictEqual(state.creates.length, before);
  assert.deepStrictEqual(lines.err, []);
});

test('a live reward never jumps the owed queue: it queues behind and the queue drains at once', async () => {
  const { r, db, state } = rig({ balance: 0 });
  await r.recordOwed({ type: 'crown', walletAddress: W2, rank: 2, week: '2026-10-05', createdAt: new Date('2026-10-05T09:00:03Z') }, { reason: 'x' });
  state.balance = 10_000_000;
  const res = await r.mintReward({ type: 'mythic', walletAddress: W1, milestone: 60 });
  assert.strictEqual(res.minted, true);
  assert.deepStrictEqual(state.creates.map(c => c.owner), [W2, W1], 'oldest first');
  assert.strictEqual(db.dump('owedRewards')[`${W1}_mythic_60`].status, 'minted');
});

test('a funded live reward mints straight away (and blockhash-not-found is retried with a new asset)', async () => {
  const { r, db, state, lines } = rig({ balance: 10_000_000, createPlan: [new Error('Transaction simulation failed: Blockhash not found'), 'ok'] });
  await db.collection('checkins').doc(W2).set({ walletAddress: W2, fcmToken: 'tokW2' });
  const res = await r.mintReward({ type: 'crown', walletAddress: W2, rank: 1, week: '2026-10-12' });
  assert.strictEqual(res.minted, true);
  assert.strictEqual(state.creates.length, 2);
  assert.notStrictEqual(state.creates[0].asset, state.creates[1].asset);
  assert.deepStrictEqual(db.dump('owedRewards'), {}, 'nothing owed');
  assert.match(state.pushes[0].body, /^You ranked #1 this week/);
  assert.deepStrictEqual(lines.err, []);
});

test('a genuine failure in the retry is logged to stderr once per attempt and parks the item after 5', async () => {
  const boom = () => new Error('custom program error: 0x26');
  const { r, db, state, lines } = rig({ balance: 0, createPlan: [boom(), boom(), boom(), boom(), boom()] });
  await r.recordOwed({ type: 'crown', walletAddress: W2, rank: 3, week: '2026-10-05', createdAt: new Date('2026-10-05T09:00:06Z') }, { reason: 'x' });
  state.balance = 10_000_000;
  for (let i = 0; i < 6; i++) await r.processOwed();
  const o = db.dump('owedRewards')['crown_2026-10-05_rank3'];
  assert.strictEqual(o.status, 'failed');
  assert.strictEqual(o.attempts, 5);
  assert.strictEqual(state.creates.length, 5, 'a parked item is not retried again');
  assert.strictEqual(lines.err.length, 5);
});

test('monthly: V2 plugin format with authority None (the createV1 enum bug), mintedMonths + push on landing', async () => {
  const { r, db, state } = rig({ balance: 10_000_000 });
  await db.collection('checkins').doc(W2).set({ walletAddress: W2, fcmToken: 'tokW2', mintedMonths: ['2026-08'] });
  const res = await r.mintReward({ type: 'monthly', walletAddress: W2, monthKey: '2026-09' });
  assert.strictEqual(res.minted, true);
  assert.deepStrictEqual(state.creates[0].plugins, [{ type: 'PermanentFreezeDelegate', frozen: true, authority: { type: 'None' } }]);
  assert.strictEqual(state.creates[0].name, 'SolWatch September 2026');
  assert.deepStrictEqual(db.dump('checkins')[W2].mintedMonths, ['2026-08', '2026-09']);
  assert.strictEqual(state.pushes[0].title, 'SolWatch badge minted!');
});

test('genesis: owed while unfunded, numbered when it lands, genesisMints record carries the payment tx', async () => {
  const { r, db, state } = rig({ balance: 0 });
  await db.collection('genesisMints').add({ walletAddress: 'Founder', number: 0, founder: true });
  const owed = await r.mintReward({ type: 'genesis', walletAddress: W1, paymentTx: 'PayTx1' });
  assert.strictEqual(owed.owed, true);
  assert.strictEqual(db.dump('owedRewards')['genesis_PayTx1'].status, 'owed');
  state.balance = 10_000_000;
  await r.processOwed();
  const g = Object.values(db.dump('genesisMints')).find(x => x.walletAddress === W1);
  assert.deepStrictEqual({ number: g.number, tx: g.txSignature }, { number: 2, tx: 'PayTx1' });
  assert.strictEqual(state.creates[0].name, 'SolWatch Genesis #2');
});
