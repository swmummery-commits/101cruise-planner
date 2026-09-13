/* Ship Spotlight newsletter refinements.
 * Keeps the core Ship Spotlight workflow untouched while applying the agreed
 * email presentation rules to preview + copied Mailchimp HTML.
 */
(function (global) {
  "use strict";

  function featureColumns(root) {
    return Array.from(root.querySelectorAll(".cr101-ss-feature-col"));
  }

  function moveRoomTypesBelowAtAGlance(root) {
    const roomChart = root.querySelector(".cr101-ss-room-chart");
    const detailTable = root.querySelector(".cr101-ss-detail-grid");
    const summaryTable = root.querySelector(".cr101-ss-summary-grid");
    if (!roomChart || (!detailTable && !summaryTable)) return;

    const roomRow = roomChart.closest("tr");
    const anchorRow = (detailTable || summaryTable).closest("tr");
    if (!roomRow || !anchorRow || !anchorRow.parentNode) return;
    if (roomRow === anchorRow.nextElementSibling) return;
    anchorRow.parentNode.insertBefore(roomRow, anchorRow.nextSibling);
  }

  function simplifyFeatureColumns(root) {
    const cols = featureColumns(root);
    if (!cols.length) return;

    // Newsletter shows names only. Descriptions belong on the dynamic ship page.
    cols.forEach((col) => {
      col.querySelectorAll("table tr > td:nth-child(2) > div").forEach((description) => description.remove());
    });

    // Remove placeholder/blank columns entirely.
    featureColumns(root).forEach((col) => {
      if (!String(col.textContent || "").trim()) col.remove();
    });

    const remaining = featureColumns(root);
    const width = remaining.length === 1 ? "100%" : "50%";
    remaining.forEach((col) => {
      col.setAttribute("width", remaining.length === 1 ? "100%" : "50%");
      col.style.width = width;
      col.style.maxWidth = width;
    });
  }

  function transformRoot(root) {
    if (!root || !root.querySelector) return root;
    moveRoomTypesBelowAtAGlance(root);
    simplifyFeatureColumns(root);
    return root;
  }

  function transformHtml(html) {
    const source = String(html || "");
    if (!source.includes("cr101-ss-wrapper")) return source;
    const holder = document.createElement("div");
    holder.innerHTML = source;
    transformRoot(holder);
    return holder.innerHTML;
  }

  function installEmailHtmlWrapper() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.emailHtml !== "function" || api.__layoutFixInstalled) return false;
    const original = api.emailHtml.bind(api);
    api.emailHtml = function () {
      return transformHtml(original());
    };
    api.__layoutFixInstalled = true;
    return true;
  }

  function installMailchimpCopyWrapper() {
    const assets = global.NewsletterMailchimpAssets;
    if (!assets || typeof assets.copyHostedHtml !== "function" || assets.__shipSpotlightLayoutFixInstalled) return false;
    const original = assets.copyHostedHtml.bind(assets);
    assets.copyHostedHtml = function (html) {
      const args = Array.prototype.slice.call(arguments, 1);
      return original.apply(assets, [transformHtml(html), ...args]);
    };
    assets.__shipSpotlightLayoutFixInstalled = true;
    return true;
  }

  function refreshPreview() {
    document.querySelectorAll(".ss-preview-canvas").forEach(transformRoot);
  }

  function install() {
    installEmailHtmlWrapper();
    installMailchimpCopyWrapper();
    refreshPreview();
  }

  install();
  const observer = new MutationObserver(install);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightLayoutFix = { transformHtml, transformRoot };
})(window);
