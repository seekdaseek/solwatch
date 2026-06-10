const cron = require('node-cron');
const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { mplCore, createV1, pluginAuthorityPair, create } = require('@metaplex-foundation/mpl-core');
const { generateSigner, keypairIdentity, publicKey } = require('@metaplex-foundation/umi');
const { fromWeb3JsKeypair } = require('@metaplex-foundation/umi-web3js-adapters');
const { Keypair } = require('@solana/web3.js');
const _bs58 = require('bs58'); const bs58 = _bs58.default || _bs58;
const { mintDailyCheckinCNFT, getTier } = require('./bubblegumService');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const RPC_ENDPOINT = process.env.HELIUS_RPC_URL;


const MYTHIC_MILESTONES = {
  30: { figure: "Hercules", name: "SW Mythic — Hercules" },
  60: { figure: "Achilles", name: "SW Mythic — Achilles" },
  90: { figure: "Odysseus", name: "SW Mythic — Odysseus" },
  120: { figure: "Zeus", name: "SW Mythic — Zeus" },
  150: { figure: "Poseidon", name: "SW Mythic — Poseidon" },
  180: { figure: "Ares", name: "SW Mythic — Ares" },
  210: { figure: "Apollo", name: "SW Mythic — Apollo" },
  240: { figure: "Athena", name: "SW Mythic — Athena" },
  270: { figure: "Hades", name: "SW Mythic — Hades" },
  300: { figure: "Odin", name: "SW Mythic — Odin" },
  330: { figure: "Thor", name: "SW Mythic — Thor" },
  365: { figure: "Prometheus", name: "SW Mythic — Prometheus" },
};

async function mintMythicMilestoneSBT(walletAddress, streakDay) {
  const milestone = MYTHIC_MILESTONES[streakDay];
  if (!milestone) return null;
  const db = getDb();
  const docId = `${walletAddress}_mythic_${streakDay}`;
  const ref = db.collection('mythicSBTs').doc(docId);
  const existing = await ref.get();
  if (existing.exists) return { alreadyMinted: true };
  const umi = createUmi(RPC_ENDPOINT).use(mplCore());
  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
  umi.use(keypairIdentity(fromWeb3JsKeypair(treasuryKeypair)));
  const assetSigner = generateSigner(umi);
  const uri = `https://seekdaseek.github.io/solwatch/cnft/mythic/day-${streakDay}.json`;
  await create(umi, {
    asset: assetSigner,
    name: milestone.name.slice(0, 32),
    uri,
    owner: publicKey(walletAddress),
    plugins: [{ type: 'PermanentFreezeDelegate', frozen: true, authority: { type: 'UpdateAuthority' } }],
  }).sendAndConfirm(umi);
  await ref.set({ walletAddress, streakDay, figure: milestone.figure, mintedAt: new Date(), uri });
  console.log(`Mythic SBT minted → ${walletAddress} | ${milestone.figure}`);
  return { success: true, figure: milestone.figure };
}

