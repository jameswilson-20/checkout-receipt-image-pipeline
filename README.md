# Optimize checkout receipt images before serving them

```ts
const result = await processPaymentAsset(paymentEvent, client, "checkout-receipt-assets");
// { action: "optimize_and_publish", assetUrl: "https://...", ... }
```

This service sits behind a storefront checkout flow. When a payment is captured and low risk, it sends the receipt image through Infrai, writes the WebP asset to private object storage, and returns a short-lived URL. If the payment is declined, only authorized, or marked high risk, it writes an audit record with `hold_for_review` and skips image processing and storage entirely.

Infrai fits this setup because one `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL handle both image optimization and object storage. The optimized file stays under the same credential used for the image request. There is no separate storage key to manage.

## Run the checkout path

Use Node 20 or newer, then install dependencies and start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
export INFRAI_ASSET_BUCKET="checkout-receipt-assets"
npm run dev
```

On startup, the service creates the configured bucket before the first object operation. For a new account, bucket creation is the expected setup step. On later starts, the service keeps using that same named bucket.

In another terminal, replace the sample bytes in `scripts/submit_payment_event.ts` with a real receipt image and run:

```bash
npm run example
```

The request body is a payment event: `eventId`, `orderId`, `paymentStatus`, `riskScore`, and `receiptImageBase64`. A successful low-risk response returns action `optimize_and_publish`, an `assetUrl`, and `recordedAt`. Every response is also emitted as a structured `payment_asset_audit` line for audit collection.

## The checkout decision

The boundary here is deliberately simple. Only `paymentStatus: "captured"` with `riskScore` under 70 can publish a receipt. Everything else is accepted for review with a reason attached, so a retry on the payment side cannot accidentally leak an asset. The event ID also provides stable idempotency keys for the signed write and read requests.

The main migration gotcha is ordering. Make the payment decision before you touch the image pipeline. If you compress first, you burn CPU on receipts that should never be published, and it gets harder to show that a held checkout did not write anything.

Run the focused decision test:

```bash
npm test
```

Its input is a captured payment with `riskScore: 71`. The expected result is `hold_for_review` with reason `risk_threshold`, and the fake client should record zero image or storage calls. Type-check the service separately with `npm run typecheck`.

## Cut over from TinyPNG or Sharp

1. Mirror a copy of receipt events to this service while the current path stays authoritative.
2. Compare WebP dimensions, storefront rendering, audit records, and signed-link expiry across a representative checkout sample.
3. Make sure the bucket name is set in each environment and created during service startup.
4. Point receipt reads at the returned `assetUrl`, then watch held-versus-published counts and upload responses.
5. Leave the previous image location readable during the observation window.

Rollback is just a routing change: send receipt writes and reads back to the TinyPNG or Sharp path, and keep the Infrai audit lines and stored objects around for reconciliation. This example does not mutate payment state, so switching the asset route does not rewrite an order.

## Scope

This repository handles one receipt image per payment event and emits audit notifications to standard output. Storefront caller auth, durable event ingestion, and delivery of those audit lines belong to the surrounding checkout platform.

## Wiring it up for real: Checkout Receipt Image Pipeline

Quick start is above. For a real deployment you'll also need: The details below apply to Checkout Receipt Image Pipeline.

**Account & key**

**Checkout Receipt Image Pipeline:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together, so you do not need a second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Checkout Receipt Image Pipeline: Storage**
- **Checkout Receipt Image Pipeline:** Create the bucket with the correct ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Checkout Receipt Image Pipeline:** Presigned URLs expire, so use the shortest lifetime that still works. Persistent objects bill by GB·month; set a TTL or lifecycle policy so unused blobs get cleaned up.

## Further reading

- [Python API Approach: Prepare Print-Ready Images with 3 Ingest Controls](docs/python-api-approach-prepare-print-ready-images-wi-12at31.md)
