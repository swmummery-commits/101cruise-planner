/**
 * Browser helpers for the Client Portal dashboard journey map.
 * Bundled Natural Earth land (TopoJSON) + aspect-corrected equirectangular projection.
 * No Mapbox / Google Maps / live tile servers / API keys.
 */
(function (global) {
  "use strict";

  var DEFAULT_WIDTH = 620;
  var DEFAULT_HEIGHT = 350;
  var DEFAULT_PAD_PX = 36;
  var LAND_URL_PRIMARY = "assets/geo/land-50m.json";
  var LAND_URL_FALLBACK = "assets/geo/land-110m.json";

  var landCache = null;
  var landLoadPromise = null;

  function isSeaDay(stop) {
    var type = String((stop && (stop.type || stop.entry_type)) || "").toLowerCase();
    var name = String((stop && stop.name) || "").toLowerCase();
    return type === "sea_day" || name === "at sea" || name.indexOf("at sea") !== -1;
  }

  function hasCoordinates(stop) {
    var lat = Number(stop && (stop.lat != null ? stop.lat : stop.latitude));
    var lng = Number(stop && (stop.lng != null ? stop.lng : stop.longitude));
    return Number.isFinite(lat) && Number.isFinite(lng);
  }

  function shortPortLabel(name) {
    var text = String(name || "").trim();
    var paren = text.match(/^(.+?)\s*\((.+?)\)\s*$/);
    if (paren) return paren[1].trim();
    return text.length > 18 ? text.slice(0, 16) + "…" : text;
  }

  function unwrapPolylineForDrawing(coordinates) {
    var pts = coordinates || [];
    if (!pts.length) return [];
    var out = [];
    var offset = 0;
    var prevLon = Number(pts[0][0]);
    out.push([prevLon, Number(pts[0][1])]);
    for (var i = 1; i < pts.length; i += 1) {
      var lon = Number(pts[i][0]);
      var lat = Number(pts[i][1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        out.push([lon, lat]);
        continue;
      }
      var unwrappedPrev = prevLon + offset;
      var candidate = lon + offset;
      while (candidate - unwrappedPrev > 180) {
        offset -= 360;
        candidate = lon + offset;
      }
      while (candidate - unwrappedPrev < -180) {
        offset += 360;
        candidate = lon + offset;
      }
      out.push([candidate, lat]);
      prevLon = lon;
    }
    return out;
  }

  function boundsFromPoints(points) {
    var pts = points || [];
    if (!pts.length) return null;
    var west = Infinity;
    var east = -Infinity;
    var south = Infinity;
    var north = -Infinity;
    for (var i = 0; i < pts.length; i += 1) {
      var lon = Number(pts[i][0]);
      var lat = Number(pts[i][1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    if (!Number.isFinite(west)) return null;
    return { west: west, east: east, south: south, north: north };
  }

  function expandBoundsForViewport(bounds, options) {
    options = options || {};
    var width = Number(options.width) || 1200;
    var height = Number(options.height) || 675;
    var paddingRatio = options.paddingRatio != null ? Number(options.paddingRatio) : 0.18;
    var paddingDegreesMin =
      options.paddingDegreesMin != null ? Number(options.paddingDegreesMin) : 1.2;
    var minLonSpan = options.minLonSpan != null ? Number(options.minLonSpan) : 6;
    var minLatSpan = options.minLatSpan != null ? Number(options.minLatSpan) : 4;

    var west = bounds.west;
    var east = bounds.east;
    var south = bounds.south;
    var north = bounds.north;
    var lonSpan = Math.max(east - west, 1e-9);
    var latSpan = Math.max(north - south, 1e-9);

    if (lonSpan < minLonSpan) {
      var midLon = (west + east) / 2;
      west = midLon - minLonSpan / 2;
      east = midLon + minLonSpan / 2;
      lonSpan = minLonSpan;
    }
    if (latSpan < minLatSpan) {
      var midLat = (south + north) / 2;
      south = midLat - minLatSpan / 2;
      north = midLat + minLatSpan / 2;
      latSpan = minLatSpan;
    }

    var pad = Math.max(paddingDegreesMin, paddingRatio * Math.max(lonSpan, latSpan));
    west -= pad;
    east += pad;
    south -= pad;
    north += pad;
    lonSpan = east - west;
    latSpan = north - south;

    var midLatDeg = ((south + north) / 2) * (Math.PI / 180);
    var cosLat = Math.max(Math.cos(midLatDeg), 0.2);
    var geoAspect = (lonSpan * cosLat) / latSpan;
    var svgAspect = width / height;

    if (geoAspect > svgAspect) {
      var targetLatSpan = (lonSpan * cosLat) / svgAspect;
      var extraLat = (targetLatSpan - latSpan) / 2;
      south -= extraLat;
      north += extraLat;
    } else {
      var targetLonSpan = (latSpan * svgAspect) / cosLat;
      var extraLon = (targetLonSpan - lonSpan) / 2;
      west -= extraLon;
      east += extraLon;
    }

    return {
      west: west,
      east: east,
      south: south,
      north: north,
      midLatDeg: (south + north) / 2,
      cosLat: cosLat
    };
  }

  function createProjector(geo, size) {
    var width = Number(size.width) || 1200;
    var height = Number(size.height) || 675;
    var precision = size.precision != null ? Number(size.precision) : 1;
    var lonSpan = geo.east - geo.west;
    var latSpan = geo.north - geo.south;
    var factor = Math.pow(10, precision);

    function project(lon, lat) {
      var x = ((lon - geo.west) / lonSpan) * width;
      var y = ((geo.north - lat) / latSpan) * height;
      return [Math.round(x * factor) / factor, Math.round(y * factor) / factor];
    }

    return { width: width, height: height, geo: geo, project: project };
  }

  function buildSmoothPath(points) {
    if (!points.length) return "";
    if (points.length === 2) {
      return "M " + points[0].x + " " + points[0].y + " L " + points[1].x + " " + points[1].y;
    }
    var d = "M " + points[0].x + " " + points[0].y;
    for (var i = 0; i < points.length - 1; i += 1) {
      var p0 = points[Math.max(0, i - 1)];
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = points[Math.min(points.length - 1, i + 2)];
      var cp1x = p1.x + (p2.x - p0.x) / 6;
      var cp1y = p1.y + (p2.y - p0.y) / 6;
      var cp2x = p2.x - (p3.x - p1.x) / 6;
      var cp2y = p2.y - (p3.y - p1.y) / 6;
      d +=
        " C " +
        cp1x.toFixed(1) +
        " " +
        cp1y.toFixed(1) +
        ", " +
        cp2x.toFixed(1) +
        " " +
        cp2y.toFixed(1) +
        ", " +
        p2.x +
        " " +
        p2.y;
    }
    return d;
  }

  function collectRoutePoints(journey) {
    return (journey && journey.stops ? journey.stops : [])
      .filter(function (s) {
        return !isSeaDay(s) && hasCoordinates(s);
      })
      .filter(function (s, i, arr) {
        if (i === 0) return true;
        var prev = arr[i - 1];
        return !(Number(prev.lat) === Number(s.lat) && Number(prev.lng) === Number(s.lng));
      })
      .map(function (s) {
        return {
          date: s.date || null,
          name: s.name,
          type: s.type,
          arrival: s.arrival,
          departure: s.departure,
          lat: Number(s.lat != null ? s.lat : s.latitude),
          lng: Number(s.lng != null ? s.lng : s.longitude)
        };
      });
  }

  function projectJourneyMap(journey, options) {
    options = options || {};
    var width = options.width || DEFAULT_WIDTH;
    var height = options.height || DEFAULT_HEIGHT;
    var padPx = options.padPx != null ? Number(options.padPx) : DEFAULT_PAD_PX;
    var points = collectRoutePoints(journey);
    if (points.length < 2) return null;

    var rawLonLat = points.map(function (p) {
      return [p.lng, p.lat];
    });
    var unwrapped = unwrapPolylineForDrawing(rawLonLat);
    var routeBounds = boundsFromPoints(unwrapped);
    if (!routeBounds) return null;

    var geo = expandBoundsForViewport(routeBounds, {
      width: width - padPx * 2,
      height: height - padPx * 2,
      paddingRatio: 0.18,
      paddingDegreesMin: 1.2,
      minLonSpan: 6,
      minLatSpan: 4
    });

    var inner = createProjector(geo, {
      width: width - padPx * 2,
      height: height - padPx * 2,
      precision: 1
    });

    function projectLonLat(lon, lat) {
      var xy = inner.project(lon, lat);
      return {
        x: Number((xy[0] + padPx).toFixed(1)),
        y: Number((xy[1] + padPx).toFixed(1))
      };
    }

    var projected = points.map(function (p, index) {
      var lon = unwrapped[index][0];
      var pt = projectLonLat(lon, p.lat);
      return {
        date: p.date,
        name: p.name,
        type: p.type,
        arrival: p.arrival,
        departure: p.departure,
        lat: p.lat,
        lng: p.lng,
        drawLng: lon,
        x: Math.min(width - 8, Math.max(8, pt.x)),
        y: Math.min(height - 8, Math.max(8, pt.y)),
        number: index + 1,
        label: shortPortLabel(p.name)
      };
    });

    return {
      width: width,
      height: height,
      padPx: padPx,
      pathD: buildSmoothPath(projected),
      ports: projected,
      geo: geo,
      project: function (lon, lat) {
        var pt = projectLonLat(lon, lat);
        return [pt.x, pt.y];
      }
    };
  }

  function ringIntersectsBBox(ring, bbox) {
    var minLon = Infinity;
    var maxLon = -Infinity;
    var minLat = Infinity;
    var maxLat = -Infinity;
    for (var i = 0; i < ring.length; i += 1) {
      var lon = ring[i][0];
      var lat = ring[i][1];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return !(maxLon < bbox.west || minLon > bbox.east || maxLat < bbox.south || minLat > bbox.north);
  }

  function shiftRing(ring, lonOffset) {
    if (!lonOffset) return ring;
    return ring.map(function (c) {
      return [c[0] + lonOffset, c[1]];
    });
  }

  function extractLandRingsForBBox(land, bbox) {
    var offsets = [0];
    if (bbox.west < -180 || bbox.east > 180) offsets.push(-360, 360);
    if (bbox.east > 180) offsets.push(360);
    if (bbox.west < -180) offsets.push(-360);
    var unique = [];
    var seen = {};
    for (var o = 0; o < offsets.length; o += 1) {
      if (!seen[offsets[o]]) {
        seen[offsets[o]] = true;
        unique.push(offsets[o]);
      }
    }

    var rings = [];
    var features = (land && land.features) || [];
    for (var f = 0; f < features.length; f += 1) {
      var geom = features[f] && features[f].geometry;
      if (!geom) continue;
      var polys =
        geom.type === "Polygon"
          ? [geom.coordinates]
          : geom.type === "MultiPolygon"
            ? geom.coordinates
            : [];
      for (var p = 0; p < polys.length; p += 1) {
        var poly = polys[p];
        for (var r = 0; r < poly.length; r += 1) {
          for (var u = 0; u < unique.length; u += 1) {
            var shifted = shiftRing(poly[r], unique[u]);
            if (ringIntersectsBBox(shifted, bbox)) rings.push(shifted);
          }
        }
      }
    }
    return rings;
  }

  function ringToSvgPath(ring, project) {
    if (!ring || ring.length < 2) return "";
    var parts = [];
    for (var i = 0; i < ring.length; i += 1) {
      var xy = project(ring[i][0], ring[i][1]);
      parts.push((i === 0 ? "M" : "L") + xy[0] + " " + xy[1]);
    }
    parts.push("Z");
    return parts.join("");
  }

  function topologyToFeatureCollection(topology) {
    var topojson = global.topojson;
    if (!topojson || typeof topojson.feature !== "function") {
      throw new Error("topojson-client is not loaded");
    }
    if (!topology || !topology.objects || !topology.objects.land) {
      throw new Error("Invalid land topology");
    }
    var fc = topojson.feature(topology, topology.objects.land);
    if (fc.type === "FeatureCollection") return fc;
    return { type: "FeatureCollection", features: [fc] };
  }

  function fetchJson(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
      return response.json();
    });
  }

  function loadLandFeatureCollection() {
    if (landCache) return Promise.resolve(landCache);
    if (landLoadPromise) return landLoadPromise;
    landLoadPromise = fetchJson(LAND_URL_PRIMARY)
      .catch(function (primaryError) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            "[dashboard-journey-map] primary land dataset failed; trying fallback",
            primaryError && primaryError.message ? primaryError.message : primaryError
          );
        }
        return fetchJson(LAND_URL_FALLBACK);
      })
      .then(function (topology) {
        landCache = topologyToFeatureCollection(topology);
        return landCache;
      })
      .catch(function (error) {
        landLoadPromise = null;
        throw error;
      });
    return landLoadPromise;
  }

  function buildLandMarkup(land, projection) {
    if (!land || !projection || !projection.geo || typeof projection.project !== "function") {
      return "";
    }
    var rings = extractLandRingsForBBox(land, projection.geo);
    var html = [];
    for (var i = 0; i < rings.length; i += 1) {
      var d = ringToSvgPath(rings[i], projection.project);
      if (d) html.push('<path class="dashboard-map-land-shape" d="' + d + '" fill-rule="evenodd"/>');
    }
    return html.join("");
  }

  function attachLandLayer(rootEl, projection) {
    if (!rootEl || !projection) return Promise.resolve(false);
    var landGroup = rootEl.querySelector("#dashboardMapLand");
    if (!landGroup) return Promise.resolve(false);

    return loadLandFeatureCollection()
      .then(function (land) {
        var markup = buildLandMarkup(land, projection);
        if (!markup) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[dashboard-journey-map] no land rings intersect viewport");
          }
          return false;
        }
        landGroup.innerHTML = markup;
        landGroup.setAttribute("data-land-loaded", "true");
        return true;
      })
      .catch(function (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            "[dashboard-journey-map] land layer unavailable; route-only map retained",
            error && error.message ? error.message : error
          );
        }
        return false;
      });
  }

  global.DashboardJourneyMapGeo = {
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    DEFAULT_HEIGHT: DEFAULT_HEIGHT,
    LAND_URL_PRIMARY: LAND_URL_PRIMARY,
    LAND_URL_FALLBACK: LAND_URL_FALLBACK,
    projectJourneyMap: projectJourneyMap,
    attachLandLayer: attachLandLayer,
    loadLandFeatureCollection: loadLandFeatureCollection,
    buildLandMarkup: buildLandMarkup,
    unwrapPolylineForDrawing: unwrapPolylineForDrawing,
    expandBoundsForViewport: expandBoundsForViewport,
    collectRoutePoints: collectRoutePoints,
    shortPortLabel: shortPortLabel,
    /** test helper — clears cached topology */
    _resetLandCache: function () {
      landCache = null;
      landLoadPromise = null;
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
