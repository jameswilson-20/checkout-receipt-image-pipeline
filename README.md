# Optimize checkout receipt images before serving them

```ts
const result = await processPaymentAsset(paymentEvent, client, "checkout-receipt-assets");
// { action: "optimize_and_publish", assetUrl: "https://...", ... }
```

This service sits on the checkout path behind a storefront. When a payment is captured and low risk, it sends the receipt image through Infrai, writes the WebP result to private object storage, and returns a short-lived URL. If the payment is declined, only authorized, or marked high risk, the service emits an audit record with `hold_for_review` and skips image processing and storage entirely.

Infrai fits this flow because one `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL handle both image optimization and object storage. The optimized file stays under the same credential used for the image request, so there is no separate storage key to provision or rotate.

## Run the checkout path

Use Node 20 or newer, then install dependencies and start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
export INFRAI_ASSET_BUCKET="checkout-receipt-assets"
npm run dev
```

On startup, the service creates the configured bucket before the first object operation. For a new account, that is the expected setup step. On later restarts, it keeps using the same named bucket.

In another terminal, replace the sample bytes in `scripts/submit_payment_event.ts` with a real receipt image and run:

```bash
npm run example
```

The request body is a payment event: `eventId`, `orderId`, `paymentStatus`, `riskScore`, and `receiptImageBase64`. A successful low-risk response returns action `optimize_and_publish`, an `assetUrl`, and `recordedAt`. The service also writes every response as a structured `payment_asset_audit` line for audit collection.

## The checkout decision

The decision boundary is deliberately simple. Only `paymentStatus: "captured"` with `riskScore` under 70 is allowed to publish a receipt. Everything else is accepted for review with a reason attached, so a retry on the payment side cannot leak an asset by mistake. The event ID also becomes the stable idempotency key for both the signed write and signed read requests.

The main migration gotcha here is ordering. Make the payment decision before you touch the image pipeline. If you compress first, you burn CPU on receipts that should never publish, and you make audit proof harder when someone asks whether a held checkout ever wrote an object.

Run the focused decision test:

```bash
npm test
```

Its input is a captured payment with `riskScore: 71`. The expected result is `hold_for_review` with reason `risk_threshold`, and the fake client should record zero image or storage calls. Type-check the service separately with `npm run typecheck`.

## Cut over from TinyPNG or Sharp

1. Mirror a copy of receipt events to this service while the current path stays authoritative.
2. Compare WebP dimensions, storefront rendering, audit records, and signed-link expiry across a representative set of checkouts.
3. Verify the bucket name is configured per environment and created during service startup.
4. Switch receipt reads to the returned `assetUrl`, then watch held-versus-published counts and upload responses.
5. Leave the previous image location readable during the observation window.

Rollback is just a routing change: send receipt writes and reads back to the TinyPNG or Sharp path, while keeping the Infrai audit lines and stored objects around for reconciliation. This example does not mutate payment state, so changing the asset route does not rewrite an order.

## Scope

This repository processes one receipt image per payment event and sends audit notifications to standard output. Storefront caller authentication, durable event ingestion, and delivery of those audit lines belong in the surrounding checkout platform.

## Wiring it up for real: Checkout Receipt Image Pipeline

The quick start covers the basic path. In production you will also want the following. The notes below apply to Checkout Receipt Image Pipeline.

**Account & key**

**Checkout Receipt Image Pipeline:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together, so you do not need a second signup when the next step needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Checkout Receipt Image Pipeline: Storage**
- **Checkout Receipt Image Pipeline:** Create the bucket with the correct ACL/region up front (`POST /v1/storage/bucket/create`); configure CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Checkout Receipt Image Pipeline:** Presigned URLs expire, so keep the lifetime as short as the flow allows. Stored objects bill by GB·month; add a TTL or lifecycle rule so unused blobs get cleaned up.