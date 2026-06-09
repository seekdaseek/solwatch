const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');

const POLL_INTERVAL_MS = 30_000;

const MINT_TO_COINGECKO = {
  'So11111111111111111111111111111111111111112': 'solana',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usd-coin',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'jupiter-exchange-solana',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
};

const TOKEN_NAMES = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
};

async function fetchPrices(mints) {
  const ids = [...new Set(mints.map(m => MINT_TO_COINGECKO[m]).filter(Boolean))].join(',');
  if (!ids) return {};
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  const json = await r.json();
  const result = {};
  for (const mint of mints) {
    const cgId = MINT_TO_COINGECKO[mint];
    if (cgId && json[cgId]) result[mint] = json[cgId].usd;
  }
  return result;
}

async function pollPrices() {
  const db = getDb();
  const snap = await db.collection('priceAlerts').where('active', '==', true).get();
  if (snap.empty) return;

  const mints = [...new Set(snap.docs.map(d => d.data().tokenMint))];

  let prices;
  try {
    prices = await fetchPrices(mints);
  } catch (e) {
    console.error('Price fetch failed:', e.message);
    return;
  }

  for (const doc of snap.docs) {
    const alert = doc.data();
    const currentPrice = prices[alert.tokenMint];
    if (!currentPrice) continue;
    const target = alert.targetPrice;
    const name = TOKEN_NAMES[alert.tokenMint] || alert.tokenMint.slice(0, 6);
    const triggered =
      (alert.direction === 'above' && currentPrice >= target) ||
      (alert.direction === 'below' && currentPrice <= target);
    if (!triggered) continue;

    const direction = alert.direction === 'above' ? 'crossed above' : 'dropped below';
    try {
      await sendPush(alert.fcmToken, `${name} price alert`,
        `${name} ${direction} $${target.toLocaleString()} — now $${currentPrice.toLocaleString('en', { maximumFractionDigits: 4 })}`,
        { type: 'priceAlert', tokenMint: alert.tokenMint, currentPrice: String(currentPrice), targetPrice: String(target), direction: alert.direction }
      );
    } catch (e) {
      console.warn(`Push failed for ${alert.walletAddress}: ${e.message}`);
      // If token is invalid, deactivate the alert
      if (e.code === 'messaging/invalid-argument' || e.code === 'messaging/registration-token-not-registered') {
        await doc.ref.update({ active: false, disabledReason: 'invalid_fcm_token' });
        continue;
      }
    }
    await doc.ref.update({ active: false, firedAt: new Date() });
  }
}

async function startPriceMonitor() {
  console.log('Price monitor started');
  setInterval(pollPrices, POLL_INTERVAL_MS);
  await pollPrices();
}

module.exports = { startPriceMonitor };
