/* Research Content editor field ordering.
 * Keep Paul's Tip directly beneath the Overview field without changing
 * its existing save/publish behaviour.
 */
(function () {
  "use strict";

  function movePaulsTipBelowOverview() {
    const fields = document.querySelector(".research-editor-fields");
    if (!fields) return;

    const paulsTipControl = fields.querySelector('textarea[onchange*="pauls_tip"]');
    const paulsTipField = paulsTipControl?.closest(".research-field");
    if (!paulsTipField) return;

    // Overview is the first research content field for each supported entity type.
    const overviewField = fields.querySelector(":scope > .research-field");
    if (!overviewField || overviewField === paulsTipField) return;
    if (overviewField.nextElementSibling === paulsTipField) return;

    overviewField.insertAdjacentElement("afterend", paulsTipField);
  }

  movePaulsTipBelowOverview();

  new MutationObserver(movePaulsTipBelowOverview).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
