/**
 * Royal Caribbean International — hardened source enumeration (read-only).
 *
 * Global skip/count pagination against a live catalogue is unstable when page
 * boundaries shift. Authoritative enumeration unions multiple page-size passes
 * and optionally continues until an empty page.
 */

const crypto = require("crypto");
const {
  fetchRoyalCaribbeanSearchPage,
  fetchRoyalCaribbeanFleet,
  expandGraphGroupsToRawSailings,
  officialProductKey,
  DEFAULT_PAGE_SIZE,
  GRAPH_URL,
  USER_AGENT,
  sleep
} = require("./royal-caribbean-discovery-source");

const AUTHORITATIVE_PAGE_SIZES = [25, 50, 100];
const DEFAULT_UNION_PAGE_SIZES = [50, 100];
const MAX_PAGES_PER_PASS = 100;
const STABILITY_MAX_PASSES = 3;

function symmetricSetDiff(setA, setB) {
  const onlyA = [];
  const onlyB = [];
  for (const value of setA) {
    if (!setB.has(value)) onlyA.push(value);
  }
  for (const value of setB) {
    if (!setA.has(value)) onlyB.push(value);
  }
  return {
    only_in_a: onlyA,
    only_in_b: onlyB,
    symmetric_count: onlyA.length + onlyB.length
  };
}

function unionSets(setList = []) {
  const out = new Set();
  for (const set of setList) {
    for (const value of set) out.add(value);
  }
  return out;
}

