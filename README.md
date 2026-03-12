# Phoneix Mobiles - Billing, Inventory, Repair Management

Production-oriented deployable Node.js application delivering:

- Unified billing screen with customer auto-create and real-time totals.
- Product and inventory management with stock updates and low stock dashboard alerts.
- Repair ticket lifecycle with one-click invoice generation.
- Invoice PDF generation and WhatsApp deep-link sharing flow.
- Offline-first browser queue with sync push/pull APIs.

## Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## API Overview

- `POST /api/products`, `GET /api/products`, `PATCH/DELETE /api/products/:id`
- `POST /api/customers`, `GET /api/customers`, `PATCH/DELETE /api/customers/:id`
- `POST /api/repairs`, `GET /api/repairs`, `PATCH/DELETE /api/repairs/:id`
- `POST /api/repairs/create-invoice`
- `POST /api/invoices`, `GET /api/invoices`
- `GET /api/dashboard`
- `GET /api/sync/pull`, `POST /api/sync/push`

## Deployment

Deploy as a single Node service. Persist `data/` volume to retain DB and generated PDF invoices.
