const q = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? {} : res.json();
}

function enqueueOffline(action) {
  const queue = JSON.parse(localStorage.getItem('syncQueue') || '[]');
  queue.push({ ...action, queuedAt: new Date().toISOString() });
  localStorage.setItem('syncQueue', JSON.stringify(queue));
}

async function flushQueue() {
  const queue = JSON.parse(localStorage.getItem('syncQueue') || '[]');
  if (!queue.length) return 'No pending actions';
  await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ events: queue }) });
  localStorage.setItem('syncQueue', '[]');
  return `Pushed ${queue.length} action(s)`;
}

async function loadProducts() {
  const products = await api('/api/products');
  q('products').innerHTML = products.map((p) => `<li>${p.name} | ₹${p.price} | Stock: ${p.stockQty}</li>`).join('');
}

async function loadRepairs() {
  const repairs = await api('/api/repairs');
  q('repairs').innerHTML = repairs.map((r) => `<li>${r.device} - ${r.status} - ₹${r.total}
  <button data-id="${r.id}" class="inv">Invoice</button></li>`).join('');
  document.querySelectorAll('.inv').forEach((btn) => {
    btn.onclick = async () => {
      const invoice = await api('/api/repairs/create-invoice', { method: 'POST', body: JSON.stringify({ repairId: btn.dataset.id }) });
      alert(`Repair invoice created: ${invoice.id}`);
    };
  });
}

q('addProduct').onclick = async () => {
  const payload = {
    name: q('productName').value,
    price: Number(q('productPrice').value),
    stockQty: Number(q('productStock').value)
  };
  try {
    await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    enqueueOffline({ type: 'product-create', payload });
  }
  await loadProducts();
};

q('addRepair').onclick = async () => {
  const payload = {
    device: q('repairDevice').value,
    issue: q('repairIssue').value,
    customerId: q('repairCustomerId').value || null,
    serviceCost: Number(q('repairServiceCost').value),
    parts: []
  };
  try {
    await api('/api/repairs', { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    enqueueOffline({ type: 'repair-create', payload });
  }
  await loadRepairs();
};

q('createInvoice').onclick = async () => {
  const payload = {
    customer: { name: q('customerName').value, phone: q('customerPhone').value },
    lines: JSON.parse(q('invoiceLines').value || '[]'),
    discount: Number(q('discount').value),
    paymentMethods: q('payments').value.split(',').map((x) => x.trim())
  };
  try {
    const invoice = await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
    q('invoiceResult').textContent = JSON.stringify(invoice, null, 2);
  } catch {
    enqueueOffline({ type: 'invoice-create', payload });
    q('invoiceResult').textContent = 'Offline: invoice queued for sync.';
  }
};

q('refreshDashboard').onclick = async () => {
  const data = await api('/api/dashboard');
  q('dashboard').textContent = JSON.stringify(data, null, 2);
};

q('flushSync').onclick = async () => {
  try {
    q('syncLog').textContent = await flushQueue();
  } catch (e) {
    q('syncLog').textContent = `Sync failed: ${e.message}`;
  }
};

window.addEventListener('load', async () => {
  q('syncStatus').textContent = navigator.onLine ? 'online' : 'offline-ready';
  await Promise.all([loadProducts(), loadRepairs()]);
});
