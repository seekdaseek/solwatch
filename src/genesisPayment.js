// /genesis/mint, with the payment verified on chain before anything is minted.
//
// WHY. Until 2026-10-06 the endpoint only checked that SOME transaction credited the treasury >= 0.099 SOL, at
// "confirmed". It never checked who paid or whether the signature had been used before, so one real payment
// - anyone's - could be replayed by any wallet for a free Genesis badge.
//
// NOW, in this order: supply and per-wallet checks (unchanged), then the payment is read at FINALIZED
// commitment and must
//   - have succeeded (meta.err null),
//   - be signed by the caller's wallet,
//   - carry a top-level System transfer FROM the caller TO TREASURY_WALLET totalling >= the Genesis price,
// and only then is its signature claimed in Firestore genesisPayments/<signature> with create(), which fails
// if the document exists: a reused signature gets 409, atomically, even for two requests racing.
//
// FINALITY IS WAITED FOR. The app (ProScreen.jsx handleBuyGenesis) POSTs right after sendRawTransaction, without
// waiting for any confirmation, and finality takes ~13 s or more. So the payment is polled for up to
// FINALIZED_WAIT_MS; a request that times out is told to retry with the same signature, which still works
// because nothing is claimed until the payment verifies.
'use strict';

const GENESIS_PRICE_SOL = 0.1;
const GENESIS_LAMPORTS = 100_000_000;
const GENESIS_MAX = 100;
const FINALIZED_WAIT_MS = 60_000;
const PAYMENTS = 'genesisPayments';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const looksLikePubkey = s => typeof s === 'string' && s.length >= 32 && s.length <= 44 && BASE58.test(s);
const looksLikeSignature = s => typeof s === 'string' && s.length >= 64 && s.length <= 88 && BASE58.test(s);

async function findFinalized(conn, signature, { waitMs = FINALIZED_WAIT_MS, everyMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    const tx = await conn.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (tx) return tx;
    if (Date.now() >= end) return null;
    await sleep(everyMs);
  }
}

// tx: a getParsedTransaction result. Pure: every rule above except finality and reuse.
function checkPayment(tx, { walletAddress, treasury, minLamports = GENESIS_LAMPORTS }) {
  if (!tx || !tx.transaction || !tx.transaction.message) return { ok: false, status: 400, error: 'Transaction not found' };
  if (tx.meta && tx.meta.err) return { ok: false, status: 400, error: 'Payment transaction failed on chain' };
  const msg = tx.transaction.message;
  const signers = (msg.accountKeys || []).filter(k => k.signer).map(k => String(k.pubkey));
  if (!signers.includes(walletAddress)) return { ok: false, status: 403, error: 'Payment was not signed by this wallet' };
  const transfers = (msg.instructions || []).filter(ix => ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer' && ix.parsed.info);
  const toTreasury = transfers.filter(ix => ix.parsed.info.destination === treasury);
  if (!toTreasury.length) return { ok: false, status: 400, error: 'Payment not sent to treasury' };
  const fromCaller = toTreasury.filter(ix => ix.parsed.info.source === walletAddress);
  if (!fromCaller.length) return { ok: false, status: 403, error: 'Payment to the treasury did not come from this wallet' };
  const lamports = fromCaller.reduce((a, ix) => a + Number(ix.parsed.info.lamports), 0);
  if (!(lamports >= minLamports)) return { ok: false, status: 400, error: `Insufficient payment: ${lamports} lamports, the Genesis price is ${minLamports}` };
  return { ok: true, lamports, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null };
}

// create() is the atomic "first one wins": it fails with ALREADY_EXISTS (gRPC code 6) when the doc is there.
async function claimSignature(db, signature, data) {
  try {
    await db.collection(PAYMENTS).doc(signature).create({ ...data, claimedAt: new Date() });
    return { ok: true };
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(e.message)))) {
      return { ok: false, status: 409, error: 'This payment signature has already been used' };
    }
    throw e;
  }
}

// The whole endpoint, injectable for tests. Returns { status, body }.
async function genesisMint({ walletAddress, txSignature } = {}, deps) {
  if (!walletAddress || !txSignature) return { status: 400, body: { error: 'missing fields' } };
  if (!looksLikePubkey(walletAddress) || !looksLikeSignature(txSignature)) return { status: 400, body: { error: 'malformed walletAddress or txSignature' } };
  const db = deps.getDb();

  // Supply. A paid Genesis waiting in owedRewards holds its place in the 100.
  const snap = await db.collection('genesisMints').get();
  const owedGenesis = (await db.collection('owedRewards').where('status', '==', 'owed').get()).docs
    .map(d => ({ id: d.id, ...d.data() })).filter(o => o.type === 'genesis');
  if (snap.size + owedGenesis.length >= GENESIS_MAX) return { status: 400, body: { error: 'Genesis sold out!' } };

  // One per wallet (minted, or already paid for and queued).
  const existing = await db.collection('genesisMints').where('walletAddress', '==', walletAddress).get();
  if (!existing.empty) return { status: 400, body: { error: 'Already minted Genesis badge' } };
  if (owedGenesis.some(o => o.walletAddress === walletAddress)) {
    const message = 'Your Genesis badge is already paid for and queued; it will be minted automatically.';
    return { status: 202, body: { success: false, queued: true, message, error: message } };
  }
  // Signatures used before this file existed live only in genesisMints.txSignature.
  if (!(await db.collection('genesisMints').where('txSignature', '==', txSignature).get()).empty) {
    return { status: 409, body: { error: 'This payment signature has already been used' } };
  }

  const tx = await findFinalized(deps.conn, txSignature, deps.wait || {});
  if (!tx) return { status: 400, body: { error: 'Payment not found at finalized commitment yet. Retry in a minute with the same signature.' } };
  const chk = checkPayment(tx, { walletAddress, treasury: deps.treasury, minLamports: GENESIS_LAMPORTS });
  if (!chk.ok) return { status: chk.status, body: { error: chk.error } };
  const claim = await claimSignature(db, txSignature, { walletAddress, lamports: chk.lamports, slot: chk.slot, blockTime: chk.blockTime });
  if (!claim.ok) return { status: claim.status, body: { error: claim.error } };

  const r = await deps.mintReward({ type: 'genesis', walletAddress, paymentTx: txSignature });
  if (r.owed) {
    // The app shows result.error whenever success is not true, so the queued message rides there too.
    const message = 'Payment received. Your Genesis badge is queued and will be minted automatically.';
    return { status: 202, body: { success: false, queued: true, message, error: message } };
  }
  const number = r.number ?? (await db.collection('genesisMints').where('txSignature', '==', txSignature).get()).docs.map(d => d.data().number)[0];
  return { status: 200, body: { success: true, number, remaining: GENESIS_MAX - number } };
}

module.exports = { genesisMint, checkPayment, claimSignature, findFinalized, GENESIS_PRICE_SOL, GENESIS_LAMPORTS, GENESIS_MAX };
