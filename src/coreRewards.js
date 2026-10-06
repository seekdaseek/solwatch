// mpl-core rewards - mythic SBT, weekly Crown, monthly SBT, Genesis - through ONE path that checks the mint
// payer can afford the create BEFORE building it.
//
// WHY. On 2026-10-05/06 the payer held ~0.0008 SOL and every one of these failed on chain with
// "Transfer: insufficient lamports 873768, need 3008760": the tx was built, simulated, rejected, the reward
// was lost, and the error log grew 27 lines. Now an unaffordable reward is not sent at all. It is written to
// Firestore owedRewards/<id>, beside the mint records, one stdout line says so, and processOwed() (hourly)
// mints owed rewards OLDEST FIRST once the balance covers them, then sends the push.
//
// WHAT A CREATE COSTS, measured 2026-10-06 by mainnet SIMULATION (sigVerify off, nothing sent) of all six
// shapes this file builds (mythic, three Crowns, monthly, Genesis): the asset account ends at exactly
// assetSize() bytes (6/6) holding rent(size) + 1,500,000 lamports - the mpl-core create fee - and the tx
// carries 2 signatures (payer + asset). The payer must also stay rent-exempt itself (the runtime refuses a
// transfer that takes an exempt account below its minimum), so its own 0-byte minimum is added on top.
'use strict';
const { withBlockhashRetry } = require('./blockhashRetry');

const CORE_CREATE_FEE = 1_500_000;
const SIG_FEE = 5_000;
const SIGNATURES = 2;
const PAYER_ADDRESS = 'HUYYL1HMPa4D7dw1bdiBkSSrPZ563gcuoTWmHGc9f661';
const OWED = 'owedRewards';
const MAX_ATTEMPTS = 5;   // genuine (non-balance) failures before an owed item stops retrying

