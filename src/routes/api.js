import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, JOBCARD_DIR, PDF_DIR, PUBLIC_DIR, TAX_RATE } from '../lib/config.js';
import { loadDb, saveDb, updateEntity, createBackup, restoreBackup } from '../lib/db.js';
import { addAudit } from '../lib/audit.js';
import { authorize } from '../lib/auth.js';
import { badRequest, isNonEmptyString, jsonResponse, nowIso, parseBody, toNum, normalizePhone } from '../lib/utils.js';
import { calculateInvoice, createInvoicePdf, createJobCard, createRepairInvoicePdf, findOrCreateCustomer, normalizePayments } from '../lib/services.js';

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
      syncEvents: db.syncEvents.length
    });
  }

  try {
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
      return jsonResponse(res, 200, db.auditLogs.slice(-200).reverse());
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
      const product = { id: randomUUID(), name: body.name.trim(), sku: body.sku || '', barcode: body.barcode || '', price: toNum(body.price, 0), stockQty: toNum(body.stockQty, 0), lowStockThreshold: toNum(body.lowStockThreshold, 5), createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
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

    // customers
    if (pathname === '/api/customers' && req.method === 'GET') return jsonResponse(res, 200, db.customers);
    if (pathname === '/api/customers' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      if (!isNonEmptyString(body.name)) return badRequest(res, 'name is required');
      const customer = { id: randomUUID(), name: body.name.trim(), phone: body.phone || '', createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
      db.customers.push(customer);
      addAudit(db, { actor: role, action: 'customer.create', entity: 'customers', entityId: customer.id });
      saveDb(db);
      return jsonResponse(res, 201, customer);
    }

    if (pathname.match(/^\/api\/customers\/[^/]+\/history$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const invoices = db.invoices.filter((i) => i.customerId === id);
      const repairs = db.repairs.filter((r) => r.customerId === id);
      return jsonResponse(res, 200, { invoices, repairs, spend: Number(invoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2)), invoiceCount: invoices.length, repairCount: repairs.length });
    }

    // repairs
    if (pathname === '/api/repairs' && req.method === 'GET') return jsonResponse(res, 200, db.repairs);
    if (pathname === '/api/repairs' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'technician', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      if (!isNonEmptyString(body.device) || !isNonEmptyString(body.issue)) return badRequest(res, 'device and issue are required');
      const repair = { id: randomUUID(), device: body.device.trim(), issue: body.issue.trim(), customerId: body.customerId || null, status: body.status || 'received', parts: Array.isArray(body.parts) ? body.parts : [], serviceCost: toNum(body.serviceCost, 0), total: 0, createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
      repair.total = Number(((repair.parts || []).reduce((s, p) => s + toNum(p.cost, 0), 0) + repair.serviceCost).toFixed(2));
      db.repairs.push(repair);
      addAudit(db, { actor: role, action: 'repair.create', entity: 'repairs', entityId: repair.id });
      saveDb(db);
      return jsonResponse(res, 201, repair);
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
      const subtotal = toNum(repair.total, 0);
      const tax = Number((subtotal * TAX_RATE).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));
      const invoice = { id: randomUUID(), customerId: repair.customerId, sourceRepairId: repair.id, lines: [{ productId: 'repair-service', name: `Repair: ${repair.device}`, qty: 1, price: subtotal, total: subtotal }], subtotal, discount: 0, tax, total, paymentMethods: [{ method: 'pending', amount: total }], createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
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
    if (pathname === '/api/invoices' && req.method === 'POST') {
      const role = authorize(req, res, ['admin', 'cashier']); if (!role) return;
      const body = await parseBody(req);
      const customer = findOrCreateCustomer(db, body.customer || {});
      const productMap = new Map(db.products.map((p) => [p.id, p]));
      const calc = calculateInvoice(productMap, body.lines || [], body.discount || 0);
      const paymentMethods = normalizePayments(body.paymentMethods, calc.total);

      for (const line of calc.lines) {
        const p = productMap.get(line.productId);
        p.stockQty -= line.qty;
        updateEntity(p, {});
        db.stockMovements.push({ id: randomUUID(), productId: p.id, type: 'sale', qty: -line.qty, unitPrice: line.price, createdAt: nowIso() });
      }

      const invoice = { id: randomUUID(), customerId: customer?.id || null, lines: calc.lines, subtotal: calc.subtotal, discount: calc.discountAmount, tax: calc.tax, total: calc.total, paymentMethods, createdAt: nowIso(), updatedAt: nowIso(), version: 1 };
      const pdf = createInvoicePdf(invoice, customer);
      invoice.pdfPath = pdf.relativePath;
      const phone = normalizePhone(customer?.phone);
      const msg = encodeURIComponent(`Hi ${customer?.name || 'Customer'}, invoice ${invoice.id} total ₹${invoice.total}`);
      invoice.whatsappShare = phone ? `https://wa.me/91${phone}?text=${msg}` : null;

      db.invoices.push(invoice);
      addAudit(db, { actor: role, action: 'invoice.create', entity: 'invoices', entityId: invoice.id });
      saveDb(db);
      return jsonResponse(res, 201, invoice);
    }

    if (pathname === '/api/stock-movements' && req.method === 'GET') return jsonResponse(res, 200, db.stockMovements);

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const lowStock = db.products.filter((p) => toNum(p.stockQty, 0) <= toNum(p.lowStockThreshold, 5));
      const totalSales = Number(db.invoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2));
      return jsonResponse(res, 200, { inventoryCount: db.products.length, customerCount: db.customers.length, repairCount: db.repairs.length, invoiceCount: db.invoices.length, openRepairs: db.repairs.filter((r) => r.status !== 'completed').length, lowStock, totalSales });
    }

    // sync
    if (pathname === '/api/sync/pull' && req.method === 'GET') {
      const since = searchParams.get('since') || '1970-01-01T00:00:00.000Z';
      const changed = {
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
