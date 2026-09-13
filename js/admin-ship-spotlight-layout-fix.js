/* Ship Spotlight newsletter refinements.
 * Applies the agreed email presentation rules to preview + copied Mailchimp HTML
 * without changing the separate Cruise Specials workflow.
 */
(function (global) {
  "use strict";

  const ROOM_ASSET_ENDPOINT = "/.netlify/functions/ship-spotlight-mailchimp-assets";

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

  function moveLogoAboveShipName(root) {
    if (!root || !root.querySelector) return;
    const headingCell = Array.from(root.querySelectorAll("td")).find((cell) =>
      /font-family:\s*Georgia/i.test(cell.getAttribute("style") || "")
    );
    if (!headingCell) return;

    const logoImage = Array.from(root.querySelectorAll("img")).find((img) => {
      const style = img.getAttribute("style") || "";
      return img.getAttribute("width") === "170" || /max-width:\s*170px/i.test(style) || img.dataset.shipLineLogo === "1";
    });
    if (!logoImage) return;

    logoImage.dataset.shipLineLogo = "1";
    logoImage.setAttribute("width", "230");
    const oldStyle = logoImage.getAttribute("style") || "";
    logoImage.setAttribute(
      "style",
      oldStyle
        .replace(/max-width:\s*170px/gi, "max-width:230px")
        .replace(/max-height:\s*48px/gi, "max-height:76px")
        .replace(/width:\s*auto/gi, "width:auto")
    );

    const logoRow = logoImage.closest("tr");
    const headingRow = headingCell.closest("tr");
    if (!logoRow || !headingRow || !headingRow.parentNode) return;
    const logoCell = logoRow.querySelector("td");
    if (logoCell) logoCell.setAttribute("style", "padding:0 0 14px;text-align:center;");
    if (logoRow.nextElementSibling !== headingRow) {
      headingRow.parentNode.insertBefore(logoRow, headingRow);
    }
  }

  function ensureFeatureHeading(col, title) {
    if (!col || !String(col.textContent || "").trim()) return;
    const directDivs = Array.from(col.children || []).filter((node) => node.tagName === "DIV");
    const existing = directDivs.find((node) => /exclusive areas|specialty features/i.test(String(node.textContent || "")));
    if (existing) {
      if (String(existing.textContent || "").trim() !== title) existing.textContent = title;
      if (!existing.classList.contains("cr101-ss-feature-title")) existing.classList.add("cr101-ss-feature-title");
      return;
    }
    const heading = document.createElement("div");
    heading.className = "cr101-ss-feature-title";
    heading.textContent = title;
    heading.setAttribute("style", "font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#245C4E;margin-bottom:7px;");
    col.insertBefore(heading, col.firstChild);
  }

  function simplifyFeatureColumns(root) {
    const cols = featureColumns(root);
    if (!cols.length) return;

    if (cols[0] && String(cols[0].textContent || "").trim()) ensureFeatureHeading(cols[0], "Exclusive Areas");
    if (cols[1] && String(cols[1].textContent || "").trim()) ensureFeatureHeading(cols[1], "Specialty Features");

    // Newsletter shows names only. Descriptions belong on the public ship page.
    cols.forEach((col) => {
      col.querySelectorAll("table tr > td:nth-child(2) > div").forEach((description) => description.remove());
    });

    featureColumns(root).forEach((col) => {
      if (!String(col.textContent || "").trim()) col.remove();
    });

    const remaining = featureColumns(root);
    const width = remaining.length === 1 ? "100%" : "50%";
    remaining.forEach((col) => {
      if (col.getAttribute("width") !== width) col.setAttribute("width", width);
      if (col.style.width !== width) col.style.width = width;
      if (col.style.maxWidth !== width) col.style.maxWidth = width;
    });
  }

  function decodeSvgDataUrl(src) {
    const value = String(src || "");
    if (!value.startsWith("data:image/svg+xml")) return "";
    try {
      if (value.includes(";base64,")) {
        const encoded = value.split(";base64,")[1] || "";
        return decodeURIComponent(escape(global.atob(encoded)));
      }
      const encoded = value.split(",").slice(1).join(",");
      return decodeURIComponent(encoded);
    } catch (_error) {
      return "";
    }
  }

  function encodeSvgDataUrl(svg) {
    try {
      return `data:image/svg+xml;base64,${global.btoa(unescape(encodeURIComponent(svg)))}`;
    } catch (_error) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
  }

  function centreRoomChartSvg(svgText) {
    const source = String(svgText || "").trim();
    if (!source || !/^<svg\b/i.test(source)) return source;
    try {
      const doc = new DOMParser().parseFromString(source, "image/svg+xml");
      const svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg") return source;

      const oldCx = 94;
      const oldCy = 113;
      const newCx = 280;
      const newCy = 94;
      const yShift = newCy - oldCy;

      // Remove the duplicate ROOM TYPES title inside the generated graphic.
      Array.from(svg.querySelectorAll("text")).forEach((node) => {
        if (String(node.textContent || "").trim().toUpperCase() === "ROOM TYPES" && Number(node.getAttribute("x")) > 150) {
          node.remove();
        }
      });

      // Centre every donut circle, including track, segments and white centre.
      Array.from(svg.querySelectorAll("circle")).forEach((circle) => {
        if (Number(circle.getAttribute("cx")) !== oldCx) return;
        circle.setAttribute("cx", String(newCx));
        circle.setAttribute("cy", String(newCy));
        const transform = circle.getAttribute("transform") || "";
        if (/rotate\(/i.test(transform)) circle.setAttribute("transform", `rotate(-90 ${newCx} ${newCy})`);
      });

      // Move the text inside the donut with it.
      Array.from(svg.querySelectorAll("text")).forEach((node) => {
        if (Number(node.getAttribute("x")) !== oldCx) return;
        node.setAttribute("x", String(newCx));
        const y = Number(node.getAttribute("y"));
        if (Number.isFinite(y)) node.setAttribute("y", String(y + yShift));
      });

      // Put the room legend underneath the centred donut. This is deliberately
      // one clean column: longer room names stay readable on phone screens.
      const labelNodes = Array.from(svg.querySelectorAll('text[x="222"]'));
      const valueNodes = Array.from(svg.querySelectorAll('text[x="526"]'));
      const legendRects = Array.from(svg.querySelectorAll('rect[x="202"]'));
      const legendCount = Math.max(labelNodes.length, valueNodes.length, legendRects.length);
      const legendTop = 200;
      const rowGap = 28;

      labelNodes.forEach((node, index) => {
        node.setAttribute("x", "88");
        node.setAttribute("y", String(legendTop + index * rowGap));
      });
      valueNodes.forEach((node, index) => {
        node.setAttribute("x", "472");
        node.setAttribute("y", String(legendTop + index * rowGap));
        node.setAttribute("text-anchor", "end");
      });
      legendRects.forEach((node, index) => {
        node.setAttribute("x", "64");
        node.setAttribute("y", String(legendTop - 10 + index * rowGap));
      });

      const height = Math.max(270, legendTop + legendCount * rowGap + 16);
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", `0 0 560 ${height}`);
      const background = svg.querySelector("rect:not([x])") || svg.querySelector('rect[x="0"]');
      if (background) background.setAttribute("height", String(height));

      return new XMLSerializer().serializeToString(svg);
    } catch (_error) {
      return source;
    }
  }

  function centreRoomChartImage(root) {
    const image = root?.querySelector?.(".cr101-ss-room-chart");
    if (!image || image.dataset.roomChartCentred === "1") return;
    const svg = decodeSvgDataUrl(image.getAttribute("src") || "");
    if (!svg) return;
    const centred = centreRoomChartSvg(svg);
    if (!centred || centred === svg) return;
    image.setAttribute("src", encodeSvgDataUrl(centred));
    image.dataset.roomChartCentred = "1";
  }

  function transformRoot(root) {
    if (!root || !root.querySelector) return root;
    moveLogoAboveShipName(root);
    moveRoomTypesBelowAtAGlance(root);
    centreRoomChartImage(root);
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

  function installFetchWrapper() {
    if (global.__shipSpotlightRoomAssetFetchWrapped || typeof global.fetch !== "function") return;
    const originalFetch = global.fetch.bind(global);
    global.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : String(input?.url || "");
        if (url.includes(ROOM_ASSET_ENDPOINT) && init?.body && typeof init.body === "string") {
          const payload = JSON.parse(init.body);
          const asset = Array.isArray(payload?.assets) ? payload.assets[0] : null;
          if (asset?.inline_svg) {
            const centred = centreRoomChartSvg(asset.inline_svg);
            if (centred && centred !== asset.inline_svg) {
              asset.inline_svg = centred;
              init = { ...init, body: JSON.stringify(payload) };
            }
          }
        }
      } catch (_error) {
        // Never block the normal request if a presentation-only transformation fails.
      }
      return originalFetch(input, init);
    };
    global.__shipSpotlightRoomAssetFetchWrapped = true;
  }

  function refreshPreview() {
    document.querySelectorAll(".ss-preview-canvas").forEach(transformRoot);
  }

  function install() {
    installFetchWrapper();
    installEmailHtmlWrapper();
    installMailchimpCopyWrapper();
    refreshPreview();
  }

  install();
  const observer = new MutationObserver(install);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightLayoutFix = { transformHtml, transformRoot, centreRoomChartSvg };
})(window);