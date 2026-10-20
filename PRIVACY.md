# Privacy and data use

This notice describes the personal data Freshness Tracker processes, why, and how long it keeps it. Installing the app on a store means the merchant accepts these terms.

## What the app receives

- **Fulfillment webhooks (`fulfillments/create`).** The app uses only each line item's product ID and fulfilled quantity, to decrement that product's expiry-tracked batches. The decrement is still being built: until it ships, these webhooks are acknowledged and their contents discarded.
- **No customer fields.** The app doesn't request access to customer names, email addresses, phone numbers or addresses, so Shopify redacts them before delivery.
- **Product data** (titles, inventory totals, batch quantities and expiry dates). This isn't personal data.

## What the app stores

- **No customer personal data.** Fulfillment payloads are processed and then discarded.
- **The store's session:** shop domain, granted scopes, and an expiring offline access token with its refresh token. These are needed to call the Admin API. The app uses offline sessions only, so no staff names or emails are stored.
- **Webhook IDs and topics,** so a redelivered webhook isn't applied twice.
- **Short-lived product locks:** shop domain and product ID, expiring after 30 seconds.
- **Batch records in the merchant's own store,** as metaobjects and metafields.

The app doesn't sell, share or transfer data to third parties, and it doesn't use data for advertising, profiling or automated decisions about customers.

## Retention and deletion

- **Uninstall:** the app deletes the store's session and locks.
- **Shop data erasure:** Shopify's `shop/redact` webhook, sent after uninstall, deletes them again in case anything was left.
- **Batch records:** these stay in the merchant's store, under the merchant's control.
- **Webhook IDs:** these are kept for deduplication. They contain no personal data.

## Security

- **In transit:** data travels over HTTPS.
- **At rest:** the database is a SQLite file on a full-disk-encrypted machine. A production deployment must use storage that is encrypted at rest.
- **Scope:** the app is installed only on a development store.

## Data processing terms

Freshness Tracker is a portfolio project, not a commercial product. It is installed only on its developer's development store. These terms are the agreement between the developer and any merchant who installs it.

- **Roles:** the merchant controls their customers' data. The app processes it only on the merchant's behalf, through Shopify.
- **Instructions:** data is processed only to decrement expiry-tracked batches when an order is fulfilled.
- **Confidentiality:** the data isn't disclosed to anyone except the sub-processors below.
- **Sub-processors:**
  - Shopify, the platform the app runs on.
  - Cloudflare, whose tunnel carries webhook traffic to the app in development (transit only).
- **Security:** as described under Security above.
- **Breaches:** the merchant is notified without undue delay after the developer becomes aware of a breach affecting their data.
- **Customer requests:** the app stores no customer personal data. It acknowledges Shopify's `customers/data_request` and `customers/redact` webhooks, and on request the developer confirms this to help the merchant answer a customer's access or deletion request.
- **Termination:** uninstalling the app ends processing and deletes the store's session and locks.

## Changes

If the app starts processing or storing any other personal data, this notice is updated before that change ships.
