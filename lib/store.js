/* Storage: Upstash Redis provisioned through the Vercel Marketplace.
   ROSH_MEMORY=1 is only for the local test server; production never sets it. */
import { Redis } from '@upstash/redis';
let client = null;
export function redis() {
  if (client) return client;
  if (process.env.ROSH_MEMORY === '1') return (client = memory());
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw Error('Storage is not connected yet.');
  return (client = new Redis({ url, token, automaticDeserialization: false }));
}
export async function withLocks(keys, fn) {
  const R = redis(), tok = Math.random().toString(36).slice(2), held = [];
  try {
    for (const k of keys) {
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        if (await R.set('rp:lock:' + k, tok, { nx: true, px: 5000 })) ok = true;
        else await new Promise(r => setTimeout(r, 80));
      }
      if (!ok) throw Error('Roshpad is busy, try again.');
      held.push(k);
    }
    return await fn();
  } finally {
    for (const k of held) { try { if ((await R.get('rp:lock:' + k)) === tok) await R.del('rp:lock:' + k); } catch {} }
  }
}
function memory() {
  const m = new Map(), exp = new Map();
  const alive = k => { const e = exp.get(k); if (e && e < Date.now()) { m.delete(k); exp.delete(k); } return m.has(k); };
  const list = k => alive(k) ? JSON.parse(m.get(k)) : [];
  return {
    async get(k) { return alive(k) ? m.get(k) : null; },
    async set(k, v, o = {}) { if (o.nx && alive(k)) return null; m.set(k, String(v)); if (o.px) exp.set(k, Date.now() + o.px); else if (o.ex) exp.set(k, Date.now() + o.ex * 1000); else exp.delete(k); return 'OK'; },
    async del(k) { m.delete(k); exp.delete(k); return 1; },
    async incr(k) { const v = (alive(k) ? Number(m.get(k)) : 0) + 1; m.set(k, String(v)); return v; },
    async expire(k, s) { exp.set(k, Date.now() + s * 1000); return 1; },
    async lpush(k, ...v) { const a = list(k); a.unshift(...v.reverse()); m.set(k, JSON.stringify(a)); return a.length; },
    async ltrim(k, s, e) { const a = list(k); m.set(k, JSON.stringify(a.slice(s, e + 1))); return 'OK'; },
    async lrange(k, s, e) { const a = list(k); return a.slice(s, e < 0 ? a.length + e + 1 : e + 1); },
    async llen(k) { return list(k).length; },
    async mget(...ks) { return ks.flat().map(k => alive(k) ? m.get(k) : null); }
  };
}
