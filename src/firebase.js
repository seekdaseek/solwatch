const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const serviceAccount = require('../firebase-service-account.json');

let db;
let messaging;

async function initFirebase() {
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  messaging = getMessaging();
  console.log('Firebase initialized');
}

function getDb() { return db; }
function getMessaging2() { return messaging; }

module.exports = { initFirebase, getDb, getMessaging: getMessaging2 };
