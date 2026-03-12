# Phoneix Mobiles - Billing, Inventory, Repair Management

Hardened single-service Node.js application for mobile retail + repair operations.

## Implemented Capabilities

- Unified billing workflow with line-item building, customer auto-create, discount/tax math, payment split validation, stock deductions, and stock movement logs.
- Inventory management with create/read/update/delete, low-stock thresholds, and search by name/SKU/barcode.
- Repair management with create/read/update/delete, parts + service cost totals, job-card generation, and one-click repair-to-invoice conversion.
- CRM with customer CRUD and customer history endpoint (purchase + repair summary).
- Offline-first client queue with sync push API and pull API with LWW (`updatedAt`) conflict policy.
- Invoice PDF-like artifact generation and WhatsApp deep-link generation.

## Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## API Overview

- `POST /api/products`, `GET /api/products?q=`, `PATCH/DELETE /api/products/:id`
- `POST /api/customers`, `GET /api/customers`, `PATCH/DELETE /api/customers/:id`
- `GET /api/customers/:id/history`
- `POST /api/repairs`, `GET /api/repairs`, `PATCH/DELETE /api/repairs/:id`
- `POST /api/repairs/:id/job-card`
- `POST /api/repairs/create-invoice`
- `POST /api/invoices`, `GET /api/invoices`
- `GET /api/stock-movements`
- `GET /api/dashboard`
- `GET /api/sync/pull`, `POST /api/sync/push`

## Deployment

Deploy as a Node service and persist `data/` for records and generated invoice/job-card artifacts.
