/**
 * Canonical ship-feature sync semantics.
 *
 * A feature is one logical record even when it moves between Exclusive Areas
 * and Specialty Features. Class/fleet copy treats category, title, description
 * and icon changes as updates to that logical record rather than as unrelated
 * additions or "already present" items.
 */
(function (root, factory) {
  const api = factory(root || null);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.CiShipFeatureSync = api;
    api.patchAll(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (root) {
  "use strict";

  const FEATURE_ID_PREFIX = "shipfeat_";
  const CATEGORY_EXCLUSIVE = "exclusive_areas";
  const CATEGORY_SPECIALTY = "specialty_features";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function collapseSpaces(value) {
    return trim(value).replace(/\s+/g, " ");
  }

  function normalizeCompareText(value) {
    return collapseSpaces(value).toLowerCase();
  }

  function displayText(value) {
    return collapseSpaces(value);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hash32(text) {
    let hash = 0x811c9dc5;
    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function deriveFeatureId(name) {
    const normalized = normalizeCompareText(name);
    return normalized ? `${FEATURE_ID_PREFIX}${hash32(normalized)}` : "";
  }

  function featureIdFor(entry, fallbackName) {
    const stored = isPlainObject(entry) ? trim(entry.feature_id) : "";
    return stored || deriveFeatureId(fallbackName || (isPlainObject(entry) ? entry.name || entry.label : entry));
  }

  function activeRawEntries(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (entry) {
      if (isPlainObject(entry)) return Boolean(trim(entry.name || entry.label || entry.description));
      return Boolean(trim(entry));
    });
  }

  function patchFacilitiesApi(facilitiesApi) {
    if (!facilitiesApi || facilitiesApi.__featureIdentitySyncPatched) return facilitiesApi;

    const originalLoadExclusive = facilitiesApi.loadExclusiveAreasForAdmin?.bind(facilitiesApi);
    const originalLoadSpecialty = facilitiesApi.loadSpecialtyFeaturesForAdmin?.bind(facilitiesApi);
    const originalSerializeExclusive = facilitiesApi.serializeExclusiveAreasFromAdmin?.bind(facilitiesApi);
    const originalSerializeSpecialty = facilitiesApi.serializeSpecialtyFeaturesFromAdmin?.bind(facilitiesApi);

    function loadWithIdentity(raw, loader) {
      const rows = typeof loader === "function" ? loader(raw) : [];
      const source = activeRawEntries(raw);
      return rows.map(function (row, index) {
        const rawEntry = source[index];
        const id = featureIdFor(rawEntry, row && (row.name || row.label));
        return id ? { ...row, feature_id: id } : { ...row };
      });
    }

    function serializeWithIdentity(rows, serializer) {
      if (!Array.isArray(rows) || typeof serializer !== "function") return [];
      const output = [];
      rows.forEach(function (row) {
        const name = trim(row && (row.name || row.label));
        if (!name) return;
        const serialized = serializer([row]);
        const item = Array.isArray(serialized) ? serialized[0] : null;
        if (!item) return;
        const id = trim(row && row.feature_id) || deriveFeatureId(name);
        if (isPlainObject(item)) output.push({ ...item, feature_id: id });
        else output.push({ name: String(item), feature_id: id });
      });
      return output;
    }

    if (originalLoadExclusive) {
      facilitiesApi.loadExclusiveAreasForAdmin = function (raw) {
        return loadWithIdentity(raw, originalLoadExclusive);
      };
    }
    if (originalLoadSpecialty) {
      facilitiesApi.loadSpecialtyFeaturesForAdmin = function (raw) {
        return loadWithIdentity(raw, originalLoadSpecialty);
      };
    }
    if (originalSerializeExclusive) {
      facilitiesApi.serializeExclusiveAreasFromAdmin = function (rows) {
        return serializeWithIdentity(rows, originalSerializeExclusive);
      };
    }
    if (originalSerializeSpecialty) {
      facilitiesApi.serializeSpecialtyFeaturesFromAdmin = function (rows) {
        return serializeWithIdentity(rows, originalSerializeSpecialty);
      };
    }

    facilitiesApi.__featureIdentitySyncPatched = true;
    facilitiesApi.deriveShipFeatureId = deriveFeatureId;
    return facilitiesApi;
  }

  function patchFeatureAdminApi(featureAdmin) {
    if (!featureAdmin || featureAdmin.__featureIdentitySyncPatched) return featureAdmin;
    const originalRebuild = featureAdmin.rebuildFeatureList?.bind(featureAdmin);
    const originalRead = featureAdmin.readFeatureRowsFromRoot?.bind(featureAdmin);

    if (originalRebuild) {
      featureAdmin.rebuildFeatureList = function (rootEl, rows, options) {
        originalRebuild(rootEl, rows, options);
        if (!rootEl) return;
        const supplied = Array.isArray(rows) ? rows : [];
        const cards = Array.from(rootEl.querySelectorAll(".ci-ship-feature-card"));
        cards.forEach(function (card, index) {
          const row = supplied[index] || null;
          const name = trim(row && (row.name || row.label));
          const description = trim(row && row.description);
          if (!name && !description) {
            delete card.dataset.featureId;
            return;
          }
          const id = trim(row && row.feature_id) || deriveFeatureId(name);
          if (id) card.dataset.featureId = id;
        });
      };
    }

    if (originalRead) {
      featureAdmin.readFeatureRowsFromRoot = function (rootEl) {
        const rows = originalRead(rootEl);
        if (!rootEl || !Array.isArray(rows)) return rows;
        const activeCards = Array.from(rootEl.querySelectorAll(".ci-ship-feature-card")).filter(function (card) {
          const name = trim(card.querySelector(".ci-ship-feature-name")?.value);
          const description = trim(card.querySelector(".ci-ship-feature-description")?.value);
          return Boolean(name || description);
        });
        return rows.map(function (row, index) {
          const card = activeCards[index];
          const id = trim(card?.dataset?.featureId) || deriveFeatureId(row && (row.name || row.label));
          if (card && id && card.dataset.featureId !== id) card.dataset.featureId = id;
          return id ? { ...row, feature_id: id } : { ...row };
        });
      };
    }

    featureAdmin.__featureIdentitySyncPatched = true;
    return featureAdmin;
  }

  function normalizeFeatureEntry(entry, category, facilitiesApi) {
    let loaded = null;
    if (facilitiesApi) {
      const loader = category === CATEGORY_EXCLUSIVE
        ? facilitiesApi.loadExclusiveAreasForAdmin
        : facilitiesApi.loadSpecialtyFeaturesForAdmin;
      if (typeof loader === "function") {
        const rows = loader([entry]);
        loaded = Array.isArray(rows) && rows[0] ? rows[0] : null;
      }
    }

    const object = isPlainObject(entry) ? entry : {};
    const name = displayText(
      loaded?.name || loaded?.label || object.name || object.label || (typeof entry === "string" ? entry : "")
    );
    if (!name) return null;
    const description = displayText(loaded?.description || object.description || "");
    const iconKey = trim(loaded?.icon_key || object.icon_key || "");
    const id = trim(object.feature_id || loaded?.feature_id) || deriveFeatureId(name);
    const storage = { feature_id: id, name: name };
    if (description) storage.description = description;
    if (iconKey) storage.icon_key = iconKey;
    return {
      source_key: `feature:${id}`,
      feature_id: id,
      category,
      name,
      value: name,
      description,
      icon_key: iconKey,
      storage,
      legacy: !isPlainObject(entry),
      persisted_feature_id: isPlainObject(entry) && trim(entry.feature_id) === id
    };
  }

  function listCategory(raw, category, facilitiesApi) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (entry) {
      return normalizeFeatureEntry(entry, category, facilitiesApi);
    }).filter(Boolean);
  }

  function targetEntries(targetFacilities, facilitiesApi) {
    const facilities = targetFacilities && typeof targetFacilities === "object" ? targetFacilities : {};
    const rows = [];
    const exclusive = Array.isArray(facilities.exclusive_areas) ? facilities.exclusive_areas : [];
    const specialty = Array.isArray(facilities.specialty_features) ? facilities.specialty_features : [];
    exclusive.forEach(function (entry, index) {
      const item = normalizeFeatureEntry(entry, CATEGORY_EXCLUSIVE, facilitiesApi);
      if (item) rows.push({ ...item, index, raw: entry });
    });
    specialty.forEach(function (entry, index) {
      const item = normalizeFeatureEntry(entry, CATEGORY_SPECIALTY, facilitiesApi);
      if (item) rows.push({ ...item, index, raw: entry });
    });
    return rows;
  }

  function sameVisibleContent(source, target) {
    return displayText(source.name) === displayText(target.name)
      && displayText(source.description) === displayText(target.description)
      && trim(source.icon_key) === trim(target.icon_key);
  }

  function signatureMatches(source, target) {
    const sourceDesc = displayText(source.description);
    const targetDesc = displayText(target.description);
    const sourceIcon = trim(source.icon_key);
    const targetIcon = trim(target.icon_key);
    if (sourceDesc) return sourceDesc === targetDesc;
    if (sourceIcon) return sourceIcon === targetIcon;
    return false;
  }

  function findLogicalMatches(sourceItem, facilities, facilitiesApi) {
    const all = targetEntries(facilities, facilitiesApi);
    const idMatches = all.filter(function (target) {
      return target.feature_id && sourceItem.feature_id && target.feature_id === sourceItem.feature_id;
    });
    if (idMatches.length) return idMatches;

    const sameName = all.filter(function (target) {
      return normalizeCompareText(target.name) === normalizeCompareText(sourceItem.name);
    });
    if (sameName.length) return sameName;

    const signature = all.filter(function (target) {
      return signatureMatches(sourceItem, target);
    });
    return signature.length === 1 ? signature : [];
  }

  function compareFeatureOnTarget(sourceItem, targetFacilities, facilitiesApi) {
    const matches = findLogicalMatches(sourceItem, targetFacilities, facilitiesApi);
    if (!matches.length) return { status: "missing", matches: [] };

    const exact = matches.length === 1 && matches[0];
    const sameCategory = Boolean(exact && exact.category === sourceItem.category);
    const sameContent = Boolean(exact && sameVisibleContent(sourceItem, exact));
    const sameStoredId = Boolean(exact && exact.persisted_feature_id && exact.feature_id === sourceItem.feature_id);

    if (sameCategory && sameContent && sameStoredId) {
      return {
        status: "identical",
        matches,
        targetIndex: exact.index,
        targetCategory: exact.category,
        targetEntry: exact.raw
      };
    }

    return {
      status: "changed",
      matches,
      targetIndex: exact ? exact.index : -1,
      targetCategory: exact ? exact.category : null,
      targetEntry: exact ? exact.raw : null,
      changed: {
        category: !sameCategory,
        title: !exact || displayText(sourceItem.name) !== displayText(exact.name),
        description: !exact || displayText(sourceItem.description) !== displayText(exact.description),
        icon: !exact || trim(sourceItem.icon_key) !== trim(exact.icon_key),
        identity: !sameStoredId,
        duplicate: matches.length > 1
      }
    };
  }

  function patchItemCopyApi(itemApi, facilitiesApi) {
    if (!itemApi || itemApi.__featureIdentitySyncPatched) return itemApi;

    function listSourceExclusiveAreas(raw) {
      return listCategory(raw, CATEGORY_EXCLUSIVE, facilitiesApi);
    }

    function listSourceSpecialtyFeatures(raw) {
      return listCategory(raw, CATEGORY_SPECIALTY, facilitiesApi);
    }

    function sourceItemsByKey(sourceFacilities) {
      const map = {};
      listSourceExclusiveAreas(sourceFacilities && sourceFacilities.exclusive_areas).forEach(function (item) {
        map[item.source_key] = item;
      });
      listSourceSpecialtyFeatures(sourceFacilities && sourceFacilities.specialty_features).forEach(function (item) {
        map[item.source_key] = item;
      });
      return map;
    }

    function resolveSelectedItemsFromSource(sourceFacilities, selectedItems) {
      const map = sourceItemsByKey(sourceFacilities);
      const resolved = { exclusive_areas: [], specialty_features: [] };
      const invalidKeys = [];

      const resolveRows = function (rows, category, nameField) {
        (Array.isArray(rows) ? rows : []).forEach(function (sel) {
          const key = sel && sel.source_key;
          const item = map[key];
          if (!item || item.category !== category) {
            invalidKeys.push(key);
            return;
          }
          const suppliedName = sel && sel[nameField];
          if (suppliedName && normalizeCompareText(suppliedName) !== normalizeCompareText(item.name)) {
            invalidKeys.push(key);
            return;
          }
          const payload = { source_key: item.source_key };
          payload[nameField] = item.name;
          resolved[category].push(payload);
        });
      };

      resolveRows(selectedItems && selectedItems.exclusive_areas, CATEGORY_EXCLUSIVE, "name");
      resolveRows(selectedItems && selectedItems.specialty_features, CATEGORY_SPECIALTY, "value");
      return { resolved, invalidKeys };
    }

    function compareTargetShip(sourceFacilities, targetFacilities, selectedItems, _conflictResolutions, targetShipId) {
      const map = sourceItemsByKey(sourceFacilities);
      const rows = [];
      const addSelected = function (selections, expectedCategory) {
        (Array.isArray(selections) ? selections : []).forEach(function (sel) {
          const sourceItem = map[sel && sel.source_key];
          if (!sourceItem || sourceItem.category !== expectedCategory) return;
          const comparison = compareFeatureOnTarget(sourceItem, targetFacilities, facilitiesApi);
          const plannedAction = comparison.status === "identical"
            ? "skip_identical"
            : (comparison.status === "missing" ? "add" : "replace");
          rows.push({
            category: sourceItem.category,
            source_key: sourceItem.source_key,
            sourceItem,
            comparison,
            plannedAction,
            targetShipId
          });
        });
      };
      addSelected(selectedItems && selectedItems.exclusive_areas, CATEGORY_EXCLUSIVE);
      addSelected(selectedItems && selectedItems.specialty_features, CATEGORY_SPECIALTY);
      return rows;
    }

    function buildCopyPlans({ sourceFacilities, targets, selectedItems, conflictResolutions }) {
      return (Array.isArray(targets) ? targets : []).map(function (target) {
        const items = compareTargetShip(
          sourceFacilities,
          target.facilities,
          selectedItems,
          conflictResolutions,
          target.id
        );
        return {
          targetShipId: target.id,
          targetShipName: target.name,
          items,
          summary: itemApi.summarizeTargetPlan(items)
        };
      });
    }

    function removeMatches(arrays, matches) {
      const grouped = { [CATEGORY_EXCLUSIVE]: [], [CATEGORY_SPECIALTY]: [] };
      (matches || []).forEach(function (match) {
        if (grouped[match.category]) grouped[match.category].push(match.index);
      });
      Object.keys(grouped).forEach(function (category) {
        grouped[category].sort(function (a, b) { return b - a; }).forEach(function (index) {
          arrays[category].splice(index, 1);
        });
      });
    }

    function applyItemLevelCopyToFacilities(existingFacilities, planItems) {
      const facilities = {
        ...(existingFacilities && typeof existingFacilities === "object" ? existingFacilities : {})
      };
      const arrays = {
        [CATEGORY_EXCLUSIVE]: Array.isArray(facilities.exclusive_areas) ? facilities.exclusive_areas.slice() : [],
        [CATEGORY_SPECIALTY]: Array.isArray(facilities.specialty_features) ? facilities.specialty_features.slice() : []
      };
      const outcomes = [];

      (Array.isArray(planItems) ? planItems : []).forEach(function (row) {
        const sourceItem = row.sourceItem;
        if (!sourceItem) return;
        if (row.plannedAction === "skip_identical") {
          outcomes.push({ source_key: row.source_key, outcome: "skipped_identical" });
          return;
        }
        if (row.plannedAction === "keep_existing") {
          outcomes.push({ source_key: row.source_key, outcome: "kept_existing" });
          return;
        }

        const liveFacilities = {
          exclusive_areas: arrays[CATEGORY_EXCLUSIVE],
          specialty_features: arrays[CATEGORY_SPECIALTY]
        };
        const matches = findLogicalMatches(sourceItem, liveFacilities, facilitiesApi);
        const sameCategoryMatch = matches.find(function (match) { return match.category === sourceItem.category; });
        const insertIndex = sameCategoryMatch ? sameCategoryMatch.index : arrays[sourceItem.category].length;
        if (matches.length) removeMatches(arrays, matches);

        const destination = arrays[sourceItem.category];
        const safeIndex = Math.max(0, Math.min(insertIndex, destination.length));
        destination.splice(safeIndex, 0, { ...sourceItem.storage });
        outcomes.push({
          source_key: row.source_key,
          outcome: row.plannedAction === "add" && !matches.length ? "added" : "replaced"
        });
      });

      if (arrays[CATEGORY_EXCLUSIVE].length) facilities.exclusive_areas = arrays[CATEGORY_EXCLUSIVE];
      else delete facilities.exclusive_areas;
      if (arrays[CATEGORY_SPECIALTY].length) facilities.specialty_features = arrays[CATEGORY_SPECIALTY];
      else delete facilities.specialty_features;
      return { facilities, outcomes };
    }

    function shipClassesMatch(a, b) {
      const left = normalizeCompareText(a);
      const right = normalizeCompareText(b);
      return Boolean(left && right && left === right);
    }

    function validateItemLevelCopyRequest({
      sourceShip,
      targetShips,
      targetScope,
      selectedItems,
      conflictResolutions,
      sourceFacilities
    }) {
      if (!sourceShip || !sourceShip.id || !sourceShip.cruise_line_id) {
        return { ok: false, error: "SOURCE_SHIP_INCOMPLETE" };
      }
      if (sourceShip.active === false) return { ok: false, error: "SOURCE_INACTIVE" };
      const scope = targetScope === itemApi.TARGET_SCOPE_FLEET
        ? itemApi.TARGET_SCOPE_FLEET
        : itemApi.TARGET_SCOPE_SAME_CLASS;
      const shipClass = trim(sourceShip.ship_class) || null;
      if (scope === itemApi.TARGET_SCOPE_SAME_CLASS && !shipClass) {
        return { ok: false, error: "SOURCE_CLASS_REQUIRED" };
      }
      if (!Array.isArray(targetShips) || !targetShips.length) return { ok: false, error: "NO_TARGETS" };
      const ids = targetShips.map(function (target) { return target && target.id; }).filter(Boolean);
      if (new Set(ids).size !== ids.length) return { ok: false, error: "DUPLICATE_TARGETS" };

      for (const target of targetShips) {
        if (!target || target.id === sourceShip.id) return { ok: false, error: "SOURCE_IN_TARGETS" };
        if (target.cruise_line_id !== sourceShip.cruise_line_id) return { ok: false, error: "TARGET_LINE_MISMATCH" };
        if (target.active === false) return { ok: false, error: "TARGET_INACTIVE" };
        if (scope === itemApi.TARGET_SCOPE_SAME_CLASS && !shipClassesMatch(target.ship_class, shipClass)) {
          return { ok: false, error: "TARGET_CLASS_MISMATCH" };
        }
      }

      const itemResolution = resolveSelectedItemsFromSource(sourceFacilities, selectedItems);
      if (itemResolution.invalidKeys.length) {
        return { ok: false, error: "INVALID_SELECTED_ITEMS", detail: itemResolution.invalidKeys };
      }
      const resolved = itemResolution.resolved;
      if (!resolved.exclusive_areas.length && !resolved.specialty_features.length) {
        return { ok: false, error: "NO_ITEMS_SELECTED" };
      }
      const plans = buildCopyPlans({
        sourceFacilities,
        targets: targetShips.map(function (target) {
          return { id: target.id, name: target.name, facilities: target.facilities };
        }),
        selectedItems: resolved,
        conflictResolutions: conflictResolutions || []
      });
      const totals = itemApi.summarizeAllPlans(plans);
      if (totals.noChanges) return { ok: false, error: "NO_CHANGES" };
      return {
        ok: true,
        targetScope: scope,
        shipClass,
        resolvedItems: resolved,
        plans
      };
    }

    function targetComparisonStatusLabel(items) {
      const summary = itemApi.summarizeTargetPlan(items || []);
      if (summary.noChanges && summary.skipIdenticalCount > 0) return "All selected items identical";
      const parts = [];
      if (summary.addCount) parts.push(`${summary.addCount} to add`);
      if (summary.replaceCount) parts.push(`${summary.replaceCount} to update`);
      if (summary.skipIdenticalCount) parts.push(`${summary.skipIdenticalCount} identical`);
      return parts.length ? parts.join(" · ") : "No changes";
    }

    function reconcileResultRows({ plans, results, sourceFacilities }) {
      const sourceMap = sourceItemsByKey(sourceFacilities);
      const planByTarget = Object.fromEntries((Array.isArray(plans) ? plans : []).map(function (plan) {
        return [plan.targetShipId, plan];
      }));
      return (Array.isArray(results) ? results : []).map(function (row) {
        const outcomes = itemApi.normalizeResultOutcomes(row);
        const result = itemApi.buildResultRow(row.name, outcomes, sourceMap);
        return { ...row, outcomes, items: outcomes, result, plan: planByTarget[row.id] || null };
      });
    }

    function compareExclusiveAreaOnTarget(sourceItem, targetFacilities) {
      const canonical = sourceItem && sourceItem.category
        ? sourceItem
        : { ...sourceItem, category: CATEGORY_EXCLUSIVE, feature_id: sourceItem?.feature_id || deriveFeatureId(sourceItem?.name) };
      return compareFeatureOnTarget(canonical, targetFacilities, facilitiesApi);
    }

    function compareSpecialtyFeatureOnTarget(sourceItem, targetFacilities) {
      const canonical = sourceItem && sourceItem.category
        ? sourceItem
        : {
          ...sourceItem,
          category: CATEGORY_SPECIALTY,
          name: sourceItem?.name || sourceItem?.value,
          feature_id: sourceItem?.feature_id || deriveFeatureId(sourceItem?.name || sourceItem?.value)
        };
      return compareFeatureOnTarget(canonical, targetFacilities, facilitiesApi);
    }

    itemApi.listSourceExclusiveAreas = listSourceExclusiveAreas;
    itemApi.listSourceSpecialtyFeatures = listSourceSpecialtyFeatures;
    itemApi.compareExclusiveAreaOnTarget = compareExclusiveAreaOnTarget;
    itemApi.compareSpecialtyFeatureOnTarget = compareSpecialtyFeatureOnTarget;
    itemApi.compareTargetShip = compareTargetShip;
    itemApi.buildCopyPlans = buildCopyPlans;
    itemApi.applyItemLevelCopyToFacilities = applyItemLevelCopyToFacilities;
    itemApi.resolveSelectedItemsFromSource = resolveSelectedItemsFromSource;
    itemApi.validateItemLevelCopyRequest = validateItemLevelCopyRequest;
    itemApi.targetComparisonStatusLabel = targetComparisonStatusLabel;
    itemApi.planHasConflicts = function () { return false; };
    itemApi.conflictsAreResolved = function () { return true; };
    itemApi.buildSourceItemsByKey = sourceItemsByKey;
    itemApi.reconcileResultRows = reconcileResultRows;
    itemApi.__featureIdentitySyncPatched = true;
    itemApi.deriveShipFeatureId = deriveFeatureId;
    itemApi.findLogicalFeatureMatches = function (sourceItem, facilities) {
      return findLogicalMatches(sourceItem, facilities, facilitiesApi);
    };
    return itemApi;
  }

  function patchAll(targetRoot) {
    const host = targetRoot || root || {};
    const facilitiesApi = patchFacilitiesApi(host.CiShipFacilities);
    patchFeatureAdminApi(host.CiShipFeatureAdmin);
    patchItemCopyApi(host.CiShipFacilitiesItemCopy, facilitiesApi);
    return host;
  }

  return {
    FEATURE_ID_PREFIX,
    deriveFeatureId,
    patchFacilitiesApi,
    patchFeatureAdminApi,
    patchItemCopyApi,
    patchAll
  };
});
