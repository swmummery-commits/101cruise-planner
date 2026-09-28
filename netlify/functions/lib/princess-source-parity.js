/**
 * Compare two Princess source freezes (Mac vs Netlify).
 * Unexplained set differences fail the parity gate.
 */

function asSet(values = []) {
  return new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean));
}

function sorted(values) {
  return [...values].sort();
}

function setDelta(left, right) {
  const onlyLeft = [];
  const onlyRight = [];
  for (const value of left) {
    if (!right.has(value)) onlyLeft.push(value);
  }
  for (const value of right) {
    if (!left.has(value)) onlyRight.push(value);
  }
  return { only_left: sorted(onlyLeft), only_right: sorted(onlyRight) };
}

function comparePrincessSourceFreezes(mac = {}, netlify = {}) {
  const macGroups = asSet(mac.official_group_ids || mac.group_ids);
  const netlifyGroups = asSet(netlify.official_group_ids || netlify.group_ids);
  const macExpanded = asSet(mac.expanded_official_ids || mac.expanded_ids);
  const netlifyExpanded = asSet(netlify.expanded_official_ids || netlify.expanded_ids);
  const macEligible = asSet(mac.eligible_official_ids || mac.official_ids);
  const netlifyEligible = asSet(netlify.eligible_official_ids || netlify.official_ids);

  const groups = setDelta(macGroups, netlifyGroups);
  const expanded = setDelta(macExpanded, netlifyExpanded);
  const eligible = setDelta(macEligible, netlifyEligible);

  const macRates = mac.resolution_rates || {};
  const netlifyRates = netlify.resolution_rates || {};
  const resolutionPass =
    Number(macRates.identity_coverage_pct) === 100 &&
    Number(netlifyRates.identity_coverage_pct) === 100 &&
    Number(macRates.ship_resolution_pct) === 100 &&
    Number(netlifyRates.ship_resolution_pct) === 100 &&
    Number(macRates.departure_port_resolution_pct) === 100 &&
    Number(netlifyRates.departure_port_resolution_pct) === 100 &&
    Number(macRates.destination_resolution_pct) === 100 &&
    Number(netlifyRates.destination_resolution_pct) === 100 &&
    Number(macRates.duplicate_official_identities || 0) === 0 &&
    Number(netlifyRates.duplicate_official_identities || 0) === 0;

  const hashMatch =
    mac.snapshot_id && netlify.snapshot_id ? mac.snapshot_id === netlify.snapshot_id : false;
  const eligibleMatch = eligible.only_left.length === 0 && eligible.only_right.length === 0;
  const noCollapse =
    macEligible.size > 0 &&
    netlifyEligible.size > 0 &&
    macEligible.size === Number(mac.eligible_total || macEligible.size) &&
    netlifyEligible.size === Number(netlify.eligible_total || netlifyEligible.size);

  const pass =
    eligibleMatch &&
    resolutionPass &&
    noCollapse &&
    (hashMatch || (groups.only_left.length === 0 && groups.only_right.length === 0));

  return {
    pass,
    mac_eligible: macEligible.size,
    netlify_eligible: netlifyEligible.size,
    mac_hash: mac.snapshot_id || null,
    netlify_hash: netlify.snapshot_id || null,
    hash_match: hashMatch,
    mac_only_eligible_ids: eligible.only_left,
    netlify_only_eligible_ids: eligible.only_right,
    mac_only_group_ids: groups.only_left,
    netlify_only_group_ids: groups.only_right,
    mac_only_expanded_ids: expanded.only_left,
    netlify_only_expanded_ids: expanded.only_right,
    resolution_pass: resolutionPass,
    no_collapse: noCollapse,
    unexplained_ids: [...eligible.only_left, ...eligible.only_right]
  };
}

module.exports = {
  comparePrincessSourceFreezes
};
