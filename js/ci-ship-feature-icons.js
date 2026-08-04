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
      paths: `<path d="m12 2 2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 7.1-1.01Z"/><path d="M8.5 9v4a1.5 1.5 0 0 0 3 0V9"/><path d="M10 9v10"/><path d="M17 15V9a3.5 3.5 0 0 0-3.5 3.5V14a1.5 1.5 0 0 0 3 0v5"/>`
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
      paths: `<circle cx="12" cy="12" r="3"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/>`
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
      paths: `<path d="M12 3c-2 3-5 4-5 7a5 5 0 0 0 10 0c0-3-3-4-5-7z"/><path d="M8 14c-1.5 1.5-2 3-2 4.5"/><path d="M16 14c1.5 1.5 2 3 2 4.5"/><path d="M10 20h4"/>`
    },
    theatre: {
      label: "Theatre",
      group: "specialty",
      paths: `<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>`
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
      paths: `<path d="M2 18c2-1 4-1 6 0s4 1 6 0 4-1 6 0"/><path d="M8 12V6l4-2 4 2v6"/>`
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
      paths: `<rect x="3" y="8" width="18" height="10" rx="2"/><path d="M8 12h8"/><path d="M12 8v10"/>`
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
      paths: `<path d="M6 13h12"/><path d="M6 13a4 4 0 0 1 0-8h12a4 4 0 0 1 0 8"/><path d="M8 21h8"/><path d="M12 17v4"/>`
    },
    dining: {
      label: "Dining",
      group: "specialty",
      paths: `<path d="m5 0.5 0.4 0.85 0.95 0.14-0.68 0.66 0.16 0.94-0.83-0.5-0.83 0.5 0.16-0.94-0.68-0.66 0.95-0.14Z"/><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3v7"/>`
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
    expedition: ["expedition", "discovery centre", "discovery center", "submarine", "zodiac"],
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
