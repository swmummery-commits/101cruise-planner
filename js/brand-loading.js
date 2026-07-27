/**
 * Shared brand loading indicator — four stacked flashing boxes in brand green.
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
      "<span></span><span></span><span></span><span></span>" +
      "</span>"
    );
  }

  return { html: html };
});
