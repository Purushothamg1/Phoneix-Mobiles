# Phoneix Mobiles - Billing, Inventory, Repair Management (v2)

Production-hardened modular Node.js system for mobile retail and repair operations.

## Architecture

- Modular backend (`src/lib/*`, `src/routes/*`) with separated config, auth, db, audit, PDF, and domain services.
- File-backed datastore for local deployability, now with backup/restore and audit trails.
- Role-based API access via `X-API-Key` (`admin-key`, `cashier-key`, `tech-key` by default).
- Structured startup logs and operational endpoints.

## Core Capabilities

- Unified invoice flow: customer auto-create, stock-safe line validation, tax/discount totals, payment split validation, stock movement logs.
- Repair lifecycle: create tickets, job-card generation, one-click repair-to-invoice, status progression.
- Inventory + CRM: product search by name/SKU/barcode, customer history, low-stock insights.
- Sync: pull by timestamp, push with LWW conflict resolution and duplicate op suppression via `clientOpId`.
- Artifacts: standards-compliant minimal PDF invoices and text job cards.
- Operations: `/api/ready`, `/api/metrics`, `/api/admin/backup`, `/api/admin/restore`, `/api/audit-logs`.

## Run

```bash
npm run dev
```

Open `http://localhost:3000` and use an API key in the UI access field.

## API Overview

- Health/ops: `GET /api/health`, `GET /api/ready`, `GET /api/metrics`
- Products: `POST /api/products`, `GET /api/products?q=`, `PATCH/DELETE /api/products/:id`
- Customers: `POST /api/customers`, `GET /api/customers`, `GET /api/customers/:id/history`
- Repairs: `POST /api/repairs`, `GET /api/repairs`, `POST /api/repairs/:id/job-card`, `POST /api/repairs/create-invoice`
- Invoices: `POST /api/invoices`, `GET /api/invoices`
- Sync: `GET /api/sync/pull`, `POST /api/sync/push`
- Admin: `GET /api/admin/backup`, `POST /api/admin/restore`, `GET /api/audit-logs`

## Deployment

Deploy as a Node service; persist `data/` volume for DB, backups, invoice PDFs, and job cards.
