import { API_KEYS } from './config.js';
import { jsonResponse } from './utils.js';

const roleByKey = Object.entries(API_KEYS).reduce((acc, [role, key]) => {
  acc[key] = role;
  return acc;
}, {});

export function authorize(req, res, allowedRoles = []) {
  const key = req.headers['x-api-key'];
  const role = roleByKey[key];
  if (!role) {
    jsonResponse(res, 401, { error: 'Missing or invalid API key' });
    return null;
  }
  if (allowedRoles.length && !allowedRoles.includes(role)) {
    jsonResponse(res, 403, { error: 'Forbidden for role', role });
    return null;
  }
  return role;
}
