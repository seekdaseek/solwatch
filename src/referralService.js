const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');

async function applyReferral(req, res) {
  const { walletAddress, referralCode, fcmToken } = req.body;
  if (!walletAddress || !referralCode) return res.status(400).json({ error: 'walletAddress and referralCode required' });

  try {
    const db = getDb();

    // referralCode = first 8 chars of referrer wallet
    // Find referrer by code
    const referrersSnap = await db.collection('checkins')
      .where('referralCode', '==', referralCode)
      .limit(1).get();

    // Also check by wallet prefix
    let referrerWallet = null;
    if (!referrersSnap.empty) {
      referrerWallet = referrersSnap.docs[0].data().walletAddress;
    } else {
      // find wallet that starts with referralCode
      const allSnap = await db.collection('checkins').get();
      const match = allSnap.docs.find(d => d.data().walletAddress.startsWith(referralCode));
      if (match) referrerWallet = match.data().walletAddress;
    }

    if (!referrerWallet) return res.status(404).json({ error: 'Invalid referral code' });
    if (referrerWallet === walletAddress) return res.status(400).json({ error: 'Cannot refer yourself' });

    // Check not already used referral
    const userRef = db.collection('checkins').doc(walletAddress);
    const userSnap = await userRef.get();
    if (userSnap.exists && userSnap.data().referredBy) {
      return res.status(400).json({ error: 'Already used a referral code' });
    }

    // Mark user as referred
    await userRef.set({ referredBy: referrerWallet }, { merge: true });

    // Credit referrer 7 days Pro
    const subRef = db.collection('subscriptions').doc(referrerWallet);
    const subSnap = await subRef.get();
    const now = new Date();
    const currentExpiry = subSnap.exists && subSnap.data().expiresAt
      ? subSnap.data().expiresAt.toDate() : now;
    const baseDate = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    await subRef.set({ walletAddress: referrerWallet, isPro: true, expiresAt: newExpiry }, { merge: true });

    // Notify referrer
    const referrerSnap = await db.collection('checkins').doc(referrerWallet).get();
    const referrerToken = referrerSnap.exists ? referrerSnap.data().fcmToken : null;
    if (referrerToken) {
      await sendPush(referrerToken, 'Referral bonus!',
        'Someone joined using your code — 7 days Pro added!',
        { type: 'referral' }
      );
    }

    console.log('Referral applied: ' + walletAddress + ' referred by ' + referrerWallet);
    return res.json({ success: true, referrerWallet, newExpiry });

  } catch (e) {
    console.error('Referral failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { applyReferral };
