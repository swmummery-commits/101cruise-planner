/* Admin → Cruise Database → Ships
 * Allow a canonical ship feature to be reclassified between Exclusive Areas
 * and Specialty Features without re-entering its name, description or icon.
 *
 * This is intentionally scoped to the base ship editor only. Ship Spotlight
 * consumes these canonical facilities and does not own the classification.
 */
(function (global) {
  "use strict";

  const EXCLUSIVE_ROOT_ID = "ciExclusiveAreasList";
  const SPECIALTY_ROOT_ID = "ciSpecialtyFeaturesList";
  const MOVE_ACTION = "move-feature-section";

  function featureAdmin() {
    return global.CiShipFeatureAdmin || null;
  }

  function roots() {
    return {
      exclusive: document.getElementById(EXCLUSIVE_ROOT_ID),
      specialty: document.getElementById(SPECIALTY_ROOT_ID)
    };
  }

  function readRows(root) {
    const api = featureAdmin();
    return api && root ? api.readFeatureRowsFromRoot(root) : [];
  }

  function rebuild(section, rows) {
    if (section === "exclusive" && typeof global.rebuildCiExclusiveAreasDom === "function") {
      global.rebuildCiExclusiveAreasDom(rows);
      return true;
    }
    if (section === "specialty" && typeof global.rebuildCiSpecialtyFeaturesDom === "function") {
      global.rebuildCiSpecialtyFeaturesDom(rows);
      return true;
    }
    return false;
  }

  function moveFeature(fromSection, index) {
    const currentRoots = roots();
    const sourceRoot = fromSection === "exclusive" ? currentRoots.exclusive : currentRoots.specialty;
    const targetRoot = fromSection === "exclusive" ? currentRoots.specialty : currentRoots.exclusive;
    const targetSection = fromSection === "exclusive" ? "specialty" : "exclusive";

    if (!sourceRoot || !targetRoot || !featureAdmin()) return;

    const sourceRows = readRows(sourceRoot);
    const targetRows = readRows(targetRoot);
    if (!Number.isInteger(index) || index < 0 || index >= sourceRows.length) return;

    const moved = sourceRows.splice(index, 1)[0];
    if (!moved) return;

    // Preserve the complete canonical item. Do not flatten descriptions or
    // replace the chosen icon when moving between sections.
    targetRows.push({
      name: moved.name || moved.label || "",
      description: moved.description || "",
      icon_key: moved.icon_key || "",
      showDescription: Boolean(moved.showDescription || moved.description),
      needsDescription: Boolean(moved.needsDescription && !moved.description)
    });

    rebuild(fromSection, sourceRows);
    rebuild(targetSection, targetRows);
    decorate();

    // The canonical ship editor already has an explicit Save ship workflow.
    // Make the persistence requirement obvious without auto-saving unrelated
    // unsaved edits elsewhere on the ship form.
    showMovedNotice(targetSection);
  }

  function showMovedNotice(targetSection) {
    const { exclusive, specialty } = roots();
    const host = (targetSection === "specialty" ? specialty : exclusive)?.closest(".ci-facility-section");
    if (!host) return;

    let notice = host.querySelector(".ci-feature-move-notice");
    if (!notice) {
      notice = document.createElement("p");
      notice.className = "admin-small ci-feature-move-notice";
      notice.setAttribute("role", "status");
      host.appendChild(notice);
    }
    notice.textContent = "Moved. Click Save ship to persist this change.";
  }

  function makeButton(section, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-button secondary small ci-ship-feature-section-move";
    button.dataset.action = MOVE_ACTION;
    button.dataset.section = section;
    button.dataset.index = String(index);
    button.textContent = section === "exclusive" ? "Move to Specialty →" : "← Move to Exclusive";
    button.title = section === "exclusive"
      ? "Move this item from Exclusive Areas to Specialty Features"
      : "Move this item from Specialty Features to Exclusive Areas";
    return button;
  }

  function decorateRoot(root, section) {
    if (!root) return;
    root.querySelectorAll(".ci-ship-feature-card").forEach((card, fallbackIndex) => {
      const name = String(card.querySelector(".ci-ship-feature-name")?.value || "").trim();
      const description = String(card.querySelector(".ci-ship-feature-description")?.value || "").trim();

      // Do not offer to move the blank placeholder row used when a section has
      // no canonical items yet.
      if (!name && !description) {
        card.querySelectorAll(".ci-ship-feature-section-move").forEach((node) => node.remove());
        return;
      }

      const indexAttr = Number(card.getAttribute("data-index"));
      const index = Number.isFinite(indexAttr) ? indexAttr : fallbackIndex;
      let actions = card.querySelector(".ci-ship-feature-row-actions");
      if (!actions) {
        actions = document.createElement("div");
        actions.className = "ci-ship-feature-row-actions";
        card.insertBefore(actions, card.firstChild);
      }

      let button = actions.querySelector(".ci-ship-feature-section-move");
      if (!button) {
        button = makeButton(section, index);
        // Put the classification action before destructive Remove.
        const remove = actions.querySelector('[data-action="remove"]');
        if (remove) actions.insertBefore(button, remove);
        else actions.appendChild(button);
      } else {
        // Keep decoration idempotent. Rewriting textContent on every observer
        // pass creates a new text node, which triggers the childList observer
        // again and can starve the browser before the ship editor paints.
        const nextIndex = String(index);
        const nextText = section === "exclusive" ? "Move to Specialty →" : "← Move to Exclusive";
        if (button.dataset.section !== section) button.dataset.section = section;
        if (button.dataset.index !== nextIndex) button.dataset.index = nextIndex;
        if (button.textContent !== nextText) button.textContent = nextText;
      }
    });
  }

  function decorate() {
    const currentRoots = roots();
    decorateRoot(currentRoots.exclusive, "exclusive");
    decorateRoot(currentRoots.specialty, "specialty");
  }

  function handleClick(event) {
    const button = event.target?.closest?.(`[data-action="${MOVE_ACTION}"]`);
    if (!button) return;

    // Hard scope: only accept buttons mounted inside the canonical ship editor
    // lists. This cannot run in Ship Spotlight.
    const list = button.closest(`#${EXCLUSIVE_ROOT_ID}, #${SPECIALTY_ROOT_ID}`);
    if (!list) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const section = button.dataset.section === "specialty" ? "specialty" : "exclusive";
    const index = Number(button.dataset.index);
    button.disabled = true;
    moveFeature(section, index);
  }

  function installStyles() {
    if (document.getElementById("ciShipFeatureSectionMoveStyles")) return;
    const style = document.createElement("style");
    style.id = "ciShipFeatureSectionMoveStyles";
    style.textContent = `
      #${EXCLUSIVE_ROOT_ID} .ci-ship-feature-section-move,
      #${SPECIALTY_ROOT_ID} .ci-ship-feature-section-move {
        white-space: nowrap;
      }
      .ci-feature-move-notice {
        margin: 8px 0 0;
        color: #245c4e;
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);
  }

  installStyles();
  document.addEventListener("click", handleClick, true);
  decorate();

  const observer = new MutationObserver(() => decorate());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  global.AdminShipFeatureSectionMove = {
    decorate,
    moveFeature
  };
})(window);
