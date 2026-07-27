/**
 * Shared brand loading indicator — 4×4 grid of small flashing boxes in brand green.
 * Dual export: CommonJS (tests) + browser global BrandLoading.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BrandLoading = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BOX_COUNT = 16;
  var BOX_MARKUP = new Array(BOX_COUNT + 1).join("<span></span>");

  /**
   * @param {{ inline?: boolean, large?: boolean, className?: string }=} opts
   */
  function html(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const classes = ["brand-loading-boxes"];
    if (options.inline) classes.push("brand-loading-boxes--inline");
    if (options.large) classes.push("brand-loading-boxes--large");
    if (options.className) classes.push(String(options.className));
    return (
      `<span class="${classes.join(" ")}" aria-hidden="true">` +
      BOX_MARKUP +
      "</span>"
    );
  }

  return { html: html, BOX_COUNT: BOX_COUNT };
});
