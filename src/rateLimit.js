// Fixed-window request limit per client IP, in memory (one process; a restart forgets, which is fine for an
// anti-spam limit). Used on POST /genesis/mint, where each accepted request can hold a connection for up to a
// minute while the payment finalizes.
//
// req.ip is only the real client because server.js sets trust proxy 'loopback' AND nginx sends
// X-Forwarded-For (/etc/nginx/sites-available/solwatch, location /, since 2026-10-06). Express then takes the
// rightmost address nginx appended, so a client cannot pick its own key by sending the header itself.
'use strict';

function makeRateLimiter({ windowMs, max, now = () => Date.now(), maxKeys = 10000 }) {
  const hits = new Map();   // ip -> { start, n }
  function check(key) {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      if (hits.size >= maxKeys) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      h = { start: t, n: 0 };
      hits.set(key, h);
    }
    h.n++;
    return h.n <= max ? { ok: true, remaining: max - h.n } : { ok: false, retryAfterSec: Math.ceil((h.start + windowMs - t) / 1000) };
  }
  function middleware(req, res, next) {
    const r = check(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    return res.status(429).json({ error: `Too many requests from this address; retry in ${r.retryAfterSec}s.` });
  }
  return { check, middleware };
}

module.exports = { makeRateLimiter };
