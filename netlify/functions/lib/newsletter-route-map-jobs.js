const { createHmac, timingSafeEqual } = require("node:crypto");
const { getConfig, serviceHeaders } = require("../admin-auth");

async function rest(path, { method = "GET", body } = {}) {
  const { supabaseUrl } = getConfig();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Newsletter map database request failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function signature(timestamp) {
  return createHmac("sha256", getConfig().serviceKey).update(`newsletter-route-map-worker:${timestamp}`).digest("hex");
}

function authorizedWorker(headers = {}) {
  const timestamp = headers["x-newsletter-map-time"];
  const proof = headers["x-newsletter-map-signature"];
  if (!/^\d{13}$/.test(timestamp || "") || Math.abs(Date.now() - Number(timestamp)) > 60000 ||
      !/^[0-9a-f]{64}$/.test(proof || "")) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(signature(timestamp), "hex"));
}

async function dispatchWorker() {
  const url = process.env.URL;
  if (!url) throw new Error("Production site URL is unavailable");
  const timestamp = String(Date.now());
  const response = await fetch(new URL("/.netlify/functions/newsletter-route-map-worker-background", url), {
    method: "POST",
    headers: { "x-newsletter-map-time": timestamp, "x-newsletter-map-signature": signature(timestamp) },
    signal: AbortSignal.timeout(5000)
  });
  if (response.status !== 202) throw new Error("Map worker did not accept dispatch");
}

module.exports = { rest, authorizedWorker, dispatchWorker };
