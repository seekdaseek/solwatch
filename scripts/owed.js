// Operator tool for Firestore owedRewards (src/coreRewards.js). Run from /opt/solwatch-backend.
//   node scripts/owed.js list                 every owed reward, oldest first, with status and reason
//   node scripts/owed.js add '<json>'         record a reward that ALREADY failed on chain as owed, e.g.
//     '{"type":"crown","walletAddress":"3px…","rank":1,"week":"2026-10-05","createdAt":"2026-10-05T09:00:00Z",
//       "reason":"…","attribution":"…"}'   walletAddress null = wallet unknown: listed, never minted.
// Reads/writes Firestore only. Never builds, signs or sends a transaction.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { initFirebase, getDb } = require('../src/firebase');
const { makeRewards } = require('../src/coreRewards');

const fmt = v => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v);

(async () => {
  await initFirebase();
  const db = getDb();
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'add') {
    const item = JSON.parse(arg);
    if (item.createdAt) item.createdAt = new Date(item.createdAt);
    const r = makeRewards({ getDb, log: console });
    const res = await r.recordOwed(item, { reason: item.reason, need: item.needLamports, balance: item.balanceLamports });
    console.log(res.existed ? `exists already: owedRewards/${res.id} (unchanged)` : `recorded owedRewards/${res.id}`);
  } else if (cmd === 'list' || !cmd) {
    const snap = await db.collection('owedRewards').get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(fmt(a.createdAt)) - new Date(fmt(b.createdAt)));
    console.log(`owedRewards: ${rows.length}`);
    for (const o of rows) {
      console.log(`${fmt(o.createdAt)}  ${o.status.padEnd(7)} ${o.id}`);
      console.log(`    ${o.type}${o.milestone ? ` day ${o.milestone}` : ''}${o.rank ? ` rank ${o.rank} (${o.rankName}) week ${o.week}` : ''}${o.monthKey ? ` ${o.monthKey}` : ''} -> ${o.walletAddress || 'UNKNOWN WALLET'}`);
      console.log(`    reason: ${o.reason}`);
      if (o.attribution) console.log(`    wallet from: ${o.attribution}`);
      if (o.assetAddress) console.log(`    minted: ${fmt(o.mintedAt)} asset ${o.assetAddress}`);
      if (o.lastError) console.log(`    last error (${o.attempts}): ${o.lastError}`);
    }
  } else {
    console.log('usage: node scripts/owed.js list | add <json>');
    process.exitCode = 2;
  }
  process.exit();
})().catch(e => { console.error('owed.js:', e.message); process.exit(1); });
