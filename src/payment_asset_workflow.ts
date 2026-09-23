import { z } from "zod";
import type { InfraiClient, ResizeResult } from "./infrai_client.js";

export const paymentEventSchema = z.object({
  eventId: z.string().min(1),
  orderId: z.string().min(1),
  paymentStatus: z.enum(["authorized", "captured", "declined"]),
  riskScore: z.number().min(0).max(100),
  receiptImageBase64: z.string().min(1),
});

export type PaymentEvent = z.infer<typeof paymentEventSchema>;

export type AssetDecision =
  | { action: "hold_for_review"; reason: "payment_not_captured" | "risk_threshold" }
  | { action: "optimize_and_publish"; objectKey: string };

export function decideAssetAction(event: PaymentEvent): AssetDecision {
  if (event.paymentStatus !== "captured") {
    return { action: "hold_for_review", reason: "payment_not_captured" };
  }
  if (event.riskScore >= 70) {
    return { action: "hold_for_review", reason: "risk_threshold" };
  }
  return {
    action: "optimize_and_publish",
    objectKey: `receipts/${event.orderId}/${event.eventId}.webp`,
  };
}

export type AuditNotification = {
  eventId: string;
  orderId: string;
  action: AssetDecision["action"];
  reason?: "payment_not_captured" | "risk_threshold";
  assetUrl?: string;
  recordedAt: string;
};

export type AssetClient = Pick<InfraiClient, "resize" | "ensureBucket" | "presignPut" | "presignGet">;

function decodeImage(result: ResizeResult): Uint8Array {
  const encoded = result.image.includes(",") ? result.image.slice(result.image.indexOf(",") + 1) : result.image;
  return Buffer.from(encoded, "base64");
}

export async function processPaymentAsset(
  event: PaymentEvent,
  client: AssetClient,
  bucket: string,
  now: () => Date = () => new Date(),
): Promise<AuditNotification> {
  const decision = decideAssetAction(event);
  if (decision.action === "hold_for_review") {
    return { ...decision, eventId: event.eventId, orderId: event.orderId, recordedAt: now().toISOString() };
  }

  await client.ensureBucket(bucket);
  const optimized = await client.resize(event.receiptImageBase64);
  const write = await client.presignPut(bucket, decision.objectKey, `put-${event.eventId}`);
  const upload = await fetch(write.url, {
    method: "PUT",
    headers: { "Content-Type": "image/webp" },
    body: new Uint8Array(decodeImage(optimized)),
  });
  if (!upload.ok) throw new Error(`Asset upload response ${upload.status}`);

  const read = await client.presignGet(bucket, decision.objectKey, `get-${event.eventId}`);
  return {
    eventId: event.eventId,
    orderId: event.orderId,
    action: decision.action,
    assetUrl: read.url,
    recordedAt: now().toISOString(),
  };
}
