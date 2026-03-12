import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3210;
let proc;

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}

test.before(async () => {
  proc = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT) } });
  await waitForServer();
});

test.after(() => {
  proc.kill('SIGTERM');
});

test('product + invoice flow updates stock and returns whatsapp/pdf links', async () => {
  const pRes = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Screen Guard', price: 100, stockQty: 20 })
  });
  assert.equal(pRes.status, 201);
  const product = await pRes.json();

  const iRes = await fetch(`http://127.0.0.1:${PORT}/api/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Asha', phone: '9876543210' },
      lines: [{ productId: product.id, qty: 2 }],
      discount: 10,
      paymentMethods: ['cash', 'upi']
    })
  });
  assert.equal(iRes.status, 201);
  const invoice = await iRes.json();
  assert.ok(invoice.pdfPath.includes('/invoices/'));
  assert.ok(invoice.whatsappShare.includes('wa.me'));

  const products = await (await fetch(`http://127.0.0.1:${PORT}/api/products`)).json();
  const updated = products.find((x) => x.id === product.id);
  assert.equal(updated.stockQty, 18);
});
