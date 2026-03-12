import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JOBCARD_DIR, TAX_RATE } from './config.js';
import { createPdf } from './pdf.js';
import { isNonEmptyString, normalizePhone, nowIso, toNum } from './utils.js';

export function findOrCreateCustomer(db, input) {
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

export function calculateInvoice(productMap, lines, discount = 0, taxRate = TAX_RATE) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Invoice lines are required');
  const detailed = lines.map((line) => {
    const product = productMap.get(line.productId);
    if (!product) throw new Error(`Product ${line.productId} not found`);
    const qty = toNum(line.qty, 0);
    if (qty <= 0) throw new Error(`Invalid quantity for ${product.name}`);
    const price = toNum(line.price ?? product.price, 0);
    if (product.stockQty < qty) throw new Error(`Insufficient stock for ${product.name}`);
    return { productId: product.id, name: product.name, barcode: product.barcode || '', qty, price, total: Number((qty * price).toFixed(2)) };
  });

  const subtotal = Number(detailed.reduce((s, i) => s + i.total, 0).toFixed(2));
  const discountAmount = Number(Math.min(subtotal, toNum(discount, 0)).toFixed(2));
  const taxable = subtotal - discountAmount;
  const tax = Number((taxable * taxRate).toFixed(2));
  const total = Number((taxable + tax).toFixed(2));
  return { lines: detailed, subtotal, discountAmount, tax, total };
}

export function normalizePayments(paymentMethods, total) {
  const methods = Array.isArray(paymentMethods) ? paymentMethods : [];
  if (!methods.length) return [{ method: 'cash', amount: total }];
  if (typeof methods[0] === 'string') return methods.map((m, i) => ({ method: m, amount: i === 0 ? total : 0 }));
  const sum = Number(methods.reduce((s, x) => s + toNum(x.amount, 0), 0).toFixed(2));
  if (Math.abs(sum - total) > 0.01) throw new Error(`Payment split mismatch. expected ${total}, got ${sum}`);
  return methods.map((m) => ({ method: m.method, amount: toNum(m.amount, 0) }));
}

export function createInvoicePdf(invoice, customer) {
  return createPdf([
    'PHONEIX MOBILES - TAX INVOICE',
    `Invoice ID: ${invoice.id}`,
    `Date: ${invoice.createdAt}`,
    `Customer: ${customer?.name || 'Walk-in'} ${customer?.phone || ''}`,
    ...invoice.lines.map((l) => `${l.name} x ${l.qty} @ ${l.price} = ${l.total}`),
    `Subtotal: ${invoice.subtotal}`,
    `Discount: ${invoice.discount}`,
    `Tax: ${invoice.tax}`,
    `Total: ${invoice.total}`
  ], 'invoice');
}

export function createRepairInvoicePdf(invoice, repair, customer) {
  return createPdf([
    'PHONEIX MOBILES - REPAIR INVOICE',
    `Invoice ID: ${invoice.id}`,
    `Repair ID: ${repair.id}`,
    `Device: ${repair.device}`,
    `Customer: ${customer?.name || 'Walk-in'}`,
    `Total: ${invoice.total}`
  ], 'repair-invoice');
}

export function createJobCard(repair, customer) {
  const fileName = `jobcard-${repair.id}.txt`;
  const fullPath = path.join(JOBCARD_DIR, fileName);
  const content = [
    'PHONEIX MOBILES - JOB CARD',
    `Ticket: ${repair.id}`,
    `Created: ${repair.createdAt}`,
    `Customer: ${customer?.name || 'Walk-in'} (${customer?.phone || 'N/A'})`,
    `Device: ${repair.device}`,
    `Issue: ${repair.issue}`,
    `Status: ${repair.status}`,
    `Service Cost: ${toNum(repair.serviceCost, 0)}`,
    `Parts Cost: ${(repair.parts || []).reduce((s, p) => s + toNum(p.cost, 0), 0)}`,
    `Total: ${repair.total}`
  ].join('\n');
  fs.writeFileSync(fullPath, content);
  return { fileName, fullPath, relativePath: `/jobcards/${fileName}` };
}