function dedupeGroupsById(groups = []) {
  const byId = new Map();
  for (const group of groups) {
    const id = String(group?.id || "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, group);
  }
  return [...byId.values()];
}

async function enumerateGlobalOffsetPass({
  pageSize = DEFAULT_PAGE_SIZE,
  stopAtTotal = true,
  untilEmpty = false,
  requestDelayMs = 100,
  filters = "{}",
  today = null
} = {}) {
  const startedAt = new Date().toISOString();
  const groups = [];
  const seenGroupIds = new Set();
  const pageLog = [];
  let skip = 0;
  let totalOfficial = 0;
  let pages = 0;

  while (pages < MAX_PAGES_PER_PASS) {
    const batch = await fetchRoyalCaribbeanSearchPage({ skip, count: pageSize, filters });
    pageLog.push({
      skip,
      ok: batch.ok,
      returned: batch.cruises?.length || 0,
      total: batch.total,
      first_group_id: batch.cruises?.[0]?.id || null,
      last_group_id: batch.cruises?.[batch.cruises.length - 1]?.id || null
    });
    if (!batch.ok) break;
    totalOfficial = batch.total || totalOfficial;
    if (!(batch.cruises?.length)) break;
    for (const group of batch.cruises) {
      const id = String(group?.id || "").trim();
      if (!id || seenGroupIds.has(id)) continue;
      seenGroupIds.add(id);
      groups.push(group);
    }
    pages += 1;
    const reachedOfficialTotal = stopAtTotal && !untilEmpty && skip + pageSize >= totalOfficial;
    if (reachedOfficialTotal) break;
    skip += pageSize;
    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  const expanded = expandGraphGroupsToRawSailings(groups, {
    today: today || new Date().toISOString().slice(0, 10),
    futureOnly: false
  });
  const sailingIds = new Set(expanded.products.map((p) => officialProductKey(p)).filter(Boolean));

  return {
    method: "global_offset",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    page_size: pageSize,
    stop_at_total: stopAtTotal,
    until_empty: untilEmpty,
    results_total: totalOfficial,
    pages_requested: pageLog.length,
    raw_group_records: groups.length,
    unique_group_ids: seenGroupIds.size,
    unique_sailing_ids: sailingIds.size,
    duplicate_group_ids_suppressed: Math.max(0, pageLog.reduce((n, p) => n + (p.returned || 0), 0) - groups.length),
    duplicate_sailing_ids: expanded.audit?.duplicate_sailing_ids || 0,
    page_log: pageLog,
    groups,
    sailing_ids: sailingIds,
    group_ids: seenGroupIds,
    products: expanded.products
  };
}

async function enumerateMultiPageSizeUnion({
  pageSizes = DEFAULT_UNION_PAGE_SIZES,
  requestDelayMs = 100,
  today = null,
  stopAtTotal = true,
  untilEmpty = false
} = {}) {
  const startedAt = new Date().toISOString();
  const passes = [];
  for (const pageSize of pageSizes) {
    passes.push(
      await enumerateGlobalOffsetPass({
        pageSize,
        stopAtTotal,
        untilEmpty,
        requestDelayMs,
        today
      })
    );
    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  const allGroups = dedupeGroupsById(passes.flatMap((pass) => pass.groups));
  const groupIds = new Set(allGroups.map((g) => g.id).filter(Boolean));
  const expanded = expandGraphGroupsToRawSailings(allGroups, {
    today: today || new Date().toISOString().slice(0, 10),
    futureOnly: false
  });
  const sailingIds = new Set(expanded.products.map((p) => officialProductKey(p)).filter(Boolean));

  const passComparisons = [];
  for (let i = 0; i < passes.length; i += 1) {
    for (let j = i + 1; j < passes.length; j += 1) {
      passComparisons.push({
        a_page_size: passes[i].page_size,
        b_page_size: passes[j].page_size,
        group_symmetric_diff: symmetricSetDiff(passes[i].group_ids, passes[j].group_ids).symmetric_count,
        sailing_symmetric_diff: symmetricSetDiff(passes[i].sailing_ids, passes[j].sailing_ids).symmetric_count
      });
    }
  }

  return {
    method: "multi_page_size_union",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    page_sizes: pageSizes,
    passes: passes.map(({ page_size, results_total, raw_group_records, unique_group_ids, unique_sailing_ids, pages_requested }) => ({
      page_size,
      results_total,
      raw_group_records,
      unique_group_ids,
      unique_sailing_ids,
      pages_requested
    })),
    pass_comparisons: passComparisons,
    results_total: Math.max(...passes.map((p) => p.results_total || 0), 0),
    raw_group_records: allGroups.length,
    unique_group_ids: groupIds.size,
    unique_sailing_ids: sailingIds.size,
    duplicate_sailing_ids: expanded.audit?.duplicate_sailing_ids || 0,
    groups: allGroups,
    group_ids: groupIds,
    sailing_ids: sailingIds,
    products: expanded.products
  };
}

async function enumerateUntilStableUnion({
  pageSizes = AUTHORITATIVE_PAGE_SIZES,
  requestDelayMs = 150,
  today = null,
  maxPasses = STABILITY_MAX_PASSES
} = {}) {
  let previous = null;
  const history = [];
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const current = await enumerateMultiPageSizeUnion({ pageSizes, requestDelayMs, today });
    history.push({
      pass,
      unique_group_ids: current.unique_group_ids,
      unique_sailing_ids: current.unique_sailing_ids,
      results_total: current.results_total
    });
    if (previous) {
      const groupDiff = symmetricSetDiff(previous.group_ids, current.group_ids);
      const sailingDiff = symmetricSetDiff(previous.sailing_ids, current.sailing_ids);
      if (groupDiff.symmetric_count === 0 && sailingDiff.symmetric_count === 0) {
        return {
          ...current,
          stable: true,
          stability_passes: pass,
          history,
          stability_note: "Consecutive union passes produced identical group and sailing identity sets"
        };
      }
    }
    previous = current;
    if (pass < maxPasses && requestDelayMs > 0) await sleep(requestDelayMs * 2);
  }

  const finalDiff =
    history.length >= 2
      ? symmetricSetDiff(
          new Set(history[history.length - 2].unique_group_ids ? [...previous.group_ids] : []),
          previous.group_ids
        )
      : null;

  return {
    ...previous,
    stable: false,
    stability_passes: maxPasses,
    history,
    final_pass_group_ids: previous.unique_group_ids,
    final_pass_sailing_ids: previous.unique_sailing_ids,
    stability_note: "Union passes did not fully converge within pass limit; using latest union",
    final_diff: finalDiff
  };
}

async function enumerateShipCoveragePartition({ unionResult, today = null } = {}) {
  const fleet = await fetchRoyalCaribbeanFleet();
  if (!unionResult?.products?.length) {
    return {
      method: "ship_coverage_partition",
      supported_api_ship_filter: false,
      note: "Royal Caribbean GraphQL ignores ship/date filter strings in practice; coverage is computed from union enumeration products",
      fleet_ok: fleet.ok,
      fleet_ship_count: fleet.ships?.length || 0,
      covered_ship_codes: [],
      missing_ship_codes: (fleet.ships || []).map((s) => s.code).filter(Boolean),
      partitions: []
    };
  }

  const byShip = new Map();
  for (const product of unionResult.products) {
    const code = String(product.ship_code || "").trim().toUpperCase();
    if (!code) continue;
    if (!byShip.has(code)) byShip.set(code, new Set());
    byShip.get(code).add(product.official_sailing_id);
  }

  const fleetCodes = (fleet.ships || []).map((s) => String(s.code || "").trim().toUpperCase()).filter(Boolean);
  const covered = [];
  const missing = [];
  const partitions = [];
  for (const code of fleetCodes) {
    const sailingIds = byShip.get(code) || new Set();
    const entry = {
      ship_code: code,
      unique_sailing_ids: sailingIds.size,
      sample_sailing_ids: [...sailingIds].slice(0, 3)
    };
    partitions.push(entry);
    if (sailingIds.size > 0) covered.push(code);
    else missing.push(code);
  }

  return {
    method: "ship_coverage_partition",
    supported_api_ship_filter: false,
    note: "Post-union ship coverage audit — not independent API-filtered partitions",
    fleet_ok: fleet.ok,
    fleet_ship_count: fleetCodes.length,
    covered_ship_codes: covered,
    missing_ship_codes: missing,
    partitions
  };
}

async function fetchRoyalCaribbeanCruiseDetail(groupId, { userAgent = USER_AGENT } = {}) {
  const query = `query RoyalCaribbeanCruiseDetail($id: String!) {
    cruise(id: $id) {
      id
      productViewLink
      masterSailing {
        itinerary {
          code
          ship { code name }
          departurePort { code name }
        }
      }
      sailings { id sailDate status }
    }
  }`;
  const response = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": userAgent
    },
    body: JSON.stringify({ query, variables: { id: groupId } })
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok && !body.errors?.length && Boolean(body.data?.cruise?.id),
    status: response.status,
    group_id: groupId,
    cruise: body.data?.cruise || null,
    error: body.errors?.[0]?.message || null
  };
}

