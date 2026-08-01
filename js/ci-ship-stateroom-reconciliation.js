/**
 * Cruise Intelligence stateroom total reconciliation.
 * Shared by My Ship, Admin, and server-side tests.
 *
 * Authoritative total: ci_cruise_ships.stateroom_count only.
 * Public donut always shows all valid stored categories when present.
 * Centre shows the published total only when category sum matches exactly.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiStateroomReconciliation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const PARENT_CHILD_OVERLAP_RULES = [
    {
      parent: "Suites",
      children: ["Owners Suites", "Owner Suites", "Owner's Suites", "Owner\u2019s Suites"]
    }
  ];

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function humaniseLabel(key) {
    const map = {
      inside: "Inside",
      oceanview: "Oceanview",
      ocean_view: "Oceanview",
      balcony: "Balcony",
      suites: "Suites",
      suite: "Suites",
      owners_suites: "Owners Suites",
      owner_suites: "Owners Suites"
    };
    const lower = String(key || "").toLowerCase();
    if (map[lower]) return map[lower];
    return String(key || "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
  }

  function normalizeCategoryLabel(label) {
    return trim(label)
      .replace(/[\u2018\u2019`´]/g, "'")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function parseIntegerCount(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) return null;
    return number;
  }

  function parseBreakdownRows(raw, invalidRows) {
    const rows = [];
    if (!raw) return rows;
    let value = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_error) {
        if (invalidRows) invalidRows.push({ reason: "malformed_json" });
        return rows;
      }
    }

    const pushRow = (label, countRaw) => {
      const text = trim(label);
      if (!text) return;
      const count = parseIntegerCount(countRaw);
      if (count === null) {
        if (invalidRows && countRaw !== null && countRaw !== undefined && countRaw !== "") {
          invalidRows.push({ label: text, reason: "invalid_count", value: countRaw });
        }
        return;
      }
      if (count === 0) return;
      rows.push({ label: text, count });
    };

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        pushRow(
          entry.label || entry.name || entry.type || entry.stateroom_type,
          entry.count ?? entry.value ?? entry.quantity
        );
      });
      return rows;
    }

    if (typeof value === "object") {
      Object.entries(value).forEach(([key, entryValue]) => {
        if (key === "custom" && Array.isArray(entryValue)) {
          entryValue.forEach((entry) => {
            if (!entry || typeof entry !== "object") return;
            pushRow(entry.name || entry.label, entry.count ?? entry.value);
          });
          return;
        }
        pushRow(humaniseLabel(key), entryValue);
      });
    }

    return rows;
  }

  function parseStoredCategories(stateroomBreakdown, legacyBreakdown) {
    const invalidRows = [];
    let rows = parseBreakdownRows(stateroomBreakdown, invalidRows);
    if (!rows.length && legacyBreakdown) {
      rows = parseBreakdownRows(legacyBreakdown, invalidRows);
    }
    return { rows, invalidRows };
  }

  function findDuplicateNormalizedLabels(rows) {
    const seen = new Set();
    const duplicates = [];
    rows.forEach((row) => {
      const key = normalizeCategoryLabel(row.label);
      if (!key) return;
      if (seen.has(key)) duplicates.push(row.label);
      else seen.add(key);
    });
    return duplicates;
  }

  function stateroomCategoryRank(label) {
    const n = normalizeCategoryLabel(label).replace(/[_-]+/g, " ");
    if (n === "inside" || n === "interior") return 1;
    if (n === "oceanview" || n === "ocean view") return 2;
    if (n === "balcony" || n === "veranda") return 3;
    if (n === "suites" || n === "suite") return 4;
    return 100;
  }

  function sortCategories(rows) {
    return (rows || [])
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const rankDiff = stateroomCategoryRank(a.row.label) - stateroomCategoryRank(b.row.label);
        if (rankDiff !== 0) return rankDiff;
        return a.index - b.index;
      })
      .map(({ row }) => row);
  }

  function toRenderedCategories(rows) {
    return sortCategories(rows).map((row) => ({
      label: row.label,
      count: row.count,
      value: row.count
    }));
  }

  function sumCounts(rows) {
    return (rows || []).reduce((total, row) => total + Number(row.count || 0), 0);
  }

  function parseAuthoritativeTotal(stateroomCount) {
    if (stateroomCount === null || stateroomCount === undefined || stateroomCount === "") {
      return null;
    }
    const number = Number(stateroomCount);
    if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
      return null;
    }
    return number;
  }

  function detectOverlapCandidates(rows) {
    const matches = [];
    PARENT_CHILD_OVERLAP_RULES.forEach((rule) => {
      const hasParent = rows.some((row) => normalizeCategoryLabel(row.label) === normalizeCategoryLabel(rule.parent));
      if (!hasParent) return;
      rule.children.forEach((childLabel) => {
        const child = rows.find((row) => normalizeCategoryLabel(row.label) === normalizeCategoryLabel(childLabel));
        if (child) matches.push({ parent: rule.parent, child: child.label, count: child.count });
      });
    });
    return matches;
  }

  function publicDisplayStatusLabel(result) {
    switch (result.status) {
      case "exact":
        return "Public donut centre will show the published stateroom total.";
      case "mismatch":
        return "Public donut will retain all room-type categories and counts, with no total shown in the centre.";
      case "no_breakdown":
      case "no_total":
      case "invalid":
        return "Public Room Types section will show the unavailable state.";
      default:
        return "Public Room Types section will show the unavailable state.";
    }
  }

  function adminExplanationFor(result) {
    if (result.status === "exact") {
      return {
        publicNote: "Public donut centre will show the published stateroom total.",
        cleanupNote: ""
      };
    }
    if (result.status === "mismatch") {
      return {
        publicNote: "Public donut will retain all room-type categories and counts, with no total shown in the centre.",
        cleanupNote: result.overlapCandidates.length
          ? "Review whether overlapping subtype categories should be removed from the broad stateroom breakdown."
          : "Review whether the category breakdown or published total needs correction."
      };
    }
    if (result.status === "no_breakdown") {
      return {
        publicNote: "Public Room Types section will show the unavailable state.",
        cleanupNote: "Add room-type categories if a public breakdown should be shown."
      };
    }
    return {
      publicNote: result.publicMessage || "Public Room Types section will show the unavailable state.",
      cleanupNote: ""
    };
  }

  /**
   * @param {object} input
   * @param {number|null|undefined} input.stateroomCount
   * @param {*} input.stateroomBreakdown
   * @param {*} [input.legacyBreakdown] - cabin_type_summary fallback for parsing only
   */
  function reconcileStateroomDisplay(input) {
    const authoritativeTotal = parseAuthoritativeTotal(input?.stateroomCount);
    const parsed = parseStoredCategories(input?.stateroomBreakdown, input?.legacyBreakdown);
    const storedRows = parsed.rows;
    const invalidRows = parsed.invalidRows;
    const duplicateLabels = findDuplicateNormalizedLabels(storedRows);
    const rawBreakdownSum = sumCounts(storedRows);
    const renderedCategories = toRenderedCategories(storedRows);
    const canRenderDonut = renderedCategories.length > 0;
    const totalsMatch = authoritativeTotal != null && rawBreakdownSum === authoritativeTotal;
    const difference = authoritativeTotal == null ? null : rawBreakdownSum - authoritativeTotal;
    const centreMode = canRenderDonut && totalsMatch ? "total" : "blank";
    const overlapCandidates = detectOverlapCandidates(storedRows);

    const base = {
      authoritativeTotal,
      rawBreakdownSum,
      renderedBreakdownSum: rawBreakdownSum,
      difference,
      totalsMatch,
      renderedCategories,
      omittedOverlappingCategories: [],
      addedOtherCount: 0,
      canRenderDonut,
      centreMode,
      overlapCandidates,
      publicMessage: "",
      adminExplanation: { publicNote: "", cleanupNote: "" },
      invalidRows,
      duplicateLabels
    };

    if (!canRenderDonut) {
      if (authoritativeTotal == null) {
        return finishResult({ ...base, status: "no_total", publicMessage: "Detailed room-type mix unavailable" });
      }
      if (invalidRows.length || duplicateLabels.length) {
        return finishResult({ ...base, status: "invalid", publicMessage: "Detailed room-type mix unavailable" });
      }
      return finishResult({ ...base, status: "no_breakdown", publicMessage: "Detailed room-type mix unavailable" });
    }

    if (duplicateLabels.length || invalidRows.length) {
      return finishResult({
        ...base,
        status: "invalid",
        centreMode: "blank",
        publicMessage: ""
      });
    }

    if (totalsMatch) {
      return finishResult({ ...base, status: "exact", centreMode: "total", publicMessage: "" });
    }

    return finishResult({
      ...base,
      status: "mismatch",
      centreMode: "blank",
      publicMessage: ""
    });
  }

  function finishResult(result) {
    result.publicDisplayStatus = publicDisplayStatusLabel(result);
    result.adminExplanation = adminExplanationFor(result);
    if (!result.publicMessage && !result.canRenderDonut) {
      result.publicMessage = "Detailed room-type mix unavailable";
    }
    return result;
  }

  function validateStateroomSave(input) {
    const reconciliation = reconcileStateroomDisplay(input);
    const errors = [];
    const warnings = [];

    const total = parseAuthoritativeTotal(input?.stateroomCount);
    if (input?.stateroomCount !== null && input?.stateroomCount !== undefined && input?.stateroomCount !== "" && total == null) {
      errors.push("Published stateroom total must be a non-negative whole number.");
    }

    const parsed = parseStoredCategories(input?.stateroomBreakdown, null);
    parsed.rows.forEach((row) => {
      if (parseIntegerCount(row.count) == null) {
        errors.push(`Category "${row.label}" must use a non-negative whole number.`);
      }
    });
    parsed.invalidRows.forEach((row) => {
      if (row.label) errors.push(`Category "${row.label}" has an invalid count.`);
      else errors.push("Stateroom breakdown contains invalid values.");
    });

    if (reconciliation.duplicateLabels.length) {
      errors.push(`Duplicate category labels are not allowed: ${reconciliation.duplicateLabels.join(", ")}.`);
    }

    if (total != null && reconciliation.rawBreakdownSum > total) {
      warnings.push("Category sum exceeds the published stateroom total.");
    } else if (total != null && reconciliation.rawBreakdownSum < total) {
      warnings.push("Category sum is below the published stateroom total.");
    }

    if (reconciliation.overlapCandidates.length) {
      warnings.push("Suites and Owners Suites are stored together — review for overlap.");
    }

    if (total != null && reconciliation.rawBreakdownSum > 0 && reconciliation.difference !== 0) {
      const signed = reconciliation.difference > 0 ? `+${reconciliation.difference}` : String(reconciliation.difference);
      warnings.push(`Published total and category sum differ by ${signed}.`);
    }

    return {
      errors,
      warnings,
      reconciliation
    };
  }

  return {
    PARENT_CHILD_OVERLAP_RULES,
    normalizeCategoryLabel,
    parseStoredCategories,
    reconcileStateroomDisplay,
    validateStateroomSave,
    publicDisplayStatusLabel
  };
});
