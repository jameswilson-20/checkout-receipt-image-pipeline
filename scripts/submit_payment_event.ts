const response = await fetch("http://localhost:3000/payment-events", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    eventId: "evt-checkout-1042",
    orderId: "order-1042",
    paymentStatus: "captured",
    riskScore: 18,
    receiptImageBase64: Buffer.from("replace-with-receipt-image-bytes").toString("base64"),
  }),
});

console.log(response.status, await response.json());

export {};
