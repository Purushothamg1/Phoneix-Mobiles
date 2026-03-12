import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3210;
const API_KEY = 'admin-key';
let proc;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
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
  if (path.startsWith('/api/') && !['/api/health', '/api/ready', '/api/metrics'].includes(path)) headers['X-API-Key'] = API_KEY;
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

test('settings module is readable and patchable', async () => {
  const get = await jfetch('/api/settings');
  assert.equal(get.status, 200);
  assert.ok(get.data.shop);

  const patch = await jfetch('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ billing: { invoicePrefix: 'PX', defaultTaxRate: 0.2, defaultLowStockThreshold: 3 } })
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.data.billing.invoicePrefix, 'PX');
});

test('inventory core: create product, adjust stock, list movements', async () => {
  const created = await jfetch('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: `Battery-${Date.now()}`, barcode: 'BAT001', price: 900, stockQty: 10 })
  });
  assert.equal(created.status, 201);

  const adj = await jfetch('/api/inventory/adjust', {
    method: 'POST',
    body: JSON.stringify({ productId: created.data.id, delta: 3, reason: 'manual count correction' })
  });
  assert.equal(adj.status, 200);
  assert.equal(adj.data.stockQty, 13);

  const movements = await jfetch('/api/stock-movements');
  assert.equal(movements.status, 200);
  assert.equal(movements.data.some((m) => m.type === 'adjustment'), true);
});

test('billing core: invoice, cancel and return', async () => {
  const p = await jfetch('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: `Cable-${Date.now()}`, price: 100, stockQty: 10 })
  });

  const invoice = await jfetch('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      customer: { name: 'Asha', phone: '9876543210' },
      lines: [{ productId: p.data.id, qty: 2 }],
      discount: 10,
      paymentMethods: ['cash']
    })
  });
  assert.equal(invoice.status, 201);
  assert.ok(invoice.data.number.startsWith('PX-') || invoice.data.number.startsWith('INV-'));
  assert.ok(invoice.data.pdfPath.includes('/invoices/'));

  const cancel = await jfetch(`/api/invoices/${invoice.data.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.status, 'cancelled');

  const invoice2 = await jfetch('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ lines: [{ productId: p.data.id, qty: 1 }], paymentMethods: ['cash'] })
  });
  const ret = await jfetch(`/api/invoices/${invoice2.data.id}/return`, {
    method: 'POST',
    body: JSON.stringify({ lines: [{ productId: p.data.id, qty: 1 }] })
  });
  assert.equal(ret.status, 201);
  assert.equal(ret.data.type, 'return');
});

test('repair + crm + reports + ops', async () => {
  const c = await jfetch('/api/customers', { method: 'POST', body: JSON.stringify({ name: `Ravi-${Date.now()}`, phone: '9999911111' }) });
  const repair = await jfetch('/api/repairs', {
    method: 'POST',
    body: JSON.stringify({ device: 'iPhone 12', issue: 'No display', customerId: c.data.id, serviceCost: 500, parts: [{ name: 'Display', cost: 3500 }] })
  });
  assert.equal(repair.status, 201);

  const update = await jfetch(`/api/repairs/${repair.data.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
  assert.equal(update.status, 200);

  const card = await jfetch(`/api/repairs/${repair.data.id}/job-card`, { method: 'POST' });
  assert.equal(card.status, 201);

  const inv = await jfetch('/api/repairs/create-invoice', { method: 'POST', body: JSON.stringify({ repairId: repair.data.id }) });
  assert.equal(inv.status, 201);

  const history = await jfetch(`/api/customers/${c.data.id}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.data.repairCount, 1);

  const report = await jfetch(`/api/reports/sales?from=${encodeURIComponent('1970-01-01T00:00:00.000Z')}&to=${encodeURIComponent(new Date().toISOString())}`);
  assert.equal(report.status, 200);
  assert.ok(typeof report.data.gross === 'number');

  const metrics = await jfetch('/api/metrics');
  assert.equal(metrics.status, 200);
  assert.ok(typeof metrics.data.invoices === 'number');

  const backup = await jfetch('/api/admin/backup');
  assert.equal(backup.status, 200);

  const audits = await jfetch('/api/audit-logs');
  assert.equal(audits.status, 200);
  assert.equal(Array.isArray(audits.data), true);
});
