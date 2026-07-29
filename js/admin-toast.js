/**
 * Floating Admin toasts — visible wherever you are on the page.
 * window.AdminToast.show(message, tone, { actions, durationMs })
 */
(function (global) {
  "use strict";

  const HOST_ID = "admin-toast-host";
  const recentKeys = new Map(); // key -> timestamp
  const DEDUPE_MS = 2500;

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.className = "admin-toast-host";
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-relevant", "additions");
    document.body.appendChild(host);
    return host;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function toneClass(tone) {
    const t = String(tone || "").toLowerCase();
    if (t === "error" || t === "danger") return "is-error";
    if (t === "success") return "is-success";
    if (t === "running" || t === "info") return "is-info";
    return "is-info";
  }

  function shouldSkip(key) {
    const now = Date.now();
    for (const [k, at] of recentKeys) {
      if (now - at > DEDUPE_MS) recentKeys.delete(k);
    }
    if (recentKeys.has(key)) return true;
    recentKeys.set(key, now);
    return false;
  }

  /**
   * @param {string} message
   * @param {string} [tone]
   * @param {{ actions?: Array<{label:string, onClick:Function}>, durationMs?: number, force?: boolean }} [options]
   */
  function show(message, tone, options = {}) {
    const text = String(message || "").trim();
    if (!text) return null;
    const t = String(tone || "info").toLowerCase();
    if (t === "running") return null; // keep running status inline near buttons
    const key = `${t}|${text}`;
    if (!options.force && shouldSkip(key)) return null;

    const host = ensureHost();
    const el = document.createElement("div");
    el.className = `admin-toast ${toneClass(t)}`;
    el.setAttribute("role", t === "error" ? "alert" : "status");

    const actions = Array.isArray(options.actions) ? options.actions : [];
    const actionsHtml = actions
      .map(
        (action, index) =>
          `<button type="button" class="admin-toast-action" data-toast-action="${index}">${esc(
            action.label || "OK"
          )}</button>`
      )
      .join("");

    el.innerHTML = `
      <div class="admin-toast-body">
        <p class="admin-toast-text">${esc(text)}</p>
        ${actionsHtml ? `<div class="admin-toast-actions">${actionsHtml}</div>` : ""}
      </div>
      <button type="button" class="admin-toast-dismiss" aria-label="Dismiss">×</button>
    `;

    const dismiss = () => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 180);
    };

    el.querySelector(".admin-toast-dismiss")?.addEventListener("click", dismiss);
    actions.forEach((action, index) => {
      el.querySelector(`[data-toast-action="${index}"]`)?.addEventListener("click", () => {
        try {
          action.onClick?.();
        } finally {
          dismiss();
        }
      });
    });

    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-visible"));

    const duration =
      typeof options.durationMs === "number"
        ? options.durationMs
        : t === "error"
          ? 10000
          : 5500;
    if (duration > 0) setTimeout(dismiss, duration);
    return el;
  }

  /**
   * After Admin re-renders, surface new error/success banners as toasts.
   */
  function mirrorFromAdminRoot(root) {
    if (!root) return;
    const nodes = root.querySelectorAll(
      ".admin-message.admin-error, .admin-message.admin-success, .admin-error.admin-message"
    );
    const seenText = new Set();
    nodes.forEach((node) => {
      if (node.hidden) return;
      const text = String(node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text.length < 3) return;
      // Avoid toasting huge validation lists / composer checklists
      if (text.length > 280) return;
      if (seenText.has(text)) return;
      seenText.add(text);
      const tone = node.classList.contains("admin-error") ? "error" : "success";
      const actions = [];
      // Prefer explicit take-over control when lock banner is present
      if (/is editing this cruise/i.test(text) && typeof global.takeOverFeaturedCruiseEdit === "function") {
        const blockedId = global.featuredEditLockBlocked?.id;
        if (blockedId) {
          actions.push({
            label: "Take over editing",
            onClick: () => global.takeOverFeaturedCruiseEdit(blockedId)
          });
        }
      }
      show(text.replace(/\s*Take over editing\s*$/i, "").trim(), tone, { actions });
    });
  }

  global.AdminToast = { show, mirrorFromAdminRoot, ensureHost };
})(typeof window !== "undefined" ? window : globalThis);
