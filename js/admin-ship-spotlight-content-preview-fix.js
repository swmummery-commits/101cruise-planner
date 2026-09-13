/* Ship Spotlight admin quality fixes:
 * - use full research overview for the default short introduction (summary_text
 *   is deliberately compact and can be truncated by the research pipeline)
 * - make newsletter preview CTA open a dynamic-page preview even before save
 * - add an explicit Preview Dynamic Page button
 * - when copying the newsletter block, publish the linked page automatically so
 *   the email CTA cannot point at an unpublished page.
 */
(function (global) {
  "use strict";

  const LIVE_BASE = "https://admirable-tiramisu-d4da8a.netlify.app/ships/";
  let introRequestToken = 0;

  function overlay() {
    return document.getElementById("shipSpotlightOverlay");
  }

  function selector() {
    return overlay()?.querySelector(".ss-selector select") || null;
  }

  function selectedShipId() {
    return String(selector()?.value || "").trim();
  }

  function slugValue() {
    return String(overlay()?.querySelector("#ssSlug")?.value || "").trim();
  }

  function previewUrl() {
    const shipId = selectedShipId();
    const slug = slugValue();
    if (!shipId || !slug) return "";
    return `${LIVE_BASE}${encodeURIComponent(slug)}?preview=1&ship_id=${encodeURIComponent(shipId)}`;
  }

  function hasSavedSpotlight() {
    return Array.from(overlay()?.querySelectorAll(".ss-selector .admin-small") || [])
      .some((node) => /saved spotlight/i.test(String(node.textContent || "")));
  }

  async function hydrateIntroFromOverview() {
    const root = overlay();
    const shipId = selectedShipId();
    const textarea = root?.querySelector("#ssIntro");
    if (!root || !shipId || !textarea || hasSavedSpotlight()) return;
    if (textarea.dataset.fullOverviewCheckedFor === shipId) return;
    textarea.dataset.fullOverviewCheckedFor = shipId;

    const db = global.supabaseClient;
    if (!db) return;
    const token = ++introRequestToken;

    try {
      let query = db
        .from("research_content")
        .select("summary_text,content_json,content_status,content_version")
        .eq("entity_type", "ship")
        .eq("entity_id", shipId)
        .in("content_status", ["published", "reviewed"])
        .order("content_version", { ascending: false })
        .limit(1);
      const result = await query.maybeSingle();
      if (token !== introRequestToken || result.error || !result.data) return;

      const summary = String(result.data.summary_text || "").trim();
      const overview = String(result.data.content_json?.overview || "").trim();
      const current = String(textarea.value || "").trim();
      if (!overview || overview === current) return;

      // Only replace the generated default. Never replace something the editor
      // has typed deliberately.
      const isGeneratedDefault = !current || current === summary || (summary && current.startsWith(summary));
      if (!isGeneratedDefault) return;

      textarea.value = overview;
      global.ShipSpotlightAdmin?.capture?.();
    } catch (_error) {
      // A missing overview should never break the admin editor.
    }
  }

  function addDynamicPreviewButton() {
    const root = overlay();
    if (!root || root.querySelector("[data-ship-dynamic-preview]")) return;
    const publicHeading = Array.from(root.querySelectorAll("section h3"))
      .find((node) => /public ship page/i.test(String(node.textContent || "")));
    const section = publicHeading?.closest("section");
    const helper = section?.querySelector(".admin-helper");
    if (!section || !helper) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-button secondary small";
    button.dataset.shipDynamicPreview = "1";
    button.textContent = "Preview Dynamic Page";
    button.style.marginTop = "10px";
    button.addEventListener("click", () => {
      const url = previewUrl();
      if (url) global.open(url, "_blank", "noopener");
    });
    helper.insertAdjacentElement("afterend", button);
  }

  function installPreviewCtaGuard() {
    if (global.__shipSpotlightPreviewCtaGuardInstalled) return;
    document.addEventListener("click", (event) => {
      const link = event.target?.closest?.(".ss-preview-canvas a");
      if (!link) return;
      const text = String(link.textContent || "").trim();
      if (!/^EXPLORE\b/i.test(text)) return;
      const url = previewUrl();
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      global.open(url, "_blank", "noopener");
    }, true);
    global.__shipSpotlightPreviewCtaGuardInstalled = true;
  }

  function ensurePublishChecked() {
    const checkbox = overlay()?.querySelector("#ssPublished");
    if (!checkbox || checkbox.checked) return;
    checkbox.checked = true;
    global.ShipSpotlightAdmin?.capture?.();
  }

  function wrapCopyActions() {
    const api = global.ShipSpotlightAdmin;
    if (!api || api.__contentPreviewFixWrapped) return;

    ["copyNewsletterBlock", "copyAgainIfReady"].forEach((name) => {
      if (typeof api[name] !== "function") return;
      const original = api[name].bind(api);
      api[name] = function () {
        ensurePublishChecked();
        return original.apply(api, arguments);
      };
    });
    api.__contentPreviewFixWrapped = true;
  }

  function refresh() {
    wrapCopyActions();
    installPreviewCtaGuard();
    addDynamicPreviewButton();
    hydrateIntroFromOverview();
  }

  refresh();
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("change", (event) => {
    if (event.target === selector()) {
      introRequestToken += 1;
      setTimeout(refresh, 0);
    }
  }, true);

  global.ShipSpotlightContentPreviewFix = { previewUrl, refresh };
})(window);
