/**
 * Safe remote fetch with redirect re-validation and size limits.
 */

import { assertSafeRemoteUrl } from "./url-safety.js";
import { LIMITS } from "./media-utils.js";

/**
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, maxRedirects?: number }} [opts]
 */
export async function fetchRemoteAsset(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? LIMITS.fetchTimeoutMs;
  const maxBytes = opts.maxBytes ?? LIMITS.maxDownloadBytes;
  const maxRedirects = opts.maxRedirects ?? LIMITS.maxRedirects;

  let current = String(url).trim();
  let redirects = 0;

  while (true) {
    assertSafeRemoteUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "image/*,*/*;q=0.8",
          "User-Agent": "101cruise-squarespace-media-migration/1.0"
        }
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === "AbortError") {
        throw Object.assign(new Error("Fetch timed out"), { code: "timeout" });
      }
      throw Object.assign(new Error(error.message || "Fetch failed"), {
        code: "fetch_failed"
      });
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) {
        throw Object.assign(new Error("Redirect without Location"), {
          code: "bad_redirect"
        });
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        throw Object.assign(new Error("Too many redirects"), { code: "too_many_redirects" });
      }
      current = new URL(loc, current).toString();
      continue;
    }

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        code: "http_error",
        status: response.status
      });
    }

    const lenHeader = response.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > maxBytes) {
      throw Object.assign(new Error("Remote Content-Length exceeds limit"), {
        code: "too_large"
      });
    }

    const ab = await response.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length > maxBytes) {
      throw Object.assign(new Error("Downloaded body exceeds limit"), {
        code: "too_large"
      });
    }
    return {
      buffer,
      finalUrl: current,
      status: response.status,
      contentType: response.headers.get("content-type") || null
    };
  }
}
