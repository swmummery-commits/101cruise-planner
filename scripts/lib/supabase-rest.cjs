/**
 * Shared Supabase REST helper for developer scripts (service role from .env).
 * Never logs secrets.
 */

const fs = require("fs");
const https = require("https");
const path = require("path");

function loadEnvFile(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function getSupabaseConfig(rootDir) {
  loadEnvFile(rootDir);
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env");
  }
  return { url, key };
}

function createSupabaseRest(rootDir) {
  const { url, key } = getSupabaseConfig(rootDir);

  function request(restPath, options = {}) {
    const method = options.method || "GET";
    const prefer = options.prefer || (method === "GET" ? "count=exact" : "return=representation");
    const body = options.body != null ? JSON.stringify(options.body) : null;

    return new Promise((resolve, reject) => {
      const u = new URL(`${url}/rest/v1/${restPath.replace(/^\//, "")}`);
      const headers = {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        Prefer: prefer
      };
      if (body) headers["Content-Type"] = "application/json";

      const req = https.request(
        u,
        { method, headers },
        (res) => {
          let raw = "";
          res.on("data", (c) => {
            raw += c;
          });
          res.on("end", () => {
            let data = null;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {
              data = raw;
            }
            if (res.statusCode >= 400) {
              const msg =
                (data && (data.message || data.error || data.hint)) ||
                raw ||
                `HTTP ${res.statusCode}`;
              const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
              err.statusCode = res.statusCode;
              err.body = data;
              reject(err);
              return;
            }
            resolve(data);
          });
        }
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function get(restPath) {
    return request(restPath, { method: "GET" });
  }

  return { request, get, url };
}

module.exports = {
  loadEnvFile,
  getSupabaseConfig,
  createSupabaseRest
};
