# Shopify Freshness Tracker

An embedded Shopify app for stores that sell perishable goods. Merchants record stock in **batches**, each with a quantity and an expiration date, and see which products are fresh, close to expiry or expired. When an order is fulfilled, stock is meant to come out of the soonest-expiring batch first (**FEFO**, first expired, first out).

It's a portfolio project, built to show custom Shopify app work end to end. It runs on a development store only.

## Status

| Area                                                    | State                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| Batch tracking on the product page                      | Done                                                             |
| Freshness dashboard                                     | Done                                                             |
| Fulfillment and compliance webhooks                     | Done: signature-verified; fulfillments deduplicated and recorded |
| FEFO decrement, per-product lock and line-item grouping | Done as tested building blocks                                   |
| Decrementing batches when an order is fulfilled         | In progress: the webhook handler doesn't call these yet          |

## Features

**Product page panel** (Admin UI extension on the product details page)

- Add, edit and remove batches, each with a quantity and an expiration date. Every row shows a live status badge.
- Validation: quantity must be a whole number from 1 to 1,000,000,000, and the expiration date is required. Past dates are allowed, because expired stock exists until it's removed.
- A non-blocking warning when the batches add up to more than the product's tracked inventory.
- Load and save errors are shown in the panel, never silently swallowed. Most failed loads can be retried in place.

**Dashboard** (the app's home page)

- Each product's overall status, earliest expiry and a per-batch breakdown. Sold-out batches are marked as such. It shows the first 50 products by title and up to 10 batches each.
- An empty state when the store has no products.

**Privacy page** (`/app/privacy`)

- Renders [PRIVACY.md](PRIVACY.md) inside the admin. It's linked from the app nav and the dashboard.

## How it works

```
Product page panel ──writes──▶ freshness_batch metaobjects (quantity, expiration_date)
                               product metafields: freshness_batches (list of batches)
                                                   earliest_expiration_date (readable in Liquid)
Dashboard ──reads──▶ the same metaobjects and metafields through the Admin GraphQL API

fulfillments/create webhook ─▶ verify HMAC ─▶ skip duplicates ─▶ group line items by product
                            ─▶ per-product lock ─▶ FEFO decrement ─▶ write batches  (last four steps in progress)
```

**Freshness status is computed on every view, never stored.** It comes from each batch's expiration date and the shop's local "today":

| Status   | Rule                           |
| -------- | ------------------------------ |
| Expired  | the expiration date has passed |
| Use Soon | expires today or within 3 days |
| Fresh    | otherwise                      |

A product's status is that of its worst in-stock batch, or **Not set** when it has no in-stock batch with a date.

## Key decisions

- **Plain calendar dates.** Batches store `YYYY-MM-DD`. Days remaining is simple date subtraction in the shop's timezone, the way FEFO and inventory systems count it.
- **Expired stock is never decremented.** FEFO skips expired batches, because packing teams shouldn't ship them. Anything that fresh stock can't cover is reported as a shortfall, never driven negative.
- **A per-product lock** (Prisma, SQLite) serializes batch updates. Batches live in Shopify, not in the app's database, so a transaction can't protect them. The lock expires after 30 seconds, so a crashed holder frees it, and release only deletes the caller's own lock.
- **`fulfillments/create`, not `orders/paid`.** Stock leaves on shipment, and partial fulfillments arrive as separate events. On a real partial fulfillment, the payload's `quantity` was the units shipped in that fulfillment.
- **Minimal data access.** The scopes are `write_products`, `read_metaobjects` and `read_fulfillments`. The app requests no protected customer fields, which Shopify's docs say are then redacted from payloads, and it stores no customer data.
- **Pure logic in `shared/`.** Freshness, FEFO, validation and grouping are pure functions with unit tests. Routes and the extension call them instead of re-implementing the rules.

## Tech stack

|                      |                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------- |
| App framework        | React Router 7, `@shopify/shopify-app-react-router`                                          |
| UI                   | Polaris web components, Preact (admin extension)                                             |
| Data                 | Shopify metaobjects and metafields; Prisma with SQLite for sessions, webhook dedup and locks |
| Shopify APIs         | Admin GraphQL API and webhooks, version 2026-07                                              |
| Language and runtime | TypeScript (ES2024), Node.js 22.12 or newer                                                  |
| Tests                | Vitest, against a separate SQLite test database                                              |

## Project structure

```
app/
  routes/        dashboard, privacy page, auth, webhook handlers
  product-lock.server.ts
  webhooks.server.ts
extensions/
  freshness-panel/   product page Admin UI extension
shared/          pure, unit-tested logic used by the app and the extension
prisma/          schema and migrations
```

## Running locally

You need Node.js 22.12 or newer, a [Shopify Partner](https://www.shopify.com/partners) account and a development store.

```shell
npm install
echo 'DATABASE_URL="file:dev.sqlite"' > .env   # the CLI supplies the Shopify credentials
npm run config:link               # connect the config to your own app
npm run setup                     # generate the Prisma client and create the database
npm run dev                       # start the app and tunnel through the Shopify CLI
```

Subscribing to `fulfillments/create` needs **protected customer data** access. Select it in your app's dashboard under API access requests, and complete the data protection details. No customer fields are needed.

## Testing and quality

```shell
npm test                # unit and integration tests
npm run typecheck       # app types, including generated route types
npm run typecheck:ext   # extension types
npm run lint
```

Tests that touch the database recreate `prisma/test.sqlite` from the migrations on every run, so they never touch development data. Git hooks run lint-staged on commit, check commit messages against Conventional Commits, and run every check above (plus a format check) before a push.

## Privacy

[PRIVACY.md](PRIVACY.md) covers what the app receives and stores, retention and the data processing terms.
