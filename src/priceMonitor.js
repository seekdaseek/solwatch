const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');

const POLL_INTERVAL_MS = 30_000;

// PRICE SOURCE: Jupiter quote API, resolved BY MINT.
//
// WHY NOT PYTH ANY MORE. hermes.pyth.network began answering 401 to
// unauthenticated callers on 2026-08-27. It was the only source here, so
// fetchPrices() threw on every 30s poll and the error log grew ~30 lines every
// 15 minutes. Nothing in this service broke; a free upstream stopped being free.
//
// WHY NOT COINBASE/KRAKEN. Those resolve by TICKER. Alerts here are stored
// against a token MINT and a mint is the only identifier this service holds.
// Jupiter quotes by mint, which is why Pyth was chosen in the first place.
//
// HOW THE PRICE IS READ. A quote of exactly ONE whole token into USDC returns
// swapUsdValue, the USD value of the INPUT - so for a one-token input that is
// the unit price directly, with no decimal arithmetic. The amount must
// therefore be 10^decimals of the input mint, which is why decimals are pinned
// per mint below instead of assumed to be 6. Verified on-chain 2026-08-27:
// SOL 9, USDC 6, JUP 6, BONK 5.
//
// THIS CHAIN IS SOLWATCH'S OWN COPY. agentfeed, riskguard and skrly-alerts
// each carry their own. One being healthy says nothing about the others, and a
// shared require would let a single edit take all four down together.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const MINT_DECIMALS = {
  'So11111111111111111111111111111111111111112': 9,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 6,
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5,
};

const TOKEN_NAMES = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
};

// A price is only usable if it is a finite number ABOVE zero. This service
// fires 'below' alerts, so a zero or NaN reaching the caller would push a false
// alert to a real device. Anything else is dropped.
function usablePrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchOne(mint) {
  // USDC is the asset being quoted INTO. Jupiter rejects a same-mint quote
  // outright with CIRCULAR_ARBITRAGE_IS_DISABLED, so asking would be a
  // guaranteed error rather than a price. It is 1 USD by definition here.
  if (mint === USDC_MINT) return 1;

  const decimals = MINT_DECIMALS[mint];
  if (decimals === undefined) return null;

  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}` +
    `&outputMint=${USDC_MINT}&amount=${10 ** decimals}&slippageBps=50`;

  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Jupiter HTTP ${r.status}`);
  const j = await r.json();
  if (j.error || j.errorCode) throw new Error(`Jupiter: ${j.error || j.errorCode}`);

  // swapUsdValue first. outAmount is the same number in USDC base units, but it
  // is QUANTISED to whole micro-USDC: one BONK quotes at outAmount 3, a single
  // significant figure, and a cheaper token would round to 0 outright. That is
  // why it is only the fallback, and why usablePrice() rejects a zero.
  return usablePrice(j.swapUsdValue)
    ?? usablePrice(j.outAmount != null ? Number(j.outAmount) / 1e6 : null);
}

// SECOND SOURCE: DexScreener. Keyless, one request for every missing mint at
// once (documented up to 30 addresses, 300 req/min). Jupiter is a router quote
// and DexScreener is pool data, so they fail for different reasons - which is
// the point of having a second one at all.
//
// TWO TRAPS, both measured on 2026-08-27 against the live endpoint:
//
// 1. MINT ADDRESSES ARE NOT UNIQUE ACROSS CHAINS. The response carries every
//    chain. Address So111...112 also exists on chain 'fogo' as a token called
//    FOGO priced $0.009151, against wrapped SOL's $104.70 - a four-order-of-
//    magnitude error waiting to fire a 'below' alert on every board. It sorted
//    tenth by liquidity that day, so highest-liquidity alone would have
//    excluded it, but that is luck and not a guarantee. chainId is checked.
//
// 2. THE FIRST PAIR IS NOT THE RIGHT PAIR. Pair order is arbitrary; that FOGO
//    pool was returned FIRST for the SOL mint. The pair with the greatest
//    liquidity.usd is chosen instead, never the first entry.
//
// USDC never reaches here - fetchOne answers it as 1 before any network call -
// which is just as well: it has 0 pairs as a baseToken and 9 as a quoteToken,
// so DexScreener cannot price it as a base at all.
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

