/**
 * Fetch readable text excerpts from selected source pages (bounded, not a crawler).
 * Timeouts are intentionally short so research stays within Netlify function limits.
 */

const MAX_BYTES = 180_000;
const MAX_EXCERPT_CHARS = 2200;
const FETCH_TIMEOUT_MS = 5_000;

function stripHtml(html) {
  let text = String(html || "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<\/(p|div|h1|h2|h3|h4|li|tr|br|section|article)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  return text;
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, maxExcerptChars?: number }} [options]
 */
async function fetchSourceExcerpt(url, options = {}) {
  const timeoutMs = Math.max(1500, Number(options.timeoutMs) || FETCH_TIMEOUT_MS);
  const maxExcerptChars = Math.min(
    8_000,
    Math.max(500, Number(options.maxExcerptChars) || MAX_EXCERPT_CHARS)
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "User-Agent": "101cruise-research-bot/1.0 (+https://101cruise.com.au)"
      }
    });
    if (!response.ok) {
      return { ok: false, url, error: `HTTP ${response.status}`, excerpt: "", chars: 0 };
    }
    const contentType = String(response.headers.get("content-type") || "");
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType) && contentType) {
      return { ok: false, url, error: `Unsupported content-type ${contentType}`, excerpt: "", chars: 0 };
    }

    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    let html = "";
    if (reader) {
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength || value.length || 0;
        chunks.push(value);
        if (total >= MAX_BYTES) break;
      }
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      html = merged.toString("utf8");
    } else {
      html = await response.text();
      if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
    }

    const excerpt = stripHtml(html).slice(0, maxExcerptChars);
    return {
      ok: Boolean(excerpt),
      url,
      excerpt,
      chars: excerpt.length,
      error: excerpt ? null : "No readable text extracted"
    };
  } catch (error) {
    return {
      ok: false,
      url,
      excerpt: "",
      chars: 0,
      error: error.name === "AbortError" ? "Fetch timeout" : error.message || "Fetch failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  stripHtml,
  fetchSourceExcerpt,
  MAX_EXCERPT_CHARS,
  FETCH_TIMEOUT_MS
};
