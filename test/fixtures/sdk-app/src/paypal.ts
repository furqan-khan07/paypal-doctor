import { Client, Environment, OrdersController, CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import type { Request, Response } from "express";

const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID!,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  },
  environment: Environment.Sandbox,
});
const orders = new OrdersController(client);

type Line = { sku: string; price: number; qty: number };

export async function createOrder(req: Request, res: Response) {
  const { items } = req.body as { items: Line[] };
  const total = items.reduce((sum, line) => sum + line.price * line.qty, 0);
  const request = {
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [{ amount: { currencyCode: "USD", value: total.toFixed(2) } }],
    },
    prefer: "return=minimal",
  };
  const { body } = await orders.createOrder(request);
  res.json(JSON.parse(body as string));
}

export async function captureOrder(req: Request, res: Response) {
  const { result } = await orders.captureOrder({ id: req.params.orderID, prefer: "return=representation" });
  if (result.status === "COMPLETED") {
    markPaid(req.params.orderID);
  }
  res.json(result);
}

function markPaid(id: string) {
  console.log("paid", id);
}
