import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const PDF_DIR = path.join(ROOT, 'data', 'invoices');
const PUBLIC_DIR = path.join(ROOT, 'public');

if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

const defaultDb = {
  customers: [],
  products: [],
  repairs: [],
  invoices: [],
  stockMovements: [],
  syncEvents: []
};

function loadDb() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultDb, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function findOrCreateCustomer(db, input) {
  if (!input?.name) return null;
  const normalized = input.name.trim().toLowerCase();
  let existing = db.customers.find((c) => c.name.trim().toLowerCase() === normalized || (input.phone && c.phone === input.phone));
  if (!existing) {
    existing = { id: randomUUID(), name: input.name.trim(), phone: input.phone || '', createdAt: new Date().toISOString() };
    db.customers.push(existing);
  }
  return existing;
}

function calculateInvoice(productsMap, lines, discount = 0, taxRate = 0.18) {
  const detailed = lines.map((line) => {
    const product = productsMap.get(line.productId);
    if (!product) throw new Error(`Product ${line.productId} not found`);
    const qty = Number(line.qty || 0);
    const price = Number(line.price ?? product.price);
    const total = qty * price;
    return { ...line, name: product.name, qty, price, total };
  });
  const subtotal = detailed.reduce((sum, i) => sum + i.total, 0);
  const discountAmount = Math.min(subtotal, Number(discount || 0));
  const taxable = subtotal - discountAmount;
  const tax = Number((taxable * taxRate).toFixed(2));
  const grandTotal = Number((taxable + tax).toFixed(2));
  return { lines: detailed, subtotal, discountAmount, tax, grandTotal };
}

