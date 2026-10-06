const cron = require('node-cron');
const { getDb } = require('./firebase');
const { sendPush } = require('./fcm');
const { mintDailyCheckinCNFT, getTier } = require('./bubblegumService');
// Every mpl-core reward goes through coreRewards: balance checked before the tx is built, an unaffordable
// one recorded as owed (owedRewards/<id>) and minted by the hourly retry once the payer covers it.
const { rewards, MYTHIC_MILESTONES } = require('./coreRewards');

// Same doc id (mythicSBTs/<wallet>_mythic_<day>) and record as before; returns { owed: true } instead of a
// failed transaction when the mint payer cannot cover the create.
async function mintMythicMilestoneSBT(walletAddress, streakDay) {
  if (!MYTHIC_MILESTONES[streakDay]) return null;
  return rewards().mintReward({ type: 'mythic', walletAddress, milestone: streakDay });
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

  // mintedMonths update and the push happen inside coreRewards once the mint lands (now, or from the owed
  // queue later). The old createV1 + pluginAuthorityPair call failed on every run with "Invalid data enum
  // variant ... got undefined" (2026-10-01, 3pxVa...); coreRewards builds the V2 plugin format instead.
  for (const doc of snap.docs) {
    const user = doc.data();
    if (user.mintedMonths?.includes(monthKey)) continue;
    try {
      await rewards().mintReward({ type: 'monthly', walletAddress: user.walletAddress, monthKey });
    } catch (e) {
      console.error(`SBT mint failed for ${user.walletAddress}:`, e.message);
    }
  }
}

module.exports = { handleCheckin, scheduleMonthlyMint, mintMythicMilestoneSBT };
