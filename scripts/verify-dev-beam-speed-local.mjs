#!/usr/bin/env node
/**
 * Local DEV verification for beam + cruising speed.
 * Admin uses a local proxy so the DEV service-role key never enters the browser.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PRODUCTION_REF = "xikbibxyinttllxamgao";
const DEV_REF = "vkheexbapykcdfbqcach";
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 9998;
const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) throw new Error("Missing .env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const DEV_URL = String(process.env.SUPABASE_DEV_URL || "").replace(/\/$/, "");
const DEV_KEY = process.env.SUPABASE_DEV_SERVICE_ROLE_KEY || "";
if (!DEV_URL.includes(DEV_REF)) throw new Error("SUPABASE_DEV_URL must target DEV project only");
if (DEV_URL.includes(PRODUCTION_REF)) throw new Error("Refusing production URL");

const devHeaders = {
  apikey: DEV_KEY,
  Authorization: `Bearer ${DEV_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

async function devQuery(path, opts = {}) {
  const res = await fetch(`${DEV_URL}/rest/v1/${path}`, { headers: devHeaders, ...opts });
  const text = await res.text();
  if (!res.ok) throw new Error(`DEV ${path} ${res.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

const TEST_BEAM = 37.25;
const TEST_SPEED = 20.5;
const SHIP_ID = "891ac463-070c-4291-9f23-a53631e40e22";
const SHIP_NAME = "Adventure of the Seas";
const CRUISE_LINE = "Royal Caribbean International";

function patchAdminJs(source) {
  return source
    .replace(
      'const SUPABASE_URL = "https://xikbibxyinttllxamgao.supabase.co"',
      `const SUPABASE_URL = "${PROXY_URL}"`
    )
    .replace(
      'const SUPABASE_KEY = "sb_publishable_MEFg6spz5_Uod7sZGU8whw_UvOQDW60"',
      'const SUPABASE_KEY = "local-dev-verify-anon-placeholder"'
    )
    .replace(
      "initAdmin();",
      `(async function __devVerifyInit(){
        document.body?.classList?.remove("admin-loading-active");
        if (typeof window.AdminHeight?.start === "function") window.AdminHeight.start();
        await loadAdminData();
        activeTab = "cruise-ships";
        ciSubView = "ships";
        editingCiShipId = "${SHIP_ID}";
        renderAdmin();
      })();`
    );
}

function startDevProxy() {
  const server = http.createServer(async (req, res) => {
    try {
      const target = `${DEV_URL}${req.url}`;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          apikey: DEV_KEY,
          authorization: `Bearer ${DEV_KEY}`,
          "content-type": req.headers["content-type"] || "application/json",
          accept: req.headers.accept || "application/json",
          prefer: req.headers.prefer || ""
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body
      });
      const out = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "access-control-allow-origin": "*"
      });
      res.end(out);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error.message || error));
    }
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, PROXY_HOST, () => resolve(server)));
}

function waitForUrl(baseUrl, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${baseUrl}/admin.html`, { method: "HEAD" });
        if (res.ok) return resolve();
      } catch {
        /* retry */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("Local dev server not reachable"));
      setTimeout(tick, 800);
    };
    tick();
  });
}

const originalRows = await devQuery(
  `ci_cruise_ships?select=id,name,beam_metres,cruising_speed_knots,gross_tonnage,passenger_capacity&id=eq.${SHIP_ID}&limit=1`
);
const original = originalRows[0];
if (!original) throw new Error("Test ship not found on DEV");

const report = {
  ship: `${SHIP_NAME} (${SHIP_ID}) — ${CRUISE_LINE}`,
  valuesEntered: { beam_metres: TEST_BEAM, cruising_speed_knots: TEST_SPEED },
  saveResult: null,
  reloadResult: null,
  myShipResult: null,
  defects: [],
  devOnly: true,
  pushedOrDeployed: false
};

const baseUrl = process.env.VERIFY_BASE_URL || "http://localhost:8888";
const proxyServer = await startDevProxy();

