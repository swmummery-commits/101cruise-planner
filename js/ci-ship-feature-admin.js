/**
 * Shared Admin structured ship-feature row editor (Exclusive Areas + Specialty Features).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipFeatureAdmin = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function iconsApi() {
    return (typeof window !== "undefined" && window.CiShipFeatureIcons) || null;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderIconPicker(row, index, prefix) {
    const icons = iconsApi();
    const iconKey = trim(row.icon_key) || (icons ? icons.FALLBACK_KEY : "sparkles");
    const label = icons ? icons.iconLabel(iconKey) : iconKey;
    const svg = icons ? icons.renderIconSvg(iconKey, "ci-ship-feature-picker-svg") : "";

    return `
      <div class="ci-ship-feature-icon-picker" data-prefix="${esc(prefix)}" data-index="${index}">
        <button type="button" class="ci-ship-feature-icon-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose icon for ${esc(row.name || "feature")}">
          ${svg}
          <span class="ci-ship-feature-icon-trigger-label">${esc(label)}</span>
        </button>
        <input type="hidden" class="ci-ship-feature-icon-key" value="${esc(iconKey)}">
        <div class="ci-ship-feature-icon-menu" role="listbox" hidden data-lazy-icons="1"></div>
      </div>`;
  }

  function populateIconMenu(menu, selectedKey) {
    const icons = iconsApi();
    if (!icons || !menu || menu.dataset.populated === "1") return;
    const iconKey = trim(selectedKey) || icons.FALLBACK_KEY;
    menu.innerHTML = icons.listIconCatalog().map(function (item) {
      const selected = item.key === iconKey ? " selected" : "";
      return `<button type="button" class="ci-ship-feature-icon-option${selected}" data-icon-key="${esc(item.key)}" title="${esc(item.label)}" aria-label="${esc(item.label)}">
        ${icons.renderIconSvg(item.key, "ci-ship-feature-icon-option-svg")}
        <span class="ci-ship-feature-icon-option-label">${esc(item.label)}</span>
      </button>`;
    }).join("");
    menu.dataset.populated = "1";
  }

  function renderFeatureRow(row, index, total, options) {
    const opts = options || {};
    const prefix = opts.prefix || "ciShipFeature";
    const cardClass = opts.cardClass || "ci-ship-feature-card";
    const readonly = Boolean(opts.readonly);
    const sectionLabel = opts.sectionLabel || "Feature";
    const showDescription = Boolean(row.showDescription || row.description);
    const descHidden = showDescription ? "" : " hidden";
    const addDescHidden = showDescription ? " hidden" : "";
    const readAttr = readonly ? " readonly" : "";
    const needsDesc = Boolean(row.needsDescription && !row.description);
    const addDescBtn = readonly
      ? `<button type="button" class="admin-button secondary small ci-ship-feature-add-desc${addDescHidden}" disabled>Add description</button>`
      : `<button type="button" class="admin-button secondary small ci-ship-feature-add-desc${addDescHidden}" data-action="show-desc" data-index="${index}">Add description</button>`;

    const actions = readonly
      ? ""
      : `
      <div class="ci-ship-feature-row-actions">
        <button type="button" class="admin-button secondary small" data-action="move-up" data-index="${index}" title="Move up">↑</button>
        <button type="button" class="admin-button secondary small" data-action="move-down" data-index="${index}" title="Move down">↓</button>
        <button type="button" class="admin-button secondary small" data-action="remove" data-index="${index}">Remove</button>
      </div>`;

    const head = total > 1 && !readonly
      ? `<div class="ci-ship-feature-card-head"><strong class="ci-ship-feature-card-title">${esc(sectionLabel)} ${index + 1}</strong>${actions}</div>`
      : (total > 1 && readonly ? `<strong class="ci-ship-feature-card-title">${esc(sectionLabel)} ${index + 1}</strong>` : actions);

    return `
      <div class="${cardClass}" data-index="${index}">
        ${head}
        <div class="ci-ship-feature-row-layout">
          ${renderIconPicker(row, index, prefix)}
          <div class="ci-ship-feature-fields">
            <div class="admin-field">
              <label>Name</label>
              <input type="text" class="ci-ship-feature-name" value="${esc(row.name || row.label || "")}" placeholder="Feature name"${readAttr}>
            </div>
            ${addDescBtn}
            <div class="ci-ship-feature-description-wrap admin-field${descHidden}">
              <label>Description${readonly ? "" : " <span class=\"admin-small\">(recommended)</span>"}</label>
              <textarea class="ci-ship-feature-description" rows="2" placeholder="Short detail shown on My Ship"${readAttr}>${esc(row.description || "")}</textarea>
            </div>
            ${needsDesc && !readonly ? `<p class="admin-small ci-ship-feature-needs-desc">Description needed</p>` : ""}
          </div>
        </div>
      </div>`;
  }

  function readFeatureRowsFromRoot(root) {
    if (!root) return [];
    const rows = [];
    root.querySelectorAll(".ci-ship-feature-card").forEach(function (card) {
      const name = trim(card.querySelector(".ci-ship-feature-name")?.value);
      const description = trim(card.querySelector(".ci-ship-feature-description")?.value);
      const icon_key = trim(card.querySelector(".ci-ship-feature-icon-key")?.value);
      const descWrap = card.querySelector(".ci-ship-feature-description-wrap");
      const showDescription = Boolean(descWrap && !descWrap.classList.contains("hidden"));
      if (!name && !description) return;
      rows.push({
        name: name,
        description: description,
        icon_key: icon_key,
        showDescription: showDescription || Boolean(description),
        needsDescription: !description
      });
    });
    return rows;
  }

  function rebuildFeatureList(root, rows, options) {
    if (!root) return;
    root.dataset.featureBound = "";
    const opts = options || {};
    const list = rows.length ? rows : [{ name: "", description: "", icon_key: iconsApi()?.FALLBACK_KEY || "sparkles", showDescription: false, needsDescription: false }];
    root.innerHTML = list.map(function (row, index) {
      return renderFeatureRow(row, index, list.length, opts);
    }).join("");
  }

  let documentCloseBound = false;

  function bindFeatureList(root, handlers) {
    if (!root) return;
    if (root.dataset.featureBound === "1") return;
    root.dataset.featureBound = "1";
    const h = handlers || {};

    root.addEventListener("click", function (event) {
      const trigger = event.target.closest(".ci-ship-feature-icon-trigger");
      if (trigger) {
        const picker = trigger.closest(".ci-ship-feature-icon-picker");
        const menu = picker?.querySelector(".ci-ship-feature-icon-menu");
        if (!menu) return;
        const hidden = picker?.querySelector(".ci-ship-feature-icon-key");
        populateIconMenu(menu, hidden?.value);
        const open = menu.hasAttribute("hidden");
        root.querySelectorAll(".ci-ship-feature-icon-menu").forEach(function (node) {
          node.hidden = true;
        });
        root.querySelectorAll(".ci-ship-feature-icon-trigger").forEach(function (node) {
          node.setAttribute("aria-expanded", "false");
        });
        if (open) {
          menu.hidden = false;
          trigger.setAttribute("aria-expanded", "true");
        }
        event.stopPropagation();
        return;
      }

      const option = event.target.closest(".ci-ship-feature-icon-option");
      if (option) {
        const picker = option.closest(".ci-ship-feature-icon-picker");
        const hidden = picker?.querySelector(".ci-ship-feature-icon-key");
        const triggerBtn = picker?.querySelector(".ci-ship-feature-icon-trigger");
        const menu = picker?.querySelector(".ci-ship-feature-icon-menu");
        const key = option.getAttribute("data-icon-key");
        if (hidden && key) hidden.value = key;
        if (triggerBtn && iconsApi()) {
          triggerBtn.innerHTML = `${iconsApi().renderIconSvg(key, "ci-ship-feature-picker-svg")}<span class="ci-ship-feature-icon-trigger-label">${esc(iconsApi().iconLabel(key))}</span>`;
          triggerBtn.setAttribute("aria-expanded", "false");
        }
        if (menu) menu.hidden = true;
        picker?.querySelectorAll(".ci-ship-feature-icon-option").forEach(function (btn) {
          btn.classList.toggle("selected", btn.getAttribute("data-icon-key") === key);
        });
        if (h.onChange) h.onChange();
        event.stopPropagation();
        return;
      }

      const actionBtn = event.target.closest("[data-action]");
      if (!actionBtn) return;
      const card = actionBtn.closest(".ci-ship-feature-card");
      const index = Number(card?.getAttribute("data-index"));
      if (!Number.isFinite(index)) return;
      const action = actionBtn.getAttribute("data-action");
      if (action === "show-desc" && h.onShowDescription) h.onShowDescription(index);
      else if (action === "remove" && h.onRemove) h.onRemove(index);
      else if (action === "move-up" && h.onMove) h.onMove(index, -1);
      else if (action === "move-down" && h.onMove) h.onMove(index, 1);
    });

    if (!documentCloseBound) {
      documentCloseBound = true;
      document.addEventListener("click", function (event) {
        if (event.target.closest(".ci-ship-feature-icon-picker")) return;
        document.querySelectorAll(".ci-ship-feature-icon-menu").forEach(function (node) {
          node.hidden = true;
        });
        document.querySelectorAll(".ci-ship-feature-icon-trigger").forEach(function (node) {
          node.setAttribute("aria-expanded", "false");
        });
      });
    }
  }

  return {
    renderIconPicker: renderIconPicker,
    renderFeatureRow: renderFeatureRow,
    readFeatureRowsFromRoot: readFeatureRowsFromRoot,
    rebuildFeatureList: rebuildFeatureList,
    bindFeatureList: bindFeatureList
  };
});
