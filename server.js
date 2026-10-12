// DonutSMP Trades: serves the page and creates exact-price Whop checkouts.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const WHOP_API_KEY = process.env.WHOP_API_KEY || "";
const WHOP_COMPANY_ID = process.env.WHOP_COMPANY_ID || "";
const WHOP_API_BASE = process.env.WHOP_API_BASE || "https://api.whop.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://oceanlin0.github.io";

const CENTS_PER_MILLION = 5;   // $0.05 per 1M
const MIN_MILLIONS = 20;       // $1.00 minimum order
const MAX_MILLIONS = 2000;     // $100.00 maximum order

// Keep names and prices in sync with the items list in index.html.
const ITEMS = {
  "Netherite armor set": 600, "Netherite sword": 150, "Netherite pickaxe": 150, "Elytra": 300,
  "Skeleton spawner": 300, "Zombie spawner": 250, "Blaze spawner": 400, "Iron golem spawner": 500,
  "Netherite ingots x16": 500, "Diamonds x64": 200, "Emeralds x64": 250, "Obsidian x64": 100,
  "Totems of Undying x4": 200, "Enchanted golden apples x16": 300, "Ender pearls x16": 100, "Shulker box": 150
};

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, headers || {}));
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function cors(req) {
  const o = req.headers.origin;
  if (o && o === ALLOWED_ORIGIN) {
    return { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
  }
  return {};
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2048) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function whopCheckout(cents, title, meta) {
  const make = (withMeta) => {
    const body = {
      mode: "payment",
      plan: {
        company_id: WHOP_COMPANY_ID, currency: "usd", plan_type: "one_time",
        initial_price: cents / 100, release_method: "buy_now",
        product: { external_identifier: "donutsmp-order", title: "DonutSMP order" }
      }
    };
    if (withMeta) body.metadata = meta;
    return fetch(WHOP_API_BASE + "/api/v1/checkout_configurations", {
      method: "POST",
      headers: { Authorization: "Bearer " + WHOP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  };
  let r = await make(true);
  if (r.status === 400 || r.status === 422) r = await make(false);
  const text = await r.text();
  if (!r.ok) { console.error("Whop error", r.status, text.slice(0, 500)); throw new Error("whop"); }
  const j = JSON.parse(text);
  let url = j.purchase_url || (j.id ? "/checkout/" + j.id + "/" : "");
  if (!url) throw new Error("no url");
  if (url.startsWith("/")) url = "https://whop.com" + url;
  console.log("checkout", j.id, title, JSON.stringify(meta));
  return url;
}

async function handleCheckout(req, res) {
  const h = cors(req);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "Too many tries. Wait a minute and try again." }, h);
  if (!WHOP_API_KEY || !WHOP_COMPANY_ID) return send(res, 503, { error: "Checkout is not set up yet." }, h);
  let p;
  try { p = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: "Bad request." }, h); }
  const ign = String(p.ign || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(ign)) return send(res, 400, { error: "Enter your Minecraft username (3 to 16 letters, numbers or underscores)." }, h);
  let cents, title, meta;
  if (p.type === "money") {
    const m = Number(p.millions);
    if (!Number.isInteger(m) || m < MIN_MILLIONS || m > MAX_MILLIONS) return send(res, 400, { error: "Choose between " + MIN_MILLIONS + "M and " + MAX_MILLIONS + "M." }, h);
    cents = m * CENTS_PER_MILLION; title = m + "M money for " + ign; meta = { type: "money", millions: String(m), ign: ign };
  } else if (p.type === "item" && Object.prototype.hasOwnProperty.call(ITEMS, p.name)) {
    cents = ITEMS[p.name]; title = p.name + " for " + ign; meta = { type: "item", item: p.name, ign: ign };
  } else return send(res, 400, { error: "Unknown order." }, h);
  try { send(res, 200, { url: await whopCheckout(cents, title, meta) }, h); }
  catch (e) { send(res, 502, { error: "Could not start checkout. Try again in a moment." }, h); }
}

const page = fs.readFileSync(path.join(__dirname, "index.html"));
http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/checkout") {
    if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); return res.end(); }
    if (req.method === "POST") return handleCheckout(req, res);
    return send(res, 405, { error: "Use POST." });
  }
  if (url === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(PORT, () => console.log("listening on " + PORT));
