const q = (id) => document.getElementById(id);
let products = [];
let invoiceLines = [];

const apiKey = () => q('apiKey').value.trim();

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (path.startsWith('/api/') && !['/api/health', '/api/ready', '/api/metrics'].includes(path)) headers['X-API-Key'] = apiKey();
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `failed ${res.status}`);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

function totals() {
  const subtotal = invoiceLines.reduce((s, l) => s + l.qty * l.price, 0);
  const discount = Number(q('discount').value || 0);
  const tax = Number((Math.max(0, subtotal - discount) * 0.18).toFixed(2));
  const total = Number((Math.max(0, subtotal - discount) + tax).toFixed(2));
  q('totals').textContent = `Subtotal: ${subtotal.toFixed(2)} | Tax: ${tax.toFixed(2)} | Total: ${total.toFixed(2)}`;
}

function renderLines() {
  q('invoiceLines').innerHTML = invoiceLines.map((l, i) => `<tr><td>${l.name}</td><td>${l.qty}</td><td>${l.price}</td><td>${(l.qty*l.price).toFixed(2)}</td><td><button data-i="${i}" class="rm">x</button></td></tr>`).join('');
  document.querySelectorAll('.rm').forEach((b) => b.onclick = () => { invoiceLines.splice(Number(b.dataset.i), 1); renderLines(); totals(); });
}

async function loadProducts() {
  const search = q('productSearch').value.trim();
  products = await api(`/api/products${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const options = products.map((p) => `<option value="${p.id}">${p.name} | ₹${p.price} | stock:${p.stockQty}</option>`).join('');
  q('productSelect').innerHTML = options;
  q('adjustProduct').innerHTML = options;
}

async function loadRepairs() {
  const repairs = await api('/api/repairs');
  q('repairs').innerHTML = repairs.slice(-8).reverse().map((r) => `<li>${r.device} (${r.status}) ₹${r.total} <button data-id="${r.id}" class="job">JobCard</button> <button data-id="${r.id}" class="inv">Invoice</button></li>`).join('');
  document.querySelectorAll('.job').forEach((b) => b.onclick = async () => alert((await api(`/api/repairs/${b.dataset.id}/job-card`, { method: 'POST' })).relativePath));
  document.querySelectorAll('.inv').forEach((b) => b.onclick = async () => alert((await api('/api/repairs/create-invoice', { method: 'POST', body: JSON.stringify({ repairId: b.dataset.id }) })).number));
}

async function loadSettings() {
  const s = await api('/api/settings');
  q('shopName').value = s.shop?.name || '';
  q('invoicePrefix').value = s.billing?.invoicePrefix || '';
  q('taxRate').value = s.billing?.defaultTaxRate ?? 0.18;
  q('lowStockDefault').value = s.billing?.defaultLowStockThreshold ?? 5;
  q('settingsOut').textContent = JSON.stringify(s, null, 2);
}

q('loadSettings').onclick = () => loadSettings().catch((e) => q('settingsOut').textContent = e.message);
q('saveSettings').onclick = async () => {
  const payload = {
    shop: { name: q('shopName').value },
    billing: { invoicePrefix: q('invoicePrefix').value, defaultTaxRate: Number(q('taxRate').value || 0.18), defaultLowStockThreshold: Number(q('lowStockDefault').value || 5) }
  };
  q('settingsOut').textContent = JSON.stringify(await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) }), null, 2);
};

q('refreshProducts').onclick = loadProducts;
q('productSearch').oninput = () => loadProducts().catch(() => {});
q('discount').oninput = totals;
q('addLine').onclick = () => {
  const p = products.find((x) => x.id === q('productSelect').value);
  if (!p) return;
  invoiceLines.push({ productId: p.id, name: p.name, qty: Number(q('lineQty').value || 1), price: Number(p.price) });
  renderLines(); totals();
};

q('addProduct').onclick = async () => {
  await api('/api/products', { method: 'POST', body: JSON.stringify({ name: q('productName').value, barcode: q('barcode').value, price: Number(q('productPrice').value || 0), stockQty: Number(q('productStock').value || 0) }) });
  await loadProducts();
};

q('adjustStock').onclick = async () => {
  await api('/api/inventory/adjust', { method: 'POST', body: JSON.stringify({ productId: q('adjustProduct').value, delta: Number(q('adjustDelta').value || 0), reason: q('adjustReason').value }) });
  await loadProducts();
};

q('addRepair').onclick = async () => {
  await api('/api/repairs', { method: 'POST', body: JSON.stringify({ device: q('repairDevice').value, issue: q('repairIssue').value, serviceCost: Number(q('repairServiceCost').value || 0), parts: [] }) });
  await loadRepairs();
};

q('createInvoice').onclick = async () => {
  const raw = q('payments').value.trim();
  let paymentMethods;
  try { paymentMethods = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map((x) => x.trim()).filter(Boolean); } catch { paymentMethods = ['cash']; }
  const out = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ customer: { name: q('customerName').value, phone: q('customerPhone').value }, lines: invoiceLines.map((l) => ({ productId: l.productId, qty: l.qty })), discount: Number(q('discount').value || 0), paymentMethods }) });
  q('invoiceResult').textContent = JSON.stringify(out, null, 2);
  invoiceLines = []; renderLines(); totals(); await loadProducts();
};

q('refreshDashboard').onclick = async () => q('dashboard').textContent = JSON.stringify(await api('/api/dashboard'), null, 2);
q('salesReport').onclick = async () => {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  q('reportOut').textContent = JSON.stringify(await api(`/api/reports/sales?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`), null, 2);
};

window.addEventListener('load', async () => {
  await Promise.all([loadProducts(), loadRepairs(), loadSettings()]);
  totals();
});
