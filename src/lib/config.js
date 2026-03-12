import path from 'node:path';

export const PORT = Number(process.env.PORT || 3000);
export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, 'data');
export const DATA_FILE = path.join(DATA_DIR, 'db.json');
export const PDF_DIR = path.join(DATA_DIR, 'invoices');
export const JOBCARD_DIR = path.join(DATA_DIR, 'jobcards');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const TAX_RATE = 0.18;
export const API_KEYS = {
  admin: process.env.ADMIN_API_KEY || 'admin-key',
  cashier: process.env.CASHIER_API_KEY || 'cashier-key',
  technician: process.env.TECH_API_KEY || 'tech-key'
};
