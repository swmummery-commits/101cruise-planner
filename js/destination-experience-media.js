/**
 * Destination Experience — read-only Caribbean media loading and assignment.
 * Browser global: DestinationExperienceMedia
 *
 * Uses an isolated local snapshot for prototype stability. No writes.
 */
(function (root) {
  "use strict";

  var SNAPSHOT_URL = "/data/prototype/caribbean-media-snapshot.json";
  var ASSIGNMENT_ORDER = ["hero", "reason-1", "reason-2", "reason-3", "advice", "cta"];
  var OBJECT_POSITIONS = {
    hero: "center center",
    "reason-1": "center 30%",
    "reason-2": "70% 55%",
    "reason-3": "25% 70%",
    advice: "center 60%",
    cta: "center 40%"
  };

  function asArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function normaliseDestinationName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function isExplicitCaribbeanAssociation(row) {
    if (!row || row.is_active === false) return false;
    if (row.media_type !== "destination") return false;
    return normaliseDestinationName(row.destination_name) === "caribbean";
  }

  function sortDestinationMedia(rows) {
    return asArray(rows)
      .slice()
      .sort(function (a, b) {
        var aDef = a.is_default ? 0 : 1;
        var bDef = b.is_default ? 0 : 1;
        if (aDef !== bDef) return aDef - bDef;
        var aCreated = String(a.created_at || "");
        var bCreated = String(b.created_at || "");
        if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  function filterCaribbeanMedia(rows) {
    return sortDestinationMedia(asArray(rows).filter(isExplicitCaribbeanAssociation));
  }

  function toImageDto(row, role, destName) {
    if (!row || !row.public_url) return null;
    return {
      url: row.public_url,
      alt: row.alt_text || (destName ? destName + " destination" : "Destination"),
      objectPosition: OBJECT_POSITIONS[role] || "center center",
      mediaId: row.id || null,
      title: row.title || "",
      source: "media_library_snapshot",
      role: role
    };
  }

  function assignDestinationImages(slug, rows, fallbackHero) {
    var canonical = normaliseDestinationName(slug);
    if (canonical !== "caribbean") {
      return {
        assignments: {},
        pool: [],
        usedFallback: Boolean(fallbackHero)
      };
    }

    var pool = filterCaribbeanMedia(rows);
    var assignments = Object.create(null);
    var used = Object.create(null);

    ASSIGNMENT_ORDER.forEach(function (role, index) {
      var row = pool[index] || pool[pool.length - 1] || null;
      if (!row) return;
      assignments[role] = toImageDto(row, role, "Caribbean");
      used[row.id] = true;
    });

    if (!assignments.hero && fallbackHero) {
      assignments.hero = {
        url: fallbackHero.url,
        alt: fallbackHero.alt,
        objectPosition: OBJECT_POSITIONS.hero,
        mediaId: fallbackHero.mediaId || null,
        title: fallbackHero.title || "caribbean-hero",
        source: fallbackHero.source || "cruise_finder_fallback",
        role: "hero"
      };
    }

    if (!assignments.cta && assignments.advice) {
      assignments.cta = Object.assign({}, assignments.advice, { role: "cta", objectPosition: OBJECT_POSITIONS.cta });
    }

    return {
      assignments: assignments,
      pool: pool,
      usedFallback: !pool.length
    };
  }

  async function loadCaribbeanMedia(options) {
    options = options || {};
    try {
      var response = await fetch(options.snapshotUrl || SNAPSHOT_URL, {
        method: "GET",
        cache: "no-store"
      });
      if (!response.ok) throw new Error("snapshot unavailable");
      var payload = await response.json();
      return filterCaribbeanMedia(payload.items || payload);
    } catch (_error) {
      return filterCaribbeanMedia(options.snapshotItems || []);
    }
  }

  root.DestinationExperienceMedia = {
    SNAPSHOT_URL: SNAPSHOT_URL,
    ASSIGNMENT_ORDER: ASSIGNMENT_ORDER,
    filterCaribbeanMedia: filterCaribbeanMedia,
    sortDestinationMedia: sortDestinationMedia,
    isExplicitCaribbeanAssociation: isExplicitCaribbeanAssociation,
    assignDestinationImages: assignDestinationImages,
    loadCaribbeanMedia: loadCaribbeanMedia,
    toImageDto: toImageDto
  };
})(typeof window !== "undefined" ? window : globalThis);
