/**
 * Optional Client Reviews block for a newsletter issue.
 *
 * The section is omitted unless the review text has non-whitespace content.
 * Preview and Mailchimp export share this HTML. Photo addresses are absolute
 * so the existing email-image upload can rewrite them before send.
 */
(function (global) {
  "use strict";

  const PAGE_BG = "#F7F7F7";
  const MAX_WIDTH = 600;
  const PHOTO_COLUMN_PX = 200;

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function cleanId(value, fallback) {
    const cleaned = String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
    return cleaned || fallback;
  }

  function absoluteHttpUrl(value) {
    const url = String(value || "").trim();
    if (!/^https?:\/\//i.test(url)) return "";
    return url;
  }

  function empty() {
    return {
      eyebrow: "",
      headline: "",
      text: "",
      photos: []
    };
  }

  function normalizePhoto(raw, index) {
    const url = absoluteHttpUrl(raw?.url || raw?.public_url);
    if (!url) return null;
    const mediaId = cleanId(raw?.media_id || "", "");
    const id = cleanId(raw?.id || mediaId, `photo-${index + 1}`);
    const width = Number(raw?.width);
    const height = Number(raw?.height);
    const alt = String(raw?.alt || raw?.alt_text || "").trim() || "Client review photo";
    return {
      id,
      media_id: mediaId || null,
      url,
      alt,
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
      file_name: String(raw?.file_name || "").trim()
    };
  }

  function normalize(row) {
    const source = row && typeof row === "object" ? row : {};
    const photos = Array.isArray(source.photos)
      ? source.photos
      : Array.isArray(source.client_review_photos)
        ? source.client_review_photos
        : [];
    return {
      eyebrow: String(source.eyebrow ?? source.client_review_eyebrow ?? "").trim(),
      headline: String(source.headline ?? source.client_review_headline ?? "").trim(),
      text: String(source.text ?? source.client_review_text ?? "").trim(),
      photos: photos.map(normalizePhoto).filter(Boolean)
    };
  }

  function hasText(review) {
    return Boolean(normalize(review).text);
  }

  function paragraphs(value) {
    return String(value || "")
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map(
        (part, index, all) =>
          `<p style="margin:0 0 ${index === all.length - 1 ? 0 : 14}px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#202020;text-align:left;">${esc(part).replace(/\n/g, "<br>")}</p>`
      )
      .join("");
  }

  function photoImg(photo, index, total) {
    const margin = index === total - 1 ? "0" : "0 0 12px";
    return `<img class="cr101-review-photo" src="${esc(photo.url)}" alt="${esc(photo.alt)}" width="${PHOTO_COLUMN_PX}" border="0" style="display:block;width:100%;max-width:${PHOTO_COLUMN_PX}px;height:auto;border:0;border-radius:12px;margin:${margin};">`;
  }

  function styleBlock() {
    return `<style type="text/css">
  @media only screen and (max-width: 620px) {
    .cr101-review-col {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
    }
    .cr101-review-photos {
      padding-bottom: 16px !important;
    }
    .cr101-review-gap {
      display: none !important;
      width: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }
    .cr101-review-photo {
      width: 100% !important;
      max-width: 100% !important;
    }
  }
</style>`;
  }

  function copyCell(review, { fullWidth }) {
    const headline = review.headline
      ? `<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;line-height:1.25;color:#111111;text-align:left;margin:0 0 12px;">${esc(review.headline)}</div>`
      : "";
    const widthStyle = fullWidth ? "width:100%;" : "";
    return `<td class="cr101-review-col cr101-review-copy" valign="top" align="left" style="${widthStyle}vertical-align:top;text-align:left;">${headline}${paragraphs(review.text)}</td>`;
  }

  /**
   * Email-safe fragment. Returns "" when the review text is blank.
   * Photos use their stored order. With no photos, the text uses the full width.
   */
  function renderHtml(review) {
    const value = normalize(review);
    if (!value.text) return "";

    const eyebrow = value.eyebrow
      ? `<tr>
          <td colspan="${value.photos.length ? 3 : 1}" align="center" width="${MAX_WIDTH}" style="width:100%;padding:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#245C4E;">${esc(value.eyebrow)}</td>
        </tr>`
      : "";

    const columns = value.photos.length
      ? `<tr>
          <td class="cr101-review-col cr101-review-photos" valign="top" align="left" width="${PHOTO_COLUMN_PX}" style="width:33%;max-width:${PHOTO_COLUMN_PX}px;vertical-align:top;">
            ${value.photos.map((photo, index) => photoImg(photo, index, value.photos.length)).join("")}
          </td>
          <td class="cr101-review-gap" width="18" style="width:18px;font-size:0;line-height:0;">&nbsp;</td>
          ${copyCell(value, { fullWidth: false })}
        </tr>`
      : `<tr>${copyCell(value, { fullWidth: true })}</tr>`;

    return `${styleBlock()}
<table role="presentation" class="cr101-client-reviews" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;border-collapse:collapse;background-color:${PAGE_BG};" data-cr101-client-reviews="1">
  <tr>
    <td align="center" bgcolor="${PAGE_BG}" style="padding:8px 16px 32px;background-color:${PAGE_BG};">
      <table role="presentation" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;">
        ${eyebrow}
        ${columns}
      </table>
    </td>
  </tr>
</table>`;
  }

  function applyToExportResult(result, review) {
    if (!result?.ok || !result.html) return result;
    const block = renderHtml(review);
    if (!block) return result;
    const html = `${result.html}${block}`;
    const previewHtml =
      typeof result.previewHtml === "string" && result.previewHtml.includes(result.html)
        ? result.previewHtml.replace(result.html, html)
        : result.previewHtml;
    return { ...result, html, previewHtml };
  }

  function exportStamp(review) {
    const value = normalize(review);
    return [value.eyebrow, value.headline, value.text, value.photos.map((photo) => photo.url).join("|")].join(
      "\u0001"
    );
  }

  function orderPhotos(photos, orderedIds) {
    const current = normalize({ photos }).photos;
    const byId = new Map(current.map((photo) => [photo.id, photo]));
    const next = [];
    for (const id of orderedIds || []) {
      const photo = byId.get(String(id || ""));
      if (!photo) continue;
      next.push(photo);
      byId.delete(photo.id);
    }
    for (const photo of byId.values()) next.push(photo);
    return next;
  }

  function photoFromMedia(media, extras = {}) {
    return normalizePhoto(
      {
        id: media?.id,
        media_id: media?.id,
        url: media?.public_url || media?.url,
        alt: extras.alt || media?.alt_text || media?.title,
        width: extras.width ?? media?.width,
        height: extras.height ?? media?.height,
        file_name: extras.file_name || media?.file_name
      },
      0
    );
  }

  global.NewsletterClientReviews = {
    empty,
    normalize,
    hasText,
    renderHtml,
    applyToExportResult,
    exportStamp,
    orderPhotos,
    photoFromMedia
  };
})(typeof window !== "undefined" ? window : globalThis);
