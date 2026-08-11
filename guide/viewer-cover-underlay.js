(() => {
  "use strict";

  const book = document.getElementById("book");
  if (!book) return;

  const PAGE_PATH = "./pages";
  const cacheKey = Date.now().toString(36);

  const pageUrl = (page) => `${PAGE_PATH}/page-${String(page).padStart(2, "0")}.webp?v=${cacheKey}`;

  let underlay = null;

  function removeUnderlay() {
    if (!underlay) return;
    underlay.remove();
    underlay = null;
  }

  function buildUnderlay(leftPage, rightPage) {
    removeUnderlay();

    const wrap = document.createElement("div");
    wrap.className = "cover-underlay";
    wrap.setAttribute("aria-hidden", "true");

    for (const page of [leftPage, rightPage]) {
      const slot = document.createElement("div");
      slot.className = "cover-underlay-page";

      const img = new Image();
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      img.src = pageUrl(page);

      slot.appendChild(img);
      wrap.appendChild(slot);
    }

    book.prepend(wrap);
    underlay = wrap;
  }

  function sync() {
    if (matchMedia("(max-width:800px)").matches) {
      removeUnderlay();
      return;
    }

    const mode = book.dataset.mode;
    const openingFront = mode === "cover" && book.classList.contains("cover-opening");
    const closingFront = mode === "cover" && book.classList.contains("is-back");
    const closingBack = mode === "back" && book.classList.contains("is-forward");

    if (openingFront || closingFront) {
      if (!underlay || underlay.dataset.kind !== "front") {
        buildUnderlay(2, 3);
        underlay.dataset.kind = "front";
      }
      return;
    }

    if (closingBack) {
      if (!underlay || underlay.dataset.kind !== "back") {
        buildUnderlay(38, 39);
        underlay.dataset.kind = "back";
      }
      return;
    }

    removeUnderlay();
  }

  const observer = new MutationObserver(sync);
  observer.observe(book, {
    attributes: true,
    attributeFilter: ["class", "data-mode"]
  });

  addEventListener("resize", sync);
  sync();
})();
