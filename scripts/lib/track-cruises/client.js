/**
 * Sprint 15A — minimal Track.cruises RapidAPI client (validation only).
 * Never logs the API key or request headers.
 */

const { TrackCruisesRequestGuard, DEFAULT_MAX_LIVE_CALLS } = require("./request-guard");

/**
 * @param {{ key: string, host: string, guard?: TrackCruisesRequestGuard, fetchImpl?: typeof fetch }} options
 */
function createTrackCruisesClient(options) {
  const key = String(options.key || "").trim();
  const host = String(options.host || "").trim();
  if (!key) throw new Error("Missing RapidAPI key.");
  if (!host) throw new Error("Missing RapidAPI host.");

  const guard = options.guard || new TrackCruisesRequestGuard({ maxLiveCalls: DEFAULT_MAX_LIVE_CALLS });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  async function request(method, pathname, query = {}) {
    guard.assertLiveAllowed(`${method} ${pathname}`);
    guard.assertNotPagination(query);
    guard.assertNotBulk(query);

    const url = new URL(`https://${host}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          "X-RapidAPI-Key": key,
          "X-RapidAPI-Host": host,
          Accept: "application/json"
        }
      });
    } catch (error) {
      guard.record(pathname, false);
      return {
        ok: false,
        status: 0,
        error: { code: "network_error", message: String(error.message || error) },
        body: null,
        guard
      };
    }

    const status = response.status;
    let body = null;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    const ok = status >= 200 && status < 300;
    guard.record(pathname, ok);

    if (status === 401) {
      return {
        ok: false,
        status,
        error: { code: "unauthorized", message: "401 Missing or invalid auth." },
        body,
        guard
      };
    }
    if (status === 429) {
      return {
        ok: false,
        status,
        error: { code: "rate_limited", message: "429 Rate limit exceeded." },
        body,
        guard
      };
    }
    if (!ok) {
      return {
        ok: false,
        status,
        error: {
          code: "http_error",
          message: `HTTP ${status}`,
          detail: body && typeof body === "object" ? body.title || body.message || body.detail : null
        },
        body,
        guard
      };
    }

    return { ok: true, status, body, guard };
  }

  return {
    guard,
    getCoverage: () => request("GET", "/coverage"),
    getCruises: (params = {}) => request("GET", "/cruises", params),
    getCruise: (id) => request("GET", `/cruises/${encodeURIComponent(id)}`)
  };
}

module.exports = {
  createTrackCruisesClient
};
