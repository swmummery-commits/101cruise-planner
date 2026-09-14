/**
 * Adds a Find Ships action to Cruise Line research editor pages.
 * It discovers the line's current fleet from official sources and adds only
 * missing ships to Cruise Intelligence. Existing ships are never deleted.
 */
(function (global) {
  "use strict";

  const researchAdmin = global.ResearchContentAdmin;
  if (!researchAdmin || typeof researchAdmin.renderPanel !== "function") return;

  let busy = false;
  const originalRenderPanel = researchAdmin.renderPanel.bind(researchAdmin);

  function escapeAttr(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function extractCruiseLineName(html) {
    const host = document.createElement("div");
    host.innerHTML = html;
    const refreshButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent.trim() === "Refresh Research"
    );
    if (!refreshButton) return "";

    const hasCruiseLineMeta = Array.from(host.querySelectorAll("p,div,span,small")).some((el) => {
      const text = el.textContent.replace(/\s+/g, " ").trim();
      return /^Cruise Line\s*[·•|]/i.test(text) && text.length < 140;
    });
    if (!hasCruiseLineMeta) return "";

    const excluded = new Set([
      "101cruise Admin",
      "Overview",
      "Sources",
      "Paul's Tip",
      "Market position",
      "Brand personality"
    ]);
    const headings = Array.from(host.querySelectorAll("h1,h2,h3,h4")).filter((heading) => {
      const position = heading.compareDocumentPosition(refreshButton);
      return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    for (let index = headings.length - 1; index >= 0; index -= 1) {
      const text = headings[index].textContent.replace(/\s+/g, " ").trim();
      if (text && text.length <= 120 && !excluded.has(text)) return text;
    }
    return "";
  }

  function injectFindShipsButton(html) {
    if (typeof html !== "string" || !html.includes("Refresh Research")) return html;
    const lineName = extractCruiseLineName(html);
    if (!lineName) return html;

    const refreshPattern = /(<button\b[^>]*onclick="ResearchContentAdmin\.refreshResearch\(\)"[^>]*>\s*Refresh Research\s*<\/button>)/i;
    if (!refreshPattern.test(html)) return html;

    const button = `
      <button type="button" class="admin-button" data-find-cruise-line-ships data-line-name="${escapeAttr(lineName)}"
        onclick="CruiseLineShipFinder.findShips(this)" ${busy ? "disabled" : ""}>${busy ? "Finding Ships…" : "Find Ships"}</button>
      <span class="admin-muted" data-find-cruise-line-ships-status style="margin-left:6px"></span>`;
    return html.replace(refreshPattern, `$1${button}`);
  }

  researchAdmin.renderPanel = function (...args) {
    return injectFindShipsButton(originalRenderPanel(...args));
  };

  function statusFor(button) {
    const parent = button?.parentElement;
    return parent?.querySelector("[data-find-cruise-line-ships-status]") || null;
  }

  async function findShips(button) {
    if (busy) return;
    const lineName = String(button?.dataset?.lineName || "").trim();
    if (!lineName) return;

    const status = statusFor(button);
    const originalText = button.textContent;
    busy = true;
    button.disabled = true;
    button.textContent = "Finding Ships…";
    if (status) status.textContent = "Searching official cruise line sources…";

    try {
      const headers =
        typeof global.adminAuthHeaders === "function"
          ? await global.adminAuthHeaders()
          : { "Content-Type": "application/json" };
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";

      const response = await fetch("/.netlify/functions/find-cruise-line-ships", {
        method: "POST",
        headers,
        body: JSON.stringify({ line_name: lineName })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Find Ships failed (${response.status})`);
      }

      const found = Number(data.found_count || 0);
      const added = Number(data.added_count || 0);
      const existing = Number(data.existing_count || 0);
      const updated = Number(data.updated_count || 0);
      let message = `Found ${found} ship${found === 1 ? "" : "s"} from official sources.`;
      if (added) message += ` Added ${added} new ship${added === 1 ? "" : "s"}.`;
      if (existing) message += ` ${existing} already in the database.`;
      if (updated) message += ` ${updated} existing record${updated === 1 ? "" : "s"} refreshed.`;
      if (!added && found) message += " No new ships needed to be added.";
      if (status) {
        status.textContent = message;
        status.title = Array.isArray(data.added) && data.added.length ? `Added: ${data.added.join(", ")}` : "";
      }
    } catch (error) {
      if (status) status.textContent = error.message || "Find Ships failed.";
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = originalText || "Find Ships";
    }
  }

  global.CruiseLineShipFinder = { findShips };
})(typeof window !== "undefined" ? window : globalThis);
