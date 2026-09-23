import { createServer, type ServerResponse } from "node:http";
import { InfraiClient, InfraiError } from "./infrai_client.js";
import { paymentEventSchema, processPaymentAsset } from "./payment_asset_workflow.js";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

const client = new InfraiClient(apiKey);
const bucket = process.env.INFRAI_ASSET_BUCKET ?? "checkout-receipt-assets";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/payment-events") {
    json(response, 404, { error: "route_not_found" });
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = paymentEventSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) {
      json(response, 400, { error: "invalid_payment_event", issues: parsed.error.issues });
      return;
    }

    const notification = await processPaymentAsset(parsed.data, client, bucket);
    console.log(JSON.stringify({ type: "payment_asset_audit", ...notification }));
    json(response, notification.action === "hold_for_review" ? 202 : 201, notification);
  } catch (error) {
    if (error instanceof SyntaxError) {
      json(response, 400, { error: "invalid_json" });
    } else if (error instanceof InfraiError && error.status >= 400 && error.status < 500) {
      json(response, error.status, { error: error.code, message: error.message });
    } else {
      console.error(error);
      json(response, 502, { error: "asset_pipeline_failed" });
    }
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Checkout asset service listening on http://localhost:${port}`));
