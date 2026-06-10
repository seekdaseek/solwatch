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

// ─── Referral ─────────────────────────────────────────────────────────────────
app.post('/referral/apply', async (req, res) => {
  const { applyReferral } = require('./referralService');
  await applyReferral(req, res);
});

// ─── Streak freeze ───────────────────────────────────────────────────────────
app.post('/freeze-streak', async (req, res) => {
  const { handleFreezeStreak } = require('./freezeService');
  await handleFreezeStreak(req, res);
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/stats", async (req, res) => {
  try {
    const { walletAddress } = req.query;
    if (!walletAddress) return res.status(400).json({ error: "missing walletAddress" });
    const db = require("./firebase").getDb();
    const snap = await db.collection("checkins").doc(walletAddress).get();
    if (!snap.exists) return res.json({ streak: 0, tier: "Bronze", monthlyCheckins: 0, totalCheckins: 0 });
    res.json(snap.data());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const { walletAddress } = req.query;
    if (!walletAddress) return res.status(400).json({ error: "missing walletAddress" });
    const db = require("./firebase").getDb();
    const priceSnap = await db.collection("priceAlerts").where("walletAddress", "==", walletAddress).get();
    const walletSnap = await db.collection("walletWatches").where("walletAddress", "==", walletAddress).get();
    const priceAlerts = priceSnap.docs.map(d => ({ id: d.id, type: "price", ...d.data() }));
    const walletAlerts = walletSnap.docs.map(d => ({ id: d.id, type: "wallet", ...d.data() }));
    const userDoc = await db.collection("users").doc(walletAddress).get();
    const whaleAlertsEnabled = userDoc.exists ? (userDoc.data().whaleAlertsEnabled || false) : false;
    res.json({ priceAlerts, walletAlerts, whaleAlertsEnabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post("/alerts/whale", async (req, res) => {
  try {
    const { walletAddress, enabled, fcmToken } = req.body;
    if (!walletAddress) return res.status(400).json({ error: "missing walletAddress" });
    const db = require("./firebase").getDb();
    await db.collection("users").doc(walletAddress).set({ whaleAlertsEnabled: enabled, fcmToken }, { merge: true });
    res.json({ success: true, whaleAlertsEnabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post("/admin/mint-mythic", async (req, res) => {
  try {
    const { walletAddress, secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });
    const { mintMythicSBT } = require("./bubblegumService");
    const days = [30,60,90,120,150,180,210,240,270,300,330,365];
    const results = [];
    for (const day of days) {
      try {
        const r = await mintMythicSBT(walletAddress, day);
        results.push({ day, status: "ok", figure: r.figure });
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) {
        results.push({ day, status: "fail", error: e.message });
      }
    }
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.post("/admin/mint-mythic-sbt", async (req, res) => {
  try {
    const { walletAddress, secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });
    const { mintMythicMilestoneSBT } = require("./checkinService");
    const days = [30,60,90,120,150,180,210,240,270,300,330,365];
    const results = [];
    for (const day of days) {
      try {
        const r = await mintMythicMilestoneSBT(walletAddress, day);
        results.push({ day, status: "ok" });
        await new Promise(r => setTimeout(r, 3000));
      } catch(e) {
        results.push({ day, status: "fail", error: e.message });
      }
    }
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.delete("/alerts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.query;
    if (!walletAddress) return res.status(400).json({ error: "missing walletAddress" });
    const db = require("./firebase").getDb();
    const priceRef = db.collection("priceAlerts").doc(id);
    const walletRef = db.collection("walletWatches").doc(id);
    const [priceDoc, walletDoc] = await Promise.all([priceRef.get(), walletRef.get()]);
    if (priceDoc.exists && priceDoc.data().walletAddress === walletAddress) {
      await priceRef.delete();
    } else if (walletDoc.exists && walletDoc.data().walletAddress === walletAddress) {
      await walletRef.delete();
    } else {
      return res.status(404).json({ error: "alert not found" });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


const GENESIS_PRICE = 0.1;
const GENESIS_MAX = 100;

app.post("/genesis/mint", async (req, res) => {
  try {
    const { walletAddress, txSignature } = req.body;
    if (!walletAddress || !txSignature) return res.status(400).json({ error: "missing fields" });
    const db = require("./firebase").getDb();
    
    // Check supply
    const snap = await db.collection("genesisMints").get();
    if (snap.size >= GENESIS_MAX) return res.status(400).json({ error: "Genesis sold out!" });
    
    // Check not already minted
    const existing = await db.collection("genesisMints").where("walletAddress", "==", walletAddress).get();
    if (!existing.empty) return res.status(400).json({ error: "Already minted Genesis badge" });
    
    // Verify payment on-chain
    const { Connection, PublicKey } = require("@solana/web3.js");
    const conn = new Connection(process.env.HELIUS_RPC_URL, "confirmed");
    const tx = await conn.getTransaction(txSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) return res.status(400).json({ error: "Transaction not found" });
    const accountKeys = tx.transaction.message.getAccountKeys ? tx.transaction.message.getAccountKeys().staticAccountKeys : tx.transaction.message.accountKeys;
    const treasuryPubkey = new PublicKey(process.env.TREASURY_WALLET);
    const treasuryIdx = accountKeys.findIndex(k => k.equals(treasuryPubkey));
    if (treasuryIdx === -1) return res.status(400).json({ error: "Payment not sent to treasury" });
    const received = tx.meta.postBalances[treasuryIdx] - tx.meta.preBalances[treasuryIdx];
    const minLamports = GENESIS_PRICE * 1e9 * 0.99;
    if (received < minLamports) return res.status(400).json({ error: "Insufficient payment" });
    
    // Assign number
    const number = snap.size + 1;
    
    // Mint real Core NFT
    const { mplCore, create } = require("@metaplex-foundation/mpl-core");
    const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
    const { keypairIdentity, publicKey, generateSigner } = require("@metaplex-foundation/umi");
    const { fromWeb3JsKeypair } = require("@metaplex-foundation/umi-web3js-adapters");
    const { Keypair } = require("@solana/web3.js");
    const _bs58 = require("bs58"); const bs58 = _bs58.default || _bs58;
    const umi = createUmi(process.env.HELIUS_RPC_URL).use(mplCore());
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
    umi.use(keypairIdentity(fromWeb3JsKeypair(keypair)));
    const assetSigner = generateSigner(umi);
    const uri = `https://seekdaseek.github.io/solwatch/cnft/genesis/${number}.json`;
    await create(umi, {
      asset: assetSigner,
      name: `SolWatch Genesis #${number}`.slice(0, 32),
      uri,
      owner: publicKey(walletAddress),
      plugins: [{ type: 'PermanentFreezeDelegate', frozen: false, authority: { type: 'UpdateAuthority' } }],
    }).sendAndConfirm(umi);
    
    await db.collection("genesisMints").add({ walletAddress, number, txSignature, mintedAt: new Date() });
    res.json({ success: true, number, remaining: GENESIS_MAX - number });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/genesis/status", async (req, res) => {
  try {
    const db = require("./firebase").getDb();
    const snap = await db.collection("genesisMints").get();
    res.json({ minted: snap.size, remaining: GENESIS_MAX - snap.size, price: GENESIS_PRICE, soldOut: snap.size >= GENESIS_MAX });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.post("/admin/mint-founder", async (req, res) => {
  try {
    const { walletAddress, secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });
    const db = require("./firebase").getDb();
    const existing = await db.collection("genesisMints").where("number", "==", 0).get();
    if (!existing.empty) return res.status(400).json({ error: "Founder already minted" });
    const { mplCore, create } = require("@metaplex-foundation/mpl-core");
    const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
    const { keypairIdentity, publicKey, generateSigner } = require("@metaplex-foundation/umi");
    const { fromWeb3JsKeypair } = require("@metaplex-foundation/umi-web3js-adapters");
    const { Keypair } = require("@solana/web3.js");
    const _bs58 = require("bs58"); const bs58 = _bs58.default || _bs58;
    const umi = createUmi(process.env.HELIUS_RPC_URL).use(mplCore());
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
    umi.use(keypairIdentity(fromWeb3JsKeypair(keypair)));
    const assetSigner = generateSigner(umi);
    const uri = "https://seekdaseek.github.io/solwatch/cnft/genesis/0.json";
    await create(umi, {
      asset: assetSigner,
      name: "SolWatch Genesis #0 Founder",
      uri,
      owner: publicKey(walletAddress),
      plugins: [{ type: 'PermanentFreezeDelegate', frozen: false, authority: { type: 'UpdateAuthority' } }],
    }).sendAndConfirm(umi);
    await db.collection("genesisMints").add({ walletAddress, number: 0, founder: true, mintedAt: new Date() });
    res.json({ success: true, message: "Founder #0 minted" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get("/leaderboard", async (req, res) => {
  try {
    const db = require("./firebase").getDb();
    const snap = await db.collection("checkins")
      .orderBy("streak", "desc")
      .limit(20)
      .get();
    const board = snap.docs.map((d, i) => {
      const data = d.data();
      const addr = d.id;
      return {
        rank: i + 1,
        wallet: addr.slice(0, 4) + "..." + addr.slice(-4),
        streak: data.streak || 0,
        tier: data.streak >= 365 ? "Diamond" : data.streak >= 100 ? "Platinum" : data.streak >= 30 ? "Gold" : data.streak >= 14 ? "Silver" : "Bronze",
        totalCheckins: data.totalCheckins || 0,
      };
    });
    res.json({ leaderboard: board, updatedAt: new Date() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await initFirebase();
  startPriceMonitor();
  scheduleMonthlyMint();
  
const cron = require('node-cron');

cron.schedule('0 9 * * 1', async () => {
  console.log('Running weekly leaderboard rewards...');
  try {
    const db = require('./firebase').getDb();
    const { sendPush } = require('./fcm');
    const snap = await db.collection('checkins').orderBy('streak', 'desc').limit(3).get();
    if (snap.empty) return;
    const { mplCore, create } = require('@metaplex-foundation/mpl-core');
    const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
    const { keypairIdentity, publicKey, generateSigner } = require('@metaplex-foundation/umi');
    const { fromWeb3JsKeypair } = require('@metaplex-foundation/umi-web3js-adapters');
    const { Keypair } = require('@solana/web3.js');
    const _bs58 = require('bs58'); const bs58 = _bs58.default || _bs58;
    const umi = createUmi(process.env.HELIUS_RPC_URL).use(mplCore());
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
    umi.use(keypairIdentity(fromWeb3JsKeypair(keypair)));
    const crowns = ['gold_crown', 'silver_crown', 'bronze_crown'];
    const ranks = ['Champion', 'Challenger', 'Contender'];
    const week = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < snap.docs.length; i++) {
      const user = snap.docs[i].data();
      const walletAddress = snap.docs[i].id;
      const crown = crowns[i];
      const rank = ranks[i];
      try {
        const assetSigner = generateSigner(umi);
        const uri = `https://seekdaseek.github.io/solwatch/cnft/rewards/${crown}.json`;
        await create(umi, {
          asset: assetSigner,
          name: `SolWatch ${rank} ${week}`.slice(0, 32),
          uri,
          owner: publicKey(walletAddress),
          plugins: [{ type: 'PermanentFreezeDelegate', frozen: false, authority: { type: 'UpdateAuthority' } }],
        }).sendAndConfirm(umi);
        if (user.fcmToken) await sendPush(user.fcmToken, 'Weekly Crown!', `You ranked #${i+1} this week and earned the ${rank} Crown!`, { type: 'reward', rank: String(i+1) });
        console.log(`Crown minted to #${i+1}: ${walletAddress}`);
      } catch(e) { console.error(`Crown mint failed for rank ${i+1}:`, e.message); }
      await new Promise(r => setTimeout(r, 3000));
    }
    console.log('Weekly rewards done');
  } catch(e) { console.error('Weekly reward error:', e.message); }
});

console.log('Weekly reward scheduler registered');

app.listen(process.env.PORT || 3000, () =>
    console.log('SolWatch running on port ' + (process.env.PORT || 3000))
  );
}

boot().catch(console.error);
