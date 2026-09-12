import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../js/ship-spotlight-email.js", import.meta.url), "utf8");
const context = {
  console,
  Intl,
  URL,
  encodeURIComponent,
  globalThis: null
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ship-spotlight-email.js" });

const api = context.ShipSpotlightEmail;
assert.ok(api, "ShipSpotlightEmail should be exported to globalThis");

const ship = {
  name: "Sun Princess",
  slug: "sun-princess",
  year_built: 2024,
  passenger_capacity: 4300,
  crew_count: 1600,
  gross_tonnage: 177882,
  length_metres: 345,
  deck_count: 21,
  hero_image_url: "https://images.example.test/sun-princess.jpg",
  ci_cruise_lines: { name: "Princess Cruises" }
};

const spotlight = {
  eyebrow: "SHIP OF THE WEEK",
  newsletter_heading: "Sun Princess",
  editorial_intro: "A new-generation Princess ship with big open spaces and contemporary venues.",
  highlights: ["The Dome", "Park19", "Multi-storey Piazza"],
  stat_keys: [...api.DEFAULT_STAT_KEYS],
  hero_image_url: ship.hero_image_url,
  public_slug: ship.slug
};

const rendered = api.renderFragment(spotlight, ship);
assert.equal(rendered.ok, true, rendered.errors?.join(" "));
assert.match(rendered.html, /SHIP OF THE WEEK/);
assert.match(rendered.html, /177,882 GT/);
assert.match(rendered.html, /4,300/);
assert.match(rendered.html, /EXPLORE SUN PRINCESS/);
assert.match(rendered.html, /https:\/\/www\.101cruise\.com\.au\/ship\?slug=sun-princess/);
assert.doesNotMatch(rendered.html, /<!doctype|<html|<head|<body|<script/i);
assert.deepEqual(api.assertFragmentSafe(rendered.html), []);

const zeroPlaceholderShip = { ...ship, gross_tonnage: 0 };
const zeroRendered = api.renderFragment(spotlight, zeroPlaceholderShip);
assert.equal(zeroRendered.ok, true);
assert.doesNotMatch(zeroRendered.html, /0 GT/);

const missingHero = api.renderFragment(
  { ...spotlight, hero_image_url: "" },
  { ...ship, hero_image_url: "" }
);
assert.equal(missingHero.ok, false);
assert.ok(missingHero.errors.some((message) => /hero image/i.test(message)));

const unsafeHero = api.renderFragment(
  { ...spotlight, hero_image_url: "/relative-image.jpg" },
  ship
);
assert.equal(unsafeHero.ok, false);
assert.ok(missingHero.errors.length > 0);

console.log("Ship Spotlight email renderer tests passed.");
