import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, JOBCARD_DIR, PDF_DIR, PUBLIC_DIR, TAX_RATE } from '../lib/config.js';
import { loadDb, saveDb, updateEntity, createBackup, restoreBackup } from '../lib/db.js';
import { addAudit } from '../lib/audit.js';
import { authorize } from '../lib/auth.js';
import { badRequest, isNonEmptyString, jsonResponse, nowIso, parseBody, toNum, normalizePhone } from '../lib/utils.js';
import { calculateInvoice, createInvoicePdf, createJobCard, createRepairInvoicePdf, findOrCreateCustomer, normalizePayments } from '../lib/services.js';

function nextInvoiceNumber(db, prefix) {
  const count = db.invoices.filter((i) => i.number?.startsWith(prefix)).length + 1;
  return `${prefix}-${String(count).padStart(5, '0')}`;
}

function ensureRepairStatus(db, status) {
  return db.settings.repair.statuses.includes(status);
}

export async function handleRequest(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS') return jsonResponse(res, 204, {});

  if (pathname.startsWith('/invoices/')) {
    const file = path.join(PDF_DIR, path.basename(pathname));
    if (!fs.existsSync(file)) return jsonResponse(res, 404, { error: 'Invoice PDF not found' });
    return jsonResponse(res, 200, fs.readFileSync(file), 'application/pdf');
  }

  if (pathname.startsWith('/jobcards/')) {
    const file = path.join(JOBCARD_DIR, path.basename(pathname));
    if (!fs.existsSync(file)) return jsonResponse(res, 404, { error: 'Job card not found' });
    return jsonResponse(res, 200, fs.readFileSync(file), 'text/plain');
  }

  if (!pathname.startsWith('/api/')) {
    const target = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.join(PUBLIC_DIR, target);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return jsonResponse(res, 404, { error: 'Not found' });
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(full)] || 'application/octet-stream';
    return jsonResponse(res, 200, fs.readFileSync(full), type);
  }

  if (pathname === '/api/health' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, now: nowIso() });
  if (pathname === '/api/ready' && req.method === 'GET') {
    const healthy = fs.existsSync(path.dirname(BACKUP_DIR));
    return jsonResponse(res, healthy ? 200 : 503, { ready: healthy, now: nowIso() });
  }

  const db = loadDb();

  if (pathname === '/api/metrics' && req.method === 'GET') {
    return jsonResponse(res, 200, {
      products: db.products.length,
      customers: db.customers.length,
      repairs: db.repairs.length,
      invoices: db.invoices.length,
      auditLogs: db.auditLogs.length,
      syncEvents: db.syncEvents.length,
      returns: db.invoices.filter((i) => i.type === 'return').length
    });
  }

  try {
    if (pathname === '/api/settings' && req.method === 'GET') {
      const role = authorize(req, res, ['admin', 'cashier', 'technician']);
      if (!role) return;
      return jsonResponse(res, 200, db.settings);
    }

    if (pathname === '/api/settings' && req.method === 'PATCH') {
      const role = authorize(req, res, ['admin']);
      if (!role) return;
      const body = await parseBody(req);
      db.settings = { ...db.settings, ...body, updatedAt: nowIso(), version: Number(db.settings.version || 0) + 1 };
      addAudit(db, { actor: role, action: 'settings.update', entity: 'settings', entityId: 'global', payload: body });
      saveDb(db);
      return jsonResponse(res, 200, db.settings);
    }

    // admin operations
    if (pathname === '/api/admin/backup' && req.method === 'GET') {
      const role = authorize(req, res, ['admin']);
      if (!role) return;
      const out = createBackup(db);
      addAudit(db, { actor: role, action: 'backup.create', entity: 'system', entityId: out.fileName });
      saveDb(db);
      return jsonResponse(res, 200, out);
    }

    if (pathname === '/api/admin/restore' && req.method === 'POST') {
      const role = authorize(req, res, ['admin']);
      if (!role) return;
      const body = await parseBody(req);
      if (!body?.db) return badRequest(res, 'db payload is required');
      const restored = restoreBackup(body.db);
      addAudit(restored, { actor: role, action: 'backup.restore', entity: 'system', entityId: 'db' });
      saveDb(restored);
      return jsonResponse(res, 200, { restored: true });
    }

    if (pathname === '/api/audit-logs' && req.method === 'GET') {
      const role = authorize(req, res, ['admin']);
      if (!role) return;
      return jsonResponse(res, 200, db.auditLogs.slice(-300).reverse());
    }

    // products
    if (pathname === '/api/products' && req.method === 'GET') {
      const q = (searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return jsonResponse(res, 200, db.products);
      return jsonResponse(res, 200, db.products.filter((p) => p.name.toLowerCase().includes(q) || String(p.sku || '').toLowerCase().includes(q) || String(p.barcode || '').toLowerCase().includes(q)));
    }

    if (pathname === '/api/products' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']);
      if (!role) return;
      const body = await parseBody(req);
      if (!isNonEmptyString(body.name)) return badRequest(res, 'name is required');
      const product = {
        id: randomUUID(),
        name: body.name.trim(),
        sku: body.sku || '',
        barcode: body.barcode || '',
        category: body.category || 'general',
        costPrice: toNum(body.costPrice, 0),
        price: toNum(body.price, 0),
        stockQty: toNum(body.stockQty, 0),
        lowStockThreshold: toNum(body.lowStockThreshold, db.settings.billing.defaultLowStockThreshold || 5),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      db.products.push(product);
      addAudit(db, { actor: role, action: 'product.create', entity: 'products', entityId: product.id, payload: product });
      saveDb(db);
      return jsonResponse(res, 201, product);
    }

    if (pathname.startsWith('/api/products/') && req.method === 'PATCH') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const product = db.products.find((p) => p.id === id);
      if (!product) return jsonResponse(res, 404, { error: 'Not found' });
      const patch = { ...body };
      if (patch.price != null) patch.price = toNum(patch.price, product.price);
      if (patch.stockQty != null) patch.stockQty = toNum(patch.stockQty, product.stockQty);
      updateEntity(product, patch);
      addAudit(db, { actor: role, action: 'product.update', entity: 'products', entityId: product.id, payload: patch });
      saveDb(db);
      return jsonResponse(res, 200, product);
    }

    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      const role = authorize(req, res, ['admin']); if (!role) return;
      const id = pathname.split('/').pop();
      db.products = db.products.filter((p) => p.id !== id);
      addAudit(db, { actor: role, action: 'product.delete', entity: 'products', entityId: id });
      saveDb(db);
      return jsonResponse(res, 204, {});
    }

    if (pathname === '/api/inventory/adjust' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      const product = db.products.find((p) => p.id === body.productId);
      if (!product) return jsonResponse(res, 404, { error: 'Product not found' });
      const delta = toNum(body.delta, 0);
      if (!db.settings.inventory.allowNegativeStock && product.stockQty + delta < 0) return badRequest(res, 'Negative stock not allowed');
      product.stockQty += delta;
      updateEntity(product, {});
      db.stockMovements.push({ id: randomUUID(), productId: product.id, type: 'adjustment', qty: delta, reason: body.reason || '', createdAt: nowIso() });
      addAudit(db, { actor: role, action: 'inventory.adjust', entity: 'products', entityId: product.id, payload: { delta, reason: body.reason } });
      saveDb(db);
      return jsonResponse(res, 200, product);
    }

    // customers
    if (pathname === '/api/customers' && req.method === 'GET') return jsonResponse(res, 200, db.customers);
    if (pathname === '/api/customers' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      if (!isNonEmptyString(body.name)) return badRequest(res, 'name is required');
      const customer = { id: randomUUID(), name: body.name.trim(), phone: body.phone || '', email: body.email || '', createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
      db.customers.push(customer);
      addAudit(db, { actor: role, action: 'customer.create', entity: 'customers', entityId: customer.id });
      saveDb(db);
      return jsonResponse(res, 201, customer);
    }

    if (pathname.startsWith('/api/customers/') && req.method === 'PATCH') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const customer = db.customers.find((c) => c.id === id);
      if (!customer) return jsonResponse(res, 404, { error: 'Not found' });
      updateEntity(customer, body);
      addAudit(db, { actor: role, action: 'customer.update', entity: 'customers', entityId: id });
      saveDb(db);
      return jsonResponse(res, 200, customer);
    }

    if (pathname.startsWith('/api/customers/') && req.method === 'DELETE') {
      const role = authorize(req, res, ['admin']); if (!role) return;
      const id = pathname.split('/').pop();
      db.customers = db.customers.filter((c) => c.id !== id);
      addAudit(db, { actor: role, action: 'customer.delete', entity: 'customers', entityId: id });
      saveDb(db);
      return jsonResponse(res, 204, {});
    }

    if (pathname.match(/^\/api\/customers\/[^/]+\/history$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const invoices = db.invoices.filter((i) => i.customerId === id && i.type !== 'return');
      const returns = db.invoices.filter((i) => i.customerId === id && i.type === 'return');
      const repairs = db.repairs.filter((r) => r.customerId === id);
      return jsonResponse(res, 200, {
        invoices,
        returns,
        repairs,
        spend: Number(invoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2)),
        returnsAmount: Number(returns.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2)),
        invoiceCount: invoices.length,
        repairCount: repairs.length
      });
    }

    // repairs
    if (pathname === '/api/repairs' && req.method === 'GET') return jsonResponse(res, 200, db.repairs);
    if (pathname === '/api/repairs' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'technician', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      if (!isNonEmptyString(body.device) || !isNonEmptyString(body.issue)) return badRequest(res, 'device and issue are required');
      const status = body.status || db.settings.repair.defaultStatus;
      if (!ensureRepairStatus(db, status)) return badRequest(res, 'invalid repair status');
      const repair = { id: randomUUID(), device: body.device.trim(), issue: body.issue.trim(), customerId: body.customerId || null, status, parts: Array.isArray(body.parts) ? body.parts : [], serviceCost: toNum(body.serviceCost, 0), total: 0, notes: body.notes || '', createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
      repair.total = Number(((repair.parts || []).reduce((s, p) => s + toNum(p.cost, 0), 0) + repair.serviceCost).toFixed(2));
      db.repairs.push(repair);
      addAudit(db, { actor: role, action: 'repair.create', entity: 'repairs', entityId: repair.id });
      saveDb(db);
      return jsonResponse(res, 201, repair);
    }

    if (pathname.startsWith('/api/repairs/') && req.method === 'PATCH' && !pathname.endsWith('/job-card')) {
      const role = authorize(req, res, ['admin', 'technician', 'cashier']); if (!role) return;
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const repair = db.repairs.find((r) => r.id === id);
      if (!repair) return jsonResponse(res, 404, { error: 'Repair not found' });
      if (body.status && !ensureRepairStatus(db, body.status)) return badRequest(res, 'invalid repair status');
      updateEntity(repair, body);
      repair.total = Number((((repair.parts || []).reduce((s, p) => s + toNum(p.cost, 0), 0)) + toNum(repair.serviceCost, 0)).toFixed(2));
      addAudit(db, { actor: role, action: 'repair.update', entity: 'repairs', entityId: id });
      saveDb(db);
      return jsonResponse(res, 200, repair);
    }

    if (pathname.startsWith('/api/repairs/') && req.method === 'DELETE') {
      const role = authorize(req, res, ['admin']); if (!role) return;
      const id = pathname.split('/').pop();
      db.repairs = db.repairs.filter((r) => r.id !== id);
      addAudit(db, { actor: role, action: 'repair.delete', entity: 'repairs', entityId: id });
      saveDb(db);
      return jsonResponse(res, 204, {});
    }

    if (pathname.match(/^\/api\/repairs\/[^/]+\/job-card$/) && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'technician', 'cashier']); if (!role) return;
      const id = pathname.split('/')[3];
      const repair = db.repairs.find((r) => r.id === id);
      if (!repair) return jsonResponse(res, 404, { error: 'Repair not found' });
      const customer = db.customers.find((c) => c.id === repair.customerId);
      const card = createJobCard(repair, customer);
      updateEntity(repair, { jobCardPath: card.relativePath });
      addAudit(db, { actor: role, action: 'repair.jobcard', entity: 'repairs', entityId: repair.id });
      saveDb(db);
      return jsonResponse(res, 201, card);
    }

    if (pathname === '/api/repairs/create-invoice' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'technician', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      const repair = db.repairs.find((r) => r.id === body.repairId);
      if (!repair) return jsonResponse(res, 404, { error: 'Repair not found' });
      const customer = db.customers.find((c) => c.id === repair.customerId);
      const taxRate = db.settings.billing.defaultTaxRate || TAX_RATE;
      const subtotal = toNum(repair.total, 0);
      const tax = Number((subtotal * taxRate).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));
      const invoice = {
        id: randomUUID(),
        number: nextInvoiceNumber(db, db.settings.billing.repairInvoicePrefix || 'RINV'),
        type: 'repair',
        customerId: repair.customerId,
        sourceRepairId: repair.id,
        lines: [{ productId: 'repair-service', name: `Repair: ${repair.device}`, qty: 1, price: subtotal, total: subtotal }],
        subtotal,
        discount: 0,
        tax,
        total,
        paymentMethods: [{ method: 'pending', amount: total }],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      const pdf = createRepairInvoicePdf(invoice, repair, customer);
      invoice.pdfPath = pdf.relativePath;
      db.invoices.push(invoice);
      updateEntity(repair, { status: 'completed' });
      addAudit(db, { actor: role, action: 'repair.invoice', entity: 'invoices', entityId: invoice.id });
      saveDb(db);
      return jsonResponse(res, 201, invoice);
    }

    // invoices
    if (pathname === '/api/invoices' && req.method === 'GET') return jsonResponse(res, 200, db.invoices);
    if (pathname.startsWith('/api/invoices/') && req.method === 'GET') {
      const id = pathname.split('/').pop();
      const invoice = db.invoices.find((i) => i.id === id);
      if (!invoice) return jsonResponse(res, 404, { error: 'Not found' });
      return jsonResponse(res, 200, invoice);
    }

    if (pathname === '/api/invoices' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      const customer = findOrCreateCustomer(db, body.customer || {});
      const productMap = new Map(db.products.map((p) => [p.id, p]));
      const taxRate = toNum(body.taxRate, db.settings.billing.defaultTaxRate || TAX_RATE);
      const calc = calculateInvoice(productMap, body.lines || [], body.discount || 0, taxRate);
      const paymentMethods = normalizePayments(body.paymentMethods, calc.total);

      for (const line of calc.lines) {
        const p = productMap.get(line.productId);
        if (!db.settings.inventory.allowNegativeStock && p.stockQty - line.qty < 0) {
          return badRequest(res, `Negative stock not allowed for ${p.name}`);
        }
        p.stockQty -= line.qty;
        updateEntity(p, {});
        db.stockMovements.push({ id: randomUUID(), productId: p.id, type: 'sale', qty: -line.qty, unitPrice: line.price, createdAt: nowIso() });
      }

      const invoice = {
        id: randomUUID(),
        number: nextInvoiceNumber(db, db.settings.billing.invoicePrefix || 'INV'),
        type: 'sale',
        customerId: customer?.id || null,
        lines: calc.lines,
        subtotal: calc.subtotal,
        discount: calc.discountAmount,
        tax: calc.tax,
        total: calc.total,
        paymentMethods,
        status: 'issued',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      const pdf = createInvoicePdf(invoice, customer);
      invoice.pdfPath = pdf.relativePath;
      const phone = normalizePhone(customer?.phone);
      const messageTemplate = db.settings.notifications.whatsappTemplate || 'Hi {{customer}}, invoice {{invoiceId}} total ₹{{total}}.';
      const msg = encodeURIComponent(messageTemplate.replace('{{customer}}', customer?.name || 'Customer').replace('{{invoiceId}}', invoice.number).replace('{{total}}', String(invoice.total)));
      invoice.whatsappShare = db.settings.notifications.whatsappEnabled && phone ? `https://wa.me/91${phone}?text=${msg}` : null;

      db.invoices.push(invoice);
      addAudit(db, { actor: role, action: 'invoice.create', entity: 'invoices', entityId: invoice.id });
      saveDb(db);
      return jsonResponse(res, 201, invoice);
    }

    if (pathname.match(/^\/api\/invoices\/[^/]+\/cancel$/) && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const id = pathname.split('/')[3];
      const invoice = db.invoices.find((i) => i.id === id);
      if (!invoice) return jsonResponse(res, 404, { error: 'Invoice not found' });
      if (invoice.status === 'cancelled') return badRequest(res, 'Invoice already cancelled');
      if (invoice.type !== 'sale') return badRequest(res, 'Only sale invoices can be cancelled');
      for (const line of invoice.lines) {
        const p = db.products.find((x) => x.id === line.productId);
        if (p) {
          p.stockQty += line.qty;
          updateEntity(p, {});
          db.stockMovements.push({ id: randomUUID(), productId: p.id, type: 'cancel-restock', qty: line.qty, unitPrice: line.price, createdAt: nowIso() });
        }
      }
      updateEntity(invoice, { status: 'cancelled', cancelledAt: nowIso() });
      addAudit(db, { actor: role, action: 'invoice.cancel', entity: 'invoices', entityId: id });
      saveDb(db);
      return jsonResponse(res, 200, invoice);
    }

    if (pathname.match(/^\/api\/invoices\/[^/]+\/return$/) && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const id = pathname.split('/')[3];
      const original = db.invoices.find((i) => i.id === id);
      if (!original) return jsonResponse(res, 404, { error: 'Invoice not found' });
      const body = await parseBody(req);
      const returnLines = Array.isArray(body.lines) && body.lines.length ? body.lines : original.lines.map((l) => ({ productId: l.productId, qty: l.qty }));
      const outLines = [];
      let subtotal = 0;
      for (const rl of returnLines) {
        const src = original.lines.find((l) => l.productId === rl.productId);
        if (!src) continue;
        const qty = Math.min(toNum(rl.qty, 0), src.qty);
        if (qty <= 0) continue;
        const p = db.products.find((x) => x.id === rl.productId);
        if (p) {
          p.stockQty += qty;
          updateEntity(p, {});
          db.stockMovements.push({ id: randomUUID(), productId: p.id, type: 'return-restock', qty, unitPrice: src.price, createdAt: nowIso() });
        }
        const total = Number((qty * toNum(src.price, 0)).toFixed(2));
        subtotal += total;
        outLines.push({ productId: src.productId, name: src.name, qty, price: src.price, total });
      }
      const taxRate = db.settings.billing.defaultTaxRate || TAX_RATE;
      const tax = Number((subtotal * taxRate).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));
      const ret = {
        id: randomUUID(),
        number: `${original.number}-RET-${Date.now().toString().slice(-4)}`,
        type: 'return',
        sourceInvoiceId: original.id,
        customerId: original.customerId,
        lines: outLines,
        subtotal,
        discount: 0,
        tax,
        total,
        paymentMethods: [{ method: 'refund', amount: total }],
        status: 'issued',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      db.invoices.push(ret);
      addAudit(db, { actor: role, action: 'invoice.return', entity: 'invoices', entityId: ret.id, payload: { source: original.id } });
      saveDb(db);
      return jsonResponse(res, 201, ret);
    }

    if (pathname === '/api/stock-movements' && req.method === 'GET') return jsonResponse(res, 200, db.stockMovements);

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const lowStock = db.products.filter((p) => toNum(p.stockQty, 0) <= toNum(p.lowStockThreshold, 5));
      const salesInvoices = db.invoices.filter((i) => i.type === 'sale' || i.type === 'repair');
      const returnInvoices = db.invoices.filter((i) => i.type === 'return');
      const grossSales = Number(salesInvoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2));
      const returnsAmount = Number(returnInvoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2));
      return jsonResponse(res, 200, {
        inventoryCount: db.products.length,
        customerCount: db.customers.length,
        repairCount: db.repairs.length,
        invoiceCount: db.invoices.length,
        openRepairs: db.repairs.filter((r) => !['completed', 'delivered'].includes(r.status)).length,
        lowStock,
        grossSales,
        returnsAmount,
        netSales: Number((grossSales - returnsAmount).toFixed(2))
      });
    }

    if (pathname === '/api/reports/sales' && req.method === 'GET') {
      const from = searchParams.get('from') || '1970-01-01T00:00:00.000Z';
      const to = searchParams.get('to') || nowIso();
      const inRange = db.invoices.filter((i) => i.createdAt >= from && i.createdAt <= to);
      const sales = inRange.filter((i) => i.type !== 'return');
      const returns = inRange.filter((i) => i.type === 'return');
      return jsonResponse(res, 200, {
        from,
        to,
        invoices: sales.length,
        returns: returns.length,
        gross: Number(sales.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2)),
        returnAmount: Number(returns.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2))
      });
    }

    // sync
    if (pathname === '/api/sync/pull' && req.method === 'GET') {
      const since = searchParams.get('since') || '1970-01-01T00:00:00.000Z';
      const changed = {
        settings: db.settings.updatedAt > since ? db.settings : null,
        customers: db.customers.filter((x) => (x.updatedAt || x.createdAt) > since),
        products: db.products.filter((x) => (x.updatedAt || x.createdAt) > since),
        repairs: db.repairs.filter((x) => (x.updatedAt || x.createdAt) > since),
        invoices: db.invoices.filter((x) => (x.updatedAt || x.createdAt) > since)
      };
      return jsonResponse(res, 200, { changed, serverTime: nowIso(), conflictPolicy: 'lww-updatedAt', idempotencyHint: 'clientOpId recommended' });
    }

    if (pathname === '/api/sync/push' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier', 'technician']); if (!role) return;
      const body = await parseBody(req);
      const events = Array.isArray(body.events) ? body.events : [];
      const seen = new Set();
      const applied = [];
      const conflicts = [];

      for (const evt of events) {
        const { entity, operation, record, clientOpId } = evt;
        if (clientOpId && seen.has(clientOpId)) continue;
        if (clientOpId) seen.add(clientOpId);
        if (!entity || !operation || !record?.id) continue;

        if (entity === 'settings' && operation === 'upsert') {
          const st = db.settings.updatedAt || '';
          const ct = record.updatedAt || '';
          if (ct >= st) {
            db.settings = { ...db.settings, ...record };
            applied.push({ entity, operation: 'upsert', id: 'global' });
          } else {
            conflicts.push({ entity, id: 'global', winner: 'server', serverTime: st, clientTime: ct });
          }
          continue;
        }

        const col = db[entity];
        if (!Array.isArray(col)) continue;
        const idx = col.findIndex((x) => x.id === record.id);

        if (operation === 'delete') {
          if (idx >= 0) { col.splice(idx, 1); applied.push({ entity, operation, id: record.id }); }
          continue;
        }
        if (idx < 0) { col.push(record); applied.push({ entity, operation: 'insert', id: record.id }); continue; }

        const existing = col[idx];
        const st = existing.updatedAt || existing.createdAt || '';
        const ct = record.updatedAt || record.createdAt || '';
        if (ct >= st) {
          col[idx] = { ...existing, ...record };
          applied.push({ entity, operation: 'upsert', id: record.id });
        } else {
          conflicts.push({ entity, id: record.id, winner: 'server', serverTime: st, clientTime: ct });
        }
      }

      const event = { id: randomUUID(), createdAt: nowIso(), by: role, received: events.length, applied, conflicts };
      db.syncEvents.push(event);
      addAudit(db, { actor: role, action: 'sync.push', entity: 'syncEvents', entityId: event.id, payload: { received: events.length, applied: applied.length, conflicts: conflicts.length } });
      saveDb(db);
      return jsonResponse(res, 202, { accepted: true, eventId: event.id, applied, conflicts });
    }

    return jsonResponse(res, 404, { error: 'Route not found' });
  } catch (error) {
    return jsonResponse(res, 500, { error: error.message || 'Unhandled error' });
  }
}
