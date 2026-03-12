import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3210;
const API_KEY = 'admin-key';
let proc;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}

async function jfetch(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (path.startsWith('/api/') && !['/api/health', '/api/ready', '/api/metrics'].includes(path)) {
    headers['X-API-Key'] = API_KEY;
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: res.status, data };
}

test.before(async () => {
  proc = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT) } });
  await waitForServer();
});

test.after(() => proc.kill('SIGTERM'));

test('ops endpoints: ready, metrics, backup', async () => {
  const ready = await jfetch('/api/ready');
  assert.equal(ready.status, 200);

  const metrics = await jfetch('/api/metrics');
  assert.equal(metrics.status, 200);
  assert.ok(typeof metrics.data.products === 'number');

  const backup = await jfetch('/api/admin/backup');
  assert.equal(backup.status, 200);
  assert.ok(backup.data.fileName.includes('backup-'));
});

test('invoice flow updates stock and returns whatsapp/pdf links', async () => {
  const p = await jfetch('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: `Battery-${Date.now()}`, barcode: 'BAT001', price: 900, stockQty: 10 })
  });
  assert.equal(p.status, 201);

  const i = await jfetch('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      customer: { name: 'Asha', phone: '9876543210' },
      lines: [{ productId: p.data.id, qty: 2 }],
      discount: 100,
      paymentMethods: [{ method: 'cash', amount: 2006 }]
    })
  });
  assert.equal(i.status, 201);
  assert.ok(i.data.pdfPath.includes('/invoices/'));
  assert.ok(i.data.whatsappShare.includes('wa.me'));

  const products = await jfetch('/api/products');
  const updated = products.data.find((x) => x.id === p.data.id);
  assert.equal(updated.stockQty, 8);
});

test('sync handles duplicate clientOpId + detects older timestamp conflict', async () => {
  const product = await jfetch('/api/products', {
    method: 'POST', body: JSON.stringify({ name: `SyncTest-${Date.now()}`, price: 50, stockQty: 5 })
  });
  const base = product.data;

  const push = await jfetch('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      events: [
        { clientOpId: 'abc', entity: 'products', operation: 'upsert', record: { ...base, stockQty: 4, updatedAt: '2099-01-01T00:00:00.000Z' } },
        { clientOpId: 'abc', entity: 'products', operation: 'upsert', record: { ...base, stockQty: 3, updatedAt: '2099-01-01T00:00:00.000Z' } },
        { clientOpId: 'old', entity: 'products', operation: 'upsert', record: { ...base, stockQty: 1, updatedAt: '2000-01-01T00:00:00.000Z' } }
      ]
    })
  });

  assert.equal(push.status, 202);
  assert.equal(push.data.applied.length >= 1, true);
  assert.equal(push.data.conflicts.length >= 1, true);
});

test('repair job card + repair invoice + customer history + audit log', async () => {
  const c = await jfetch('/api/customers', { method: 'POST', body: JSON.stringify({ name: `Ravi-${Date.now()}`, phone: '9999911111' }) });
  const repair = await jfetch('/api/repairs', {
    method: 'POST',
    body: JSON.stringify({ device: 'iPhone 12', issue: 'No display', customerId: c.data.id, serviceCost: 500, parts: [{ name: 'Display', cost: 3500 }] })
  });
  assert.equal(repair.status, 201);

  const card = await jfetch(`/api/repairs/${repair.data.id}/job-card`, { method: 'POST' });
  assert.equal(card.status, 201);

  const inv = await jfetch('/api/repairs/create-invoice', { method: 'POST', body: JSON.stringify({ repairId: repair.data.id }) });
  assert.equal(inv.status, 201);

  const history = await jfetch(`/api/customers/${c.data.id}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.data.repairCount, 1);

  const audits = await jfetch('/api/audit-logs');
  assert.equal(audits.status, 200);
  assert.equal(Array.isArray(audits.data), true);
});
