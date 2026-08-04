/**
 * Cruise line ship feature catalogue — Exclusive Areas + Specialty Features.
 * Browser global: CruiseLineFeaturesAdmin
 */
(function (global) {
  "use strict";

  let features = [];
  let loading = false;
  let loadError = "";
  let saving = false;
  let reordering = false;
  let message = "";
  let messageTone = "";
  let activeLineId = "";
  let editingId = null;
  let creatingType = "";
  let draft = emptyDraft();
  let draggedFeatureId = null;
  let draggedSourceType = "";
  let dragFromHandle = false;

  function emptyDraft() {
    return {
      name: "",
      description: "",
      icon_key: "sparkles",
      is_active: true,
      assignedClassKeys: [],
      assignedShipIds: []
    };
  }

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
  }

  function svc() {
    return global.CruiseLineFeaturesService || null;
  }

  function icons() {
    return global.CiShipFeatureIcons || null;
  }

  function featureAdmin() {
    return global.CiShipFeatureAdmin || null;
  }

  function rerender(options) {
    const opts = options && typeof options === "object" ? options : {};
    if (opts.activateFeaturesTab && typeof global.setCiLineTab === "function") {
      try {
        global.setCiLineTab("features");
      } catch (_error) {
        /* ignore */
      }
    }
    try {
      if (typeof global.renderCiAdmin === "function") {
        global.renderCiAdmin();
        return;
      }
      if (typeof global.renderAdmin === "function") {
        global.renderAdmin();
        return;
      }
      console.error("CruiseLineFeaturesAdmin: renderAdmin is not available");
    } catch (error) {
      console.error("CruiseLineFeaturesAdmin: render failed", error);
    }
  }

  function setMessage(text, tone) {
    message = text || "";
    messageTone = tone || "";
  }

  function syncWindowCache() {
    global.ciCruiseLineFeatures = features.slice();
  }

  function withSavingOverlay(fn, supportMessage) {
    const loading = global.AdminLoading;
    if (loading?.withSaving) {
      return loading.withSaving(fn, {
        key: "ci-line-features",
        supportMessage: supportMessage || ""
      });
    }
    return fn();
  }

  function sortedFeatures(featureType) {
    const service = svc();
    return service ? service.filterByType(features, featureType) : [];
  }

  function activeFeatures(featureType) {
    const service = svc();
    const rows = service ? service.filterByType(features, featureType) : [];
    return service ? service.listActiveFeaturesFromRows(rows) : rows.filter((row) => row.is_active !== false);
  }

  function tplApi() {
    return global.CiShipClassFacilitiesTemplate || null;
  }

  function lineShips() {
    return (global.ciCruiseShips || []).filter(function (ship) {
      return ship && ship.cruise_line_id === activeLineId;
    });
  }

  function lineTemplates() {
    return (global.ciShipClassFacilityTemplates || []).filter(function (row) {
      return row && row.cruise_line_id === activeLineId;
    });
  }

  function classOptionsForLine() {
    const api = tplApi();
    if (!api || !activeLineId) return [];
    return api.listDistinctClassesForLine(global.ciCruiseShips || [], activeLineId);
  }

  function classKeyForName(className) {
    const api = tplApi();
    return api ? api.normalizeClassKey(className) : String(className || "").trim().toLowerCase();
  }

  function templateIncludesFeature(template, featureType, name) {
    const service = svc();
    if (!service || !template) return false;
    const key =
      featureType === "exclusive_area"
        ? "exclusive_areas"
        : featureType === "specialty_feature"
          ? "specialty_features"
          : null;
    if (!key) return false;
    const norm = service.normalizeName(name);
    return (Array.isArray(template[key]) ? template[key] : []).some(function (item) {
      return service.normalizeName(service.featureItemName(item)) === norm;
    });
  }

  function assignedClassKeysForFeature(featureType, name) {
    const api = tplApi();
    if (!api || !name) return [];
    const templates = lineTemplates();
    return classOptionsForLine().filter(function (className) {
      const template = api.templateRecordForClass(templates, activeLineId, className);
      return templateIncludesFeature(template, featureType, name);
    }).map(classKeyForName);
  }

  function assignedShipIdsForFeature(featureType, name) {
    const service = svc();
    if (!service || !name) return [];
    return lineShips()
      .filter(function (ship) {
        return service.shipHasFeature(ship, featureType, name);
      })
      .map(function (ship) {
        return String(ship.id);
      });
  }

  function featureToDraft(row) {
    const featureType = row?.feature_type || "";
    return {
      name: row?.name || "",
      description: row?.description || "",
      icon_key: row?.icon_key || "sparkles",
      is_active: row?.is_active !== false,
      assignedClassKeys: assignedClassKeysForFeature(featureType, row?.name),
      assignedShipIds: assignedShipIdsForFeature(featureType, row?.name)
    };
  }

  function readDraftFromDom() {
    const get = (id) => document.getElementById(id)?.value;
    draft = {
      name: String(get("ciLineFeatureName") || "").trim(),
      description: String(get("ciLineFeatureDescription") || "").trim(),
      icon_key: String(document.querySelector("#ciLineFeaturesPanel .ci-ship-feature-icon-key")?.value || draft.icon_key || "sparkles").trim() || "sparkles",
      is_active: String(get("ciLineFeatureActive") || "true") !== "false",
      assignedClassKeys: Array.from(document.querySelectorAll(".ci-line-feature-class-cb:checked")).map(function (el) {
        return String(el.value || "").trim();
      }).filter(Boolean),
      assignedShipIds: Array.from(document.querySelectorAll(".ci-line-feature-ship-cb:checked")).map(function (el) {
        return String(el.value || "").trim();
      }).filter(Boolean)
    };
    return draft;
  }

  function renderAssignmentSection(featureType) {
    const classes = classOptionsForLine();
    const ships = lineShips()
      .slice()
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
      });
    const selectedClasses = new Set((draft.assignedClassKeys || []).map(String));
    const selectedShips = new Set((draft.assignedShipIds || []).map(String));

    const classList = classes.length
      ? classes
          .map(function (className) {
            const key = classKeyForName(className);
            const memberCount = ships.filter(function (ship) {
              return classKeyForName(ship.ship_class) === key;
            }).length;
            const checked = selectedClasses.has(key) ? "checked" : "";
            return `
              <label class="ci-check-control ci-line-feature-assign-item">
                <input type="checkbox" class="ci-line-feature-class-cb" value="${esc(key)}" data-class-name="${esc(className)}" ${checked}>
                <span>${esc(className)} <span class="admin-small">(${memberCount} ship${memberCount === 1 ? "" : "s"})</span></span>
              </label>`;
          })
          .join("")
      : `<p class="admin-small">No ship classes assigned on this line yet. Assign classes under Ship Classes, then return here.</p>`;

    const shipList = ships.length
      ? ships
          .map(function (ship) {
            const checked = selectedShips.has(String(ship.id)) ? "checked" : "";
            const classLabel = ship.ship_class ? ` · ${esc(ship.ship_class)}` : "";
            return `
              <label class="ci-check-control ci-line-feature-assign-item">
                <input type="checkbox" class="ci-line-feature-ship-cb" value="${esc(ship.id)}" ${checked}>
                <span>${esc(ship.name || "Untitled ship")}<span class="admin-small">${classLabel}</span></span>
              </label>`;
          })
          .join("")
      : `<p class="admin-small">No ships on this cruise line yet.</p>`;

    const typeLabel = featureType === "exclusive_area" ? "exclusive area" : "specialty feature";
    return `
      <div class="ci-line-feature-assign">
        <h5>Assign this ${esc(typeLabel)}</h5>
        <p class="admin-small">Choose which ship classes and ships this ${esc(typeLabel)} belongs to. Class selections update facilities templates. Ship selections add or remove only this feature — other ship facilities stay intact.</p>
        <div class="ci-line-feature-assign-block">
          <h6>Ship classes</h6>
          <div class="ci-line-feature-assign-grid">${classList}</div>
        </div>
        <div class="ci-line-feature-assign-block">
          <h6>Individual ships</h6>
          <div class="ci-line-feature-assign-grid">${shipList}</div>
        </div>
      </div>`;
  }

  async function saveClassAssignments(featureType, savedFeature, previousName) {
    const service = svc();
    const api = tplApi();
    if (!service || !api || !activeLineId || !window.adminAuthHeaders) return { classesUpdated: 0 };

    const selectedKeys = new Set((draft.assignedClassKeys || []).map(String));
    const classes = classOptionsForLine();
    const item = service.featureItemFromCatalogueRow(savedFeature);
    const oldName = previousName || savedFeature.name;
    let classesUpdated = 0;

    for (let i = 0; i < classes.length; i += 1) {
      const className = classes[i];
      const key = classKeyForName(className);
      const existing = api.templateRecordForClass(lineTemplates(), activeLineId, className);
      const basePayload = existing
        ? {
            exclusive_areas: Array.isArray(existing.exclusive_areas) ? existing.exclusive_areas : [],
            specialty_features: Array.isArray(existing.specialty_features) ? existing.specialty_features : []
          }
        : api.resolveClassTemplatePayload({
            templates: lineTemplates(),
            ships: global.ciCruiseShips || [],
            cruiseLineId: activeLineId,
            className: className
          }).payload;

      const hadFeature =
        templateIncludesFeature(
          {
            exclusive_areas: basePayload.exclusive_areas,
            specialty_features: basePayload.specialty_features
          },
          featureType,
          oldName
        ) ||
        templateIncludesFeature(
          {
            exclusive_areas: basePayload.exclusive_areas,
            specialty_features: basePayload.specialty_features
          },
          featureType,
          savedFeature.name
        );
      const shouldHave = selectedKeys.has(key);
      if (!shouldHave && !hadFeature) continue;

      let nextPayload = basePayload;
      if (oldName && service.normalizeName(oldName) !== service.normalizeName(savedFeature.name)) {
        nextPayload = service.removeFeatureFromTemplatePayload(nextPayload, featureType, oldName);
      }
      if (shouldHave) {
        nextPayload = service.mergeFeatureIntoTemplatePayload(nextPayload, featureType, item);
      } else {
        nextPayload = service.removeFeatureFromTemplatePayload(nextPayload, featureType, savedFeature.name);
        if (oldName) nextPayload = service.removeFeatureFromTemplatePayload(nextPayload, featureType, oldName);
      }

      const headers = await window.adminAuthHeaders({ "Content-Type": "application/json" });
      const response = await fetch("/.netlify/functions/ci-ship-class-facilities-save", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          cruise_line_id: activeLineId,
          class_name: className,
          exclusive_areas: nextPayload.exclusive_areas,
          specialty_features: nextPayload.specialty_features
        })
      });
      const data = await response.json().catch(function () {
        return {};
      });
      if (!response.ok || data.success === false) {
        throw new Error(data.detail || data.error || `Could not update ${className} template.`);
      }
      if (data.template && window.mergeCiShipClassFacilityTemplate) {
        window.mergeCiShipClassFacilityTemplate(data.template);
      }
      classesUpdated += 1;
    }

    if (window.refreshCiLineShipClassesSection) window.refreshCiLineShipClassesSection();
    return { classesUpdated: classesUpdated };
  }

  async function saveShipAssignments(featureType, savedFeature, previousName) {
    const service = svc();
    const client = global.supabaseClient;
    if (!service || !client || !activeLineId) return { shipsUpdated: 0 };

    const selectedIds = new Set((draft.assignedShipIds || []).map(String));
    const item = service.featureItemFromCatalogueRow(savedFeature);
    const namesToClear = [savedFeature.name, previousName]
      .map(function (name) {
        return service.normalizeName(name);
      })
      .filter(Boolean);
    let shipsUpdated = 0;

    const targets = lineShips().filter(function (ship) {
      const id = String(ship.id);
      const selected = selectedIds.has(id);
      const currentlyHas =
        service.shipHasFeature(ship, featureType, savedFeature.name) ||
        (previousName && service.shipHasFeature(ship, featureType, previousName));
      return selected || currentlyHas;
    });

    for (let i = 0; i < targets.length; i += 1) {
      const ship = targets[i];
      const selected = selectedIds.has(String(ship.id));
      let nextFacilities = ship.facilities && typeof ship.facilities === "object" ? Object.assign({}, ship.facilities) : {};
      const arrayKey =
        featureType === "exclusive_area"
          ? "exclusive_areas"
          : featureType === "specialty_feature"
            ? "specialty_features"
            : null;
      if (!arrayKey) continue;

      if (selected) {
        nextFacilities = service.mergeFeatureIntoShipFacilities(nextFacilities, featureType, item);
      } else {
        const arr = Array.isArray(nextFacilities[arrayKey]) ? nextFacilities[arrayKey].slice() : [];
        nextFacilities[arrayKey] = arr.filter(function (entry) {
          return !namesToClear.includes(service.normalizeName(service.featureItemName(entry)));
        });
        if (!nextFacilities[arrayKey].length) delete nextFacilities[arrayKey];
      }

      const result = await client
        .from("ci_cruise_ships")
        .update({ facilities: nextFacilities })
        .eq("id", ship.id)
        .select()
        .single();
      if (result.error) {
        throw new Error(result.error.message || `Could not update ${ship.name || "ship"}.`);
      }
      const idx = (global.ciCruiseShips || []).findIndex(function (row) {
        return row.id === ship.id;
      });
      if (idx >= 0) {
        global.ciCruiseShips[idx] = Object.assign({}, global.ciCruiseShips[idx], result.data || { facilities: nextFacilities });
      }
      shipsUpdated += 1;
    }

    if (window.syncCiCatalogueWindowState) window.syncCiCatalogueWindowState();
    return { shipsUpdated: shipsUpdated };
  }

  async function migrateFeatureTypeAssignments(sourceType, targetType, featureRow) {
    const service = svc();
    const api = tplApi();
    if (!service || !featureRow?.name) return { classesUpdated: 0, shipsUpdated: 0 };

    const item = service.featureItemFromCatalogueRow(featureRow);
    const name = featureRow.name;
    let classesUpdated = 0;
    let shipsUpdated = 0;

    if (api && window.adminAuthHeaders && activeLineId) {
      const classes = classOptionsForLine();
      for (let i = 0; i < classes.length; i += 1) {
        const className = classes[i];
        const existing = api.templateRecordForClass(lineTemplates(), activeLineId, className);
        const basePayload = existing
          ? {
              exclusive_areas: Array.isArray(existing.exclusive_areas) ? existing.exclusive_areas : [],
              specialty_features: Array.isArray(existing.specialty_features) ? existing.specialty_features : []
            }
          : api.resolveClassTemplatePayload({
              templates: lineTemplates(),
              ships: global.ciCruiseShips || [],
              cruiseLineId: activeLineId,
              className: className
            }).payload;

        if (!templateIncludesFeature(basePayload, sourceType, name)) continue;

        let nextPayload = service.removeFeatureFromTemplatePayload(basePayload, sourceType, name);
        nextPayload = service.mergeFeatureIntoTemplatePayload(nextPayload, targetType, item);

        const headers = await window.adminAuthHeaders({ "Content-Type": "application/json" });
        const response = await fetch("/.netlify/functions/ci-ship-class-facilities-save", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            cruise_line_id: activeLineId,
            class_name: className,
            exclusive_areas: nextPayload.exclusive_areas,
            specialty_features: nextPayload.specialty_features
          })
        });
        const data = await response.json().catch(function () {
          return {};
        });
        if (!response.ok || data.success === false) {
          throw new Error(data.detail || data.error || `Could not update ${className} template.`);
        }
        if (data.template && window.mergeCiShipClassFacilityTemplate) {
          window.mergeCiShipClassFacilityTemplate(data.template);
        }
        classesUpdated += 1;
      }
      if (window.refreshCiLineShipClassesSection) window.refreshCiLineShipClassesSection();
    }

    const client = global.supabaseClient;
    if (client && activeLineId) {
      const ships = lineShips();
      for (let i = 0; i < ships.length; i += 1) {
        const ship = ships[i];
        if (!service.shipHasFeature(ship, sourceType, name)) continue;

        let nextFacilities =
          ship.facilities && typeof ship.facilities === "object" ? Object.assign({}, ship.facilities) : {};
        nextFacilities = service.removeFeatureFromShipFacilities(nextFacilities, sourceType, name);
        nextFacilities = service.mergeFeatureIntoShipFacilities(nextFacilities, targetType, item);

        const result = await client
          .from("ci_cruise_ships")
          .update({ facilities: nextFacilities })
          .eq("id", ship.id)
          .select()
          .single();
        if (result.error) {
          throw new Error(result.error.message || `Could not update ${ship.name || "ship"}.`);
        }
        const idx = (global.ciCruiseShips || []).findIndex(function (row) {
          return row.id === ship.id;
        });
        if (idx >= 0) {
          global.ciCruiseShips[idx] = Object.assign({}, global.ciCruiseShips[idx], result.data || { facilities: nextFacilities });
        }
        shipsUpdated += 1;
      }
      if (window.syncCiCatalogueWindowState) window.syncCiCatalogueWindowState();
    }

    return { classesUpdated: classesUpdated, shipsUpdated: shipsUpdated };
  }

  async function loadForLine(lineId, { rerenderOnComplete = true } = {}) {
    const service = svc();
    activeLineId = String(lineId || "").trim();
    if (!activeLineId || !service) {
      features = [];
      syncWindowCache();
      return;
    }
    loading = true;
    loadError = "";
    if (rerenderOnComplete) rerender();
    try {
      features = await service.listFeaturesForLine(activeLineId);
      syncWindowCache();
    } catch (error) {
      loadError = error.message || "Could not load ship features.";
      features = [];
      syncWindowCache();
    } finally {
      loading = false;
      if (rerenderOnComplete) rerender();
    }
  }

  function startCreate(featureType) {
    const type = String(featureType || "").trim();
    if (type !== "exclusive_area" && type !== "specialty_feature") {
      console.warn("CruiseLineFeaturesAdmin.startCreate: invalid feature type", featureType);
      return;
    }
    creatingType = type;
    editingId = null;
    draft = emptyDraft();
    const iconApi = icons();
    if (iconApi) draft.icon_key = iconApi.FALLBACK_KEY;
    setMessage("", "");
    if (activeLineId && typeof global.loadCiShipClassFacilityTemplatesForLine === "function") {
      global.loadCiShipClassFacilityTemplatesForLine(activeLineId);
    }
    rerender({ activateFeaturesTab: true });
  }

  function startEdit(id) {
    const featureId = String(id || "").trim();
    const row = features.find((item) => item.id === featureId);
    if (!row) {
      console.warn("CruiseLineFeaturesAdmin.startEdit: feature not found", id);
      return;
    }
    creatingType = "";
    editingId = featureId;
    draft = featureToDraft(row);
    setMessage("", "");
    if (activeLineId && typeof global.loadCiShipClassFacilityTemplatesForLine === "function") {
      global.loadCiShipClassFacilityTemplatesForLine(activeLineId);
    }
    rerender({ activateFeaturesTab: true });
  }

  function cancelEdit() {
    creatingType = "";
    editingId = null;
    draft = emptyDraft();
    setMessage("", "");
    rerender({ activateFeaturesTab: true });
  }

  function retryLoad() {
    return loadForLine(activeLineId);
  }

  async function saveFeature() {
    const service = svc();
    if (!service || saving || !activeLineId) return;
    readDraftFromDom();
    const row = editingId ? features.find((item) => item.id === editingId) : null;
    const featureType = row?.feature_type || creatingType;
    if (!featureType) return;
    const previousName = row?.name || "";

    return withSavingOverlay(async function () {
      saving = true;
      setMessage("Saving feature…", "running");
      rerender({ activateFeaturesTab: true });
      try {
        let savedFeature = null;
        if (editingId) {
          const validation = service.validateFeatureInput({
            name: draft.name,
            description: draft.description,
            icon_key: draft.icon_key,
            is_active: draft.is_active,
            feature_type: featureType,
            cruise_line_id: activeLineId,
            existingRows: features,
            editingId
          });
          if (!validation.ok) {
            setMessage(validation.error, "error");
            return;
          }
          savedFeature = await service.updateFeature(editingId, validation.payload);
        } else {
          const validation = service.buildCreatePayload({
            name: draft.name,
            description: draft.description,
            icon_key: draft.icon_key,
            is_active: draft.is_active,
            feature_type: featureType,
            cruise_line_id: activeLineId,
            existingRows: features
          });
          if (!validation.ok) {
            setMessage(validation.error, "error");
            return;
          }
          savedFeature = await service.createFeature(validation.payload);
        }

        savedFeature = Object.assign({}, savedFeature || {}, {
          name: draft.name,
          description: draft.description,
          icon_key: draft.icon_key,
          is_active: draft.is_active,
          feature_type: featureType
        });

        const classResult = await saveClassAssignments(featureType, savedFeature, previousName);
        const shipResult = await saveShipAssignments(featureType, savedFeature, previousName);

        const parts = ["Feature saved."];
        if (classResult.classesUpdated) {
          parts.push(
            `Updated ${classResult.classesUpdated} class template${classResult.classesUpdated === 1 ? "" : "s"}.`
          );
        }
        if (shipResult.shipsUpdated) {
          parts.push(`Updated ${shipResult.shipsUpdated} ship${shipResult.shipsUpdated === 1 ? "" : "s"}.`);
        }
        setMessage(parts.join(" "), "success");

        await loadForLine(activeLineId, { rerenderOnComplete: false });
        creatingType = "";
        editingId = null;
        draft = emptyDraft();
      } catch (error) {
        setMessage(error.message || "Could not save feature.", "error");
      } finally {
        saving = false;
        rerender({ activateFeaturesTab: true });
      }
    }, "Saving feature…");
  }

  async function deleteFeature(id) {
    const service = svc();
    if (!service || saving) return;
    const row = features.find((item) => item.id === id);
    if (!row) return;
    const label = row.name || "this feature";
    if (!global.confirm(`Delete “${label}”? Class templates that use it will need updating.`)) return;

    return withSavingOverlay(async function () {
      saving = true;
      setMessage("Deleting feature…", "running");
      rerender();
      try {
        await service.deleteFeature(id);
        setMessage(`Deleted “${label}”.`, "success");
        if (editingId === id) cancelEdit();
        await loadForLine(activeLineId, { rerenderOnComplete: false });
      } catch (error) {
        setMessage(error.message || "Could not delete feature.", "error");
      } finally {
        saving = false;
        rerender();
      }
    }, "Deleting feature…");
  }

  function findDraggedRow() {
    if (!draggedFeatureId) return null;
    const panel = document.getElementById("ciLineFeaturesPanel");
    if (!panel) return null;
    return panel.querySelector(
      `.ci-line-feature-row[data-feature-id="${CSS.escape(String(draggedFeatureId))}"]`
    );
  }

  function clearDropTargets() {
    document.querySelectorAll(".ci-line-feature-list.is-drop-target").forEach(function (list) {
      list.classList.remove("is-drop-target");
    });
  }

  function onDragHandlePointerDown(event) {
    dragFromHandle = true;
    event.stopPropagation();
  }

  function onDragStart(event, id) {
    if (!dragFromHandle || saving || reordering) {
      event.preventDefault();
      return;
    }
    dragFromHandle = false;
    draggedFeatureId = String(id || "");
    draggedSourceType = String(event.currentTarget?.getAttribute("data-feature-type") || "");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedFeatureId);
    event.currentTarget.classList.add("is-dragging");
  }

  function onDragEnd(event) {
    dragFromHandle = false;
    clearDropTargets();
    event.currentTarget?.classList.remove("is-dragging");
    const featureId = draggedFeatureId;
    const sourceType = draggedSourceType;
    draggedFeatureId = null;
    draggedSourceType = "";
    if (!featureId) return;

    const targetType = event.currentTarget?.closest("[data-feature-type]")?.getAttribute("data-feature-type");
    if (!targetType) return;

    if (sourceType && sourceType !== targetType) {
      saveMoveFromDom(featureId, sourceType, targetType);
    } else {
      saveOrderFromDom(targetType);
    }
  }

  function allowDrop(event) {
    if (!draggedFeatureId || saving || reordering) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const list = event.currentTarget;
    const dragged = findDraggedRow();
    if (!dragged) return;

    clearDropTargets();
    list.classList.add("is-drop-target");

    const targetType = list.getAttribute("data-feature-type");
    const sourceList = dragged.parentElement;
    if (sourceList !== list && targetType) {
      dragged.setAttribute("data-feature-type", targetType);
      const placeholder = list.querySelector(":scope > .admin-small");
      if (placeholder) placeholder.remove();
    }

    const cards = Array.from(list.querySelectorAll(".ci-line-feature-row:not(.is-dragging)"));
    const afterElement = cards.find(function (card) {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });

    if (afterElement) {
      if (dragged.nextSibling !== afterElement) list.insertBefore(dragged, afterElement);
    } else if (list.lastElementChild !== dragged) {
      list.appendChild(dragged);
    }
  }

  function onDrop(event) {
    if (!draggedFeatureId) return;
    event.preventDefault();
  }

  function readOrderedIdsFromDom(featureType) {
    const list = document.getElementById(
      featureType === "exclusive_area" ? "ciLineFeaturesEaList" : "ciLineFeaturesSfList"
    );
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-feature-id]"))
      .map((el) => el.getAttribute("data-feature-id"))
      .filter(Boolean);
  }

  async function saveOrderFromDom(featureType) {
    const service = svc();
    if (!service || saving || reordering || !activeLineId) return;
    const orderedIds = readOrderedIdsFromDom(featureType);
    if (!orderedIds.length) return;
    const reorder = service.buildReorderPayload(orderedIds);
    if (!reorder.ok) {
      setMessage(reorder.error, "error");
      rerender();
      return;
    }

    return withSavingOverlay(async function () {
      reordering = true;
      setMessage("Saving order…", "running");
      rerender();
      try {
        features = await service.reorderFeatures(activeLineId, featureType, orderedIds);
        syncWindowCache();
        setMessage("Order saved.", "success");
      } catch (error) {
        setMessage(error.message || "Could not save feature order.", "error");
        await loadForLine(activeLineId, { rerenderOnComplete: false });
      } finally {
        reordering = false;
        rerender();
      }
    }, "Saving feature order…");
  }

  async function saveMoveFromDom(featureId, sourceType, targetType) {
    const service = svc();
    if (!service || saving || reordering || !activeLineId) return;
    const row = features.find(function (item) {
      return item.id === featureId;
    });
    if (!row) {
      await loadForLine(activeLineId);
      return;
    }

    const duplicate = features.some(function (item) {
      return (
        item.id !== featureId &&
        item.feature_type === targetType &&
        service.normalizeName(item.name) === service.normalizeName(row.name)
      );
    });
    if (duplicate) {
      setMessage("A feature with this name already exists in that section.", "error");
      await loadForLine(activeLineId);
      return;
    }

    const sourceIds = readOrderedIdsFromDom(sourceType);
    const targetIds = readOrderedIdsFromDom(targetType);
    const sourceReorder = sourceIds.length ? service.buildReorderPayload(sourceIds) : { ok: true };
    const targetReorder = service.buildReorderPayload(targetIds);
    if (!sourceReorder.ok) {
      setMessage(sourceReorder.error, "error");
      await loadForLine(activeLineId);
      return;
    }
    if (!targetReorder.ok) {
      setMessage(targetReorder.error, "error");
      await loadForLine(activeLineId);
      return;
    }

    const targetLabel = targetType === "exclusive_area" ? "Exclusive Areas" : "Specialty Features";

    return withSavingOverlay(async function () {
      reordering = true;
      setMessage(`Moving to ${targetLabel}…`, "running");
      rerender();
      try {
        await service.updateFeature(featureId, { feature_type: targetType });
        if (sourceIds.length) {
          await service.reorderFeatures(activeLineId, sourceType, sourceIds);
        }
        await service.reorderFeatures(activeLineId, targetType, targetIds);
        const migration = await migrateFeatureTypeAssignments(sourceType, targetType, row);
        features = await service.listFeaturesForLine(activeLineId);
        syncWindowCache();
        const parts = [`Moved to ${targetLabel}.`];
        if (migration.classesUpdated) {
          parts.push(
            `Updated ${migration.classesUpdated} class template${migration.classesUpdated === 1 ? "" : "s"}.`
          );
        }
        if (migration.shipsUpdated) {
          parts.push(`Updated ${migration.shipsUpdated} ship${migration.shipsUpdated === 1 ? "" : "s"}.`);
        }
        setMessage(parts.join(" "), "success");
      } catch (error) {
        setMessage(error.message || "Could not move feature.", "error");
        await loadForLine(activeLineId, { rerenderOnComplete: false });
      } finally {
        reordering = false;
        rerender();
      }
    }, `Moving to ${targetLabel}…`);
  }

  function renderFeatureForm(featureType) {
    const showForm =
      (creatingType === featureType || (editingId && features.find((row) => row.id === editingId)?.feature_type === featureType));
    if (!showForm) return "";

    const title = editingId ? "Edit feature" : featureType === "exclusive_area" ? "Add exclusive area" : "Add specialty feature";
    const admin = featureAdmin();
    const iconRow = admin
      ? admin.renderIconPicker(
          { name: draft.name, icon_key: draft.icon_key },
          0,
          "ciLineFeature"
        )
      : "";

    return `
      <div class="admin-card ci-line-feature-form">
        <h5>${esc(title)}</h5>
        <div class="ci-ship-feature-row-layout">
          ${iconRow}
          <div class="ci-ship-feature-fields">
            <div class="admin-field">
              <label for="ciLineFeatureName">Name</label>
              <input id="ciLineFeatureName" type="text" value="${esc(draft.name)}" placeholder="e.g. Cagney's Steakhouse" maxlength="160">
            </div>
            <div class="admin-field">
              <label for="ciLineFeatureDescription">Description <span class="admin-small">(optional)</span></label>
              <textarea id="ciLineFeatureDescription" rows="2" placeholder="Short detail shown on My Ship">${esc(draft.description)}</textarea>
            </div>
            <div class="admin-field">
              <label for="ciLineFeatureActive">Active</label>
              <select id="ciLineFeatureActive">
                <option value="true" ${draft.is_active ? "selected" : ""}>Active</option>
                <option value="false" ${!draft.is_active ? "selected" : ""}>Inactive</option>
              </select>
            </div>
          </div>
        </div>
        ${renderAssignmentSection(featureType)}
        <div class="admin-actions-row">
          <button type="button" class="admin-button small" onclick="CruiseLineFeaturesAdmin.saveFeature()" ${saving ? "disabled" : ""}>Save feature</button>
          <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.cancelEdit()">Cancel</button>
        </div>
      </div>`;
  }

  function renderFeatureList(featureType, title) {
    const rows = sortedFeatures(featureType);
    const listId = featureType === "exclusive_area" ? "ciLineFeaturesEaList" : "ciLineFeaturesSfList";
    const iconApi = icons();

    const list = rows.length
      ? rows
          .map(function (row) {
            const inactive = row.is_active === false ? " is-inactive" : "";
            const svg = iconApi ? iconApi.renderIconSvg(row.icon_key, "ci-line-feature-icon") : "";
            return `
          <div class="ci-line-feature-row${inactive}" draggable="true" data-feature-id="${esc(row.id)}" data-feature-type="${esc(featureType)}">
            <button type="button" class="ci-drag-handle" aria-label="Drag to reorder or move between sections" data-ci-line-feature-action="drag-handle">⋮⋮</button>
            <span class="ci-line-feature-icon-wrap">${svg}</span>
            <div class="ci-line-feature-copy">
              <strong>${esc(row.name)}</strong>
              ${row.description ? `<span class="admin-small">${esc(row.description)}</span>` : ""}
              ${row.is_active === false ? `<span class="admin-small ci-line-feature-inactive-tag">Inactive</span>` : ""}
            </div>
            <div class="ci-line-feature-actions">
              <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.startEdit('${esc(row.id)}')">Edit</button>
              <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.deleteFeature('${esc(row.id)}')">Delete</button>
            </div>
          </div>`;
          })
          .join("")
      : `<p class="admin-small">No ${title.toLowerCase()} yet. Add branded names for this line (e.g. “The Haven”, “Crown Grill”).</p>`;

    return `
      <div class="ci-line-feature-group">
        <div class="ci-line-feature-group-head">
          <h5>${esc(title)}</h5>
          <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.startCreate('${esc(featureType)}')" ${saving ? "disabled" : ""}>Add</button>
        </div>
        ${renderFeatureForm(featureType)}
        <div id="${listId}" class="ci-line-feature-list" data-feature-type="${esc(featureType)}">${list}</div>
      </div>`;
  }

  function renderSection(line) {
    if (!line?.id) return "";
    if (loading) {
      return `
        <div class="ci-line-features-panel" id="ciLineFeaturesPanel">
          <h4>Ship features catalogue</h4>
          <p class="admin-muted admin-running-status" role="status">Loading ship features…</p>
        </div>`;
    }
    if (loadError) {
      return `
        <div class="ci-line-features-panel" id="ciLineFeaturesPanel">
          <h4>Ship features catalogue</h4>
          <div class="admin-message admin-error">${esc(loadError)}</div>
          <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.retryLoad()">Retry</button>
        </div>`;
    }

    const msgClass =
      messageTone === "error"
        ? "admin-error"
        : messageTone === "success"
          ? "admin-success"
          : messageTone === "running"
            ? "admin-running"
            : "";

    return `
      <div class="ci-line-features-panel" id="ciLineFeaturesPanel">
        <h4>Ship features catalogue</h4>
        <p class="admin-small">Define branded Exclusive Areas and Specialty Features once for ${esc(line.name || "this line")}. Drag items between sections to change type, or use the handle to reorder. When you add or edit a feature, you can assign it to ship classes and individual ships here.</p>
        ${message ? `<p class="admin-small ${msgClass}">${esc(message)}</p>` : ""}
        ${renderFeatureList("exclusive_area", "Exclusive Areas")}
        ${renderFeatureList("specialty_feature", "Specialty Features")}
      </div>`;
  }

  function bindIconPickers(root) {
    const admin = featureAdmin();
    if (!admin || !root) return;
    const form = root.querySelector(".ci-line-feature-form");
    if (form) {
      form.dataset.featureBound = "";
      admin.bindFeatureList(form, {});
    }
  }

  function afterRender() {
    const panel = document.getElementById("ciLineFeaturesPanel");
    if (!panel) return;
    bindIconPickers(panel);

    panel.querySelectorAll("[data-ci-line-feature-action='drag-handle']").forEach(function (btn) {
      btn.addEventListener("pointerdown", onDragHandlePointerDown);
    });
    panel.querySelectorAll(".ci-line-feature-row").forEach(function (row) {
      row.addEventListener("dragstart", function (event) {
        onDragStart(event, row.getAttribute("data-feature-id"));
      });
      row.addEventListener("dragend", onDragEnd);
    });
    panel.querySelectorAll(".ci-line-feature-list").forEach(function (list) {
      list.addEventListener("dragover", allowDrop);
      list.addEventListener("drop", onDrop);
    });
  }

  global.CruiseLineFeaturesAdmin = {
    renderSection,
    afterRender,
    loadForLine,
    startCreate,
    startEdit,
    cancelEdit,
    saveFeature,
    deleteFeature,
    retryLoad,
    getFeatures: function () {
      return features.slice();
    },
    refreshForActiveLine: function () {
      return loadForLine(activeLineId);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
