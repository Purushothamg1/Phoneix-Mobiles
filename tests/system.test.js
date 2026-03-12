import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3210;
let proc;

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}

async function jfetch(path, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
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

test('invoice flow updates stock and returns whatsapp/pdf links', async () => {
  const p = await jfetch('/api/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Battery', barcode: 'BAT001', price: 900, stockQty: 10 })
  });
  assert.equal(p.status, 201);

  const i = await jfetch('/api/invoices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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

test('prevents overselling stock', async () => {
  const p = await jfetch('/api/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cable', price: 100, stockQty: 1 })
  });
  const fail = await jfetch('/api/invoices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: [{ productId: p.data.id, qty: 5 }] })
  });
  assert.equal(fail.status, 500);
  assert.match(fail.data.error, /Insufficient stock/);
});

test('repair job card + repair invoice + customer history', async () => {
  const c = await jfetch('/api/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ravi', phone: '9999911111' })
  });

  const repair = await jfetch('/api/repairs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device: 'iPhone 12', issue: 'No display', customerId: c.data.id,
      serviceCost: 500, parts: [{ name: 'Display', cost: 3500 }]
    })
  });
  assert.equal(repair.status, 201);

  const card = await jfetch(`/api/repairs/${repair.data.id}/job-card`, { method: 'POST' });
  assert.equal(card.status, 201);
  assert.ok(card.data.relativePath.includes('/jobcards/'));

  const inv = await jfetch('/api/repairs/create-invoice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repairId: repair.data.id })
  });
  assert.equal(inv.status, 201);

  const history = await jfetch(`/api/customers/${c.data.id}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.data.repairCount, 1);
  assert.equal(history.data.invoiceCount >= 1, true);
});
