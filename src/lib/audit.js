import { randomUUID } from 'node:crypto';
import { nowIso } from './utils.js';

export function addAudit(db, { actor = 'system', action, entity, entityId, payload }) {
  db.auditLogs.push({
    id: randomUUID(),
    actor,
    action,
    entity,
    entityId,
    payload,
    at: nowIso()
  });
}
