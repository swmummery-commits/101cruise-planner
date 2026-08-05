/**
 * Ship feature icon library — Exclusive Areas & Specialty Features.
 * Outline SVGs matching My Ship / Onboard at a Glance visual language.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipFeatureIcons = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const FALLBACK_KEY = "sparkles";
  const STROKE = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

  /** @type {Record<string, { label: string, group: string, paths: string }>} */
  const ICONS = {
    crown: {
      label: "Crown / premium",
      group: "exclusive",
      paths: `<path d="M4 18h16"/><path d="M6 18V9l3 2 3-5 3 5 3-2v9"/>`
    },
    lounge: {
      label: "Lounge",
      group: "exclusive",
      paths: `<path d="M4 18v-4a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4"/><path d="M4 18h16"/><path d="M8 14v-2"/><path d="M16 14v-2"/>`
    },
    "sun-deck": {
      label: "Sun deck",
      group: "exclusive",
      paths: `<circle cx="12" cy="5" r="3"/><path d="M12 8v3"/><path d="M5 20h14"/><path d="M7 20l2-6h6l2 6"/>`
    },
    key: {
      label: "Key / access",
      group: "exclusive",
      paths: `<circle cx="8" cy="8" r="4"/><path d="M12 8h8"/><path d="M18 8v4"/><path d="M16 8v3"/>`
    },
    shield: {
      label: "Shield / private",
      group: "exclusive",
      paths: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`
    },
    "private-dining": {
      label: "Private dining",
      group: "exclusive",
      paths: `<path d="m18 1.2 1.1 2.4 2.65 0.38-1.95 1.85 0.45 2.6L18 6.9 16.05 8.4l0.45-2.6-1.95-1.85 2.65-0.38Z"/><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3v7"/>`
    },
    "suite-attendant": {
      label: "Suite attendant",
      group: "exclusive",
      paths: `<circle cx="12" cy="5.5" r="2.25"/><path d="M9.75 8.25h4.5"/><path d="M9.75 8.25 8.75 9.75"/><path d="M14.25 8.25 15.25 9.75"/><path d="M8.25 20v-5.5a3.75 3.75 0 0 1 7.5 0V20"/><path d="M5 13.5h3.75"/><path d="M5 14.25v0.75a0.75 0.75 0 0 0 0.75 0.75h2.25"/>`
    },
    terrace: {
      label: "Terrace",
      group: "exclusive",
      paths: `<path d="M4 20h16"/><path d="M6 20V8l6-4 6 4v12"/><path d="M10 12h4"/>`
    },
    sanctuary: {
      label: "Sanctuary",
      group: "exclusive",
      paths: `<path d="M12 3 4 9v12h16V9Z"/><path d="M9 21v-6h6v6"/>`
    },
    observation: {
      label: "Observation",
      group: "exclusive",
      paths: `<circle cx="8" cy="11" r="3"/><circle cx="16" cy="11" r="3"/><path d="M11 11h2"/><path d="M8 14v4"/><path d="M16 14v4"/>`
    },
    star: {
      label: "Star",
      group: "exclusive",
      paths: `<path d="m12 2 2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 7.1-1.01Z"/>`
    },
    pool: {
      label: "Pool",
      group: "specialty",
      paths: `<path d="M2 20c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M2 16c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M12 4v8"/><path d="M8 8h8"/>`
    },
    fitness: {
      label: "Fitness",
      group: "specialty",
      paths: `<path d="m17.5 6.5 1 1"/><path d="m6.5 6.5-1 1"/><path d="M12 12v9"/><path d="M8 9h8"/><path d="M9 22h6"/><circle cx="12" cy="5" r="2"/>`
    },
    spa: {
      label: "Spa",
      group: "specialty",
      paths: `<path d="M4 15h16"/><path d="M6 15v3"/><path d="M18 15v3"/><circle cx="7.5" cy="12.5" r="1.4"/><path d="M9 13h5"/><circle cx="14" cy="7.5" r="1.6"/><path d="M14 9.1v3.9"/><path d="M12.5 13h3"/>`
    },
    theatre: {
      label: "Theatre",
      group: "specialty",
      paths: `<path d="M5 4v16"/><path d="M5 4c1.5 2 1.5 4 0 6"/><path d="M5 10c1.5 2 1.5 4 0 6"/><path d="M19 4v16"/><path d="M19 4c-1.5 2-1.5 4 0 6"/><path d="M19 10c-1.5 2-1.5 4 0 6"/><path d="M4 20h16"/><path d="M8 17h8"/>`
    },
    "live-music": {
      label: "Live music",
      group: "specialty",
      paths: `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`
    },
    cinema: {
      label: "Cinema",
      group: "specialty",
      paths: `<rect x="2" y="7" width="20" height="13" rx="2"/><path d="m7 7 5-4 5 4"/>`
    },
    casino: {
      label: "Casino",
      group: "specialty",
      paths: `<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><path d="M12 9v6"/>`
    },
    kids: {
      label: "Kids / youth",
      group: "specialty",
      paths: `<circle cx="12" cy="8" r="3"/><path d="M4 20a8 8 0 0 1 16 0"/>`
    },
    shopping: {
      label: "Shopping",
      group: "specialty",
      paths: `<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>`
    },
    "water-park": {
      label: "Water park",
      group: "specialty",
      paths: `<path d="M4 20c2-2 4-2 6 0s4 2 6 0"/><path d="M7 14l2-8 3 5 2-6 3 9"/><path d="M5 10h14"/>`
    },
    surf: {
      label: "Surf / FlowRider",
      group: "specialty",
      paths: `<path d="M2 18c2.5-1 4.5-1 7 0s4.5 1 7 0 2.5-1 5 0"/><path d="M7 15.5h8"/><circle cx="13" cy="9" r="1.5"/><path d="M13 10.5v4"/><path d="m11.5 14.5 1.5-1.5 1.5 1.5"/>`
    },
    "roller-coaster": {
      label: "Roller coaster",
      group: "specialty",
      paths: `<path d="M4 16c0-4 3-8 8-8s8 4 8 8"/><circle cx="6" cy="16" r="2"/><circle cx="18" cy="16" r="2"/><path d="M8 8V4"/><path d="M16 8V4"/>`
    },
    "go-kart": {
      label: "Go-kart",
      group: "specialty",
      paths: `<path d="M3 15h18"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 15V9l4-3h6l4 3v6"/>`
    },
    "ice-rink": {
      label: "Ice rink",
      group: "specialty",
      paths: `<path d="M7 5v7"/><path d="M5.5 12h3"/><path d="M5.5 14h3"/><path d="M5.5 15.5v2"/><path d="M15 5v7"/><path d="M13.5 12h3"/><path d="M13.5 14h3"/><path d="M16.5 15.5v2"/>`
    },
    skydiving: {
      label: "Skydiving simulator",
      group: "specialty",
      paths: `<path d="M12 3v10"/><path d="m8 9 4 4 4-4"/><path d="M4 20h16"/><path d="M8 20l4-7 4 7"/>`
    },
    climbing: {
      label: "Climbing wall",
      group: "specialty",
      paths: `<path d="M4 20 12 4l8 16"/><path d="M9 14h6"/><path d="M7 17h10"/>`
    },
    "zip-line": {
      label: "Zip line",
      group: "specialty",
      paths: `<path d="M4 6h16"/><path d="M6 6v2"/><path d="M18 6v2"/><path d="M8 20l8-12"/>`
    },
    "mini-golf": {
      label: "Mini golf",
      group: "specialty",
      paths: `<path d="M4 20h16"/><circle cx="16" cy="10" r="2"/><path d="M6 20V8l6-2"/>`
    },
    "sports-court": {
      label: "Sports court",
      group: "specialty",
      paths: `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16"/><path d="M4 12h16"/>`
    },
    games: {
      label: "Games / arcade",
      group: "specialty",
      paths: `<rect x="3" y="8" width="18" height="10" rx="2"/><path d="M8 13h2"/><path d="M9 12v2"/><circle cx="15" cy="13" r="1"/><circle cx="17" cy="15" r="1"/>`
    },
    library: {
      label: "Library",
      group: "specialty",
      paths: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`
    },
    "art-gallery": {
      label: "Art gallery",
      group: "specialty",
      paths: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 15l2-3 2 2 3-4 3 5"/>`
    },
    science: {
      label: "Science / lab",
      group: "specialty",
      paths: `<path d="M10 2v6l-4 9a2 2 0 0 0 2 3h8a2 2 0 0 0 2-3l-4-9V2"/><path d="M8 12h8"/>`
    },
    marina: {
      label: "Marina / watersports",
      group: "specialty",
      paths: `<path d="M3 18h18"/><path d="M6 18V8l6-3 6 3v10"/><path d="M10 12h4"/>`
    },
    garden: {
      label: "Garden",
      group: "specialty",
      paths: `<path d="M12 22V12"/><path d="M12 12C12 8 8 6 5 8c0 4 3 6 7 4"/><path d="M12 12c0-4 4-6 7-4 0 4-3 6-7 4"/>`
    },
    cooking: {
      label: "Cooking",
      group: "specialty",
      paths: `<path d="M6 16h12"/><path d="M8 16v2"/><path d="M16 16v2"/><path d="M7 14h10"/><path d="M12 5c-1.5 2.5-3 4-3 6a3 3 0 0 0 6 0c0-2-1.5-3.5-3-6z"/>`
    },
    dining: {
      label: "Dining",
      group: "specialty",
      paths: `<path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3v7"/>`
    },
    drinks: {
      label: "Drinks / bar",
      group: "specialty",
      paths: `<path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8z"/>`
    },
    expedition: {
      label: "Expedition",
      group: "specialty",
      paths: `<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M3 12h18"/><path d="m8 8 8 8"/>`
    },
    compass: {
      label: "Compass / discovery",
      group: "specialty",
      paths: `<circle cx="12" cy="12" r="9"/><path d="m16 8-4 8-4-8 8-4z"/>`
    },
    zodiac: {
      label: "Zodiac boat",
      group: "specialty",
      paths: `<path d="M3 14.5c2.5-3.5 6-5 9-5s6.5 1.5 9 5"/><path d="M4 14.5h16"/><path d="M6.5 14.5v2.5"/><path d="M17.5 14.5v2.5"/><path d="M9 11.5h6"/>`
    },
    sparkles: {
      label: "General feature",
      group: "specialty",
      paths: `<path d="M12 3v3"/><path d="M12 18v3"/><path d="m4.2 4.2 2.1 2.1"/><path d="m17.7 17.7 2.1 2.1"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m4.2 19.8 2.1-2.1"/><path d="m17.7 6.3 2.1-2.1"/><circle cx="12" cy="12" r="2"/>`
    }
  };

  /** @type {Record<string, string[]>} */
  const ALIAS_GROUPS = {
    crown: ["suite deck", "queens grill", "princess grill", "yacht club", "the haven", "the retreat", "rockstar", "premium suite"],
    lounge: ["lounge", "concierge club", "diamond club", "executive lounge", "suite lounge", "club lounge", "premium lounge"],
    "sun-deck": ["sun deck", "sundeck", "private deck", "suite sun deck", "sanctuary", "adults-only deck"],
    "private-dining": ["private restaurant", "exclusive restaurant", "blu", "luminae", "coastal kitchen", "dining room", "specialty dining"],
    "suite-attendant": ["personal suite attendant", "suite attendant", "butler", "stateroom attendant", "room attendant", "personal butler", "24 hour butler"],
    fitness: ["fitness", "fitness center", "fitness centre", "gym", "exercise", "fitness center, with classes"],
    spa: ["spa", "thermal suite", "wellness", "hydrotherapy"],
    cinema: ["cinema", "movie", "film", "outdoor screen"],
    "water-park": ["water park", "waterslide", "water slide", "aqua park", "splash park"],
    surf: ["surf", "flowrider", "wave simulator"],
    "roller-coaster": ["roller coaster", "bolt", "coaster"],
    skydiving: ["skydiving", "skydiving simulator", "ripcord"],
    climbing: ["climbing", "climbing wall", "rock wall"],
    "zip-line": ["zip line", "zipline"],
    "sports-court": ["sports court", "basketball", "tennis", "pickleball"],
    kids: ["kids", "children", "youth", "teen", "family club", "kids club"],
    library: ["library", "books", "reading room"],
    "art-gallery": ["art", "gallery", "exhibition"],
    science: ["science", "laboratory", "research centre", "research center"],
    marina: ["marina", "watersports platform", "water sports platform", "yacht marina"],
    zodiac: ["zodiac", "zodiac landing", "rubber boat", "rib boat", "inflatable boat", "tender boat"],
    expedition: ["expedition", "discovery centre", "discovery center", "submarine"],
    pool: ["pool", "main pool", "swimming pool"],
    theatre: ["theatre", "theater", "show lounge"],
    casino: ["casino"],
    shopping: ["shopping", "shops", "boutique"],
    games: ["arcade", "games room", "game room"],
    dining: ["restaurant", "eatery"],
    drinks: ["bar", "pub", "lounge bar"],
    observation: ["observation", "observatory", "lookout"],
    sanctuary: ["retreat", "haven"],
    terrace: ["terrace", "veranda"],
    key: ["key card", "keyed access"],
    shield: ["private area", "members only"]
  };

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeMatchText(value) {
    return trim(value)
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isKnownIconKey(key) {
    return Boolean(key && Object.prototype.hasOwnProperty.call(ICONS, key));
  }

  function resolveShipFeatureIconKey(name, explicitIconKey) {
    const explicit = trim(explicitIconKey);
    if (explicit && isKnownIconKey(explicit)) return explicit;

    const normalized = normalizeMatchText(name);
    if (!normalized) return FALLBACK_KEY;

    for (const [iconKey, aliases] of Object.entries(ALIAS_GROUPS)) {
      if (!isKnownIconKey(iconKey)) continue;
      for (const alias of aliases) {
        const aliasNorm = normalizeMatchText(alias);
        if (!aliasNorm) continue;
        if (normalized === aliasNorm || normalized.includes(aliasNorm) || aliasNorm.includes(normalized)) {
          return iconKey;
        }
      }
    }

    for (const iconKey of Object.keys(ICONS)) {
      const labelNorm = normalizeMatchText(ICONS[iconKey].label);
      if (labelNorm && (normalized === labelNorm || normalized.includes(labelNorm))) {
        return iconKey;
      }
    }

    return FALLBACK_KEY;
  }

  function getIconMeta(iconKey) {
    const key = isKnownIconKey(iconKey) ? iconKey : FALLBACK_KEY;
    return { key: key, ...ICONS[key] };
  }

  function renderIconSvg(iconKey, className) {
    const meta = getIconMeta(iconKey);
    const cls = className ? ` class="${className}"` : "";
    return `<svg viewBox="0 0 24 24" fill="none" ${STROKE}${cls} aria-hidden="true">${meta.paths}</svg>`;
  }

  function renderFeatureIconHtml(iconKey, className) {
    const wrapClass = className || "ship-feature-icon";
    return `<span class="${wrapClass}" aria-hidden="true">${renderIconSvg(iconKey, "ship-feature-icon-svg")}</span>`;
  }

  function listIconCatalog() {
    return Object.entries(ICONS).map(function ([key, meta]) {
      return { key: key, label: meta.label, group: meta.group };
    });
  }

  function iconLabel(iconKey) {
    return getIconMeta(iconKey).label;
  }

  return {
    FALLBACK_KEY: FALLBACK_KEY,
    ICONS: ICONS,
    isKnownIconKey: isKnownIconKey,
    resolveShipFeatureIconKey: resolveShipFeatureIconKey,
    getIconMeta: getIconMeta,
    renderIconSvg: renderIconSvg,
    renderFeatureIconHtml: renderFeatureIconHtml,
    listIconCatalog: listIconCatalog,
    iconLabel: iconLabel,
    normalizeMatchText: normalizeMatchText
  };
});
