/* Serves logos stored by api/meta */
import { redis } from '../lib/store.js';

export default async function handler(req, res) {
  try {
    const id = String((req.query || {}).id || '');
    const s = /^[a-z0-9]{10}$/.test(id) ? await redis().get('rp:img:' + id) : null;
    const m = s && s.match(/^data:(image\/(?:webp|png|jpeg));base64,(.+)$/);
    if (!m) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', m[1]);
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    res.setHeader('access-control-allow-origin', '*');
    res.end(Buffer.from(m[2], 'base64'));
  } catch { res.statusCode = 500; res.end(); }
}
