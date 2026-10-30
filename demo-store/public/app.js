// Storefront. The cart lives in localStorage and is sent to the server as-is,
// prices included.
const fmt = (n) => `$${n.toFixed(2)}`;
const cart = JSON.parse(localStorage.getItem("kiln-cart") || "[]");

function saveCart() {
  localStorage.setItem("kiln-cart", JSON.stringify(cart));
  renderCart();
}

function addToCart(product) {
  const line = cart.find((l) => l.sku === product.sku);
  if (line) line.quantity += 1;
  else cart.push({ sku: product.sku, name: product.name, price: product.price, quantity: 1 });
  saveCart();
}

function renderCart() {
  const list = document.getElementById("cart-lines");
  list.innerHTML = "";
  for (const line of cart) {
    const li = document.createElement("li");
    li.textContent = `${line.quantity} x ${line.name}`;
    const amount = document.createElement("span");
    amount.textContent = fmt(line.price * line.quantity);
    li.append(amount);
    list.append(li);
  }
  const total = cart.reduce((s, l) => s + l.price * l.quantity, 0);
  document.getElementById("cart-total").textContent = fmt(total);
}

async function renderProducts() {
  const products = await (await fetch("/api/products")).json();
  const grid = document.getElementById("products");
  for (const p of products) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `<div class="swatch ${p.image}"></div><h3></h3><span class="price"></span>`;
    card.querySelector("h3").textContent = p.name;
    card.querySelector(".price").textContent = fmt(p.price);
    const btn = document.createElement("button");
    btn.textContent = "Add to cart";
    btn.onclick = () => addToCart(p);
    card.append(btn);
    grid.append(card);
  }
}

function showResult(text) {
  document.getElementById("result").textContent = text;
}

async function loadPayPal() {
  const config = await (await fetch("/api/config")).json();
  if (!config.clientId) {
    document.getElementById("paypal-note").textContent =
      "Set PAYPAL_CLIENT_ID (a sandbox client id) to show the PayPal buttons.";
    return;
  }
  const script = document.createElement("script");
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=${config.currency}`;
  script.onload = () => {
    window.paypal
      .Buttons({
        async createOrder() {
          const res = await fetch("/api/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cart }),
          });
          const order = await res.json();
          if (!order.id) throw new Error(order.error || "Could not start checkout");
          return order.id;
        },
        async onApprove(data) {
          const res = await fetch(`/api/orders/${data.orderID}/capture`, { method: "POST" });
          const capture = await res.json();
          const status = await (await fetch(`/api/store-orders/${data.orderID}`)).json();
          showResult(`Order ${data.orderID}: ${status.status} (PayPal says ${capture.status || res.status})`);
          if (status.status === "paid") {
            cart.length = 0;
            saveCart();
          }
        },
        onError(err) {
          showResult(`Checkout failed: ${err.message || err}`);
        },
      })
      .render("#paypal-button-container");
  };
  document.head.append(script);
}

renderProducts();
renderCart();
loadPayPal();
