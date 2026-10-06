// GET /stats body: only the fields the app reads; the stored fcmToken never leaves the server.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { statsView, STATS_FIELDS } = require('../src/statsView');

test('a stored checkins doc is reduced to streak, monthlyCheckins, totalCheckins', () => {
  const doc = { walletAddress: 'BTuCQ', fcmToken: 'cxoz6OugRSCz:APA91b-secret', streak: 3, monthlyCheckins: 4, totalCheckins: 31,
    lastCheckin: '2026-10-05', currentMonth: 9, mintedMonths: [], freezeActive: false };
  const v = statsView(doc);
  assert.deepStrictEqual(v, { streak: 3, monthlyCheckins: 4, totalCheckins: 31 });
  assert.ok(!JSON.stringify(v).includes('APA91b'), 'no fcmToken, in any form');
  assert.deepStrictEqual(STATS_FIELDS, ['streak', 'monthlyCheckins', 'totalCheckins']);
});

test('no doc / missing numbers read as 0, the shape HomeScreen already handles', () => {
  assert.deepStrictEqual(statsView(null), { streak: 0, monthlyCheckins: 0, totalCheckins: 0 });
  assert.deepStrictEqual(statsView({ streak: 5 }), { streak: 5, monthlyCheckins: 0, totalCheckins: 0 });
});