function createSimplePdf(invoice, customer) {
  const text = [
    'Phoenix Mobiles Invoice',
    `Invoice: ${invoice.id}`,
    `Date: ${new Date(invoice.createdAt).toLocaleString('en-IN')}`,
    `Customer: ${customer?.name || 'Walk-in'} ${customer?.phone || ''}`,
    '---',
    ...invoice.lines.map((l) => `${l.name} x ${l.qty} @ ${l.price} = ${l.total}`),
    '---',
    `Subtotal: ${invoice.subtotal}`,
    `Discount: ${invoice.discount}`,
    `Tax: ${invoice.tax}`,
    `Total: ${invoice.total}`
  ].join('\n');

  const content = Buffer.from(text, 'utf8');
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.1\n'),
    Buffer.from('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'),
    Buffer.from('2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n'),
    Buffer.from('3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<<>>>>endobj\n'),
    Buffer.from(`4 0 obj<</Length ${content.length + 20}>>stream\nBT /F1 10 Tf 50 750 Td (`),
    Buffer.from(text.replace(/\n/g, ') Tj T* ('), 'utf8'),
    Buffer.from(') Tj ET\nendstream endobj\n'),
    Buffer.from('xref\n0 5\n0000000000 65535 f \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n0\n%%EOF')
  ]);

  const fileName = `invoice-${invoice.id}.pdf`;
  const fullPath = path.join(PDF_DIR, fileName);
  fs.writeFileSync(fullPath, pdf);
  return { fileName, fullPath, relativePath: `/invoices/${fileName}` };
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(filePath);
  const contentType = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(fs.readFileSync(filePath));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (pathname.startsWith('/invoices/')) {
    const filePath = path.join(PDF_DIR, path.basename(pathname));
    if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Invoice PDF not found' });
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end(fs.readFileSync(filePath));
  }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  try {
    const db = loadDb();

    if (pathname === '/api/health') return json(res, 200, { ok: true, now: new Date().toISOString() });

    if (pathname === '/api/products' && req.method === 'GET') return json(res, 200, db.products);
    if (pathname === '/api/customers' && req.method === 'GET') return json(res, 200, db.customers);
    if (pathname === '/api/repairs' && req.method === 'GET') return json(res, 200, db.repairs);
    if (pathname === '/api/invoices' && req.method === 'GET') return json(res, 200, db.invoices);
    if (pathname === '/api/stock-movements' && req.method === 'GET') return json(res, 200, db.stockMovements);

    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await parseBody(req);
      const product = { id: randomUUID(), name: body.name, sku: body.sku || '', barcode: body.barcode || '', price: Number(body.price || 0), stockQty: Number(body.stockQty || 0), lowStockThreshold: Number(body.lowStockThreshold || 5), createdAt: new Date().toISOString() };
      db.products.push(product);
      saveDb(db);
      return json(res, 201, product);
    }

    if (pathname.startsWith('/api/products/') && req.method === 'PATCH') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const product = db.products.find((p) => p.id === id);
      if (!product) return json(res, 404, { error: 'Not found' });
      Object.assign(product, body, { updatedAt: new Date().toISOString() });
      saveDb(db);
      return json(res, 200, product);
    }

    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.products = db.products.filter((p) => p.id !== id);
      saveDb(db);
      return json(res, 204, {});
    }

    if (pathname === '/api/customers' && req.method === 'POST') {
      const body = await parseBody(req);
      const customer = { id: randomUUID(), name: body.name, phone: body.phone || '', createdAt: new Date().toISOString() };
      db.customers.push(customer);
      saveDb(db);
      return json(res, 201, customer);
    }

    if (pathname.startsWith('/api/customers/') && req.method === 'PATCH') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const customer = db.customers.find((c) => c.id === id);
      if (!customer) return json(res, 404, { error: 'Not found' });
      Object.assign(customer, body, { updatedAt: new Date().toISOString() });
      saveDb(db);
      return json(res, 200, customer);
    }

    if (pathname.startsWith('/api/customers/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.customers = db.customers.filter((c) => c.id !== id);
      saveDb(db);
      return json(res, 204, {});
    }

    if (pathname === '/api/repairs' && req.method === 'POST') {
      const body = await parseBody(req);
      const repair = {
        id: randomUUID(),
        device: body.device,
        issue: body.issue,
        customerId: body.customerId || null,
        status: body.status || 'received',
        parts: body.parts || [],
        serviceCost: Number(body.serviceCost || 0),
        total: Number(body.total || 0),
        createdAt: new Date().toISOString()
      };
      repair.total = repair.parts.reduce((s, p) => s + Number(p.cost || 0), 0) + repair.serviceCost;
      db.repairs.push(repair);
      saveDb(db);
      return json(res, 201, repair);
    }

    if (pathname.startsWith('/api/repairs/') && req.method === 'PATCH') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const repair = db.repairs.find((r) => r.id === id);
      if (!repair) return json(res, 404, { error: 'Not found' });
      Object.assign(repair, body, { updatedAt: new Date().toISOString() });
      repair.total = (repair.parts || []).reduce((s, p) => s + Number(p.cost || 0), 0) + Number(repair.serviceCost || 0);
      saveDb(db);
      return json(res, 200, repair);
    }

    if (pathname.startsWith('/api/repairs/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.repairs = db.repairs.filter((r) => r.id !== id);
      saveDb(db);
      return json(res, 204, {});
    }

    if (pathname === '/api/repairs/create-invoice' && req.method === 'POST') {
      const body = await parseBody(req);
      const repair = db.repairs.find((r) => r.id === body.repairId);
      if (!repair) return json(res, 404, { error: 'Repair not found' });
      const invoice = {
        id: randomUUID(),
        customerId: repair.customerId,
        lines: [{ productId: 'repair-service', name: `Repair: ${repair.device}`, qty: 1, price: repair.total, total: repair.total }],
        subtotal: repair.total,
        discount: 0,
        tax: Number((repair.total * 0.18).toFixed(2)),
        total: Number((repair.total * 1.18).toFixed(2)),
        paymentMethods: ['pending'],
        sourceRepairId: repair.id,
        createdAt: new Date().toISOString()
      };
      const customer = db.customers.find((c) => c.id === invoice.customerId);
      const pdfInfo = createSimplePdf(invoice, customer);
      invoice.pdfPath = pdfInfo.relativePath;
      db.invoices.push(invoice);
      saveDb(db);
      return json(res, 201, invoice);
    }

    if (pathname === '/api/invoices' && req.method === 'POST') {
      const body = await parseBody(req);
      const customer = findOrCreateCustomer(db, body.customer || {});
      const productMap = new Map(db.products.map((p) => [p.id, p]));
      const calculated = calculateInvoice(productMap, body.lines || [], body.discount || 0);
      for (const line of calculated.lines) {
        const product = productMap.get(line.productId);
        product.stockQty -= line.qty;
        db.stockMovements.push({ id: randomUUID(), productId: product.id, type: 'sale', qty: -line.qty, reference: 'invoice', createdAt: new Date().toISOString() });
      }
      const invoice = {
        id: randomUUID(),
        customerId: customer?.id || null,
        lines: calculated.lines,
        subtotal: calculated.subtotal,
        discount: calculated.discountAmount,
        tax: calculated.tax,
        total: calculated.grandTotal,
        paymentMethods: body.paymentMethods || ['cash'],
        createdAt: new Date().toISOString()
      };
      const pdfInfo = createSimplePdf(invoice, customer);
      invoice.pdfPath = pdfInfo.relativePath;
      const phone = (customer?.phone || '').replace(/\D/g, '');
      const message = encodeURIComponent(`Hi ${customer?.name || 'Customer'}, Invoice ${invoice.id} Total ₹${invoice.total}. PDF saved at ${pdfInfo.fullPath}`);
      invoice.whatsappShare = phone ? `https://wa.me/91${phone}?text=${message}` : null;
      db.invoices.push(invoice);
      saveDb(db);
      return json(res, 201, invoice);
    }

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const lowStock = db.products.filter((p) => p.stockQty <= p.lowStockThreshold);
      const totalSales = db.invoices.reduce((s, i) => s + Number(i.total || 0), 0);
      return json(res, 200, {
        inventoryCount: db.products.length,
        customerCount: db.customers.length,
        repairCount: db.repairs.length,
        invoiceCount: db.invoices.length,
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
      return json(res, 200, { changed, serverTime: new Date().toISOString() });
    }

    if (pathname === '/api/sync/push' && req.method === 'POST') {
      const body = await parseBody(req);
      const event = { id: randomUUID(), payload: body, createdAt: new Date().toISOString(), resolution: 'server-wins-on-timestamp' };
      db.syncEvents.push(event);
      saveDb(db);
      return json(res, 202, { accepted: true, eventId: event.id });
    }

    return json(res, 404, { error: 'Route not found' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Phoneix Mobiles system running on http://localhost:${PORT}`);
});
