/* Keep Ship Spotlight newsletter/public-page links on the live Netlify ship route
 * until /ships/* is mapped on the 101cruise.com.au public domain. */
(function (global) {
  "use strict";

  const OLD_BASE = "https://101cruise.com.au/ships/";
  const LIVE_BASE = "https://admirable-tiramisu-d4da8a.netlify.app/ships/";

  function replaceLinks(value) {
    return String(value || "").split(OLD_BASE).join(LIVE_BASE);
  }

  function patchMountedLinks() {
    document.querySelectorAll("#shipSpotlightOverlay a").forEach((link) => {
      const raw = link.getAttribute("href") || "";
      if (raw.startsWith(OLD_BASE)) link.setAttribute("href", replaceLinks(raw));
    });
    document.querySelectorAll("#shipSpotlightOverlay .admin-helper").forEach((node) => {
      const text = String(node.textContent || "");
      if (text.includes(OLD_BASE)) node.textContent = replaceLinks(text);
    });
  }

  function installSpotlightWrapper() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.emailHtml !== "function" || api.__publicLinkFixInstalled) return;
    const original = api.emailHtml.bind(api);
    api.emailHtml = function () {
      return replaceLinks(original());
    };
    api.__publicLinkFixInstalled = true;
  }

  function installCopyWrapper() {
    const assets = global.NewsletterMailchimpAssets;
    if (!assets || typeof assets.copyHostedHtml !== "function" || assets.__shipSpotlightPublicLinkFixInstalled) return;
    const original = assets.copyHostedHtml.bind(assets);
    assets.copyHostedHtml = function (html) {
      const args = Array.prototype.slice.call(arguments, 1);
      return original.apply(assets, [replaceLinks(html), ...args]);
    };
    assets.__shipSpotlightPublicLinkFixInstalled = true;
  }

  function installClickGuard() {
    if (global.__shipSpotlightPublicClickGuardInstalled) return;
    document.addEventListener("click", function (event) {
      const link = event.target?.closest?.("#shipSpotlightOverlay a");
      if (!link) return;
      const raw = link.getAttribute("href") || "";
      if (!raw.startsWith(OLD_BASE)) return;
      event.preventDefault();
      const corrected = replaceLinks(raw);
      link.setAttribute("href", corrected);
      global.open(corrected, link.getAttribute("target") || "_blank", "noopener");
    }, true);
    global.__shipSpotlightPublicClickGuardInstalled = true;
  }

  function install() {
    installSpotlightWrapper();
    installCopyWrapper();
    installClickGuard();
    patchMountedLinks();
  }

  install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightPublicLinkFix = { replaceLinks, LIVE_BASE };
})(window);