async function handleCheckin(walletAddress, fcmToken) {
  const db = getDb();
  const ref = db.collection('checkins').doc(walletAddress);
  const snap = await ref.get();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  let data = snap.exists ? snap.data() : {
    walletAddress, fcmToken, streak: 0, lastCheckin: null,
    totalCheckins: 0, monthlyCheckins: 0,
    currentMonth: now.getMonth(), mintedMonths: [],
  };

  data.fcmToken = fcmToken;

  if (data.currentMonth !== now.getMonth()) {
    data.monthlyCheckins = 0;
    data.currentMonth = now.getMonth();
  }

  if (data.lastCheckin === todayStr) {
    return { alreadyCheckedIn: true, streak: data.streak, monthlyCheckins: data.monthlyCheckins };
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const missedDay = data.lastCheckin && data.lastCheckin !== yesterdayStr && data.lastCheckin !== todayStr;
  if (missedDay && data.freezeActive && data.freezeExpiry) {
    const expiry = data.freezeExpiry.toDate ? data.freezeExpiry.toDate() : new Date(data.freezeExpiry);
    if (expiry > now) {
      data.streak = data.streak + 1;
      data.freezeActive = false;
      data.freezeExpiry = null;
    } else {
      data.streak = 1;
      data.freezeActive = false;
      data.freezeExpiry = null;
    }
  } else {
    data.streak = data.lastCheckin === yesterdayStr ? data.streak + 1 : 1;
  }
  data.lastCheckin = todayStr;
  data.totalCheckins += 1;
  data.monthlyCheckins += 1;

  await ref.set(data, { merge: true });

  // Mint daily cNFT (non-blocking)
  let cnftResult = null;
  try {
    cnftResult = await mintDailyCheckinCNFT(walletAddress, data.streak);
  } catch (e) {
    console.error(`cNFT mint failed for ${walletAddress} (streak ${data.streak}):`, e.message);
  }

  // Streak milestone notifications
  const tier = getTier(data.streak);
  let message = null;
  if (data.streak === 7)   message = `7-day streak! You're on fire. Tier: ${tier}`;
  else if (data.streak === 14)  message = `14 days straight. Legendary. Tier: ${tier}`;
  else if (data.streak === 30)  message = `30-day streak! Gold tier unlocked. SBT incoming...`;
  else if (data.streak === 90)  message = `90 days. Platinum. You're built different.`;
  else if (data.streak === 365) message = `365 days. Diamond. Unmatchable.`;

  if (MYTHIC_MILESTONES[data.streak]) {
    mintMythicMilestoneSBT(walletAddress, data.streak).catch(e =>
      console.error('Mythic SBT failed:', e.message)
    );
  }

  // Milestone proximity alerts
  const milestones = [14, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 365];
  for (const m of milestones) {
    const daysAway = m - data.streak;
    if (daysAway === 3) {
      const mTier = data.streak >= 100 ? 'Platinum' : data.streak >= 30 ? 'Gold' : data.streak >= 14 ? 'Silver' : 'Bronze';
      await sendPush(fcmToken, 'Almost there!', `3 days to day ${m} — keep your streak alive!`, { type: 'milestone_soon', milestone: String(m) });
      break;
    }
  }

  if (message) {
    await sendPush(fcmToken, 'SolWatch streak', message, {
      type: 'streak', streak: String(data.streak), tier,
    });
  }

  return {
    success: true, streak: data.streak, tier,
    monthlyCheckins: data.monthlyCheckins,
    totalCheckins: data.totalCheckins,
    cnft: cnftResult,
  };
}

function scheduleMonthlyMint() {
  cron.schedule('5 0 1 * *', async () => {
    console.log('Running month-end SBT mint...');
    await mintMonthlyBadges();
  });
  console.log('Monthly mint scheduler registered');
}

async function mintMonthlyBadges() {
  const db = getDb();
  const now = new Date();
  const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthKey = `${lastMonthYear}-${String(lastMonth + 1).padStart(2, '0')}`;

  const snap = await db.collection('checkins')
    .where('currentMonth', '==', lastMonth)
    .where('monthlyCheckins', '>=', 30)
    .get();

  if (snap.empty) { console.log('No 30-day completions last month'); return; }
  console.log(`Minting SBTs for ${snap.size} users...`);

  const umi = createUmi(RPC_ENDPOINT).use(mplCore());
  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
  umi.use(keypairIdentity(fromWeb3JsKeypair(treasuryKeypair)));

  for (const doc of snap.docs) {
    const user = doc.data();
    if (user.mintedMonths?.includes(monthKey)) continue;
    try {
      const assetSigner = generateSigner(umi);
      const uri = `${process.env.METADATA_BASE_URL}/${monthKey}.json`;
      await createV1(umi, {
        asset: assetSigner,
        name: `SolWatch ${MONTH_NAMES[lastMonth]} ${lastMonthYear}`,
        uri,
        owner: publicKey(user.walletAddress),
        plugins: [pluginAuthorityPair({
          type: 'PermanentFreezeDelegate',
          data: { frozen: true },
          authority: { type: 'None' },
        })],
      }).sendAndConfirm(umi);

      await doc.ref.update({ mintedMonths: [...(user.mintedMonths || []), monthKey] });

      if (user.fcmToken) await sendPush(user.fcmToken, 'SolWatch badge minted!',
        `Your ${MONTH_NAMES[lastMonth]} ${lastMonthYear} SBT just landed in your wallet.`,
        { type: 'sbt', monthKey }
      );
      console.log(`SBT minted → ${user.walletAddress}`);
    } catch (e) {
      console.error(`SBT mint failed for ${user.walletAddress}:`, e.message);
    }
  }
}

module.exports = { handleCheckin, scheduleMonthlyMint, mintMythicMilestoneSBT };
