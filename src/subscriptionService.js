const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');

const RPC_ENDPOINT    = process.env.HELIUS_RPC_URL;
const TREASURY_WALLET = process.env.TREASURY_WALLET;
const PRO_PRICE_SOL   = parseFloat(process.env.PRO_PRICE_SOL);
const PRO_DURATION_DAYS = parseInt(process.env.PRO_DURATION_DAYS);

const SBT_DISCOUNT_PER_BADGE = 0.10;
const SBT_DISCOUNT_MAX       = 0.50;

const connection = new Connection(RPC_ENDPOINT, 'confirmed');

async function getSBTCount(walletAddress) {
  const db = getDb();
  const snap = await db.collection('checkins').doc(walletAddress).get();
  if (!snap.exists) return 0;
  return (snap.data().mintedMonths || []).length;
}

async function getDiscountedPrice(walletAddress) {
  const sbtCount = await getSBTCount(walletAddress);
  const discountRate = Math.min(sbtCount * SBT_DISCOUNT_PER_BADGE, SBT_DISCOUNT_MAX);
  const discountedPrice = parseFloat((PRO_PRICE_SOL * (1 - discountRate)).toFixed(4));
  return { sbtCount, discountRate, discountedPrice, basePrice: PRO_PRICE_SOL };
}

async function verifyAndActivatePro(walletAddress, txSignature, fcmToken) {
  if (!walletAddress || !txSignature) throw new Error('walletAddress and txSignature required');

  const db = getDb();
  const txRef = db.collection('processedTxs').doc(txSignature);
  const txSnap = await txRef.get();
  if (txSnap.exists) throw new Error('Transaction already processed');

  const tx = await connection.getTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error('Transaction not found on chain');
  if (tx.meta?.err) throw new Error('Transaction failed on chain');

  const accountKeys = tx.transaction.message.staticAccountKeys ||
                      tx.transaction.message.accountKeys;
  const sender = accountKeys[0].toBase58();
  if (sender !== walletAddress) throw new Error(`Sender mismatch: tx from ${sender}, expected ${walletAddress}`);

  const { discountedPrice, sbtCount, discountRate } = await getDiscountedPrice(walletAddress);
  const MIN_LAMPORTS = Math.floor(discountedPrice * LAMPORTS_PER_SOL);

  const treasuryPubkey = new PublicKey(TREASURY_WALLET);
  const treasuryIdx = accountKeys.findIndex(k => k.equals(treasuryPubkey));
  if (treasuryIdx === -1) throw new Error('Treasury not in tx accounts');

  const received = tx.meta.postBalances[treasuryIdx] - tx.meta.preBalances[treasuryIdx];
  if (received < MIN_LAMPORTS) {
    throw new Error(
      `Insufficient payment: ${received / LAMPORTS_PER_SOL} SOL received, ` +
      `need ${discountedPrice} SOL (${Math.round(discountRate * 100)}% SBT discount applied)`
    );
  }

  const userRef = db.collection('subscriptions').doc(walletAddress);
  const userSnap = await userRef.get();
  const now = new Date();
  const currentExpiry = userSnap.exists && userSnap.data().expiresAt
    ? userSnap.data().expiresAt.toDate() : now;
  const baseDate = currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(baseDate.getTime() + PRO_DURATION_DAYS * 24 * 60 * 60 * 1000);

  const batch = db.batch();
  batch.set(txRef, {
    walletAddress, txSignature,
    amountSol: received / LAMPORTS_PER_SOL,
    discountedPrice, sbtCount, discountRate,
    processedAt: now, type: 'pro_subscription',
  });
  batch.set(userRef, {
    walletAddress, isPro: true, expiresAt: newExpiry,
    lastPaymentAt: now, lastTxSignature: txSignature,
    fcmToken: fcmToken || userSnap.data()?.fcmToken,
  }, { merge: true });
  await batch.commit();

  if (fcmToken) {
    const discountMsg = discountRate > 0 ? ` (${Math.round(discountRate * 100)}% SBT discount applied)` : '';
    await sendPush(fcmToken, 'Welcome to SolWatch Pro',
      `Pro active until ${newExpiry.toLocaleDateString()}${discountMsg}. Unlimited alerts unlocked.`,
      { type: 'pro_activated', expiresAt: newExpiry.toISOString() }
    );
  }

  console.log(`Pro activated: ${walletAddress} until ${newExpiry.toISOString()} | SBTs: ${sbtCount} | discount: ${Math.round(discountRate * 100)}%`);
  return { success: true, expiresAt: newExpiry, sbtCount, discountRate };
}

async function isProActive(walletAddress) {
  const db = getDb();
  const snap = await db.collection('subscriptions').doc(walletAddress).get();
  if (!snap.exists) return false;
  const data = snap.data();
  if (!data.expiresAt) return false;
  return data.expiresAt.toDate() > new Date();
}

async function getProStatus(walletAddress) {
  const db = getDb();
  const snap = await db.collection('subscriptions').doc(walletAddress).get();
  if (!snap.exists) return { isPro: false, expiresAt: null, daysRemaining: 0 };
  const data = snap.data();
  const expiresAt = data.expiresAt?.toDate() || null;
  const now = new Date();
  const isPro = expiresAt && expiresAt > now;
  const daysRemaining = isPro ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : 0;
  return { isPro, expiresAt, daysRemaining };
}

module.exports = { verifyAndActivatePro, isProActive, getProStatus, getDiscountedPrice, getSBTCount };
