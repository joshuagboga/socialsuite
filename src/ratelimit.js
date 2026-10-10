// Small in-memory rate limiter (fixed window). Good for a single server process, which is how
// SocialSuite runs. If you ever run several instances, move these counters to Redis.

const limiters = new Set();

export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  const entry = (key, now = Date.now()) => {
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    return e;
  };
  const limiter = {
    max,
    windowMs,
    /** Record one use. */
    hit(key) { entry(key).count++; },
    /** { allowed, remaining, retryAfter (seconds) } without recording anything. */
    check(key) {
      const e = entry(key);
      return {
        allowed: e.count < max,
        remaining: Math.max(0, max - e.count),
        retryAfter: Math.ceil((e.resetAt - Date.now()) / 1000),
      };
    },
    reset(key) { hits.delete(key); },
    sweep(now = Date.now()) { for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k); },
  };
  limiters.add(limiter);
  return limiter;
}

// Forget expired windows so the maps do not grow forever.
setInterval(() => limiters.forEach((l) => l.sweep()), 60_000).unref();

export function tooMany(res, retryAfter, message = "Too many requests. Please wait and try again.") {
  res.set("Retry-After", String(Math.max(1, retryAfter)));
  return res.status(429).json({ error: message, retryAfter });
}

/** Express middleware: count every request against `key(req)`. */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message }) {
  const limiter = createLimiter({ windowMs, max });
  return (req, res, next) => {
    const k = key(req);
    const { allowed, retryAfter } = limiter.check(k);
    if (!allowed) return tooMany(res, retryAfter, message);
    limiter.hit(k);
    next();
  };
}
