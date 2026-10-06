// Retry a send ONLY when the failure proves the transaction cannot have landed:
//   "Blockhash not found"   - preflight simulation refused it (2026-10-05: BTuCQ... streak 3 and VCkQ... streak
//                             4 lost their daily cNFT this way); the tx never reached the cluster.
//   block height exceeded / expired blockhash - it can never land now.
// Anything else - above all a confirmation timeout - may still land, and retrying it could mint twice, so it
// is thrown at once. Each attempt must build a NEW umi builder: a builder without a blockhash fetches the
// latest one when it is sent (umi TransactionBuilder.buildWithLatestBlockhash), which is the fresh blockhash.
'use strict';

const RETRYABLE = /blockhash not found|block ?height ?exceeded|blockhash[^\n]*expired|expired[^\n]*blockhash/i;
const firstLine = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2).join(' ');

async function withBlockhashRetry(label, attemptFn, { retries = 2, delayMs = 1500, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptFn(attempt);
    } catch (e) {
      if (attempt >= retries || !RETRYABLE.test(String(e && e.message))) throw e;
      // stdout: a retry is not a failure. Only the final one reaches stderr, through the caller.
      log.log(`${label}: ${firstLine(e.message)} - fresh blockhash, retry ${attempt + 1}/${retries}`);
      await sleep(delayMs);
    }
  }
}

module.exports = { withBlockhashRetry, RETRYABLE };
