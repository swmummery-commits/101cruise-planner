/* Ship Spotlight feature heading guard.
 *
 * Classification of Exclusive Areas vs Specialty Features belongs to the
 * canonical Admin → Cruise Database → Ships editor. Ship Spotlight only reads
 * that base data. This helper therefore does presentation work only: it makes
 * sure the newsletter feature column carries the correct heading.
 */
(function (global) {
  "use strict";

  const TITLE_STYLE = "font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#245C4E;margin-bottom:7px;";

  function ensureTitle(col, title) {
    if (!col) return;
    const existing = Array.from(col.children || []).find((node) =>
      node.tagName === "DIV" && /exclusive areas|specialty features/i.test(String(node.textContent || "").trim())
    );
    if (existing) {
      if (String(existing.textContent || "").trim() !== title) existing.textContent = title;
      existing.classList.add("cr101-ss-feature-title");
      existing.setAttribute("style", TITLE_STYLE);
      return;
    }
    const heading = document.createElement("div");
    heading.className = "cr101-ss-feature-title";
    heading.textContent = title;
    heading.setAttribute("style", TITLE_STYLE);
    col.insertBefore(heading, col.firstChild);
  }

  function ensureNewsletterFeatureTitles(rootNode) {
    if (!rootNode?.querySelectorAll) return rootNode;
    const cols = Array.from(rootNode.querySelectorAll(".cr101-ss-feature-col"))
      .filter((col) => String(col.textContent || "").trim());

    if (cols.length >= 2) {
      ensureTitle(cols[0], "Exclusive Areas");
      ensureTitle(cols[1], "Specialty Features");
      return rootNode;
    }

    if (cols.length === 1) {
      const text = String(cols[0].textContent || "");
      if (/specialty features/i.test(text)) ensureTitle(cols[0], "Specialty Features");
      else if (/exclusive areas/i.test(text)) ensureTitle(cols[0], "Exclusive Areas");
    }
    return rootNode;
  }

  function ensureTitlesHtml(html) {
    const source = String(html || "");
    if (!source.includes("cr101-ss-feature-col")) return source;
    const holder = document.createElement("div");
    holder.innerHTML = source;
    ensureNewsletterFeatureTitles(holder);
    return holder.innerHTML;
  }

  function installEmailWrapper() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.emailHtml !== "function" || api.__featureTitleFixInstalled) return;
    const original = api.emailHtml.bind(api);
    api.emailHtml = function () {
      return ensureTitlesHtml(original());
    };
    api.__featureTitleFixInstalled = true;
  }

  function refreshMountedPreview() {
    document.querySelectorAll(".ss-preview-canvas").forEach(ensureNewsletterFeatureTitles);
  }

  function install() {
    installEmailWrapper();
    refreshMountedPreview();
  }

  install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightFeatureTools = {
    ensureNewsletterFeatureTitles,
    ensureTitlesHtml
  };
})(window);
