import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const PDF_DIR = path.join(ROOT, 'data', 'invoices');
const JOBCARD_DIR = path.join(ROOT, 'data', 'jobcards');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TAX_RATE = 0.18;

for (const dir of [path.dirname(DATA_FILE), PDF_DIR, JOBCARD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const defaultDb = {
  customers: [],
  products: [],
  repairs: [],
  invoices: [],
  stockMovements: [],
  syncEvents: []
};

const nowIso = () => new Date().toISOString();
const toNum = (val, fallback = 0) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
};

function loadDb() {
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(defaultDb, null, 2));
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function badRequest(res, message) {
  return send(res, 400, { error: message });
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function findOrCreateCustomer(db, input) {
  if (!isNonEmptyString(input?.name)) return null;
  const normalizedName = input.name.trim().toLowerCase();
  const normalizedPhone = normalizePhone(input.phone);
  let existing = db.customers.find(
    (c) => c.name.trim().toLowerCase() === normalizedName || (normalizedPhone && normalizePhone(c.phone) === normalizedPhone)
  );
  if (!existing) {
    existing = {
      id: randomUUID(),
      name: input.name.trim(),
      phone: input.phone || '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      version: 1
    };
    db.customers.push(existing);
  }
  return existing;
}

function updateEntity(entity, patch) {
  Object.assign(entity, patch);
  entity.updatedAt = nowIso();
  entity.version = toNum(entity.version, 0) + 1;
}

function calculateInvoice(productMap, lines, discount = 0, taxRate = TAX_RATE) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Invoice lines are required');
  const detailed = lines.map((line) => {
    const product = productMap.get(line.productId);
    if (!product) throw new Error(`Product ${line.productId} not found`);
    const qty = toNum(line.qty, 0);
    if (qty <= 0) throw new Error(`Invalid quantity for ${product.name}`);
    const price = toNum(line.price ?? product.price, 0);
    if (price < 0) throw new Error(`Invalid price for ${product.name}`);
    if (product.stockQty < qty) throw new Error(`Insufficient stock for ${product.name}`);
    const total = Number((qty * price).toFixed(2));
    return { productId: product.id, barcode: product.barcode || '', name: product.name, qty, price, total };
  });

  const subtotal = Number(detailed.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  const discountAmount = Number(Math.min(subtotal, toNum(discount, 0)).toFixed(2));
  const taxable = subtotal - discountAmount;
  const tax = Number((taxable * taxRate).toFixed(2));
  const total = Number((taxable + tax).toFixed(2));
  return { lines: detailed, subtotal, discountAmount, tax, total };
}

function validatePayments(paymentMethods, total) {
  const methods = Array.isArray(paymentMethods) ? paymentMethods : [];
  if (methods.length === 0) return [{ method: 'cash', amount: total }];

  if (typeof methods[0] === 'string') {
    return methods.map((method, idx) => ({ method, amount: idx === 0 ? total : 0 }));
  }

  const sum = Number(methods.reduce((s, m) => s + toNum(m.amount, 0), 0).toFixed(2));
  if (Math.abs(sum - total) > 0.01) throw new Error(`Payment split mismatch. expected ${total}, got ${sum}`);
  return methods.map((m) => ({ method: m.method, amount: toNum(m.amount, 0) }));
}

function createPseudoPdf(textContent, fileNamePrefix) {
  const text = textContent.join('\n');
  const pdf = Buffer.from(`%PDF-1.1\n% Phoneix pseudo-pdf\n${text}\n%%EOF`, 'utf8');
  const fileName = `${fileNamePrefix}-${Date.now()}.pdf`;
  const fullPath = path.join(PDF_DIR, fileName);
  fs.writeFileSync(fullPath, pdf);
  return { fileName, fullPath, relativePath: `/invoices/${fileName}` };
}

function createJobCardFile(repair, customer) {
  const content = [
    'PHONEIX MOBILES - JOB CARD',
    `Ticket ID: ${repair.id}`,
    `Created: ${repair.createdAt}`,
    `Status: ${repair.status}`,
    `Customer: ${customer?.name || 'Walk-in'} (${customer?.phone || 'N/A'})`,
    `Device: ${repair.device}`,
    `Issue: ${repair.issue}`,
    `Parts Cost: ${repair.parts.reduce((s, p) => s + toNum(p.cost, 0), 0)}`,
    `Service Cost: ${toNum(repair.serviceCost, 0)}`,
    `Total: ${toNum(repair.total, 0)}`
  ].join('\n');
  const fileName = `jobcard-${repair.id}.txt`;
  const fullPath = path.join(JOBCARD_DIR, fileName);
  fs.writeFileSync(fullPath, content);
  return { fileName, fullPath, relativePath: `/jobcards/${fileName}` };
}

function serveStatic(res, pathname) {
  const target = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC_DIR, target);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return send(res, 404, { error: 'Not found' });
  const ext = path.extname(full);
  const type = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.txt': 'text/plain'
  }[ext] || 'application/octet-stream';
  return send(res, 200, fs.readFileSync(full), type);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (pathname.startsWith('/invoices/')) {
    const file = path.join(PDF_DIR, path.basename(pathname));
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Invoice PDF not found' });
    return send(res, 200, fs.readFileSync(file), 'application/pdf');
  }

  if (pathname.startsWith('/jobcards/')) {
    const file = path.join(JOBCARD_DIR, path.basename(pathname));
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Job card not found' });
    return send(res, 200, fs.readFileSync(file), 'text/plain');
  }

  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);

  try {
    const db = loadDb();

    if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, now: nowIso() });

    if (pathname === '/api/products' && req.method === 'GET') {
      const q = (searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return send(res, 200, db.products);
      const filtered = db.products.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.sku || '').toLowerCase().includes(q) ||
        String(p.barcode || '').toLowerCase().includes(q)
      );
      return send(res, 200, filtered);
    }

    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!isNonEmptyString(body.name)) return badRequest(res, 'name is required');
      const product = {
        id: randomUUID(),
        name: body.name.trim(),
        sku: body.sku || '',
        barcode: body.barcode || '',
        price: toNum(body.price, 0),
        stockQty: toNum(body.stockQty, 0),
        lowStockThreshold: toNum(body.lowStockThreshold, 5),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      db.products.push(product);
      saveDb(db);
      return send(res, 201, product);
    }

    if (pathname.startsWith('/api/products/') && req.method === 'PATCH') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const product = db.products.find((p) => p.id === id);
      if (!product) return send(res, 404, { error: 'Not found' });
      const patch = { ...body };
      if (patch.stockQty != null) patch.stockQty = toNum(patch.stockQty, product.stockQty);
      if (patch.price != null) patch.price = toNum(patch.price, product.price);
      updateEntity(product, patch);
      saveDb(db);
      return send(res, 200, product);
    }

    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.products = db.products.filter((p) => p.id !== id);
      saveDb(db);
      return send(res, 204, {});
    }

    if (pathname === '/api/customers' && req.method === 'GET') return send(res, 200, db.customers);

    if (pathname === '/api/customers' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!isNonEmptyString(body.name)) return badRequest(res, 'name is required');
      const customer = {
        id: randomUUID(),
        name: body.name.trim(),
        phone: body.phone || '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      db.customers.push(customer);
      saveDb(db);
      return send(res, 201, customer);
    }

    if (pathname.match(/^\/api\/customers\/[^/]+\/history$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const invoices = db.invoices.filter((i) => i.customerId === id);
      const repairs = db.repairs.filter((r) => r.customerId === id);
      const spend = Number(invoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2));
      return send(res, 200, { invoices, repairs, spend, invoiceCount: invoices.length, repairCount: repairs.length });
    }

    if (pathname.startsWith('/api/customers/') && req.method === 'PATCH') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const customer = db.customers.find((c) => c.id === id);
      if (!customer) return send(res, 404, { error: 'Not found' });
      updateEntity(customer, body);
      saveDb(db);
      return send(res, 200, customer);
    }

    if (pathname.startsWith('/api/customers/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.customers = db.customers.filter((c) => c.id !== id);
      saveDb(db);
      return send(res, 204, {});
    }

    if (pathname === '/api/repairs' && req.method === 'GET') return send(res, 200, db.repairs);

    if (pathname === '/api/repairs' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!isNonEmptyString(body.device) || !isNonEmptyString(body.issue)) return badRequest(res, 'device and issue are required');
      const repair = {
        id: randomUUID(),
        device: body.device.trim(),
        issue: body.issue.trim(),
        customerId: body.customerId || null,
        status: body.status || 'received',
        parts: Array.isArray(body.parts) ? body.parts : [],
        serviceCost: toNum(body.serviceCost, 0),
        total: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };
      repair.total = Number((repair.parts.reduce((s, p) => s + toNum(p.cost, 0), 0) + repair.serviceCost).toFixed(2));
      db.repairs.push(repair);
      saveDb(db);
      return send(res, 201, repair);
    }

    if (pathname.startsWith('/api/repairs/') && req.method === 'PATCH') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const repair = db.repairs.find((r) => r.id === id);
      if (!repair) return send(res, 404, { error: 'Not found' });
      updateEntity(repair, body);
      repair.total = Number(((repair.parts || []).reduce((s, p) => s + toNum(p.cost, 0), 0) + toNum(repair.serviceCost, 0)).toFixed(2));
      saveDb(db);
      return send(res, 200, repair);
    }

    if (pathname.startsWith('/api/repairs/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.repairs = db.repairs.filter((r) => r.id !== id);
      saveDb(db);
      return send(res, 204, {});
    }

    if (pathname.match(/^\/api\/repairs\/[^/]+\/job-card$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const repair = db.repairs.find((r) => r.id === id);
      if (!repair) return send(res, 404, { error: 'Repair not found' });
      const customer = db.customers.find((c) => c.id === repair.customerId);
      const card = createJobCardFile(repair, customer);
      repair.jobCardPath = card.relativePath;
      updateEntity(repair, {});
      saveDb(db);
      return send(res, 201, { repairId: repair.id, ...card });
    }

    if (pathname === '/api/repairs/create-invoice' && req.method === 'POST') {
      const body = await parseBody(req);
      const repair = db.repairs.find((r) => r.id === body.repairId);
      if (!repair) return send(res, 404, { error: 'Repair not found' });
      const customer = db.customers.find((c) => c.id === repair.customerId);

      const subtotal = toNum(repair.total, 0);
      const tax = Number((subtotal * TAX_RATE).toFixed(2));
      const total = Number((subtotal + tax).toFixed(2));
      const invoice = {
        id: randomUUID(),
        customerId: repair.customerId,
        lines: [{ productId: 'repair-service', name: `Repair: ${repair.device}`, qty: 1, price: subtotal, total: subtotal }],
        subtotal,
        discount: 0,
        tax,
        total,
        paymentMethods: [{ method: 'pending', amount: total }],
        sourceRepairId: repair.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };

      const pdfInfo = createPseudoPdf([
        'Phoneix Mobiles - Repair Invoice',
        `Invoice ID: ${invoice.id}`,
        `Repair ID: ${repair.id}`,
        `Customer: ${customer?.name || 'Walk-in'}`,
        `Total: ${invoice.total}`
      ], 'invoice');

      invoice.pdfPath = pdfInfo.relativePath;
      db.invoices.push(invoice);
      repair.status = 'completed';
      updateEntity(repair, {});
      saveDb(db);
      return send(res, 201, invoice);
    }

    if (pathname === '/api/invoices' && req.method === 'GET') return send(res, 200, db.invoices);

    if (pathname === '/api/invoices' && req.method === 'POST') {
      const body = await parseBody(req);
      const customer = findOrCreateCustomer(db, body.customer || {});
      const productMap = new Map(db.products.map((p) => [p.id, p]));
      const calc = calculateInvoice(productMap, body.lines || [], body.discount || 0);
      const paymentMethods = validatePayments(body.paymentMethods, calc.total);

      for (const line of calc.lines) {
        const product = productMap.get(line.productId);
        product.stockQty -= line.qty;
        updateEntity(product, {});
        db.stockMovements.push({
          id: randomUUID(),
          productId: product.id,
          type: 'sale',
          qty: -line.qty,
          unitPrice: line.price,
          referenceType: 'invoice',
          createdAt: nowIso()
        });
      }

      const invoice = {
        id: randomUUID(),
        customerId: customer?.id || null,
        lines: calc.lines,
        subtotal: calc.subtotal,
        discount: calc.discountAmount,
        tax: calc.tax,
        total: calc.total,
        paymentMethods,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      };

      const pdfInfo = createPseudoPdf([
        'Phoneix Mobiles - Tax Invoice',
        `Invoice ID: ${invoice.id}`,
        `Date: ${invoice.createdAt}`,
        `Customer: ${customer?.name || 'Walk-in'} ${customer?.phone || ''}`,
        ...invoice.lines.map((l) => `${l.name} x ${l.qty} @ ${l.price} = ${l.total}`),
        `Subtotal: ${invoice.subtotal}`,
        `Discount: ${invoice.discount}`,
        `Tax: ${invoice.tax}`,
        `Total: ${invoice.total}`
      ], 'invoice');

      invoice.pdfPath = pdfInfo.relativePath;
      const phone = normalizePhone(customer?.phone);
      const message = encodeURIComponent(`Hi ${customer?.name || 'Customer'}, Invoice ${invoice.id} total ₹${invoice.total}. PDF saved at ${pdfInfo.fullPath}`);
      invoice.whatsappShare = phone ? `https://wa.me/91${phone}?text=${message}` : null;

      db.invoices.push(invoice);
      saveDb(db);
      return send(res, 201, invoice);
    }

    if (pathname === '/api/stock-movements' && req.method === 'GET') return send(res, 200, db.stockMovements);

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const lowStock = db.products.filter((p) => toNum(p.stockQty, 0) <= toNum(p.lowStockThreshold, 5));
      const totalSales = Number(db.invoices.reduce((s, i) => s + toNum(i.total, 0), 0).toFixed(2));
      const openRepairs = db.repairs.filter((r) => r.status !== 'completed').length;
      return send(res, 200, {
        inventoryCount: db.products.length,
        customerCount: db.customers.length,
        repairCount: db.repairs.length,
        invoiceCount: db.invoices.length,
        openRepairs,
        lowStock,
        totalSales
      });
    }

    if (pathname === '/api/sync/pull' && req.method === 'GET') {
      const since = searchParams.get('since') || '1970-01-01T00:00:00.000Z';
      const changed = {
        customers: db.customers.filter((x) => (x.updatedAt || x.createdAt) > since),
        products: db.products.filter((x) => (x.updatedAt || x.createdAt) > since),
        repairs: db.repairs.filter((x) => (x.updatedAt || x.createdAt) > since),
        invoices: db.invoices.filter((x) => (x.updatedAt || x.createdAt) > since)
      };
      return send(res, 200, { changed, serverTime: nowIso(), resolution: 'lww-timestamp' });
    }

    if (pathname === '/api/sync/push' && req.method === 'POST') {
      const body = await parseBody(req);
      const events = Array.isArray(body.events) ? body.events : [];
      const applied = [];
      const conflicts = [];

      for (const evt of events) {
        const { entity, operation, record } = evt;
        if (!entity || !operation || !record?.id) continue;
        const collection = db[entity];
        if (!Array.isArray(collection)) continue;

        const idx = collection.findIndex((x) => x.id === record.id);
        if (operation === 'delete') {
          if (idx >= 0) {
            collection.splice(idx, 1);
            applied.push({ id: record.id, entity, operation });
          }
          continue;
        }

        if (idx < 0) {
          collection.push(record);
          applied.push({ id: record.id, entity, operation: 'insert' });
          continue;
        }

        const serverRec = collection[idx];
        const serverTime = serverRec.updatedAt || serverRec.createdAt || '';
        const clientTime = record.updatedAt || record.createdAt || '';
        if (clientTime >= serverTime) {
          collection[idx] = { ...serverRec, ...record };
          applied.push({ id: record.id, entity, operation: 'upsert' });
        } else {
          conflicts.push({ id: record.id, entity, winner: 'server', serverTime, clientTime });
        }
      }

      const event = { id: randomUUID(), payload: { eventsCount: events.length }, createdAt: nowIso(), applied, conflicts };
      db.syncEvents.push(event);
      saveDb(db);
      return send(res, 202, { accepted: true, eventId: event.id, applied, conflicts });
    }

    return send(res, 404, { error: 'Route not found' });
  } catch (error) {
    return send(res, 500, { error: error.message || 'Unhandled server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Phoneix Mobiles system running on http://localhost:${PORT}`);
});
