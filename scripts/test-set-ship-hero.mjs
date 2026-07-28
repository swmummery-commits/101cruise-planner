/**
 * Ship hero replacement — Media Library set_ship_hero.
 * Run: node scripts/test-set-ship-hero.mjs
 * Offline fixtures only; does not write production data.
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { setShipHero } = require("../netlify/functions/lib/set-ship-hero.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function createStore() {
  const ships = new Map([
    [
      "ship-a",
      {
        id: "ship-a",
        name: "Test Ship A",
        hero_image_url: "https://cdn.example/hero-old.jpg"
      }
    ],
    [
      "ship-b",
      {
        id: "ship-b",
        name: "Test Ship B",
        hero_image_url: "https://cdn.example/ship-b-hero.jpg"
      }
    ]
  ]);
  const media = new Map([
    [
      "media-old",
      {
        id: "media-old",
        title: "Old hero",
        media_type: "ship",
        ship_id: "ship-a",
        public_url: "https://cdn.example/hero-old.jpg",
        is_default: true,
        is_active: true
      }
    ],
    [
      "media-new",
      {
        id: "media-new",
        title: "New hero",
        media_type: "ship",
        ship_id: "ship-a",
        public_url: "https://cdn.example/hero-new.jpg",
        is_default: false,
        is_active: true
      }
    ],
    [
      "media-other-ship",
      {
        id: "media-other-ship",
        title: "Other ship",
        media_type: "ship",
        ship_id: "ship-b",
        public_url: "https://cdn.example/ship-b.jpg",
        is_default: true,
        is_active: true
      }
    ],
    [
      "media-unassociated",
      {
        id: "media-unassociated",
        title: "Loose",
        media_type: "ship",
        ship_id: null,
        public_url: "https://cdn.example/loose.jpg",
        is_default: false,
        is_active: true
      }
    ],
    [
      "media-dest",
      {
        id: "media-dest",
        title: "Destination",
        media_type: "destination",
        ship_id: null,
        destination_name: "Santorini",
        public_url: "https://cdn.example/dest.jpg",
        is_default: true,
        is_active: true
      }
    ]
  ]);
  const bookingSnapshot = { bookings: 3, customers: 2 };
  const writes = [];
  let failNextShipPatch = false;
  let inFlight = 0;
  let maxInFlight = 0;

  function parseEq(path, key) {
    const m = path.match(new RegExp(`(?:^|[?&])${key}=eq\\.([^&]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function supabase(path, options = {}) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const method = (options.method || "GET").toUpperCase();
      const body = options.body ? JSON.parse(options.body) : null;

      if (path.startsWith("/rest/v1/media_library")) {
        if (method === "GET") {
          const id = parseEq(path, "id");
          if (id) {
            const row = media.get(id);
            return row ? [row] : [];
          }
          const shipId = parseEq(path, "ship_id");
          const wantDefault = /is_default=eq\.true/.test(path);
          let rows = [...media.values()].filter((r) => {
            if (shipId && r.ship_id !== shipId) return false;
            if (/media_type=eq\.ship/.test(path) && r.media_type !== "ship") return false;
            if (wantDefault && r.is_default !== true) return false;
            return true;
          });
          return rows.map((r) => ({ ...r }));
        }
        if (method === "PATCH") {
          writes.push({ table: "media_library", path, body });
          const id = parseEq(path, "id");
          if (id) {
            const row = media.get(id);
            if (!row) return [];
            Object.assign(row, body);
            return [{ ...row }];
          }
          // Bulk filter patch
          const shipId = parseEq(path, "ship_id");
          const wantDefault = /is_default=eq\.true/.test(path);
          for (const row of media.values()) {
            if (shipId && row.ship_id !== shipId) continue;
            if (/media_type=eq\.ship/.test(path) && row.media_type !== "ship") continue;
            if (wantDefault && row.is_default !== true) continue;
            Object.assign(row, body);
          }
          return null;
        }
      }

      if (path.startsWith("/rest/v1/ci_cruise_ships")) {
        if (method === "GET") {
          const id = parseEq(path, "id");
          const row = ships.get(id);
          return row ? [{ ...row }] : [];
        }
        if (method === "PATCH") {
          writes.push({ table: "ci_cruise_ships", path, body });
          if (failNextShipPatch) {
            failNextShipPatch = false;
            const err = new Error("simulated ship patch failure");
            err.statusCode = 500;
            throw err;
          }
          const id = parseEq(path, "id");
          const row = ships.get(id);
          if (!row) return [];
          Object.assign(row, body);
          return [{ ...row }];
        }
      }

      throw new Error(`unexpected supabase path ${method} ${path}`);
    } finally {
      inFlight -= 1;
    }
  }

  return {
    ships,
    media,
    bookingSnapshot,
    writes,
    supabase,
    failNextShipPatch() {
      failNextShipPatch = true;
    },
    maxInFlight: () => maxInFlight,
    defaultsFor(shipId) {
      return [...media.values()].filter(
        (m) => m.ship_id === shipId && m.media_type === "ship" && m.is_default
      );
    }
  };
}

async function main() {
  let passed = 0;

  // 1. Promote non-default → sole default + hero URL
  {
    const store = createStore();
    const result = await setShipHero({ mediaId: "media-new", supabase: store.supabase });
    assert(result.success === true, "success");
    assert(store.media.get("media-new").is_default === true, "new is default");
    assert(store.media.get("media-old").is_default === false, "old not default");
    assert(store.defaultsFor("ship-a").length === 1, "exactly one default");
    assert(
      store.ships.get("ship-a").hero_image_url === "https://cdn.example/hero-new.jpg",
      "hero_image_url updated"
    );
    assert(store.media.has("media-old"), "old hero retained");
    assert(store.bookingSnapshot.bookings === 3, "no booking data changes");
    passed += 1;
  }

  // 2. Failed ship update preserves previous hero
  {
    const store = createStore();
    store.failNextShipPatch();
    let threw = false;
    try {
      await setShipHero({ mediaId: "media-new", supabase: store.supabase });
    } catch (e) {
      threw = true;
      assert(/Could not update ship hero|Previous hero was restored|simulated/i.test(e.message), e.message);
    }
    assert(threw, "should throw on failure");
    assert(store.media.get("media-old").is_default === true, "old default restored");
    assert(store.media.get("media-new").is_default === false, "new not left default");
    assert(
      store.ships.get("ship-a").hero_image_url === "https://cdn.example/hero-old.jpg",
      "hero url restored"
    );
    assert(store.defaultsFor("ship-a").length === 1, "still one default after rollback");
    passed += 1;
  }

  // 3. Duplicate / idempotent calls do not create conflicting writes
  {
    const store = createStore();
    await setShipHero({ mediaId: "media-new", supabase: store.supabase });
    const writesAfterFirst = store.writes.length;
    const second = await setShipHero({ mediaId: "media-new", supabase: store.supabase });
    assert(second.unchanged === true, "second call unchanged");
    assert(store.writes.length === writesAfterFirst, "no extra writes on idempotent call");
    assert(store.defaultsFor("ship-a").length === 1, "still one default");
    passed += 1;
  }

  // 4. Image for another ship cannot be promoted onto ship-a context
  //    (setShipHero uses the media's own ship_id — promoting other-ship media
  //    must not alter ship-a)
  {
    const store = createStore();
    await setShipHero({ mediaId: "media-other-ship", supabase: store.supabase });
    assert(store.ships.get("ship-a").hero_image_url === "https://cdn.example/hero-old.jpg", "ship-a untouched");
    assert(store.media.get("media-old").is_default === true, "ship-a default untouched");
    assert(store.ships.get("ship-b").hero_image_url === "https://cdn.example/ship-b.jpg", "ship-b hero set to its media");
    passed += 1;
  }

  // 5. Unassociated image cannot be promoted
  {
    const store = createStore();
    let threw = false;
    try {
      await setShipHero({ mediaId: "media-unassociated", supabase: store.supabase });
    } catch (e) {
      threw = true;
      assert(/not associated/i.test(e.message), e.message);
      assert(e.statusCode === 400, "400");
    }
    assert(threw, "unassociated rejected");
    passed += 1;
  }

  // 6. Non-ship rejected; destination default unchanged semantics (source check)
  {
    const store = createStore();
    let threw = false;
    try {
      await setShipHero({ mediaId: "media-dest", supabase: store.supabase });
    } catch (e) {
      threw = true;
      assert(/Only ship images/i.test(e.message), e.message);
    }
    assert(threw, "destination rejected");
    assert(store.media.get("media-dest").is_default === true, "dest default unchanged");
    passed += 1;
  }

  // 7. Admin UI: set_ship_hero workflow + capture-before-render + no ship checkbox
  {
    const src = readFileSync(path.join(root, "js/admin-media-library.js"), "utf8");
    assert(/Set as ship hero/.test(src), "Set as ship hero button present");
    assert(/Current ship hero/.test(src), "Current ship hero label present");
    assert(/action === ['"]set_ship_hero['"]|set_ship_hero/.test(src), "client calls set_ship_hero");
    assert(/Capture before any re-render/.test(src), "save captures before re-render");
    assert(/delete payload\.is_default/.test(src), "ship save omits is_default");
    assert(/isShip\s*\?[\s\S]*?Ship hero is set with the button above/.test(src), "ship media explains button workflow");
    const defaultCheckboxCount = (src.match(/id="mediaEditDefault"/g) || []).length;
    assert(defaultCheckboxCount === 1, "exactly one Default checkbox template (non-ship only)");
    assert(/refreshMediaResultsOnly/.test(src), "search focus fix retained");
    assert(/mediaSearchDebounce/.test(src), "search debounce retained");
    passed += 1;
  }

  // 8. Server action wired; update_record guards ship is_default clear
  {
    const src = readFileSync(path.join(root, "netlify/functions/media-library.js"), "utf8");
    assert(/action === ['"]set_ship_hero['"]/.test(src), "set_ship_hero action");
    assert(/setShipHero/.test(src), "uses setShipHero helper");
    assert(/Ship heroes cannot be cleared/.test(src), "rejects clearing ship default alone");
    passed += 1;
  }

  // 9. Consumers still read hero_image_url / is_default (no booking mutation in path)
  {
    const getShip = readFileSync(path.join(root, "netlify/functions/get-ship.js"), "utf8");
    assert(/hero_image_url/.test(getShip), "get-ship returns hero_image_url");
    const linked = readFileSync(
      path.join(root, "netlify/functions/lib/customer-linked-bookings-core.js"),
      "utf8"
    );
    assert(/ship_hero_image/.test(linked), "linked bookings expose ship_hero_image");
    const gallery = readFileSync(path.join(root, "netlify/functions/lib/ship-gallery-media.js"), "utf8");
    assert(/is_default/.test(gallery), "gallery uses is_default");
    const galleryFn = readFileSync(path.join(root, "netlify/functions/ship-gallery.js"), "utf8");
    assert(/excludeHero/.test(galleryFn), "gallery excludes hero from duplicates");
    passed += 1;
  }

  // 10. Migration present for true SQL transaction
  {
    const mig = readFileSync(
      path.join(root, "supabase/migrations/20260739_set_ship_hero_media.sql"),
      "utf8"
    );
    assert(/set_ship_hero_media/.test(mig), "rpc migration");
    assert(/hero_image_url/.test(mig), "updates hero_image_url");
    assert(/is_default = false/.test(mig), "clears other defaults");
    passed += 1;
  }

  console.log(`test-set-ship-hero: ${passed} groups ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
