/**
 * Offline + live read-only checks for booking 10175811 port resolution.
 * Run: node scripts/test-ports-booking-10175811.mjs
 * Does not approve itineraries or write to cruise_itineraries.
 */

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  buildPortIndex,
  diagnosePortMatch,
  foldPortKey
} = require("../netlify/functions/lib/customer-port-match.js");
const {
  buildJourneyFromItinerary,
  projectJourneyMap
} = require("../netlify/functions/lib/dashboard-journey.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadEnv() {
  const env = {};
  const text = fs.readFileSync(path.join(root, ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

async function rest(env, p) {
  const url = env.SUPABASE_URL.replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${url}/rest/v1/${p}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 300));
  return data;
}

/* Offline deterministic matching against a fixture catalogue */
const fixturePorts = [
  {
    id: "lg",
    canonical_name: "La Goulette",
    display_name: "La Goulette, Tunisia",
    city: "La Goulette",
    aliases: ["Tunis/La Goulette", "Tunis (La Goulette)"],
    latitude: 36.8083788,
    longitude: 10.3088217
  },
  {
    id: "vl",
    canonical_name: "Valletta",
    display_name: "Valletta, Malta",
    city: "Valletta",
    aliases: ["La Valletta"],
    latitude: 35.89,
    longitude: 14.508
  },
  {
    id: "gn",
    canonical_name: "Giardini Naxos",
    display_name: "Giardini Naxos, Italy",
    city: "Giardini Naxos",
    aliases: ["Giardini-Naxos"],
    latitude: 37.8239,
    longitude: 15.2719
  },
  {
    id: "so",
    canonical_name: "Sorrento",
    display_name: "Sorrento, Italy",
    city: "Sorrento",
    aliases: [],
    latitude: 40.6299,
    longitude: 14.3768
  },
  {
    id: "np",
    canonical_name: "Naples",
    display_name: "Naples, Italy",
    city: "Naples",
    aliases: ["Napoli"],
    latitude: 40.836,
    longitude: 14.257
  },
  {
    id: "ms",
    canonical_name: "Messina",
    display_name: "Messina, Sicily",
    city: "Messina",
    aliases: ["Sicily", "Taormina"],
    latitude: 38.1938,
    longitude: 15.556
  },
  {
    id: "ct",
    canonical_name: "Catania",
    display_name: "Catania, Sicily",
    city: "Catania",
    aliases: ["Sicily", "Mount Etna"],
    latitude: 37.4996,
    longitude: 15.0893
  }
];

const { portsByKey, metaByKey } = buildPortIndex(fixturePorts);

const tunis = diagnosePortMatch("Tunis/La Goulette", portsByKey, metaByKey);
assert(tunis.status === "matched" && tunis.meta.canonical_name === "La Goulette", "Tunis/La Goulette → La Goulette only");
assert(tunis.meta.id === "lg", "Tunis/La Goulette must not resolve elsewhere");

const valletta = diagnosePortMatch("La Valletta", portsByKey, metaByKey);
assert(valletta.status === "matched" && valletta.meta.canonical_name === "Valletta", "La Valletta → Valletta");

const gn = diagnosePortMatch("Giardini Naxos", portsByKey, metaByKey);
assert(gn.status === "matched" && gn.meta.canonical_name === "Giardini Naxos", "Giardini Naxos → itself");
assert(gn.meta.canonical_name !== "Messina" && gn.meta.canonical_name !== "Catania", "Giardini Naxos not Messina/Catania");

const sorrento = diagnosePortMatch("Sorrento", portsByKey, metaByKey);
assert(sorrento.status === "matched" && sorrento.meta.canonical_name === "Sorrento", "Sorrento → itself");
assert(sorrento.meta.canonical_name !== "Naples", "Sorrento does not resolve to Naples");

/* Duplicate alias rejection: first owner wins; second identical folded alias does not steal */
assert(metaByKey.get(foldPortKey("Sicily"))?.canonical_name === "Messina", "duplicate Sicily alias stays deterministic");

const env = loadEnv();
assert(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY, "Supabase env required for live checks");
assert(!/vkheexbapykcdfbqcach/i.test(env.SUPABASE_URL), "DEV project must remain untouched");

const livePorts = await rest(
  env,
  "ports?select=id,canonical_name,display_name,city,country,aliases,latitude,longitude&latitude=not.is.null&longitude=not.is.null&limit=5000"
);
const liveIndex = buildPortIndex(livePorts);

const liveChecks = [
  ["Tunis/La Goulette", "La Goulette"],
  ["Tunis (La Goulette)", "La Goulette"],
  ["La Valletta", "Valletta"],
  ["Giardini Naxos", "Giardini Naxos"],
  ["Giardini-Naxos", "Giardini Naxos"],
  ["Sorrento", "Sorrento"]
];
for (const [entered, expected] of liveChecks) {
  const d = diagnosePortMatch(entered, liveIndex.portsByKey, liveIndex.metaByKey);
  assert(d.status === "matched", `${entered} should match`);
  assert(d.meta.canonical_name === expected, `${entered} → ${expected}, got ${d.meta?.canonical_name}`);
}

const sorrentoLive = diagnosePortMatch("Sorrento", liveIndex.portsByKey, liveIndex.metaByKey);
assert(sorrentoLive.meta.canonical_name !== "Naples", "live Sorrento ≠ Naples");
const gnLive = diagnosePortMatch("Giardini Naxos", liveIndex.portsByKey, liveIndex.metaByKey);
assert(!["Messina", "Catania"].includes(gnLive.meta.canonical_name), "live Giardini Naxos ≠ Messina/Catania");

const itineraryRows = await rest(
  env,
  "cruise_itineraries?booking_reference=eq.10175811&select=status,itinerary_data&limit=1"
);
assert(itineraryRows?.[0], "itinerary row exists");
assert(String(itineraryRows[0].status) === "review_required", "itinerary remains review_required");

const stops = itineraryRows[0].itinerary_data?.stops || [];
assert(stops.length === 8, "eight itinerary stops");

const enriched = stops.map((stop) => {
  const d = diagnosePortMatch(stop.name, liveIndex.portsByKey, liveIndex.metaByKey);
  assert(d.status === "matched", `stop unresolved: ${stop.name}`);
  return { ...stop, lat: d.hit.lat, lng: d.hit.lng, _canonical: d.meta.canonical_name };
});

const built = buildJourneyFromItinerary(
  { ...itineraryRows[0].itinerary_data, stops: enriched },
  { source: "test" }
);
assert(built.journey?.can_draw_map === true, "can_draw_map true");
const projection = projectJourneyMap(built.journey);
assert(projection.ok === true, "projection ok");
assert(projection.ports.length === 7, `seven unique plotted ports, got ${projection.ports.length}`);

const names = projection.ports.map((p) => p.name);
assert(names[0].includes("Barcelona"), "route starts Barcelona");
assert(names.some((n) => /ibiza/i.test(n)), "includes Ibiza once after collapse");
assert(names.filter((n) => /ibiza/i.test(n)).length === 1, "Ibiza overnight collapses");
assert(names.some((n) => /goulette|tunis/i.test(n)), "includes La Goulette");
assert(names.some((n) => /valletta/i.test(n)), "includes Valletta");
assert(names.some((n) => /giardini/i.test(n)), "includes Giardini Naxos");
assert(names.some((n) => /sorrento/i.test(n)), "includes Sorrento");
assert(names.some((n) => /civitavecchia|rome/i.test(n)), "includes Civitavecchia");

console.log("test-ports-booking-10175811: ok");
console.log(
  JSON.stringify(
    {
      itinerary_status: itineraryRows[0].status,
      unique_plotted_ports: projection.ports.length,
      plotted: projection.ports.map((p) => ({ name: p.name, lat: p.lat, lng: p.lng })),
      resolved_stops: enriched.map((s) => ({ date: s.date, extracted: s.name, canonical: s._canonical }))
    },
    null,
    2
  )
);
