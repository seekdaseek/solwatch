const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');

const GLOBAL_WHALE_SOL = parseFloat(process.env.GLOBAL_WHALE_SOL || '500');
const LAMPORTS_PER_SOL = 1_000_000_000;

async function whaleHandler(req, res) {
  res.status(200).json({ received: true });
  const transactions = req.body;
  if (!Array.isArray(transactions)) return;
  for (const tx of transactions) {
    try { await processTx(tx); }
    catch (e) { console.error('Whale handler error:', e.message); }
  }
}

async function processTx(tx) {
  const db = getDb();
  const nativeTransfers = tx.nativeTransfers || [];
  for (const transfer of nativeTransfers) {
    const solAmount = transfer.amount / LAMPORTS_PER_SOL;
    if (solAmount < 1) continue;
    const fromAccount = transfer.fromUserAccount;
    const toAccount = transfer.toUserAccount;
    if (solAmount >= GLOBAL_WHALE_SOL) {
      await broadcastWhaleAlert(db, tx.signature, fromAccount, toAccount, solAmount);
    }
    await checkWalletWatches(db, tx.signature, fromAccount, toAccount, solAmount);
  }
}

async function broadcastWhaleAlert(db, signature, from, to, solAmount) {
  const usdValue = await getSolUsdPrice() * solAmount;
  const title = 'Whale alert';
  const body = `${formatSol(solAmount)} SOL ($${formatUsd(usdValue)}) moved on-chain`;
  const snap = await db.collection('users').where('whaleAlertsEnabled', '==', true).get();
  const pushes = snap.docs.map(doc => {
    const { fcmToken } = doc.data();
    if (!fcmToken) return null;
    return sendPush(fcmToken, title, body, { type: 'whale', signature, from, to, solAmount: String(solAmount) });
  });
  await Promise.allSettled(pushes.filter(Boolean));
  console.log(`Whale alert: ${solAmount} SOL | ${snap.size} users`);
}

async function checkWalletWatches(db, signature, from, to, solAmount) {
  const snap = await db.collection('walletWatches').where('active', '==', true).get();
  for (const doc of snap.docs) {
    const watch = doc.data();
    const isWatched = watch.watchTarget === from || watch.watchTarget === to;
    if (!isWatched) continue;
    if (solAmount < watch.minSolAmount) continue;
    const direction = watch.watchTarget === from ? 'sent' : 'received';
    await sendPush(watch.fcmToken, 'Wallet move', `Watched wallet ${direction} ${formatSol(solAmount)} SOL`, {
      type: 'walletWatch', signature, watchTarget: watch.watchTarget, direction, solAmount: String(solAmount),
    });
  }
}

let cachedPrice = 150;
let priceLastFetched = 0;

async function getSolUsdPrice() {
  const now = Date.now();
  if (now - priceLastFetched < 30_000) return cachedPrice;
  try {
    const r = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
    const json = await r.json();
    cachedPrice = json.data['So11111111111111111111111111111111111111112']?.price || cachedPrice;
    priceLastFetched = now;
  } catch (_) {}
  return cachedPrice;
}

function formatSol(n) { return n.toLocaleString('en', { maximumFractionDigits: 1 }); }
function formatUsd(n) { return n.toLocaleString('en', { maximumFractionDigits: 0 }); }

module.exports = whaleHandler;