function computeSourceSnapshotIdFromSailingIds(sailingIds = []) {
  const sorted = [...sailingIds].sort();
  return crypto.createHash("sha256").update(sorted.join("|")).digest("hex").slice(0, 16);
}

function evaluateSourceEnumerationHealth({
  globalPass,
  unionPass,
  stableUnionPass,
  productionSailingIds = new Set(),
  directLookupResults = [],
  shipCoverage = null
} = {}) {
  const failures = [];
  const globalVsUnionGroups = symmetricSetDiff(globalPass.group_ids, unionPass.group_ids);
  const globalVsUnionSailings = symmetricSetDiff(globalPass.sailing_ids, unionPass.sailing_ids);

  if ((globalPass.pages_requested || 0) === 0) failures.push("global_pass_empty");
  if ((unionPass.unique_group_ids || 0) < (globalPass.unique_group_ids || 0)) {
    failures.push("union_smaller_than_global");
  }
  if (!stableUnionPass?.stable) {
    const last = stableUnionPass?.history || [];
    if (last.length >= 2) {
      const prev = last[last.length - 2];
      const curr = last[last.length - 1];
      const sailingDelta = Math.abs((curr.unique_sailing_ids || 0) - (prev.unique_sailing_ids || 0));
      if (sailingDelta > 5) failures.push("union_not_stable_across_passes");
    } else {
      failures.push("union_not_stable_across_passes");
    }
  }
  if ((unionPass.duplicate_sailing_ids || 0) > 0) failures.push("duplicate_sailing_ids_after_dedupe");
  if (shipCoverage?.missing_ship_codes?.length) {
    failures.push(`fleet_ships_without_union_sailings_${shipCoverage.missing_ship_codes.length}`);
  }

  const absentFromUnion = [...productionSailingIds].filter((id) => !unionPass.sailing_ids.has(id));
  const retrievableViaDetail = directLookupResults.filter((r) => r.detail_ok && r.in_union === false);
  if (
    absentFromUnion.length > 0 &&
    retrievableViaDetail.length >= Math.min(5, Math.ceil(absentFromUnion.length / 2))
  ) {
    failures.push("systematic_detail_lookup_exceeds_union_gaps");
  }

  return {
    royal_caribbean_source_enumeration_ok: failures.length === 0,
    failures,
    global_vs_union: {
      group_symmetric_diff: globalVsUnionGroups.symmetric_count,
      sailing_symmetric_diff: globalVsUnionSailings.symmetric_count,
      only_in_union_groups: globalVsUnionGroups.only_in_b.slice(0, 20),
      only_in_union_sailings: globalVsUnionSailings.only_in_b.slice(0, 20),
      only_in_global_sailings: globalVsUnionSailings.only_in_a.slice(0, 20)
    },
    production_absent_from_union_count: absentFromUnion.length,
    detail_retrievable_absent_from_union_count: retrievableViaDetail.length
  };
}

function sourceAbsenceActionAllowed(health) {
  return health?.royal_caribbean_source_enumeration_ok === true;
}

module.exports = {
  AUTHORITATIVE_PAGE_SIZES,
  DEFAULT_UNION_PAGE_SIZES,
  symmetricSetDiff,
  unionSets,
  enumerateGlobalOffsetPass,
  enumerateMultiPageSizeUnion,
  enumerateUntilStableUnion,
  enumerateShipCoveragePartition,
  fetchRoyalCaribbeanCruiseDetail,
  computeSourceSnapshotIdFromSailingIds,
  evaluateSourceEnumerationHealth,
  sourceAbsenceActionAllowed
};
