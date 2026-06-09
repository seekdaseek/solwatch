const cron = require('node-cron');
const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { mplCore, createV1, pluginAuthorityPair } = require('@metaplex-foundation/mpl-core');
const { generateSigner, keypairIdentity, publicKey } = require('@metaplex-foundation/umi');
const { fromWeb3JsKeypair } = require('@metaplex-foundation/umi-web3js-adapters');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { mintDailyCheckinCNFT, getTier } = require('./bubblegumService');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const RPC_ENDPOINT = process.env.HELIUS_RPC_URL;

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

  data.streak = data.lastCheckin === yesterdayStr ? data.streak + 1 : 1;
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
          authority: { type: 'UpdateAuthority' },
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

module.exports = { handleCheckin, scheduleMonthlyMint };
