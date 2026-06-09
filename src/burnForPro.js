const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');
const { getUnburnedCNFTCount, markCNFTsBurned } = require('./bubblegumService');

const BURN_COUNT_REQUIRED = 30;
const BURN_DAYS_REWARD    = 30;

async function handleBurnForPro(req, res) {
  const { walletAddress, fcmToken } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });

  try {
    const db = getDb();

    const count = await getUnburnedCNFTCount(walletAddress);
    if (count < BURN_COUNT_REQUIRED) {
      return res.status(403).json({
        error: `Not enough check-in NFTs. Have ${count}, need ${BURN_COUNT_REQUIRED}.`,
        code: 'INSUFFICIENT_CNFTS',
        have: count,
        need: BURN_COUNT_REQUIRED,
      });
    }

    const { mintDocs } = await markCNFTsBurned(walletAddress, BURN_COUNT_REQUIRED);

    const userRef = db.collection('subscriptions').doc(walletAddress);
    const userSnap = await userRef.get();
    const now = new Date();
    const currentExpiry = userSnap.exists && userSnap.data().expiresAt
      ? userSnap.data().expiresAt.toDate() : now;
    const baseDate = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseDate.getTime() + BURN_DAYS_REWARD * 24 * 60 * 60 * 1000);

    await userRef.set({
      walletAddress, isPro: true, expiresAt: newExpiry,
      lastBurnAt: now,
      fcmToken: fcmToken || userSnap.data()?.fcmToken,
    }, { merge: true });

    const token = fcmToken || userSnap.data()?.fcmToken;
    if (token) {
      await sendPush(token, 'Pro extended via burn!',
        `Burned ${BURN_COUNT_REQUIRED} check-in NFTs → Pro active until ${newExpiry.toLocaleDateString()}.`,
        { type: 'pro_burn', expiresAt: newExpiry.toISOString() }
      );
    }

    console.log(`Burn-for-Pro: ${walletAddress} → Pro until ${newExpiry.toISOString()}`);
    return res.json({ success: true, burnedCount: BURN_COUNT_REQUIRED, expiresAt: newExpiry, mintDocs });

  } catch (e) {
    console.error('Burn-for-Pro failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { handleBurnForPro };