const MYTHIC_MILESTONES = {
  30: { figure: 'Hercules', name: 'SW Mythic — Hercules' },
  60: { figure: 'Achilles', name: 'SW Mythic — Achilles' },
  90: { figure: 'Odysseus', name: 'SW Mythic — Odysseus' },
  120: { figure: 'Zeus', name: 'SW Mythic — Zeus' },
  150: { figure: 'Poseidon', name: 'SW Mythic — Poseidon' },
  180: { figure: 'Ares', name: 'SW Mythic — Ares' },
  210: { figure: 'Apollo', name: 'SW Mythic — Apollo' },
  240: { figure: 'Athena', name: 'SW Mythic — Athena' },
  270: { figure: 'Hades', name: 'SW Mythic — Hades' },
  300: { figure: 'Odin', name: 'SW Mythic — Odin' },
  330: { figure: 'Thor', name: 'SW Mythic — Thor' },
  365: { figure: 'Prometheus', name: 'SW Mythic — Prometheus' },
};
const CROWNS = ['gold_crown', 'silver_crown', 'bronze_crown'];
const RANKS = ['Champion', 'Challenger', 'Contender'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function truncBytes(s, max = 32) {
  let out = s;
  while (Buffer.byteLength(out, 'utf8') > max) out = out.slice(0, -1);
  return out;
}

// AssetV1 (key 1, owner 32, update authority 1+32, name 4+n, uri 4+n, seq 1) plus one first-party plugin with a
// 1-byte authority: plugin header 9 + PermanentFreezeDelegate 2 + registry 19.
function assetSize(name, uri) {
  return 66 + 4 + Buffer.byteLength(name, 'utf8') + 4 + Buffer.byteLength(uri, 'utf8') + 1 + 30;
}

// The create each reward type builds. item: { type, walletAddress, milestone | rank+week | monthKey | number }
function shape(item, env = process.env) {
  switch (item.type) {
    case 'mythic': {
      const m = MYTHIC_MILESTONES[item.milestone];
      if (!m) throw new Error(`not a mythic milestone: ${item.milestone}`);
      return { name: truncBytes(m.name), uri: `https://seekdaseek.github.io/solwatch/cnft/mythic/day-${item.milestone}.json`, frozen: true, authority: 'UpdateAuthority' };
    }
    case 'crown': {
      const i = item.rank - 1;
      if (!CROWNS[i]) throw new Error(`not a crown rank: ${item.rank}`);
      return { name: `SolWatch ${RANKS[i]} ${item.week}`.slice(0, 32), uri: `https://seekdaseek.github.io/solwatch/cnft/rewards/${CROWNS[i]}.json`, frozen: false, authority: 'UpdateAuthority' };
    }
    case 'monthly': {
      const [y, mo] = item.monthKey.split('-').map(Number);
      // authority 'None' in the V2 plugin format. The old createV1 + pluginAuthorityPair path passed
      // { type: 'None' } where V1 wants { __kind: 'None' } and failed every time: "Invalid data enum variant.
      // Expected one of [None, Owner, UpdateAuthority, Address], got undefined" (3pxVa..., 2026-10-01).
      return { name: truncBytes(`SolWatch ${MONTH_NAMES[mo - 1]} ${y}`), uri: `${env.METADATA_BASE_URL}/${item.monthKey}.json`, frozen: true, authority: 'None' };
    }
    case 'genesis':
      return { name: `SolWatch Genesis #${item.number}`.slice(0, 32), uri: `https://seekdaseek.github.io/solwatch/cnft/genesis/${item.number}.json`, frozen: false, authority: 'UpdateAuthority' };
    default:
      throw new Error(`unknown reward type: ${item.type}`);
  }
}

function owedId(item) {
  switch (item.type) {
    case 'mythic': return `${item.walletAddress || 'unknown'}_mythic_${item.milestone}`;   // = mythicSBTs doc id
    case 'crown': return `crown_${item.week}_rank${item.rank}`;
    case 'monthly': return `${item.walletAddress}_monthly_${item.monthKey}`;
    case 'genesis': return `genesis_${item.paymentTx}`;
    default: throw new Error(`unknown reward type: ${item.type}`);
  }
}

function describe(item) {
  switch (item.type) {
    case 'mythic': return `mythic SBT day ${item.milestone}`;
    case 'crown': return `${RANKS[item.rank - 1]} Crown (rank ${item.rank}) week ${item.week}`;
    case 'monthly': return `monthly SBT ${item.monthKey}`;
    case 'genesis': return `Genesis badge (payment ${String(item.paymentTx).slice(0, 12)}…)`;
    default: return item.type;
  }
}

// Everything that touches the network, Firestore or the chain is injected, so tests run on mocks only.
function makeRewards(deps) {
  const log = deps.log || console;
  let chain = Promise.resolve();
  // One create at a time, in this process: the hourly retry and a live event must never both read the same
  // balance and both send, and an owed item must never be minted twice.
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function needLamports(item) {
    const s = shape(item);
    const [rentAsset, rentPayer] = await Promise.all([
      deps.conn.getMinimumBalanceForRentExemption(assetSize(s.name, s.uri)),
      deps.conn.getMinimumBalanceForRentExemption(0),
    ]);
    return rentAsset + CORE_CREATE_FEE + SIG_FEE * SIGNATURES + rentPayer;
  }

  // Already delivered by the normal path or a previous retry?
  async function alreadyMinted(item, db) {
    if (item.type === 'mythic') return (await db.collection('mythicSBTs').doc(owedId(item)).get()).exists;
    if (item.type === 'monthly') {
      const c = await db.collection('checkins').doc(item.walletAddress).get();
      return !!(c.exists && (c.data().mintedMonths || []).includes(item.monthKey));
    }
    const o = await db.collection(OWED).doc(owedId(item)).get();
    return o.exists && o.data().status === 'minted';
  }

  async function fcmTokenOf(db, wallet) {
    const c = await db.collection('checkins').doc(wallet).get();
    return c.exists ? c.data().fcmToken || null : null;
  }

  // The canonical record each type already kept before this file existed.
  async function recordMinted(db, item, s) {
    if (item.type === 'mythic') {
      const m = MYTHIC_MILESTONES[item.milestone];
      await db.collection('mythicSBTs').doc(owedId(item)).set({ walletAddress: item.walletAddress, streakDay: item.milestone, figure: m.figure, mintedAt: new Date(), uri: s.uri });
    } else if (item.type === 'monthly') {
      const ref = db.collection('checkins').doc(item.walletAddress);
      const c = await ref.get();
      await ref.update({ mintedMonths: [...((c.exists && c.data().mintedMonths) || []), item.monthKey] });
    } else if (item.type === 'genesis') {
      await db.collection('genesisMints').add({ walletAddress: item.walletAddress, number: item.number, txSignature: item.paymentTx, mintedAt: new Date() });
    }
  }

  async function pushFor(db, item, { late }) {
    const token = item.fcmToken || await fcmTokenOf(db, item.walletAddress);
    if (!token) return;
    let title, body, data;
    if (item.type === 'mythic') {
      const m = MYTHIC_MILESTONES[item.milestone];
      title = 'Mythic SBT landed'; body = `Your ${m.figure} SBT for day ${item.milestone} just landed in your wallet.`;
      data = { type: 'mythic', milestone: String(item.milestone) };
    } else if (item.type === 'crown') {
      title = 'Weekly Crown!';
      body = late ? `Your ${RANKS[item.rank - 1]} Crown for the week of ${item.week} (#${item.rank}) just landed in your wallet.`
        : `You ranked #${item.rank} this week and earned the ${RANKS[item.rank - 1]} Crown!`;
      data = { type: 'reward', rank: String(item.rank) };
    } else if (item.type === 'monthly') {
      const [y, mo] = item.monthKey.split('-').map(Number);
      title = 'SolWatch badge minted!'; body = `Your ${MONTH_NAMES[mo - 1]} ${y} SBT just landed in your wallet.`;
      data = { type: 'sbt', monthKey: item.monthKey };
    } else {
      title = 'Genesis badge minted!'; body = `SolWatch Genesis #${item.number} just landed in your wallet.`;
      data = { type: 'genesis', number: String(item.number) };
    }
    try { await deps.sendPush(token, title, body, data); }
    catch (e) { log.warn(`push after ${describe(item)} mint failed: ${e.message}`); }
  }

  async function recordOwed(db, item, why) {
    const id = owedId(item);
    const ref = db.collection(OWED).doc(id);
    const prev = await ref.get();
    if (prev.exists) return { id, existed: true, data: prev.data() };
    const doc = {
      type: item.type, walletAddress: item.walletAddress || null,
      milestone: item.milestone ?? null, rank: item.rank ?? null, rankName: item.rank ? RANKS[item.rank - 1] : null,
      week: item.week ?? null, monthKey: item.monthKey ?? null, paymentTx: item.paymentTx ?? null,
      reason: why.reason, needLamports: why.need ?? null, balanceLamports: why.balance ?? null,
      createdAt: item.createdAt || new Date(), status: 'owed', attempts: 0, attribution: item.attribution || null,
    };
    await ref.set(doc);
    log.log(`[owed] ${describe(item)} -> ${item.walletAddress || 'UNKNOWN wallet'}: ${why.reason}; recorded ${OWED}/${id}`);
    return { id, existed: false, data: doc };
  }

  // A new asset signer and a new builder per attempt; only a provably unlanded tx is retried.
  async function sendCreate(item, s) {
    const umi = deps.getUmi();
    return withBlockhashRetry(describe(item), async () => {
      const asset = deps.generateSigner(umi);
      const res = await deps.create(umi, {
        asset, name: s.name, uri: s.uri,
        owner: deps.publicKey(item.walletAddress),
        updateAuthority: deps.publicKey(deps.env.TREASURY_WALLET),
        plugins: [{ type: 'PermanentFreezeDelegate', frozen: s.frozen, authority: { type: s.authority } }],
      }).sendAndConfirm(umi);
      return { asset: String(asset.publicKey), signature: res && res.signature ? Buffer.from(res.signature).toString('base64') : null };
    }, { log, ...(deps.retry || {}) });
  }

  // One reward. Returns { minted } | { owed } | { alreadyMinted } | { skipped }. A non-balance failure throws.
  async function attemptOne(item, { fromOwed = false } = {}) {
    const db = deps.getDb();
    if (!item.walletAddress) return { skipped: 'unknown wallet' };
    if (await alreadyMinted(item, db)) {
      if (fromOwed) await db.collection(OWED).doc(owedId(item)).update({ status: 'minted', note: 'found already minted' });
      return { alreadyMinted: true };
    }
    if (item.type === 'genesis' && item.number == null) {
      item.number = (await db.collection('genesisMints').get()).size + 1;
    }
    const s = shape(item);
    const [need, balance] = await Promise.all([needLamports(item), deps.conn.getBalance(deps.payer)]);
    if (balance < need) {
      const reason = `mint payer ${balance} lamports < need ${need} (rent + create fee + tx fee + payer rent reserve)`;
      if (!fromOwed) await recordOwed(db, item, { reason, need, balance });
      return { owed: true, need, balance };
    }
    const tx = await sendCreate(item, s);
    await recordMinted(db, item, s);
    const owedRef = db.collection(OWED).doc(owedId(item));
    if (fromOwed || (await owedRef.get()).exists) {
      await owedRef.update({ status: 'minted', mintedAt: new Date(), assetAddress: tx.asset, txSignature: tx.signature, number: item.number ?? null });
    }
    log.log(`${fromOwed ? '[owed] minted ' : ''}${describe(item)} -> ${item.walletAddress} | asset ${tx.asset}`);
    if (fromOwed || item.type !== 'mythic') await pushFor(db, item, { late: fromOwed });   // the live mythic path never pushed
    return { minted: true, ...tx, number: item.number ?? null };
  }

  // Live event (check-in, cron, endpoint). If anything is already owed, this joins the queue behind it, so a
  // top-up is spent oldest first; the queue is then drained at once rather than at the next hour.
  function mintReward(item) {
    return serial(async () => {
      const db = deps.getDb();
      const waiting = (await db.collection(OWED).where('status', '==', 'owed').get()).docs.filter(d => d.id !== owedId(item));
      if (waiting.length && item.walletAddress && !(await alreadyMinted(item, db))) {
        await recordOwed(db, item, { reason: `queued behind ${waiting.length} older owed reward(s)` });
        await drain();
        const mine = (await db.collection(OWED).doc(owedId(item)).get()).data();
        return mine && mine.status === 'minted' ? { minted: true, viaQueue: true } : { owed: true };
      }
      return attemptOne(item);
    });
  }

  // Oldest first; stop at the first one the balance cannot cover (a later, cheaper reward never jumps it).
  async function drain() {
    const db = deps.getDb();
    const snap = await db.collection(OWED).where('status', '==', 'owed').get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
    const out = { minted: 0, waiting: 0, unknown: 0, failed: 0, blockedBy: null };
    for (const o of items) {
      if (!o.walletAddress) { out.unknown++; continue; }
      const item = { type: o.type, walletAddress: o.walletAddress, milestone: o.milestone ?? undefined, rank: o.rank ?? undefined, week: o.week ?? undefined, monthKey: o.monthKey ?? undefined, paymentTx: o.paymentTx ?? undefined, number: o.number ?? undefined };
      try {
        const r = await attemptOne(item, { fromOwed: true });
        if (r.owed) { out.waiting = items.length - out.minted - out.unknown - out.failed; out.blockedBy = { id: o.id, need: r.need, balance: r.balance }; break; }
        if (r.minted || r.alreadyMinted) out.minted++;
      } catch (e) {
        out.failed++;
        const attempts = (o.attempts || 0) + 1;
        await db.collection(OWED).doc(o.id).update({ attempts, lastError: String(e.message).split('\n')[0].slice(0, 300), lastAttemptAt: new Date(), ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' } : {}) });
        log.error(`[owed] ${describe(item)} -> ${item.walletAddress} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${String(e.message).split('\n')[0]}`);
      }
    }
    return out;
  }

  const processOwed = () => serial(async () => {
    const r = await drain();
    if (r.minted || r.blockedBy || r.failed) {
      log.log(`[owed] hourly: minted ${r.minted}` + (r.blockedBy ? `, ${r.waiting} waiting (oldest ${r.blockedBy.id} needs ${r.blockedBy.need}, payer has ${r.blockedBy.balance})` : '') +
        (r.failed ? `, ${r.failed} failed` : '') + (r.unknown ? `, ${r.unknown} with unknown wallet` : ''));
    }
    return r;
  });

  return { mintReward, processOwed, recordOwed: (item, why) => recordOwed(deps.getDb(), item, why), needLamports, owedId, shape };
}

const ts = v => (v && typeof v.toDate === 'function' ? v.toDate().getTime() : new Date(v).getTime());

// The production instance, built on first use so tests (and anything that only needs the pure helpers) never
// load Firebase or a key.
let prod = null;
function rewards() {
  if (prod) return prod;
  const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
  const { mplCore, create } = require('@metaplex-foundation/mpl-core');
  const { keypairIdentity, publicKey, generateSigner } = require('@metaplex-foundation/umi');
  const { fromWeb3JsKeypair } = require('@metaplex-foundation/umi-web3js-adapters');
  const { Keypair, Connection, PublicKey } = require('@solana/web3.js');
  const _bs58 = require('bs58'); const bs58 = _bs58.default || _bs58;
  const keypair = Keypair.fromSecretKey(bs58.decode((process.env.MINT_PAYER_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY).trim()));
  prod = makeRewards({
    env: process.env,
    conn: new Connection(process.env.HELIUS_RPC_URL, 'confirmed'),
    payer: keypair.publicKey,
    getUmi: () => createUmi(process.env.HELIUS_RPC_URL).use(mplCore()).use(keypairIdentity(fromWeb3JsKeypair(keypair))),
    create, generateSigner, publicKey,
    getDb: () => require('./firebase').getDb(),
    sendPush: (...a) => require('./fcm').sendPush(...a),
  });
  return prod;
}

function scheduleOwedRetry(cron = require('node-cron')) {
  cron.schedule('17 * * * *', () => rewards().processOwed().catch(e => console.error('[owed] hourly retry error:', e.message)));
  console.log('Owed reward retry scheduled (hourly at :17)');
}

module.exports = {
  makeRewards, rewards, scheduleOwedRetry, assetSize, shape, owedId,
  MYTHIC_MILESTONES, CROWNS, RANKS, MONTH_NAMES, CORE_CREATE_FEE, PAYER_ADDRESS, truncBytes,
};
