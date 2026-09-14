/* Admin ship feature descriptions: make Enter reliably insert and preserve line breaks. */
(function () {
  "use strict";

  const selector = ".ci-ship-feature-description";

  document.addEventListener("keydown", function (event) {
    const textarea = event.target?.closest?.(selector);
    if (!textarea || event.key !== "Enter") return;

    // The ship editor lives inside a larger admin UI with keyboard handlers.
    // Own Enter here so those handlers cannot treat it as a form action.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
    textarea.setRangeText("\n", start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, true);

  document.addEventListener("focusin", function (event) {
    const textarea = event.target?.closest?.(selector);
    if (!textarea) return;
    textarea.setAttribute("aria-multiline", "true");
    textarea.title = "Press Enter to start a new line. Line breaks are shown on ship pages.";
  });
})();
