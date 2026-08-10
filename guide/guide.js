(() => {
  "use strict";

  const PAGE_COUNT = 36;
  const PAGE_PATH = "./pages";
  const PAGE_EXT = "webp";
  const MOBILE_BREAKPOINT = 800;

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

  let currentView = 0;
  let touchStartX = null;
  let touchStartY = null;
  let busy = false;

  const isMobile = () => matchMedia(`(max-width:${MOBILE_BREAKPOINT}px)`).matches;
  const desktopViews = () => {
    const views = [[1]];
    for (let page = 2; page <= PAGE_COUNT - 1; page += 2) views.push([page, page + 1]);
    views.push([PAGE_COUNT]);
    return views;
  };
  const DESKTOP_VIEWS = desktopViews();
  const totalViews = () => (isMobile() ? PAGE_COUNT : DESKTOP_VIEWS.length);
  const currentPages = () => (isMobile() ? [currentView + 1] : DESKTOP_VIEWS[currentView]);
  const pageFile = (page) => `${PAGE_PATH}/page-${String(page).padStart(2, "0")}.${PAGE_EXT}`;

  function makePage(page) {
    const img = new Image();
    img.className = "page-image";
    img.alt = `101cruise Digital Guide page ${page}`;
    img.decoding = "async";
    img.draggable = false;

    const wrap = document.createElement("div");
    wrap.className = "page-art";

    const loading = document.createElement("div");
    loading.className = "page-loading";
    loading.textContent = `Loading page ${page}…`;
    wrap.appendChild(loading);

    img.onload = () => wrap.replaceChildren(img);
    img.onerror = () => {
      const error = document.createElement("div");
      error.className = "page-error";
      error.textContent = `Page ${page} could not be loaded.`;
      wrap.replaceChildren(error);
    };
    img.src = pageFile(page);
    return wrap;
  }

  function clearSlots() {
    leftSlot.replaceChildren();
    rightSlot.replaceChildren();
    singleSlot.replaceChildren();
  }

  function renderSingle(page) {
    book.classList.add("single-mode");
    clearSlots();
    singleSlot.appendChild(makePage(page));
  }

  function renderSpread(leftPage, rightPage) {
    book.classList.remove("single-mode");
    clearSlots();
    leftSlot.appendChild(makePage(leftPage));
    rightSlot.appendChild(makePage(rightPage));
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
    const left = 3 + progress * 9;
    const right = 12 - progress * 9;
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
    if (page < 1 || page > PAGE_COUNT) return;
    const img = new Image();
    img.src = pageFile(page);
  }

  function preloadNearby() {
    const pages = currentPages();
    const first = pages[0];
    const last = pages[pages.length - 1];
    for (let offset = 1; offset <= 3; offset += 1) {
      preload(first - offset);
      preload(last + offset);
    }
  }

  function animate(direction) {
    const className = direction > 0 ? "is-forward" : "is-back";
    book.classList.remove("is-forward", "is-back");
    void book.offsetWidth;
    book.classList.add(className);
    setTimeout(() => book.classList.remove(className), 300);
  }

  function render(direction = 0) {
    const pages = currentPages();
    if (isMobile() || pages.length === 1) renderSingle(pages[0]);
    else renderSpread(pages[0], pages[1]);
    setBookMode();
    updateStatus();
    preloadNearby();
    if (direction) animate(direction);
  }

  function move(direction) {
    if (busy) return;
    const nextView = currentView + direction;
    if (nextView < 0 || nextView >= totalViews()) return;
    busy = true;
    currentView = nextView;
    render(direction);
    setTimeout(() => { busy = false; }, 230);
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
    } else if (event.key === "Home") {
      currentView = 0;
      render(-1);
    } else if (event.key === "End") {
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
