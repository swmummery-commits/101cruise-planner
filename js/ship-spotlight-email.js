/**
 * Ship Spotlight email fragment renderer.
 * Generates a standalone 600px Mailchimp Code Block fragment.
 * It is deliberately independent of NewsletterIssueComposer.
 */
(function (global) {
  "use strict";

  const SITE_ORIGIN = "https://www.101cruise.com.au";
  const MAX_WIDTH = 600;
  const BRAND_GREEN = "#8DD9BF";
  const PAGE_BG = "#F7F7F7";

  const STAT_DEFS = {
    year_built: { label: "Launched", format: "year" },
    year_refurbished: { label: "Refurbished", format: "year" },
    passenger_capacity: { label: "Guests", format: "number" },
    crew_count: { label: "Crew", format: "number" },
    stateroom_count: { label: "Staterooms", format: "number" },
    gross_tonnage: { label: "Gross tonnage", format: "tonnage" },
    length_metres: { label: "Length", format: "metres" },
    deck_count: { label: "Decks", format: "number" },
    beam_metres: { label: "Beam", format: "metres" },
    cruising_speed_knots: { label: "Cruising speed", format: "knots" }
  };

  const DEFAULT_STAT_KEYS = [
    "year_built",
    "passenger_capacity",
    "crew_count",
    "gross_tonnage",
    "length_metres",
    "deck_count"
  ];

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function formatNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? new Intl.NumberFormat("en-AU").format(Math.round(num)) : "";
  }

  function formatStat(value, type) {
    if (value === null || value === undefined || value === "") return "";
    const num = Number(value);
    if (type === "year") return Number.isFinite(num) ? String(Math.round(num)) : String(value);
    if (!Number.isFinite(num)) return String(value);
    if (type === "metres") return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(num)}m`;
    if (type === "knots") return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(num)} kn`;
    if (type === "tonnage") return `${formatNumber(num)} GT`;
    return formatNumber(num);
  }

  function publicUrl(spotlight, ship, options = {}) {
    const origin = String(options.siteOrigin || SITE_ORIGIN).replace(/\/$/, "");
    const slug = slugify(spotlight?.public_slug || ship?.slug || "");
    return slug ? `${origin}/ship?slug=${encodeURIComponent(slug)}` : "";
  }

  function selectedStats(spotlight, ship) {
    const keys =
      Array.isArray(spotlight?.stat_keys) && spotlight.stat_keys.length
        ? spotlight.stat_keys
        : DEFAULT_STAT_KEYS;
    return keys
      .map((key) => {
        const def = STAT_DEFS[key];
        if (!def) return null;
        const formatted = formatStat(ship?.[key], def.format);
        return formatted ? { key, label: def.label, value: formatted } : null;
      })
      .filter(Boolean)
      .slice(0, 8);
  }

  function normaliseHighlights(value) {
    const list = Array.isArray(value) ? value : [];
    return list
      .map((item) => String(typeof item === "string" ? item : item?.text || "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }

  function assertFragmentSafe(html) {
    const errors = [];
    const text = String(html || "");
    if (/<!doctype/i.test(text)) errors.push("Output must be an HTML fragment, not a full document.");
    if (/<(?:html|head|body|script)[\s>]/i.test(text)) errors.push("Output contains a tag that is not allowed in a Mailchimp Code Block.");
    if (/\son[a-z]+\s*=/i.test(text)) errors.push("Output must not contain JavaScript event attributes.");
    if (/src\s*=\s*["'](?!https?:\/\/)/i.test(text)) errors.push("Every image must use an absolute public URL.");
    return errors;
  }

  function validate(spotlight, ship) {
    const errors = [];
    if (!ship?.name) errors.push("Choose a ship.");
    const hero = String(spotlight?.hero_image_url || ship?.hero_image_url || "").trim();
    if (!hero) errors.push("A hero image is required.");
    if (hero && !/^https:\/\//i.test(hero)) errors.push("The hero image must use a public https address.");
    if (!selectedStats(spotlight, ship).length) errors.push("At least one ship statistic is required.");
    if (!publicUrl(spotlight, ship)) errors.push("A public ship slug is required.");
    return errors;
  }

  function renderStatCells(stats) {
    if (!stats.length) return "";
    const pairs = [];
    for (let i = 0; i < stats.length; i += 2) {
      const left = stats[i];
      const right = stats[i + 1] || null;
      const cell = (stat) =>
        stat
          ? `<td width="50%" valign="top" style="padding:12px 10px;border-top:1px solid #D9DED9;">
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.25;letter-spacing:.7px;text-transform:uppercase;color:#646B68;">${escapeHtml(stat.label)}</div>
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:21px;line-height:1.2;font-weight:700;color:#111111;margin-top:4px;">${escapeHtml(stat.value)}</div>
            </td>`
          : `<td width="50%" style="padding:12px 10px;border-top:1px solid #D9DED9;">&nbsp;</td>`;
      pairs.push(`<tr>${cell(left)}${cell(right)}</tr>`);
    }
    return pairs.join("");
  }

  function renderHighlights(highlights) {
    if (!highlights.length) return "";
    return `
      <tr>
        <td style="padding:22px 28px 2px;">
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.2;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:#245C4E;">Why this ship stands out</div>
        </td>
      </tr>
      ${highlights
        .map(
          (text) => `
      <tr>
        <td style="padding:7px 28px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#242424;">
          <span style="display:inline-block;width:18px;font-weight:700;color:#245C4E;">•</span>${escapeHtml(text)}
        </td>
      </tr>`
        )
        .join("")}`;
  }

  function renderFragment(spotlight, ship, options = {}) {
    const errors = validate(spotlight, ship);
    if (errors.length) return { ok: false, errors, html: "", previewHtml: "" };

    const line = ship?.ci_cruise_lines || {};
    const hero = String(spotlight?.hero_image_url || ship?.hero_image_url || "").trim();
    const eyebrow = String(spotlight?.eyebrow || "SHIP OF THE WEEK").trim();
    const heading = String(spotlight?.newsletter_heading || ship?.name || "").trim();
    const intro = String(spotlight?.editorial_intro || "").trim();
    const highlights = normaliseHighlights(spotlight?.highlights);
    const stats = selectedStats(spotlight, ship);
    const ctaUrl = publicUrl(spotlight, ship, options);
    const lineName = String(line?.name || ship?.cruise_line_name || "").trim();
    const alt = `${ship.name}${lineName ? `, ${lineName}` : ""}`;

    const html = `<table role="presentation" class="cr101-ship-spotlight" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;border-collapse:collapse;background-color:${PAGE_BG};">
  <tr>
    <td align="center" bgcolor="${PAGE_BG}" style="padding:24px 0;background-color:${PAGE_BG};">
      <table role="presentation" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background-color:#FFFFFF;border-radius:16px;overflow:hidden;">
        <tr>
          <td align="center" style="padding:25px 28px 10px;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.2;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;color:#245C4E;">${escapeHtml(eyebrow)}</div>
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:30px;line-height:1.12;font-weight:700;color:#111111;margin-top:7px;">${escapeHtml(heading)}</div>
            ${lineName ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#59615E;margin-top:7px;">${escapeHtml(lineName)}</div>` : ""}
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0 0;">
            <img src="${escapeHtml(hero)}" alt="${escapeHtml(alt)}" width="${MAX_WIDTH}" border="0" style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0;">
          </td>
        </tr>
        <tr>
          <td style="padding:10px 18px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              ${renderStatCells(stats)}
            </table>
          </td>
        </tr>
        ${
          intro
            ? `<tr><td style="padding:20px 28px 4px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#242424;text-align:center;">${escapeHtml(intro)}</td></tr>`
            : ""
        }
        ${renderHighlights(highlights)}
        <tr>
          <td align="center" style="padding:24px 28px 30px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr>
                <td bgcolor="${BRAND_GREEN}" style="border-radius:999px;background-color:${BRAND_GREEN};">
                  <a href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 24px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1;font-weight:700;letter-spacing:.3px;color:#111111;text-decoration:none;">EXPLORE ${escapeHtml(String(ship.name || "THIS SHIP").toUpperCase())}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

    const safety = assertFragmentSafe(html);
    if (safety.length) return { ok: false, errors: safety, html: "", previewHtml: "" };

    return {
      ok: true,
      errors: [],
      html,
      previewHtml: `<div class="cr101-admin-preview" style="background:${PAGE_BG};padding:16px;overflow:auto;">${html}</div>`,
      ctaUrl,
      filename: `101cruise-ship-spotlight-${slugify(ship.name)}.html`,
      label: `${ship.name} · Ship Spotlight`
    };
  }

  global.ShipSpotlightEmail = {
    SITE_ORIGIN,
    MAX_WIDTH,
    BRAND_GREEN,
    PAGE_BG,
    STAT_DEFS,
    DEFAULT_STAT_KEYS,
    escapeHtml,
    slugify,
    formatStat,
    publicUrl,
    selectedStats,
    normaliseHighlights,
    assertFragmentSafe,
    validate,
    renderFragment
  };
})(typeof window !== "undefined" ? window : globalThis);
