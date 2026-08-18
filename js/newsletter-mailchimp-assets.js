/**
 * Client helper for newsletter Mailchimp export.
 * Collects unique Supabase image URLs from generated HTML, uploads
 * email-optimised copies one asset per Netlify invocation, then rewrites
 * the HTML. Never returns HTML that still contains Supabase Storage URLs.
 */
(function (global) {
  "use strict";

  const ENDPOINT = "/.netlify/functions/newsletter-mailchimp-assets";
  const FETCH_MS = 75000;
  const MAX_ASSETS_PER_REQUEST = 1;

  function unescapeHtml(value) {
    return String(value || "")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">");
  }

  function normalizeSourceUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      parsed.hash = "";
      parsed.search = "";
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
      return parsed.toString();
    } catch {
      return raw.split("#")[0].split("?")[0];
    }
  }

  function isSupabaseStorageUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return false;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      if (!host.includes("supabase.co") && !host.includes("supabase.in")) return false;
      return /\/storage\/v1\/object\//i.test(parsed.pathname);
    } catch {
      return /supabase\.(co|in)\/storage\/v1\/object\//i.test(raw);
    }
  }

  function isRouteMapUrl(url) {
    const raw = String(url || "").toLowerCase();
    return /route-map|route_map|featured-cruise-route-maps/i.test(raw);
  }

  function collectImgSrcs(html) {
    const out = [];
    const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = re.exec(String(html || "")))) {
      out.push(unescapeHtml(match[1]));
    }
    return out;
  }

  function collectSupabaseImageUrls(html) {
    const seen = new Set();
    const urls = [];
    for (const src of collectImgSrcs(html)) {
      if (!isSupabaseStorageUrl(src)) continue;
      const key = normalizeSourceUrl(src) || src;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(src);
    }
    return urls;
  }

  function inferAssetType(url) {
    return isRouteMapUrl(url) ? "route_map" : "hero";
  }

  function cruiseAssetUrls(cruise) {
    if (!cruise) return [];
    const resolved =
      typeof global.resolveFeaturedCruiseImages === "function"
        ? global.resolveFeaturedCruiseImages(cruise)
        : { hero: null, routeMap: null };
    return [
      resolved.hero?.url,
      cruise.hero_image_url,
      resolved.routeMap?.url,
      cruise.route_map_image_url
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  function labelForCruise(cruise) {
    const ship =
      cruise?.ci_cruise_ships?.name ||
      cruise?.ship_name ||
      cruise?.shipName ||
      "";
    return String(ship || cruise?.headline || "cruise").trim() || "cruise";
  }

  function buildAssetList(html, cruises = []) {
    const rows = Array.isArray(cruises) ? cruises : [];
    return collectSupabaseImageUrls(html).map((sourceUrl) => {
      const normalized = normalizeSourceUrl(sourceUrl);
      const cruise =
        rows.find((row) =>
          cruiseAssetUrls(row).some((url) => normalizeSourceUrl(url) === normalized)
        ) || null;
      return {
        source_url: sourceUrl,
        asset_type: inferAssetType(sourceUrl),
        label: labelForCruise(cruise)
      };
    });
  }

  function replaceImageUrls(html, mappings) {
    let out = String(html || "");
    const list = Array.isArray(mappings) ? mappings : [];
    for (const row of list) {
      const from = String(row.source_url || "").trim();
      const to = String(row.mailchimp_file_url || row.url || "").trim();
      if (!from || !to) continue;
      out = out.split(from).join(to);
      const escaped = from.replaceAll("&", "&amp;");
      if (escaped !== from) out = out.split(escaped).join(to);
    }
    return out;
  }

  function remainingSupabaseStorageUrls(html) {
    const found = [];
    const text = String(html || "");
    const re = /https?:\/\/[^"'>\s]*supabase\.(?:co|in)\/storage\/v1\/object\/[^"'>\s]*/gi;
    let match;
    while ((match = re.exec(text))) {
      found.push(match[0]);
    }
    return [...new Set(found)];
  }

  function assertNoSupabaseStorageUrls(html) {
    const leftover = remainingSupabaseStorageUrls(html);
    if (!leftover.length) return { ok: true, leftover: [] };
    return {
      ok: false,
      leftover,
      error:
        "Exported HTML still contains Supabase Storage image links. Export stopped so those links would not be sent in Mailchimp."
    };
  }

  function progressMessage({ current, total, reused }) {
    const base = `Preparing newsletter images ${current} of ${total}…`;
    return reused ? `${base} Reused an existing Mailchimp file.` : base;
  }

  function describeAssetFailure({ data, status, index, total, asset }) {
    const filename = String(data?.generated_filename || asset?.label || "").trim();
    const httpStatus = Number(data?.http_status || data?.httpStatus || status) || null;
    const parts = [`Newsletter image ${index} of ${total} failed`];
    if (filename) parts.push(`(${filename})`);
    if (httpStatus) parts.push(`HTTP ${httpStatus}`);
    const detail = String(data?.error || "").trim();
    const head = parts.join(" ");
    const body = detail && detail !== head ? `: ${detail}` : ".";
    return `${head}${body} Export stopped so Supabase image links would not be used. Images already uploaded will be reused on retry.`;
  }

  async function requestOneAsset({ newsletterId, newsletterNumber, asset, index, total }) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
        : { "Content-Type": "application/json" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_MS);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          newsletter_id: newsletterId || null,
          newsletter_number: newsletterNumber || null,
          asset_index: index,
          asset_total: total,
          assets: [asset]
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        return {
          ok: false,
          error: describeAssetFailure({
            data,
            status: response.status,
            index,
            total,
            asset
          }),
          generated_filename: data.generated_filename || null,
          http_status: data.http_status || response.status,
          asset_index: index,
          asset_total: total
        };
      }
      const mappings = Array.isArray(data.mappings) ? data.mappings : [];
      const mapping = mappings[0];
      if (!mapping?.mailchimp_file_url) {
        return {
          ok: false,
          error: describeAssetFailure({
            data: {
              error: "Mailchimp did not return a hosted URL for this newsletter image.",
              generated_filename: mapping?.generated_filename
            },
            status: response.status,
            index,
            total,
            asset
          }),
          generated_filename: mapping?.generated_filename || null,
          http_status: response.status,
          asset_index: index,
          asset_total: total
        };
      }
      return { ok: true, data, mapping };
    } catch (error) {
      if (error.name === "AbortError") {
        return {
          ok: false,
          error: `Newsletter image ${index} of ${total} timed out. Export stopped. Try again — images that already uploaded will be reused.`,
          asset_index: index,
          asset_total: total
        };
      }
      return {
        ok: false,
        error:
          error.message ||
          `Could not reach the Mailchimp image upload service for image ${index} of ${total}. Export stopped so Supabase image links would not be used.`,
        asset_index: index,
        asset_total: total
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Rewrite generated newsletter HTML to Mailchimp-hosted image URLs.
   * Processes one unique asset per Netlify invocation.
   * @returns {{ ok: true, html, mappings, reused, uploaded } | { ok: false, error, html: "" }}
   */
  async function prepareExportedHtml({
    html,
    newsletterId,
    newsletterNumber,
    cruises,
    onProgress
  } = {}) {
    const sourceHtml = String(html || "");
    if (!sourceHtml.trim()) {
      return { ok: false, error: "Newsletter HTML was empty, so images could not be prepared.", html: "" };
    }

    const assets = buildAssetList(sourceHtml, cruises);
    if (!assets.length) {
      const safety = assertNoSupabaseStorageUrls(sourceHtml);
      if (!safety.ok) {
        return { ok: false, error: safety.error, html: "" };
      }
      return { ok: true, html: sourceHtml, mappings: [], reused: 0, uploaded: 0 };
    }

    const mappings = [];
    let reused = 0;
    let uploaded = 0;
    let folder = null;
    const total = assets.length;

    for (let i = 0; i < assets.length; i += MAX_ASSETS_PER_REQUEST) {
      const asset = assets[i];
      const current = i + 1;
      if (typeof onProgress === "function") {
        onProgress({
          current,
          total,
          label: asset.label,
          message: progressMessage({ current, total, reused: false })
        });
      }
      const result = await requestOneAsset({
        newsletterId,
        newsletterNumber,
        asset,
        index: current,
        total
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          html: "",
          generated_filename: result.generated_filename || null,
          http_status: result.http_status || null,
          asset_index: result.asset_index || current,
          asset_total: total
        };
      }
      mappings.push(result.mapping);
      if (result.data?.folder) folder = result.data.folder;
      if (result.mapping.reused || result.data?.reused > 0) reused += 1;
      if (result.mapping.uploaded || result.data?.uploaded > 0) uploaded += 1;
      if (typeof onProgress === "function" && (result.mapping.reused || result.data?.reused > 0)) {
        onProgress({
          current,
          total,
          label: asset.label,
          reused: true,
          message: progressMessage({ current, total, reused: true })
        });
      }
    }

    if (mappings.length < assets.length) {
      return {
        ok: false,
        error:
          "Mailchimp did not return a hosted URL for every newsletter image. Export stopped so Supabase links would not be used.",
        html: ""
      };
    }

    const rewritten = replaceImageUrls(sourceHtml, mappings);
    const safety = assertNoSupabaseStorageUrls(rewritten);
    if (!safety.ok) {
      return { ok: false, error: safety.error, html: "" };
    }

    return {
      ok: true,
      html: rewritten,
      mappings,
      reused,
      uploaded,
      folder
    };
  }

  const api = {
    ENDPOINT,
    FETCH_MS,
    MAX_ASSETS_PER_REQUEST,
    unescapeHtml,
    normalizeSourceUrl,
    isSupabaseStorageUrl,
    isRouteMapUrl,
    collectImgSrcs,
    collectSupabaseImageUrls,
    inferAssetType,
    buildAssetList,
    replaceImageUrls,
    remainingSupabaseStorageUrls,
    assertNoSupabaseStorageUrls,
    progressMessage,
    describeAssetFailure,
    prepareExportedHtml
  };

  global.NewsletterMailchimpAssets = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
