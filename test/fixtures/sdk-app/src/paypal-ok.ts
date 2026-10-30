// The same integration done right: nothing here should be flagged.
import { Client, Environment, OrdersController, CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { CATALOG } from "./catalog";

const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID!,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  },
  environment: process.env.PAYPAL_ENV === "live" ? Environment.Production : Environment.Sandbox,
});
const orders = new OrdersController(client);

export async function createOrderOk(req: Request, res: Response) {
  const { items } = req.body as { items: { sku: string; qty: number }[] };
  const cents = items.reduce((sum, line) => sum + CATALOG[line.sku].cents * line.qty, 0);
  const request = {
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [{ amount: { currencyCode: "USD", value: (cents / 100).toFixed(2) } }],
    },
    paypalRequestId: randomUUID(),
  };
  const { body } = await orders.createOrder(request);
  res.json(JSON.parse(body as string));
}

export async function captureOrderOk(req: Request, res: Response) {
  const { result } = await orders.captureOrder({ id: req.params.orderID, paypalRequestId: `capture-${req.params.orderID}` });
  const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
  if (capture?.status === "COMPLETED") {
    console.log("paid", req.params.orderID);
  }
  res.json(result);
}
