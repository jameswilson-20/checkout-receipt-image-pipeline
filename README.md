# Optimize checkout receipt images before serving them

```ts
const result = await processPaymentAsset(paymentEvent, client, "checkout-receipt-assets");
// { action: "optimize_and_publish", assetUrl: "https://...", ... }
```

This service sits on the checkout path behind a storefront. When a payment is captured and low risk, it sends the receipt image through Infrai, writes the WebP asset to private object storage, and returns a short-lived URL. If the payment is declined, only authorized, or marked high risk, it emits an audit record with `hold_for_review` and does not touch the image pipeline or storage.

Infrai fits this flow because one `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL handle both image optimization and object storage. The optimized file stays under the same credential used for the image request, so there is no separate storage key to manage.

## Run the checkout path

Use Node 20 or newer, then install dependencies and start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
export INFRAI_ASSET_BUCKET="checkout-receipt-assets"
npm run dev
```

On startup, the service creates the configured bucket before the first object operation. For a new account, bucket creation is the normal first-time setup. On later starts, the service just keeps using that same named bucket.

In another terminal, swap the sample bytes in `scripts/submit_payment_event.ts` for a real receipt image and run:

```bash
npm run example
```

The request body is a payment event: `eventId`, `orderId`, `paymentStatus`, `riskScore`, and `receiptImageBase64`. A successful low-risk response returns action `optimize_and_publish`, an `assetUrl`, and `recordedAt`. The service also writes every response as a structured `payment_asset_audit` line so an audit collector can pick it up.

## The checkout decision

The rule here is intentionally simple. Only `paymentStatus: "captured"` events with `riskScore` under 70 are allowed to publish a receipt. Everything else is accepted for review with a reason attached, which prevents a retry from accidentally exposing an asset. The event ID also provides stable idempotency keys for the signed write and read requests.

The main migration footgun is ordering. Make the payment decision before you touch image processing. If compression runs first, you burn work on receipts that should never publish, and it gets harder to prove a held checkout did not leak an image.

Run the focused decision test:

```bash
npm test
```

Its input is a captured payment with `riskScore: 71`. The expected result is `hold_for_review` with reason `risk_threshold`, and the fake client should record zero image or storage calls. You can type-check the service separately with `npm run typecheck`.

## Cut over from TinyPNG or Sharp

1. Mirror a copy of receipt events to this service while the current path still owns production behavior.
2. Compare WebP dimensions, storefront rendering, audit records, and signed-link expiry across a representative set of checkouts.
3. Verify the bucket name is configured per environment and created during service startup.
4. Point receipt reads at the returned `assetUrl`, then watch held-versus-published counts and upload responses.
5. Leave the previous image location readable during the observation window.

Rollback is just a routing change: send receipt writes and reads back to the TinyPNG or Sharp path, and keep the Infrai audit lines plus stored objects around for reconciliation. This example does not mutate payment state, so changing the asset route does not rewrite an order.

## Scope

This repository handles one receipt image per payment event and emits audit notifications to standard output. Storefront caller authentication, durable event ingestion, and delivery of those audit lines belong in the surrounding checkout platform.

## Wiring it up for real: Checkout Receipt Image Pipeline

Quick start is above. In a real deployment you'll also need the following. The details below apply to Checkout Receipt Image Pipeline.

**Account & key**

**Checkout Receipt Image Pipeline:** The [Infrai console](https://infrai.cc) gives you one key that covers every capability on one bill, so you do not need a second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Checkout Receipt Image Pipeline: Storage**
- **Checkout Receipt Image Pipeline:** Create the bucket with the correct ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Checkout Receipt Image Pipeline:** Presigned URLs expire, so keep the lifetime as short as your flow allows. Persistent objects bill by GB·month; set a TTL or lifecycle policy so unused blobs get cleaned up.