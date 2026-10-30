import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createOrder, captureOrder, refundCapture } from "./paypal.js";
import { CATALOG } from "./catalog.js";
import { orders } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { PORT = 8888 } = process.env;

const app = express();
app.use(express.static(path.join(here, "public")));
app.use(express.json());

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/products", (req, res) => {
  res.json(Object.values(CATALOG));
});

app.get("/api/config", (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID || null, currency: "USD" });
});

// Create a PayPal order for whatever is in the browser's cart.
app.post("/api/orders", async (req, res) => {
  try {
    const { cart } = req.body;
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const { jsonResponse, httpStatusCode } = await createOrder(total);
    if (jsonResponse.id) {
      orders.set(jsonResponse.id, { id: jsonResponse.id, status: "created", cart, total });
    }
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to create order." });
  }
});

// Buyer approved in the PayPal popup - take the money.
app.post("/api/orders/:orderID/capture", async (req, res) => {
  try {
    const { orderID } = req.params;
    const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
    const order = orders.get(orderID);
    if (order && jsonResponse.status === "COMPLETED") {
      order.status = "paid";
      order.captureId = jsonResponse.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    }
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to capture order:", error);
    res.status(500).json({ error: "Failed to capture order." });
  }
});

app.post("/api/orders/:orderID/refund", async (req, res) => {
  try {
    const order = orders.get(req.params.orderID);
    if (!order?.captureId) {
      return res.status(409).json({ error: "Order has no capture to refund." });
    }
    const { jsonResponse, httpStatusCode } = await refundCapture(order.captureId, order.total.toFixed(2));
    if (httpStatusCode < 300) order.status = "refunded";
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to refund order:", error);
    res.status(500).json({ error: "Failed to refund order." });
  }
});

// The receipt page polls this.
app.get("/api/store-orders/:orderID", (req, res) => {
  const order = orders.get(req.params.orderID);
  if (!order) return res.status(404).json({ error: "Unknown order" });
  res.json({ id: order.id, status: order.status, total: order.total, captureId: order.captureId ?? null });
});

// PayPal posts payment events here (subscribed in the developer dashboard).
app.post("/api/paypal/webhook", async (req, res) => {
  const event = req.body;
  const orderID = event.resource?.supplementary_data?.related_ids?.order_id;
  const order = orders.get(orderID);
  if (order && (event.event_type === "PAYMENT.CAPTURE.COMPLETED" || event.event_type === "PAYMENT.CAPTURE.PENDING")) {
    order.status = "paid";
    order.captureId = event.resource.id;
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Kiln & Co. listening at http://localhost:${PORT}/`);
});
