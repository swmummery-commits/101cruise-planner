(() => {
  "use strict";

  const PAGE_COUNT = 40;
  const PAGE_PATH = "./pages";
  const PAGE_EXT = "webp";
  const MOBILE_BREAKPOINT = 800;
  const HALF_TURN_MS = 460;
  const BUILD_ID = Date.now().toString(36);

  const book = document.getElementById("book");
  const leftSlot = document.getElementById("leftSlot");
  const rightSlot = document.getElementById("rightSlot");
  const singleSlot = document.getElementById("singleSlot");
  const prevButton = document.getElementById("prevButton");
  const nextButton = document.getElementById("nextButton");
  const stagePrev = document.getElementById("stagePrev");
  const stageNext = document.getElementById("stageNext");
  const fullscreenButton = document.getElementById("fullscreenButton");
  const viewerStage = document.getElementById("viewerStage");
  const pageStatus = document.getElementById("pageStatus");
  const progressBar = document.getElementById("progressBar");

  const flipSheet = document.createElement("div");
  flipSheet.className = "flip-sheet";
  flipSheet.setAttribute("aria-hidden", "true");
  flipSheet.innerHTML = '<div class="flip-face flip-front"></div>';
  book.appendChild(flipSheet);
  const flipFace = flipSheet.querySelector(".flip-face");

  let currentView = 0;
  let touchStartX = null;
  let touchStartY = null;
  let busy = false;

  const imageCache = new Map();
  const isMobile = () => matchMedia(`(max-width:${MOBILE_BREAKPOINT}px)`).matches;
  const DESKTOP_VIEWS = (() => {
    const views = [[1]];
    for (let page = 2; page <= PAGE_COUNT - 1; page += 2) views.push([page, page + 1]);
    views.push([PAGE_COUNT]);
    return views;
  })();

  const totalViews = () => (isMobile() ? PAGE_COUNT : DESKTOP_VIEWS.length);
  const currentPages = () => (isMobile() ? [currentView + 1] : DESKTOP_VIEWS[currentView]);
  const pageFile = (page) => `${PAGE_PATH}/page-${String(page).padStart(2, "0")}.${PAGE_EXT}?v=${BUILD_ID}`;

  function ensurePageLoaded(page) {
    if (page < 1 || page > PAGE_COUNT) return Promise.resolve();
    if (imageCache.has(page)) return imageCache.get(page);

    const promise = new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = async () => {
        try { await img.decode(); } catch (_) {}
        resolve();
      };
      img.onerror = () => resolve();
      img.src = pageFile(page);
    });

    imageCache.set(page, promise);
    return promise;
  }

  function makePage(page, ready = false) {
    const img = new Image();
    img.className = "page-image";
    img.alt = `101cruise Digital Guide page ${page}`;
    img.decoding = "async";
    img.draggable = false;

    const wrap = document.createElement("div");
    wrap.className = "page-art";

    if (!ready) {
      const loading = document.createElement("div");
      loading.className = "page-loading";
      loading.textContent = `Loading page ${page}…`;
      wrap.appendChild(loading);
      img.onload = () => wrap.replaceChildren(img);
    } else {
      wrap.appendChild(img);
    }

    img.onerror = () => {
      const error = document.createElement("div");
      error.className = "page-error";
      error.textContent = `Page ${page} could not be loaded.`;
      wrap.replaceChildren(error);
    };

    img.src = pageFile(page);
    return wrap;
  }

  const setPage = (slot, page, ready = false) => slot.replaceChildren(makePage(page, ready));

  function clearSlots() {
    leftSlot.replaceChildren();
    rightSlot.replaceChildren();
    singleSlot.replaceChildren();
  }

  function renderSingle(page) {
    book.classList.add("single-mode");
    clearSlots();
    setPage(singleSlot, page);
  }

  function renderSpread(leftPage, rightPage, ready = false) {
    book.classList.remove("single-mode");
    clearSlots();
    setPage(leftSlot, leftPage, ready);
    setPage(rightSlot, rightPage, ready);
  }

  function prepareTransitionBase(leftPage, rightPage) {
    book.classList.remove("single-mode");
    clearSlots();
    if (leftPage) setPage(leftSlot, leftPage, true);
    if (rightPage) setPage(rightSlot, rightPage, true);
    book.dataset.mode = "spread";
  }

  function setBookMode() {
    const pages = currentPages();
    if (!isMobile() && pages.length === 2) book.dataset.mode = "spread";
    else if (pages[0] === 1) book.dataset.mode = "cover";
    else if (pages[pages.length - 1] === PAGE_COUNT) book.dataset.mode = "back";
    else book.dataset.mode = "single";
  }

  function updateBookEdges() {
    if (isMobile()) return;
    const max = Math.max(1, totalViews() - 1);
    const progress = currentView / max;
    const left = 1.5 + progress * 2.5;
    const right = 4 - progress * 2.5;
    book.style.setProperty("--left-stack", `${left.toFixed(1)}px`);
    book.style.setProperty("--right-stack", `${right.toFixed(1)}px`);
  }

  function updateStatus() {
    const pages = currentPages();
    pageStatus.textContent = isMobile()
      ? `Page ${pages[0]} / ${PAGE_COUNT}`
      : pages.length === 1 && pages[0] === 1
        ? "Cover"
        : pages.length === 1 && pages[0] === PAGE_COUNT
          ? "Back cover"
          : `Pages ${pages[0]}–${pages[1]}`;

    const max = totalViews() - 1;
    progressBar.style.width = `${max ? (currentView / max) * 100 : 100}%`;
    const atStart = currentView === 0;
    const atEnd = currentView === max;
    prevButton.disabled = atStart;
    nextButton.disabled = atEnd;
    stagePrev.disabled = atStart;
    stageNext.disabled = atEnd;
    updateBookEdges();
  }

  function preload(page) {
    void ensurePageLoaded(page);
  }

  function preloadNearby() {
    const pages = currentPages();
    const first = pages[0];
    const last = pages[pages.length - 1];
    for (let offset = 1; offset <= 4; offset += 1) {
      preload(first - offset);
      preload(last + offset);
    }
  }

  function resetFlip() {
    flipSheet.className = "flip-sheet";
    flipSheet.style.transition = "none";
    flipSheet.style.webkitTransition = "none";
    flipSheet.style.transform = "";
    flipSheet.style.webkitTransform = "";
    flipFace.replaceChildren();
    book.classList.remove("is-turning");
  }

  function fallback(direction) {
    const className = direction > 0 ? "is-forward" : "is-back";
    book.classList.remove("is-forward", "is-back");
    void book.offsetWidth;
    book.classList.add(className);
    setTimeout(() => book.classList.remove(className), 360);
  }

  function render(direction = 0) {
    resetFlip();
    const pages = currentPages();
    if (isMobile() || pages.length === 1) renderSingle(pages[0]);
    else renderSpread(pages[0], pages[1]);
    setBookMode();
    updateStatus();
    preloadNearby();
    if (direction) fallback(direction);
  }

  function setFlipPhase(side, page, angle, extraClass = "") {
    flipSheet.className = `flip-sheet active half-${side}${extraClass ? ` ${extraClass}` : ""}`;
    flipFace.replaceChildren(makePage(page, true));
    flipSheet.style.transition = "none";
    flipSheet.style.webkitTransition = "none";
    flipSheet.style.transform = `rotateY(${angle}deg)`;
    flipSheet.style.webkitTransform = `rotateY(${angle}deg)`;
    book.classList.add("is-turning");
    void flipSheet.offsetWidth;
  }

  function animateFlipTo(angle) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        flipSheet.removeEventListener("transitionend", onEnd);
        resolve();
      };
      const onEnd = (event) => {
        if (event.target === flipSheet && event.propertyName === "transform") finish();
      };

      flipSheet.addEventListener("transitionend", onEnd);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        flipSheet.style.transition = `transform ${HALF_TURN_MS}ms cubic-bezier(.28,.02,.20,1)`;
        flipSheet.style.webkitTransition = `-webkit-transform ${HALF_TURN_MS}ms cubic-bezier(.28,.02,.20,1)`;
        flipSheet.style.transform = `rotateY(${angle}deg)`;
        flipSheet.style.webkitTransform = `rotateY(${angle}deg)`;
      }));
      setTimeout(finish, HALF_TURN_MS + 160);
    });
  }

  async function flipForward(oldPages, newPages) {
    busy = true;
    await Promise.all([
      ensurePageLoaded(oldPages[0]),
      ensurePageLoaded(oldPages[1]),
      ensurePageLoaded(newPages[0]),
      ensurePageLoaded(newPages[1])
    ]);

    setPage(leftSlot, oldPages[0], true);
    setPage(rightSlot, newPages[1], true);

    setFlipPhase("right", oldPages[1], 0);
    await animateFlipTo(-90);

    setFlipPhase("left", newPages[0], 90);
    await animateFlipTo(0);

    currentView += 1;
    renderSpread(newPages[0], newPages[1], true);
    setBookMode();
    updateStatus();
    preloadNearby();
    resetFlip();
    busy = false;
  }

  async function flipBackward(oldPages, newPages) {
    busy = true;
    await Promise.all([
      ensurePageLoaded(oldPages[0]),
      ensurePageLoaded(oldPages[1]),
      ensurePageLoaded(newPages[0]),
      ensurePageLoaded(newPages[1])
    ]);

    setPage(leftSlot, newPages[0], true);
    setPage(rightSlot, oldPages[1], true);

    setFlipPhase("left", oldPages[0], 0);
    await animateFlipTo(90);

    setFlipPhase("right", newPages[1], -90);
    await animateFlipTo(0);

    currentView -= 1;
    renderSpread(newPages[0], newPages[1], true);
    setBookMode();
    updateStatus();
    preloadNearby();
    resetFlip();
    busy = false;
  }

  async function openFrontCover() {
    busy = true;
    await Promise.all([ensurePageLoaded(1), ensurePageLoaded(2), ensurePageLoaded(3)]);

    setFlipPhase("right", 1, 0, "cover-turn");
    prepareTransitionBase(null, 3);
    await animateFlipTo(-90);

    setFlipPhase("left", 2, 90, "cover-turn");
    await animateFlipTo(0);

    currentView = 1;
    renderSpread(2, 3, true);
    setBookMode();
    updateStatus();
    preloadNearby();
    resetFlip();
    busy = false;
  }

  async function closeFrontCover() {
    busy = true;
    await Promise.all([ensurePageLoaded(1), ensurePageLoaded(2), ensurePageLoaded(3)]);

    setFlipPhase("left", 2, 0, "cover-turn");
    prepareTransitionBase(null, 3);
    await animateFlipTo(90);

    setFlipPhase("right", 1, -90, "cover-turn");
    await animateFlipTo(0);

    currentView = 0;
    renderSingle(1);
    setBookMode();
    updateStatus();
    preloadNearby();
    resetFlip();
    busy = false;
  }

  async function closeBackCover() {
    busy = true;
    await Promise.all([ensurePageLoaded(38), ensurePageLoaded(39), ensurePageLoaded(40)]);

    setFlipPhase("right", 39, 0, "cover-turn");
    prepareTransitionBase(38, null);
    await animateFlipTo(-90);

    setFlipPhase("left", 40, 90, "cover-turn");
    await animateFlipTo(0);

    currentView = DESKTOP_VIEWS.length - 1;
    renderSingle(40);
    setBookMode();
    updateStatus();
    preloadNearby();
    resetFlip();
    busy = false;
  }

  async function openBackCover() {
    busy = true;
    await Promise.all([ensurePageLoaded(38), ensurePageLoaded(39), ensurePageLoaded(40)]);

    setFlipPhase("left", 40, 0, "cover-turn");
    prepareTransitionBase(38, null);
    await animateFlipTo(90);

    setFlipPhase("right", 39, -90, "cover-turn");
    await animateFlipTo(0);

    currentView = DESKTOP_VIEWS.length - 2;
    renderSpread(38, 39, true);
    setBookMode();
    updateStatus();
    preloadNearby();
    resetFlip();
    busy = false;
  }

  function move(direction) {
    if (busy) return;
    const nextView = currentView + direction;
    if (nextView < 0 || nextView >= totalViews()) return;

    if (isMobile()) {
      currentView = nextView;
      render(direction);
      return;
    }

    const oldPages = DESKTOP_VIEWS[currentView];
    const newPages = DESKTOP_VIEWS[nextView];

    if (direction > 0 && currentView === 0) {
      void openFrontCover();
      return;
    }

    if (direction < 0 && currentView === 1) {
      void closeFrontCover();
      return;
    }

    if (direction > 0 && newPages.length === 1 && newPages[0] === PAGE_COUNT) {
      void closeBackCover();
      return;
    }

    if (direction < 0 && oldPages.length === 1 && oldPages[0] === PAGE_COUNT) {
      void openBackCover();
      return;
    }

    if (oldPages.length === 2 && newPages.length === 2) {
      if (direction > 0) void flipForward(oldPages, newPages);
      else void flipBackward(oldPages, newPages);
      return;
    }

    currentView = nextView;
    render(direction);
  }

  prevButton.onclick = () => move(-1);
  nextButton.onclick = () => move(1);
  stagePrev.onclick = () => move(-1);
  stageNext.onclick = () => move(1);

  document.addEventListener("keydown", (event) => {
    if (["ArrowRight", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      move(1);
    } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home" && !busy) {
      currentView = 0;
      render(-1);
    } else if (event.key === "End" && !busy) {
      currentView = totalViews() - 1;
      render(1);
    }
  });

  viewerStage.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }, { passive: true });

  viewerStage.addEventListener("touchend", (event) => {
    if (touchStartX === null) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1);
  }, { passive: true });

  fullscreenButton.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (_) {}
  };

  document.addEventListener("fullscreenchange", () => {
    fullscreenButton.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
  });

  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".viewer-stage")) event.preventDefault();
  });
  document.addEventListener("dragstart", (event) => {
    if (event.target.closest(".viewer-stage")) event.preventDefault();
  });

  let wasMobile = isMobile();
  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowMobile = isMobile();
      if (nowMobile === wasMobile) {
        updateBookEdges();
        return;
      }

      const oldPages = wasMobile ? [currentView + 1] : DESKTOP_VIEWS[currentView];
      const page = oldPages[0];
      currentView = nowMobile
        ? page - 1
        : page === 1
          ? 0
          : page === PAGE_COUNT
            ? DESKTOP_VIEWS.length - 1
            : Math.ceil((page - 1) / 2);
      wasMobile = nowMobile;
      render();
    }, 100);
  });

  render();
})();