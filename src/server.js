require('dotenv').config();
const express = require('express');
const { initFirebase } = require('./firebase');
const { startPriceMonitor } = require('./priceMonitor');
const { scheduleMonthlyMint } = require('./checkinService');
const whaleHandler = require('./whaleHandler');

const app = express();
app.use(express.json());

// ─── Webhooks ────────────────────────────────────────────────────────────────
app.post('/webhook/helius', whaleHandler);

// ─── Check-in ────────────────────────────────────────────────────────────────
app.post('/checkin', async (req, res) => {
  const { walletAddress, fcmToken } = req.body;
  if (!walletAddress || !fcmToken) return res.status(400).json({ error: 'missing fields' });
  try {
    const { handleCheckin } = require('./checkinService');
    const result = await handleCheckin(walletAddress, fcmToken);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Price alerts (free: 3 max, Pro: unlimited) ───────────────────────────────
app.post('/alerts/price', async (req, res) => {
  const { walletAddress, fcmToken, tokenMint, targetPrice, direction } = req.body;
  if (!walletAddress || !fcmToken || !tokenMint || !targetPrice || !direction)
    return res.status(400).json({ error: 'missing fields' });
  try {
    const db = require('./firebase').getDb();
    const { isProActive } = require('./subscriptionService');
    const isPro = await isProActive(walletAddress);

    if (!isPro) {
      const FREE_LIMIT = 3;
      const existing = await db.collection('priceAlerts')
        .where('walletAddress', '==', walletAddress)
        .where('active', '==', true)
        .get();
      if (existing.size >= FREE_LIMIT) {
        return res.status(403).json({
          error: 'Free tier limited to 3 active alerts. Upgrade to Pro for unlimited.',
          code: 'FREE_TIER_LIMIT',
          activeCount: existing.size,
        });
      }
    }

    await db.collection('priceAlerts').add({
      walletAddress, fcmToken, tokenMint,
      targetPrice: parseFloat(targetPrice),
      direction, active: true, createdAt: new Date(),
    });
    res.json({ success: true, isPro });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Wallet alerts (Pro only) ─────────────────────────────────────────────────
app.post('/alerts/wallet', async (req, res) => {
  const { walletAddress, watchTarget, fcmToken, minSolAmount } = req.body;
  if (!walletAddress || !watchTarget || !fcmToken)
    return res.status(400).json({ error: 'missing fields' });
  try {
    const { isProActive } = require('./subscriptionService');
    const isPro = await isProActive(walletAddress);
    if (!isPro) {
      return res.status(403).json({
        error: 'Wallet alerts are a Pro feature. Upgrade to unlock.',
        code: 'PRO_REQUIRED',
      });
    }
    const db = require('./firebase').getDb();
    await db.collection('walletWatches').add({
      walletAddress, watchTarget, fcmToken,
      minSolAmount: parseFloat(minSolAmount) || 50,
      active: true, createdAt: new Date(),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pro: activate (with SBT discount) ───────────────────────────────────────
app.post('/pro/activate', async (req, res) => {
  const { walletAddress, txSignature, fcmToken } = req.body;
  if (!walletAddress || !txSignature) return res.status(400).json({ error: 'missing fields' });
  try {
    const { verifyAndActivatePro } = require('./subscriptionService');
    const result = await verifyAndActivatePro(walletAddress, txSignature, fcmToken);
    res.json(result);
  } catch (e) {
    console.error('Pro activation failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ─── Pro: status ──────────────────────────────────────────────────────────────
app.get('/pro/status', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet query param required' });
  try {
    const { getProStatus } = require('./subscriptionService');
    const status = await getProStatus(wallet);
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pro: price with SBT discount ────────────────────────────────────────────
app.get('/pro/price', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet query param required' });
  try {
    const { getDiscountedPrice } = require('./subscriptionService');
    const pricing = await getDiscountedPrice(wallet);
    res.json(pricing);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pro: burn cNFTs for Pro days ─────────────────────────────────────────────
app.post('/pro/burn', async (req, res) => {
  const { handleBurnForPro } = require('./burnForPro');
  await handleBurnForPro(req, res);
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await initFirebase();
  startPriceMonitor();
  scheduleMonthlyMint();
  app.listen(process.env.PORT || 3000, () =>
    console.log('SolWatch running on port ' + (process.env.PORT || 3000))
  );
}

boot().catch(console.error);
