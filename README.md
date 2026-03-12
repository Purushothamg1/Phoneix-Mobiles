# Phoneix Mobiles - Billing, Inventory, Repair Management (v3)

Production-ready modular Node.js system for mobile shop operations with full billing, inventory, repairs, CRM, reporting and global settings.

## Implemented Modules (Core Functionalities)

### 1) Billing / Invoicing
- Unified invoice workflow with customer auto-create.
- Live line-item calculations (subtotal, discount, tax, total).
- Multi-payment support (single/split methods).
- Invoice numbering via global settings prefix.
- Stock deduction at sale time.
- Invoice PDF generation and WhatsApp share link.
- Invoice cancellation with stock rollback.
- Partial/full return invoice creation with stock restock.

### 2) Repair Management
- Full repair ticket CRUD.
- Configurable repair status workflow from global settings.
- Parts + service total computation.
- Job card generation.
- One-click repair-to-invoice conversion.

### 3) Inventory Management
- Product CRUD, barcode/SKU/name search.
- Low-stock thresholds per product and default from settings.
- Manual stock adjustment endpoint with movement log.
- Stock movement history across sale/return/cancel/adjustment.

### 4) CRM
- Customer CRUD.
- Customer history endpoint with invoices, returns, repairs and spend summary.

### 5) Reporting
- Dashboard: inventory/customers/repairs/invoices/open repairs/low stock/gross/returns/net sales.
- Sales report endpoint for date ranges.

### 6) Global Settings Module
- Shop profile (name/contact/address/GST/currency/locale).
- Billing defaults (invoice prefixes, tax rate, payment methods, low-stock default).
- Repair status workflow and default status.
- Inventory controls (negative stock rule, low-stock alert flag).
- WhatsApp template toggle and message template.

### 7) Operations / Security / Reliability
- Modular backend architecture (`src/lib`, `src/routes`).
- Role-based API authorization via `X-API-Key`.
- Audit logs for critical actions.
- Backup and restore endpoints.
- Health, readiness, metrics endpoints.
- Offline sync pull/push with LWW conflict policy and duplicate operation suppression.

## Run Locally

```bash
npm run dev
```

## How to Preview the Application

1. Start the app:
   ```bash
   npm run dev
   ```
2. Open browser:
   - `http://localhost:3000`
3. In the UI, set API key (top Access section):
   - Admin: `admin-key`
   - Cashier: `cashier-key`
   - Technician: `tech-key`
4. Click **Load Settings** first, then use modules:
   - Add products
   - Build invoice lines and complete invoice
   - Create repair tickets and generate job card / invoice
   - Use stock adjustment
   - Refresh dashboard and sales report

## API Overview
- Settings: `GET/PATCH /api/settings`
- Products: `POST/GET/PATCH/DELETE /api/products`, `POST /api/inventory/adjust`
- Customers: `POST/GET/PATCH/DELETE /api/customers`, `GET /api/customers/:id/history`
- Repairs: `POST/GET/PATCH/DELETE /api/repairs`, `POST /api/repairs/:id/job-card`, `POST /api/repairs/create-invoice`
- Invoices: `POST/GET /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices/:id/cancel`, `POST /api/invoices/:id/return`
- Reports: `GET /api/dashboard`, `GET /api/reports/sales`
- Sync: `GET /api/sync/pull`, `POST /api/sync/push`
- Ops/Admin: `GET /api/health`, `GET /api/ready`, `GET /api/metrics`, `GET /api/admin/backup`, `POST /api/admin/restore`, `GET /api/audit-logs`

## Deployment
Persist `data/` volume in production to retain DB, backups, invoice PDFs, and job cards.
