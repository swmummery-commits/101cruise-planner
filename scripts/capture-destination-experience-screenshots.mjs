#!/usr/bin/env node
/**
 * Capture Destination Experience full-page screenshots via local Chrome.
 * HOLD DEPLOY — local artifacts only (generated-assets is gitignored).
 */
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "generated-assets/destination-experience/caribbean-v1");
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

function runChrome(width, height, outfile) {
  return new Promise((resolve, reject) => {
    const target = `http://127.0.0.1:${port}/destination-experience.html?slug=caribbean`;
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      `--screenshot=${outfile}`,
      "--virtual-time-budget=10000",
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
      [1440, 5200, "desktop-full-page.png"],
      [768, 6200, "tablet-full-page.png"],
      [390, 7600, "mobile-full-page.png"]
    ];
    for (const [width, height, name] of jobs) {
      const outfile = path.join(outDir, name);
      await runChrome(width, height, outfile);
      console.log("wrote", outfile, fs.statSync(outfile).size);
    }
    for (const report of [
      "docs/destination-experience/caribbean-v1-data-gap-report.json",
      "docs/destination-experience/caribbean-v1-component-data-map.json"
    ]) {
      const base = path.basename(report).replace("caribbean-v1-", "");
      fs.copyFileSync(path.join(root, report), path.join(outDir, base));
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