try {
  await waitForUrl(baseUrl);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route("**/js/admin.js*", async (route) => {
    const response = await route.fetch();
    const body = patchAdminJs(await response.text());
    await route.fulfill({
      response,
      body,
      headers: { ...response.headers(), "content-type": "application/javascript" }
    });
  });

  await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
  await page.waitForSelector("#ciShipBeam", { timeout: 45000 });
  await page.fill("#ciShipBeam", String(TEST_BEAM));
  await page.fill("#ciShipCruisingSpeed", String(TEST_SPEED));
  await page.click("#ciShipSaveBtn");
  await page.waitForFunction(() => /Ship saved/i.test(document.body.innerText), { timeout: 20000 });

  report.saveResult = {
    ui: "Ship saved.",
    beamField: await page.inputValue("#ciShipBeam"),
    speedField: await page.inputValue("#ciShipCruisingSpeed")
  };

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#ciShipBeam", { timeout: 45000 });
  report.reloadResult = {
    beamField: await page.inputValue("#ciShipBeam"),
    speedField: await page.inputValue("#ciShipCruisingSpeed")
  };

  const dbAfterAdmin = await devQuery(
    `ci_cruise_ships?select=beam_metres,cruising_speed_knots&id=eq.${SHIP_ID}&limit=1`
  );
  report.reloadResult.database = dbAfterAdmin[0];

  const devShipRows = await devQuery(
    `ci_cruise_ships?select=id,name,slug,status,cruise_line_id,passenger_capacity,crew_count,deck_count,stateroom_count,cabin_type_summary,stateroom_breakdown,length_metres,gross_tonnage,beam_metres,cruising_speed_knots,year_built,year_refurbished,facilities,hero_image_url,updated_at,ci_cruise_lines(name)&id=eq.${SHIP_ID}&limit=1`
  );
  const devRow = devShipRows[0];
  const getShipPayload = {
    success: true,
    source: "supabase",
    ship: {
      id: devRow.id,
      name: devRow.name,
      cruise_line_id: devRow.cruise_line_id,
      cruise_line_name: devRow.ci_cruise_lines?.name || CRUISE_LINE,
      passenger_capacity: devRow.passenger_capacity,
      crew_count: devRow.crew_count,
      deck_count: devRow.deck_count,
      stateroom_count: devRow.stateroom_count,
      stateroom_types: devRow.cabin_type_summary,
      stateroom_breakdown: devRow.stateroom_breakdown,
      length_meters: devRow.length_metres,
      gross_tonnage: devRow.gross_tonnage,
      beam_metres: devRow.beam_metres,
      cruising_speed_knots: devRow.cruising_speed_knots,
      year_built: devRow.year_built,
      year_refurbished: devRow.year_refurbished,
      facilities: devRow.facilities,
      hero_image_url: devRow.hero_image_url,
      current_status: devRow.status,
      slug: devRow.slug,
      deck_plan_url: null
    }
  };

  const shipPage = await browser.newPage();
  await shipPage.route("**/.netlify/functions/get-ship*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(getShipPayload)
    });
  });
  await shipPage.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await shipPage.evaluate((line) => {
    activateCustomerSession({
      token: "dev-beam-speed-verify",
      booking: {
        base44_booking_id: "dev-beam-speed-verify",
        booking_reference: "DEVBEAM01",
        cruise_ship: "Adventure of the Seas",
        cruise_line: line,
        departing_date: "2026-12-01",
        arriving_date: "2026-12-08",
        passenger1_first_name: "Verify",
        passenger1_last_name: "Local"
      }
    });
  }, CRUISE_LINE);
  await shipPage.evaluate(() => renderTheShip());
  await shipPage.waitForSelector(".ship-stat-list", { timeout: 30000 });

  const myShipText = await shipPage.locator(".ship-info-grid").innerText();
  const spaceTrigger = shipPage.locator("[data-ship-space-ratio-trigger]");
  await spaceTrigger.click();
  await shipPage.waitForFunction(() => document.querySelector(".ship-space-ratio-popover--portaled:not([hidden])"));
  const desktopPopoverVisible = await shipPage.locator(".ship-space-ratio-popover--portaled").isVisible();
  await shipPage.keyboard.press("Escape");

  await shipPage.setViewportSize({ width: 390, height: 1200 });
  await spaceTrigger.click();
  const inlineVisible = await shipPage.locator(".ship-space-ratio-inline-panel:not([hidden])").isVisible();
  await shipPage.keyboard.press("Escape");

  const getShipLiveRes = await fetch(
    `${baseUrl}/.netlify/functions/get-ship?${new URLSearchParams({ name: SHIP_NAME, cruise_line: CRUISE_LINE })}`
  );
  const getShipLiveJson = await getShipLiveRes.json();
  const expectedSpaceRatio = (original.gross_tonnage / original.passenger_capacity).toFixed(1);

  report.myShipResult = {
    getShipLiveStatus: getShipLiveRes.status,
    getShipLiveError: getShipLiveJson.error || null,
    getShipSource: getShipPayload.source,
    getShipBeam: getShipPayload.ship.beam_metres,
    getShipSpeed: getShipPayload.ship.cruising_speed_knots,
    gridContainsWidth: /Width \(beam\)/i.test(myShipText) && /37 metres/i.test(myShipText),
    gridContainsSpeed: /Cruising speed/i.test(myShipText) && /\b21 knots\b/.test(myShipText),
    gridContainsSpaceRatio: /Space ratio/i.test(myShipText) && /GT per guest/i.test(myShipText) && myShipText.includes(expectedSpaceRatio.split(".")[0]),
    desktopExplainer: desktopPopoverVisible,
    mobileInlineExplainer: inlineVisible,
    sampleGridText: myShipText.split("\n").filter((l) => /beam|speed|Space ratio/i.test(l)).slice(0, 10)
  };

  if (Number(report.reloadResult.beamField) !== TEST_BEAM) report.defects.push("Admin reload beam field mismatch");
  if (Number(report.reloadResult.speedField) !== TEST_SPEED) report.defects.push("Admin reload speed field mismatch");
  if (Number(dbAfterAdmin[0].beam_metres) !== TEST_BEAM) report.defects.push("DEV DB beam mismatch after save");
  if (Number(dbAfterAdmin[0].cruising_speed_knots) !== TEST_SPEED) report.defects.push("DEV DB speed mismatch after save");
  if (!report.myShipResult.gridContainsWidth) report.defects.push("My Ship missing width (beam) display");
  if (!report.myShipResult.gridContainsSpeed) report.defects.push("My Ship cruising speed not shown as whole number (21 knots)");
  if (!report.myShipResult.gridContainsSpaceRatio) report.defects.push("My Ship space ratio missing or incorrect");
  if (!report.myShipResult.desktopExplainer) report.defects.push("Desktop space ratio explainer did not open");
  if (!report.myShipResult.mobileInlineExplainer) report.defects.push("Mobile inline space ratio explainer did not open");
  if (getShipLiveJson.success !== true) {
    report.defects.push(`Live get-ship on DEV local returned ${getShipLiveJson.error || getShipLiveRes.status} (DEV schema missing deck_plan columns)`);
  }

  await browser.close();
} finally {
  proxyServer.close();
  await devQuery(`ci_cruise_ships?id=eq.${SHIP_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      beam_metres: original.beam_metres,
      cruising_speed_knots: original.cruising_speed_knots
    })
  }).catch((err) => {
    report.defects.push(`Restore failed: ${err.message}`);
  });
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.defects.length ? 1 : 0);
