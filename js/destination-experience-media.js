/**
 * Destination Experience — read-only media loading and deterministic assignment.
 * Browser global: DestinationExperienceMedia
 */
(function (root) {
  "use strict";

  var SNAPSHOT_URL = "/data/prototype/caribbean-media-snapshot.json";
  var LIVE_ENDPOINT = "/.netlify/functions/public-destination-media";
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

  function normalisePortName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");
  }

  function isExplicitDestinationAssociation(row, destinationName) {
    if (!row || row.is_active === false) return false;
    if (!destinationName) return false;
    return normaliseDestinationName(row.destination_name) === normaliseDestinationName(destinationName);
  }

  function isExplicitCaribbeanAssociation(row) {
    if (!row || row.is_active === false) return false;
    if (row.media_type !== "destination") return false;
    return isExplicitDestinationAssociation(row, "Caribbean");
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

  function filterDestinationMedia(rows, destinationName) {
    return sortDestinationMedia(
      asArray(rows).filter(function (row) {
        return isExplicitDestinationAssociation(row, destinationName) && row.media_type === "destination";
      })
    );
  }

  function filterCaribbeanMedia(rows) {
    return filterDestinationMedia(rows, "Caribbean");
  }

  function toImageDto(row, role, destName, source) {
    if (!row || !row.public_url) return null;
    return {
      url: row.public_url,
      alt: row.alt_text || (destName ? destName + " destination" : "Destination"),
      objectPosition: OBJECT_POSITIONS[role] || "center center",
      mediaId: row.id || null,
      title: row.title || "",
      source: source || "media_library",
      role: role
    };
  }

  function assignDestinationImages(slug, rows, fallbackHero, destinationName) {
    var destName = destinationName || slug || "";
    var pool = filterDestinationMedia(rows, destName);
    var assignments = Object.create(null);

    ASSIGNMENT_ORDER.forEach(function (role, index) {
      var row = pool[index] || pool[pool.length - 1] || null;
      if (!row) return;
      assignments[role] = toImageDto(row, role, destName, "media_library");
    });

    if (!assignments.hero && fallbackHero) {
      assignments.hero = {
        url: fallbackHero.url,
        alt: fallbackHero.alt,
        objectPosition: OBJECT_POSITIONS.hero,
        mediaId: fallbackHero.mediaId || null,
        title: fallbackHero.title || slug + "-hero",
        source: fallbackHero.source || "cruise_finder_fallback",
        role: "hero"
      };
    }

    if (!assignments.cta && assignments.advice) {
      assignments.cta = Object.assign({}, assignments.advice, {
        role: "cta",
        objectPosition: OBJECT_POSITIONS.cta
      });
    }

    return {
      assignments: assignments,
      pool: pool,
      usedFallback: !pool.length
    };
  }

  function matchPortMedia(portName, portMediaRows, destinationName) {
    var target = normalisePortName(portName);
    if (!target) return null;
    var rows = asArray(portMediaRows).filter(function (row) {
      return (
        row &&
        row.is_active !== false &&
        row.media_type === "port" &&
        isExplicitDestinationAssociation(row, destinationName) &&
        row.public_url
      );
    });
    var exact = rows.find(function (row) {
      return normalisePortName(row.port_name) === target;
    });
    if (exact) return exact;
    var contains = rows.filter(function (row) {
      var candidate = normalisePortName(row.port_name);
      return candidate && (candidate.includes(target) || target.includes(candidate));
    });
    return contains.length === 1 ? contains[0] : null;
  }

  function applyPortMedia(ports, portMediaRows, destinationName, cataloguePortRows) {
    var catalogueByName = Object.create(null);
    asArray(cataloguePortRows).forEach(function (row) {
      if (!row || !row.public_url) return;
      var key = normalisePortName(row.port_name);
      if (key) catalogueByName[key] = row;
    });

    return asArray(ports).map(function (port) {
      var catalogue = catalogueByName[normalisePortName(port.name)];
      if (catalogue) {
        return Object.assign({}, port, {
          image: {
            url: catalogue.public_url,
            alt: catalogue.alt_text || port.name + " port",
            objectPosition: "center center",
            mediaId: catalogue.id || null,
            title: catalogue.title || port.name,
            source: catalogue.resolved_via || "ports_catalogue"
          }
        });
      }

      var match = matchPortMedia(port.name, portMediaRows, destinationName);
      if (!match) return port;
      return Object.assign({}, port, {
        image: {
          url: match.public_url,
          alt: match.alt_text || port.name + " port",
          objectPosition: "center center",
          mediaId: match.id || null,
          title: match.title || port.name,
          source: "media_library_port"
        }
      });
    });
  }

  async function loadLiveDestinationMedia(slug, destinationName, options) {
    options = options || {};
    var endpoint = options.endpoint || LIVE_ENDPOINT;
    var params = new URLSearchParams();
    if (slug) params.set("slug", slug);
    if (destinationName) params.set("name", destinationName);
    if (Array.isArray(options.portNames) && options.portNames.length) {
      params.set("ports", options.portNames.join("|"));
    }
    var response = await fetch(endpoint + "?" + params.toString(), {
      method: "GET",
      cache: "no-store"
    });
    if (!response.ok) throw new Error("live media unavailable");
    var payload = await response.json();
    return {
      destinationMedia: asArray(payload.destination_media),
      portMedia: asArray(payload.port_media),
      cataloguePortMedia: asArray(payload.catalogue_port_media),
      source: "media_library_live"
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

  async function loadDestinationMedia(slug, destinationName, options) {
    options = options || {};
    if (options.source === "snapshot") {
      return {
        destinationMedia: await loadCaribbeanMedia(options),
        portMedia: [],
        cataloguePortMedia: [],
        source: "media_library_snapshot"
      };
    }
    try {
      return await loadLiveDestinationMedia(slug, destinationName, options);
    } catch (_error) {
      if (options.allowSnapshotFallback && normaliseDestinationName(destinationName) === "caribbean") {
        return {
          destinationMedia: await loadCaribbeanMedia(options),
          portMedia: [],
          cataloguePortMedia: [],
          source: "media_library_snapshot"
        };
      }
      return { destinationMedia: [], portMedia: [], cataloguePortMedia: [], source: "unavailable" };
    }
  }

  root.DestinationExperienceMedia = {
    SNAPSHOT_URL: SNAPSHOT_URL,
    LIVE_ENDPOINT: LIVE_ENDPOINT,
    ASSIGNMENT_ORDER: ASSIGNMENT_ORDER,
    filterDestinationMedia: filterDestinationMedia,
    filterCaribbeanMedia: filterCaribbeanMedia,
    sortDestinationMedia: sortDestinationMedia,
    isExplicitDestinationAssociation: isExplicitDestinationAssociation,
    isExplicitCaribbeanAssociation: isExplicitCaribbeanAssociation,
    assignDestinationImages: assignDestinationImages,
    applyPortMedia: applyPortMedia,
    matchPortMedia: matchPortMedia,
    loadDestinationMedia: loadDestinationMedia,
    loadCaribbeanMedia: loadCaribbeanMedia,
    loadLiveDestinationMedia: loadLiveDestinationMedia,
    toImageDto: toImageDto
  };
})(typeof window !== "undefined" ? window : globalThis);
