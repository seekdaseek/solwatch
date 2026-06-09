const { getMessaging } = require('./firebase');

async function sendPush(fcmToken, title, body, data = {}) {
  const message = {
    token: fcmToken,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'solwatch_alerts' },
    },
  };
  try {
    const response = await getMessaging().send(message);
    console.log(`Push sent: ${title} → ${fcmToken.slice(0, 16)}...`);
    return response;
  } catch (e) {
    if (
      e.code === 'messaging/registration-token-not-registered' ||
      e.code === 'messaging/invalid-registration-token'
    ) {
      console.warn(`Stale FCM token: ${fcmToken.slice(0, 16)}...`);
      return null;
    }
    throw e;
  }
}

module.exports = { sendPush };
