import assert from "node:assert/strict";
import test from "node:test";
import { processPaymentAsset, type AssetClient, type PaymentEvent } from "../src/payment_asset_workflow.js";

test("a high-risk captured payment is held without publishing its receipt", async () => {
  const calls: string[] = [];
  const client: AssetClient = {
    ensureBucket: async () => { calls.push("ensureBucket"); },
    resize: async () => { calls.push("resize"); return { image: "aW1hZ2U=" }; },
    presignPut: async () => { calls.push("presignPut"); return { url: "https://upload.example/object" }; },
    presignGet: async () => { calls.push("presignGet"); return { url: "https://download.example/object" }; },
  };
  const event: PaymentEvent = {
    eventId: "evt-risk-71",
    orderId: "order-2048",
    paymentStatus: "captured",
    riskScore: 71,
    receiptImageBase64: "aW1hZ2U=",
  };

  const result = await processPaymentAsset(event, client, "checkout-assets", () => new Date("2026-01-02T03:04:05Z"));

  assert.deepEqual(result, {
    eventId: "evt-risk-71",
    orderId: "order-2048",
    action: "hold_for_review",
    reason: "risk_threshold",
    recordedAt: "2026-01-02T03:04:05.000Z",
  });
  assert.deepEqual(calls, []);
});
