/**
 * Provider registry for Engine V2.
 */

const { VacationstogoProvider } = require("./vacationstogo-provider");
const { FixtureProvider } = require("./fixture-provider");
const { TrackCruisesProvider } = require("./track-cruises-provider");

function createDefaultRegistry() {
  const map = new Map();
  // Track.cruises is registered for POC wiring only — Engine V2 customer path stays inactive.
  const providers = [
    new VacationstogoProvider(),
    new FixtureProvider(),
    new TrackCruisesProvider()
  ];
  for (const p of providers) map.set(p.id, p);
  return map;
}

function getProvider(id, registry = createDefaultRegistry()) {
  return registry.get(String(id || "").toLowerCase()) || null;
}

module.exports = {
  createDefaultRegistry,
  getProvider
};
