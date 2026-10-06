// GET /stats body: ONLY what the app reads. Until 2026-10-06 the route returned the whole checkins/<wallet>
// document, fcmToken included, to anyone who knew a wallet address.
//
// The field list comes from the app, not from this document: the one caller is HomeScreen.jsx (getStats in
// src/services/api.js), which reads streak, monthlyCheckins and totalCheckins and computes tier itself from
// streak. Cross-checked against the shipped release APK (Hermes bytecode string table): those three names
// are in it; currentMonth, mintedMonths, freezeActive and freezeExpiry are not, so the app cannot read them.
// Add a field here only when the app starts reading it.
'use strict';

const STATS_FIELDS = ['streak', 'monthlyCheckins', 'totalCheckins'];

function statsView(data) {
  const d = data || {};
  return Object.fromEntries(STATS_FIELDS.map(k => [k, Number.isFinite(d[k]) ? d[k] : 0]));
}

module.exports = { statsView, STATS_FIELDS };
