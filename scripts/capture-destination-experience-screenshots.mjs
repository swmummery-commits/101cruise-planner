#!/usr/bin/env node
/**
 * Capture Destination Experience V2 review screenshots via local Chrome.
 * HOLD DEPLOY — local artifacts only (generated-assets is gitignored).
 */
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "generated-assets/destination-experience/caribbean-v2");
const chrome =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 8765 + Math.floor(Math.random() * 200);

fs.mkdirSync(outDir, { recursive: true });

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "/destination-experience.html" : urlPath;
  const filePath = path.join(root, rel.replace(/^\//, ""));
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
});

function runChrome(width, height, query, outfile) {
  return new Promise((resolve, reject) => {
    const target = `http://127.0.0.1:${port}/destination-experience.html?${query}`;
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      `--screenshot=${outfile}`,
      "--force-device-scale-factor=1",
      "--virtual-time-budget=15000",
      target
    ];
    const child = spawn(chrome, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && fs.existsSync(outfile)) resolve();
      else reject(new Error(`Chrome exited ${code} for ${outfile}`));
    });
  });
}

server.listen(port, "127.0.0.1", async () => {
  try {
    const jobs = [
      [390, 844, "slug=caribbean", "mobile-general.png"],
      [
        390,
        2400,
        "slug=caribbean&timing=cruise&start=2026-11-17&end=2026-11-27",
        "mobile-exact-cruise-november.png"
      ],
      [
        1440,
        2800,
        "slug=caribbean&timing=cruise&start=2026-11-17&end=2026-11-27",
        "desktop-exact-cruise-november.png"
      ]
    ];
    for (const [width, height, query, name] of jobs) {
      const outfile = path.join(outDir, name);
      await runChrome(width, height, query, outfile);
      console.log("wrote", outfile, fs.statSync(outfile).size);
    }
    console.log("screenshot pack ready:", outDir);
    server.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    server.close();
    process.exit(1);
  }
});
