const crypto = require('crypto');

const SITE_GATE_COOKIE = 'lfm_site_access';
const SITE_GATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest();
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left || ''));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSiteGate(accessKeyValue) {
  const accessKey = String(accessKeyValue || '');
  const configured = accessKey.length >= 8;
  const expectedKeyHash = configured ? digest(accessKey) : null;
  const accessToken = configured
    ? crypto.createHmac('sha256', accessKey).update('legend-football-manager-site-gate-v1').digest('base64url')
    : '';
  const failures = new Map();

  function retryAfterSeconds(identifier) {
    const key = String(identifier || 'unknown');
    const record = failures.get(key);
    if (!record) return 0;
    if (record.blockedUntil > Date.now()) return Math.ceil((record.blockedUntil - Date.now()) / 1000);
    if (Date.now() - record.windowStartedAt >= FAILURE_WINDOW_MS) failures.delete(key);
    return 0;
  }

  return {
    configured,
    retryAfterSeconds,
    verifyAccessKey(candidate, identifier) {
      const key = String(identifier || 'unknown');
      if (!configured || retryAfterSeconds(key)) return false;
      if (safeEqual(expectedKeyHash, digest(candidate))) {
        failures.delete(key);
        return true;
      }
      const now = Date.now();
      const previous = failures.get(key);
      const record = previous && now - previous.windowStartedAt < FAILURE_WINDOW_MS
        ? previous
        : {count: 0, windowStartedAt: now, blockedUntil: 0};
      record.count++;
      if (record.count >= MAX_FAILURES) record.blockedUntil = now + FAILURE_WINDOW_MS;
      failures.set(key, record);
      return false;
    },
    verifyToken(candidate) {
      return configured && safeEqual(accessToken, String(candidate || ''));
    },
    accessToken
  };
}

module.exports = {SITE_GATE_COOKIE, SITE_GATE_MAX_AGE_MS, createSiteGate};