async function dexscreenerPrices(mints) {
  if (!mints.length) return {};
  const r = await fetch(DEXSCREENER_URL + mints.join(','), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
  const j = await r.json();
  const pairs = Array.isArray(j && j.pairs) ? j.pairs : [];

  const out = {};
  for (const mint of mints) {
    const mine = pairs.filter((x) =>
      x && x.chainId === 'solana' &&
      x.baseToken && x.baseToken.address === mint &&
      usablePrice(x.priceUsd) !== null);
    if (!mine.length) continue;
    const liq = (x) => Number((x.liquidity || {}).usd) || 0;
    const best = mine.reduce((a, b) => (liq(b) > liq(a) ? b : a));
    const v = usablePrice(best.priceUsd);
    if (v !== null) out[mint] = v;
  }
  return out;
}

// Same signature and same return shape as the Pyth version: { mint: usdPrice },
// carrying only the mints that resolved. Nothing downstream changes.
async function fetchPrices(mints) {
  const wanted = [...new Set(mints)]
    .filter((m) => m === USDC_MINT || MINT_DECIMALS[m] !== undefined);
  if (!wanted.length) return {};

  // Pyth answered every feed in ONE request; Jupiter quotes one mint at a time,
  // so these run together and each carries its own failure. One mint failing
  // must not blank the rest - the Pyth version also returned a partial map, and
  // the caller already skips a mint that is absent.
  const settled = await Promise.all(wanted.map(async (mint) => {
    try {
      return [mint, await fetchOne(mint)];
    } catch (e) {
      console.error(`Price fetch failed for ${TOKEN_NAMES[mint] || mint}: ${e.message}`);
      return [mint, null];
    }
  }));

  const result = {};
  for (const [mint, price] of settled) if (price !== null) result[mint] = price;

  // Only ask the second source about what Jupiter could not price, so a healthy
  // poll makes exactly one upstream call per mint and nothing extra.
  const missing = wanted.filter((m) => result[m] === undefined);
  if (missing.length) {
    try {
      const ds = await dexscreenerPrices(missing);
      for (const [mint, price] of Object.entries(ds)) {
        console.warn(`[price] ${TOKEN_NAMES[mint] || mint} served by dexscreener at ${price} (jupiter did not answer)`);
        result[mint] = price;
      }
    } catch (e) {
      console.error(`Price fetch failed (dexscreener fallback): ${e.message}`);
    }
  }

  // NAME EVERY DROPPED MINT. This is the gap that made the Jupiter cutover
  // dangerous: a mint that could not be priced was simply absent from the map
  // and pollPrices skipped it silently, so a total Jupiter outage would have
  // produced ZERO evidence. The Pyth outage was only caught because it wrote
  // 2645 error lines. Successes are deliberately not logged - at a 30s poll
  // over four mints that would be ~11,500 lines a day and would bury this.
  const dropped = wanted.filter((m) => result[m] === undefined);
  if (dropped.length) {
    console.warn(`[price] DROPPED ${dropped.length}/${wanted.length} mint(s), no source could price: ` +
      dropped.map((m) => `${TOKEN_NAMES[m] || m} (${m})`).join(', '));
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
      const pushResult = await sendPush(alert.fcmToken, `${name} price alert`,
        `${name} ${direction} $${target.toLocaleString()} — now $${currentPrice.toLocaleString('en', { maximumFractionDigits: 4 })}`,
        { type: 'priceAlert', tokenMint: alert.tokenMint, currentPrice: String(currentPrice), targetPrice: String(target), direction: alert.direction }
      );
      if (pushResult === 'STALE') {
        await doc.ref.update({ active: false, disabledReason: 'invalid_fcm_token', staleToken: true });
        continue;
      }
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

// fetchPrices is exported so the price source can be exercised on its own,
// without Firebase or a poll cycle. Nothing consumes it but tests.
module.exports = { startPriceMonitor, fetchPrices };
