import fs from 'node:fs';
import { BACKUP_DIR, DATA_DIR, DATA_FILE, JOBCARD_DIR, PDF_DIR } from './config.js';
import { nowIso } from './utils.js';

export const defaultDb = {
  settings: {
    shop: {
      name: 'Phoneix Mobiles',
      phone: '',
      address: '',
      gstin: '',
      currency: 'INR',
      locale: 'en-IN'
    },
    billing: {
      invoicePrefix: 'INV',
      repairInvoicePrefix: 'RINV',
      defaultTaxRate: 0.18,
      defaultLowStockThreshold: 5,
      paymentMethods: ['cash', 'upi', 'card', 'bank-transfer']
    },
    notifications: {
      whatsappEnabled: true,
      whatsappTemplate: 'Hi {{customer}}, invoice {{invoiceId}} total ₹{{total}}.'
    },
    repair: {
      statuses: ['received', 'diagnosis', 'in-progress', 'waiting-parts', 'ready', 'completed', 'delivered'],
      defaultStatus: 'received'
    },
    inventory: {
      allowNegativeStock: false,
      lowStockAlertEnabled: true
    },
    updatedAt: nowIso(),
    version: 1
  },
  customers: [],
  products: [],
  repairs: [],
  invoices: [],
  stockMovements: [],
  syncEvents: [],
  auditLogs: []
};

for (const dir of [DATA_DIR, PDF_DIR, JOBCARD_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadDb() {
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(defaultDb, null, 2));
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!db.settings) db.settings = structuredClone(defaultDb.settings);
  return db;
}

export function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

export function updateEntity(entity, patch) {
  Object.assign(entity, patch);
  entity.updatedAt = nowIso();
  entity.version = Number(entity.version || 0) + 1;
}

export function createBackup(db) {
  const fileName = `backup-${Date.now()}.json`;
  const fullPath = `${BACKUP_DIR}/${fileName}`;
  fs.writeFileSync(fullPath, JSON.stringify(db, null, 2));
  return { fileName, fullPath };
}

export function restoreBackup(rawDb) {
  const merged = { ...defaultDb, ...rawDb };
  if (!merged.settings) merged.settings = structuredClone(defaultDb.settings);
  saveDb(merged);
  return merged;
}
