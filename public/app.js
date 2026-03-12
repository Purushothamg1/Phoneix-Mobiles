const q = (id) => document.getElementById(id);
let products = [];
let invoiceLines = [];

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Request failed: ${res.status}`);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

function enqueueOffline(action) {
  const queue = JSON.parse(localStorage.getItem('syncQueue') || '[]');
  queue.push({ ...action, queuedAt: new Date().toISOString() });
  localStorage.setItem('syncQueue', JSON.stringify(queue));
}

function calcTotals() {
  const subtotal = invoiceLines.reduce((s, l) => s + l.qty * l.price, 0);
  const discount = Number(q('discount').value || 0);
  const taxable = Math.max(0, subtotal - discount);
  const tax = Number((taxable * 0.18).toFixed(2));
  const total = Number((taxable + tax).toFixed(2));
  q('totals').textContent = `Subtotal: ${subtotal.toFixed(2)} | Tax: ${tax.toFixed(2)} | Total: ${total.toFixed(2)}`;
}

function renderInvoiceLines() {
  q('invoiceLines').innerHTML = invoiceLines.map((line, i) => `
    <tr>
      <td>${line.name}</td>
      <td>${line.qty}</td>
      <td>${line.price}</td>
      <td>${(line.qty * line.price).toFixed(2)}</td>
      <td><button data-i="${i}" class="rm">x</button></td>
    </tr>`).join('');
  document.querySelectorAll('.rm').forEach((btn) => {
    btn.onclick = () => {
      invoiceLines.splice(Number(btn.dataset.i), 1);
      renderInvoiceLines();
      calcTotals();
    };
  });
}

async function loadProducts() {
  const search = q('productSearch').value.trim();
  products = await api(`/api/products${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  q('productSelect').innerHTML = products.map((p) => `<option value="${p.id}">${p.name} | ₹${p.price} | stock:${p.stockQty}</option>`).join('');
}

async function loadRepairs() {
  const repairs = await api('/api/repairs');
  q('repairs').innerHTML = repairs.slice(-8).reverse().map((r) => `
    <li>${r.device} (${r.status}) - ₹${r.total}
      <button data-id="${r.id}" class="job">Job Card</button>
      <button data-id="${r.id}" class="inv">Invoice</button>
    </li>`).join('');

  document.querySelectorAll('.job').forEach((btn) => {
    btn.onclick = async () => {
      const data = await api(`/api/repairs/${btn.dataset.id}/job-card`, { method: 'POST' });
      alert(`Job card generated: ${data.relativePath}`);
    };
  });

  document.querySelectorAll('.inv').forEach((btn) => {
    btn.onclick = async () => {
      const invoice = await api('/api/repairs/create-invoice', { method: 'POST', body: JSON.stringify({ repairId: btn.dataset.id }) });
      alert(`Repair invoice created: ${invoice.id}`);
    };
  });
}

q('refreshProducts').onclick = loadProducts;
q('productSearch').oninput = () => loadProducts().catch(() => {});
q('discount').oninput = calcTotals;

q('addLine').onclick = () => {
  const selected = products.find((p) => p.id === q('productSelect').value);
  if (!selected) return;
  const qty = Number(q('lineQty').value || 1);
  invoiceLines.push({ productId: selected.id, name: selected.name, qty, price: Number(selected.price) });
  renderInvoiceLines();
  calcTotals();
};

q('addProduct').onclick = async () => {
  const payload = {
    name: q('productName').value,
    barcode: q('barcode').value,
    price: Number(q('productPrice').value || 0),
    stockQty: Number(q('productStock').value || 0)
  };
  try {
    await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    enqueueOffline({ entity: 'products', operation: 'upsert', record: payload });
  }
  await loadProducts();
};

q('addRepair').onclick = async () => {
  const payload = {
    device: q('repairDevice').value,
    issue: q('repairIssue').value,
    serviceCost: Number(q('repairServiceCost').value || 0),
    parts: []
  };
  try {
    await api('/api/repairs', { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    enqueueOffline({ entity: 'repairs', operation: 'upsert', record: payload });
  }
  await loadRepairs();
};

q('createInvoice').onclick = async () => {
  let paymentMethods;
  const raw = q('payments').value.trim();
  try {
    paymentMethods = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map((x) => x.trim()).filter(Boolean);
  } catch {
    paymentMethods = ['cash'];
  }

  const payload = {
    customer: { name: q('customerName').value, phone: q('customerPhone').value },
    lines: invoiceLines.map((l) => ({ productId: l.productId, qty: l.qty })),
    discount: Number(q('discount').value || 0),
    paymentMethods
  };

  try {
    const invoice = await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
    q('invoiceResult').textContent = JSON.stringify(invoice, null, 2);
    invoiceLines = [];
    renderInvoiceLines();
    calcTotals();
    await loadProducts();
  } catch (e) {
    enqueueOffline({ entity: 'invoices', operation: 'upsert', record: payload });
    q('invoiceResult').textContent = `Offline queued or failed: ${e.message}`;
  }
};

q('refreshDashboard').onclick = async () => {
  q('dashboard').textContent = JSON.stringify(await api('/api/dashboard'), null, 2);
};

q('flushSync').onclick = async () => {
  const events = JSON.parse(localStorage.getItem('syncQueue') || '[]');
  if (!events.length) return (q('syncLog').textContent = 'No pending events');
  try {
    const out = await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ events }) });
    localStorage.setItem('syncQueue', '[]');
    q('syncLog').textContent = JSON.stringify(out, null, 2);
  } catch (e) {
    q('syncLog').textContent = `Sync failed: ${e.message}`;
  }
};

window.addEventListener('load', async () => {
  q('syncState').textContent = navigator.onLine ? 'online' : 'offline-ready';
  await Promise.all([loadProducts(), loadRepairs()]);
  calcTotals();
});
