export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v));
}
export const ipOf = req => String(req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
export const body = req => typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
