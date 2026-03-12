export const nowIso = () => new Date().toISOString();

export const toNum = (val, fallback = 0) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
};

export const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

export const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '');

export function jsonResponse(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

export function badRequest(res, message) {
  return jsonResponse(res, 400, { error: message });
}

export async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}
