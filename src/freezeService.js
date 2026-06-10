const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');
const { getUnburnedCNFTCount, markCNFTsBurned } = require('./bubblegumService');

async function handleFreezeStreak(req, res) {
  const { walletAddress, fcmToken } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });

  try {
    const db = getDb();

    const checkinRef = db.collection('checkins').doc(walletAddress);
    const snap = await checkinRef.get();
    if (snap.exists && snap.data().freezeActive) {
      return res.status(400).json({ error: 'Freeze already active', code: 'FREEZE_ACTIVE' });
    }

    const count = await getUnburnedCNFTCount(walletAddress);
    if (count < 1) {
      return res.status(403).json({ error: 'No check-in NFTs to burn', code: 'INSUFFICIENT_CNFTS', have: count });
    }

    await markCNFTsBurned(walletAddress, 1);

    const freezeExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await checkinRef.set({ freezeActive: true, freezeExpiry }, { merge: true });

    const token = fcmToken || (snap.exists ? snap.data().fcmToken : null);
    if (token) {
      await sendPush(token, 'Streak Frozen!',
        'Burned 1 badge - your streak is protected for the next 48 hours.',
        { type: 'freeze', freezeExpiry: freezeExpiry.toISOString() }
      );
    }

    console.log('Streak freeze activated for ' + walletAddress);
    return res.json({ success: true, freezeExpiry });

  } catch (e) {
    console.error('Freeze failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { handleFreezeStreak };
