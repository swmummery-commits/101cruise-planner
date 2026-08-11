(() => {
  "use strict";

  const book = document.getElementById("book");
  const pageStatus = document.getElementById("pageStatus");
  const nextButton = document.getElementById("nextButton");
  const prevButton = document.getElementById("prevButton");
  const stageNext = document.getElementById("stageNext");
  const stagePrev = document.getElementById("stagePrev");

  if (!book || !pageStatus || !nextButton || !prevButton || !stageNext || !stagePrev) return;

  // viewer-v3.js has already attached these handlers because this script is
  // loaded after it. Keeping references lets us advance the real viewer state
  // only when the physical cover animation has reached its matching end state.
  const originalNext = nextButton.onclick;
  const originalPrev = prevButton.onclick;
  if (typeof originalNext !== "function" || typeof originalPrev !== "function") return;

  const PAGE_PATH = "./pages";
  const ASSET_VERSION = "20260811-physical-cover-v1";
  const TURN_MS = 650;
  let busy = false;
  let layerNodes = [];

  const isDesktop = () => matchMedia("(min-width:801px)").matches;
  const pageUrl = (page) => `${PAGE_PATH}/page-${String(page).padStart(2, "0")}.webp?v=${ASSET_VERSION}`;

  // Warm the only images used by the cover transitions so the back face is
  // already decoded before the user clicks the arrow.
  for (const page of [1, 2, 3, 38, 39, 40]) {
    const img = new Image();
    img.decoding = "async";
    img.src = pageUrl(page);
  }

  function cleanupLayers() {
    for (const node of layerNodes) node.remove();
    layerNodes = [];
  }

  function makeImage(page) {
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.src = pageUrl(page);
    return img;
  }

  function buildBase(leftPage, rightPage) {
    const base = document.createElement("div");
    base.className = "physical-cover-base";
    base.setAttribute("aria-hidden", "true");

    const left = document.createElement("div");
    left.className = `physical-cover-base-page left${leftPage ? "" : " is-empty"}`;
    if (leftPage) left.appendChild(makeImage(leftPage));

    const right = document.createElement("div");
    right.className = `physical-cover-base-page right${rightPage ? "" : " is-empty"}`;
    if (rightPage) right.appendChild(makeImage(rightPage));

    base.append(left, right);
    book.appendChild(base);
    layerNodes.push(base);
    return base;
  }

  function buildLeaf(frontPage, backPage, extraClass, startOpenLeft = false) {
    const leaf = document.createElement("div");
    leaf.className = `physical-cover-leaf hinge-left ${extraClass}${startOpenLeft ? " start-left" : ""}`;
    leaf.setAttribute("aria-hidden", "true");

    const front = document.createElement("div");
    front.className = "physical-cover-face front";
    front.appendChild(makeImage(frontPage));

    const back = document.createElement("div");
    back.className = "physical-cover-face back";
    back.appendChild(makeImage(backPage));

    leaf.append(front, back);
    book.appendChild(leaf);
    layerNodes.push(leaf);
    return leaf;
  }

  function afterPaint(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  function holdSuppress() {
    book.classList.add("physical-cover-suppress");
    // Long enough to cover both the physical 650 ms turn and viewer-v3's
    // short fallback animation, even for transitions where the real state
    // change is intentionally delayed until the physical leaf has landed.
    setTimeout(() => book.classList.remove("physical-cover-suppress"), 1900);
  }

  function finishAfter(ms, fn) {
    setTimeout(() => {
      fn();
      requestAnimationFrame(() => {
        cleanupLayers();
        busy = false;
      });
    }, ms);
  }

  // CLOSED FRONT COVER -> PAGES 2-3
  // page 1 = front face, page 2 = reverse face, page 3 = stationary right page.
  function openFrontCover() {
    if (busy || !isDesktop()) return;
    busy = true;
    cleanupLayers();
    holdSuppress();

    buildBase(null, 3);
    const leaf = buildLeaf(1, 2, "front-cover");

    // Start viewer-v3's 650 ms state timer at the same moment, but its old
    // one-sided cover is hidden by physical-cover-suppress.
    originalNext();

    afterPaint(() => leaf.classList.add("animate-left"));

    // viewer-v3 changes to its real pages 2-3 spread at 650 ms. Keep our leaf
    // for a few extra frames so the hand-off is visually seamless.
    setTimeout(() => {
      cleanupLayers();
      busy = false;
    }, TURN_MS + 55);
  }

  // PAGES 2-3 -> CLOSED FRONT COVER
  function closeFrontCover() {
    if (busy || !isDesktop()) return;
    busy = true;
    cleanupLayers();
    holdSuppress();

    buildBase(null, 3);
    const leaf = buildLeaf(1, 2, "front-cover", true);

    afterPaint(() => leaf.classList.add("animate-right"));

    finishAfter(TURN_MS, () => originalPrev());
  }

  // PAGES 38-39 -> CLOSED BACK COVER
  // page 39 is the inside face; page 40 is the outside back cover face.
  function closeBackCover() {
    if (busy || !isDesktop()) return;
    busy = true;
    cleanupLayers();
    holdSuppress();

    buildBase(38, null);
    const leaf = buildLeaf(39, 40, "back-cover");

    afterPaint(() => leaf.classList.add("animate-left"));

    finishAfter(TURN_MS, () => originalNext());
  }

  // CLOSED BACK COVER -> PAGES 38-39
  function openBackCover() {
    if (busy || !isDesktop()) return;
    busy = true;
    cleanupLayers();
    holdSuppress();

    buildBase(38, null);
    const leaf = buildLeaf(39, 40, "back-cover-reverse", true);

    afterPaint(() => leaf.classList.add("animate-right"));

    finishAfter(TURN_MS, () => originalPrev());
  }

  function normalizedStatus() {
    return pageStatus.textContent.replace(/\s+/g, " ").trim();
  }

  function specialAction(direction) {
    if (!isDesktop()) return null;
    const status = normalizedStatus();

    if (direction > 0 && status === "Cover") return openFrontCover;
    if (direction < 0 && /^Pages 2[–-]3$/.test(status)) return closeFrontCover;
    if (direction > 0 && /^Pages 38[–-]39$/.test(status)) return closeBackCover;
    if (direction < 0 && status === "Back cover") return openBackCover;
    return null;
  }

  function interceptButton(button, direction) {
    button.addEventListener("click", (event) => {
      if (busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const action = specialAction(direction);
      if (!action) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    }, true);
  }

  interceptButton(nextButton, 1);
  interceptButton(stageNext, 1);
  interceptButton(prevButton, -1);
  interceptButton(stagePrev, -1);

  // Keep keyboard navigation consistent with the arrow buttons on the four
  // cover transitions. All normal page turns continue to viewer-v3 unchanged.
  document.addEventListener("keydown", (event) => {
    let direction = 0;
    if (["ArrowRight", "PageDown", " "].includes(event.key)) direction = 1;
    else if (["ArrowLeft", "PageUp"].includes(event.key)) direction = -1;
    else return;

    if (busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const action = specialAction(direction);
    if (!action) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    action();
  }, true);

  addEventListener("resize", () => {
    if (!isDesktop()) {
      cleanupLayers();
      busy = false;
      book.classList.remove("physical-cover-suppress");
    }
  });
})();
