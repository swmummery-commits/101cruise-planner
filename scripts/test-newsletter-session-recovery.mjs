#!/usr/bin/env node
/**
 * Newsletter save session recovery: refresh coordination, draft rules,
 * and pricing replacement that does not delete published prices first.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planPricingReplacement } from "../netlify/functions/lib/pricing-replace-plan.js";
import sessionCore from "../js/admin-newsletter-session-core.js";

const {
  accessTokenNeedsRefresh,
  createRefreshGate,
  isSessionFailureMessage,
  nextAutosaveDelay,
  publicationChanged,
  draftHasSaveableContent,
  localDraftIsFresh,
  saveStatusText,
  draftIdentity,
  draftRecordForStorage,
  normalizeDraftStore,
  localDraftConflictsWithDatabase,
  saveGenerationIsStale,
  saveFailureKind,
  AUTOSAVE_DEBOUNCE_MS,
  SESSION_REFRESH_LEAD_MS
} = sessionCore;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminJs = readFileSync(path.join(root, "js/admin.js"), "utf8");
const fnJs = readFileSync(path.join(root, "netlify/functions/featured-cruises-admin.js"), "utf8");
const html = readFileSync(path.join(root, "admin.html"), "utf8");

function assert(label, ok) {
  if (!ok) throw new Error(label);
  console.log("ok:", label);
}

const now = Date.parse("2026-10-08T06:00:00Z");

assert(
  "fresh token is not refreshed early by a competing 60s window",
  accessTokenNeedsRefresh({ access_token: "abc", expires_at: (now + 10 * 60 * 1000) / 1000 }, now) === false
);
assert(
  "token inside the lead window is refreshed by the single keeper",
  accessTokenNeedsRefresh(
    { access_token: "abc", expires_at: (now + SESSION_REFRESH_LEAD_MS - 1000) / 1000 },
    now
  ) === true
);
assert(
  "expired token needs refresh",
  accessTokenNeedsRefresh({ access_token: "abc", expires_at: (now - 5000) / 1000 }, now) === true
);
assert(
  "missing token needs refresh",
  accessTokenNeedsRefresh({ expires_at: (now + 60 * 60 * 1000) / 1000 }, now) === true
);

let calls = 0;
const gate = createRefreshGate(async () => {
  calls += 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return "ok";
});
const raced = await Promise.all([gate(), gate(), gate()]);
assert("concurrent refreshes share one flight", calls === 1 && raced.every((value) => value === "ok"));

assert("session failure copy is recognised", isSessionFailureMessage("Admin session expired. Sign in again."));
assert("ordinary save error is not a session failure", !isSessionFailureMessage("Headline is required before publishing."));

assert("first autosave waits 2.5 seconds", nextAutosaveDelay(0) === AUTOSAVE_DEBOUNCE_MS);
assert("autosave backs off after a failure", nextAutosaveDelay(2) > AUTOSAVE_DEBOUNCE_MS);
assert("autosave backoff stays bounded", nextAutosaveDelay(12) <= 30000);

assert(
  "slug change is not an autosave publication write",
  publicationChanged(
    { public_slug: "old-slug", publication_status: "published", create_public_page: true },
    { public_slug: "new-slug", publication_status: "published", create_public_page: true }
  ) === true
);
assert(
  "unchanged publication is safe to leave on the stored row",
  publicationChanged(
    { public_slug: "old-slug", publication_status: "published", create_public_page: true },
    { public_slug: "old-slug", publication_status: "published", create_public_page: true }
  ) === false
);

assert(
  "empty form is not written as a cruise",
  draftHasSaveableContent({ headline: "  " }, [{ room_label: "" }]) === false
);
assert(
  "a price row is enough to keep",
  draftHasSaveableContent({}, [{ room_label: "Balcony", cruise_101_price: "1299" }]) === true
);
assert("week-old draft can be restored", localDraftIsFresh(now - 2 * 24 * 60 * 60 * 1000, now));
assert("ancient draft is not restored", !localDraftIsFresh(now - 8 * 24 * 60 * 60 * 1000, now));

const preserve = planPricingReplacement({
  existingIds: ["price-1"],
  incomingRows: [],
  preserveExistingIfEmpty: true
});
assert("empty autosave does not delete published prices", preserve.mode === "preserve" && preserve.deleteIds.length === 0);

const replace = planPricingReplacement({
  existingIds: [{ id: "price-1" }, { id: "price-1" }],
  incomingRows: [{ id: "old", room_label: "Balcony", cruise_101_price: 1000 }]
});
assert("replacement inserts the new row", replace.mode === "replace" && replace.insert.length === 1 && replace.insert[0].id == null);
assert("replacement deletes previous ids only after insert", replace.deleteIds.length === 1 && replace.deleteIds[0] === "price-1");

const clear = planPricingReplacement({
  existingIds: ["price-1"],
  incomingRows: [],
  preserveExistingIfEmpty: false
});
assert("explicit empty save can clear prices", clear.mode === "clear" && clear.deleteIds[0] === "price-1");

const replaceFn = fnJs.match(/async function replacePricing[\s\S]*?\nasync function patchCruise/)?.[0] || "";
const insertAt = replaceFn.indexOf("method: \"POST\"");
const deleteAt = replaceFn.indexOf("method: \"DELETE\"");
assert("pricing insert is ordered before pricing delete", insertAt > 0 && deleteAt > insertAt);
assert("autosave can ask to preserve an empty price list", /preserve_existing_if_empty/.test(fnJs));
assert("failed delete rolls back the new price rows", /rollbackFilter/.test(fnJs));

assert("admin no longer refreshes 60 seconds early on every call", !/60_000/.test(adminJs.slice(adminJs.indexOf("function adminAccessTokenNeedsRefresh"), adminJs.indexOf("async function ensureAdminSession"))));
assert("admin refresh is single-flight", /adminSessionRefreshInflight/.test(adminJs));
assert("admin stops the library auto-refresh timer", /stopAutoRefresh/.test(adminJs));
assert("cruise save retries once after 401", /response\.status === 401/.test(adminJs));
assert("quiet autosave keeps publication fields from the stored cruise", /preservePublication/.test(adminJs));
assert("quiet autosave does not close the form", /keepOpen/.test(adminJs));
assert("leaving the page flushes the browser draft", /pagehide/.test(adminJs));
assert("sign-out stays local to this browser", /signOut\(\{ scope: "local" \}\)/.test(adminJs));
assert("session core loads before admin.js", /admin-newsletter-session-core\.js/.test(html) && html.indexOf("admin-newsletter-session-core.js") < html.indexOf("js/admin.js"));

const hour = 60 * 60 * 1000;
const issued = { access_token: "abc", expires_at: (now + hour) / 1000 };
assert("30 minutes idle does not expire a one-hour token", accessTokenNeedsRefresh(issued, now + 30 * 60 * 1000) === false);
assert("60 minutes idle expires a one-hour token", accessTokenNeedsRefresh(issued, now + hour + 1000) === true);
assert("several hours idle expires the token", accessTokenNeedsRefresh(issued, now + 5 * hour) === true);

assert("local backup is not described as a database save", saveStatusText("local") !== "All changes saved");
assert("database confirmation uses All changes saved", saveStatusText("saved") === "All changes saved");
assert("session status asks the editor to sign in", saveStatusText("session") === "Session expired, sign in to continue");
assert("failed save offers retry", saveStatusText("failed") === "Save failed, retry available");

const cruiseA = draftIdentity({ cruiseId: "cruise-a" });
const cruiseB = draftIdentity({ clientKey: "local-b" });
assert("different cruises get different draft keys", cruiseA !== cruiseB);
const stored = normalizeDraftStore({
  drafts: {
    [cruiseA]: { savedAt: now, draft: { headline: "A" }, editingFeaturedCruiseId: "cruise-a" },
    [cruiseB]: { savedAt: now, draft: { headline: "B" }, clientKey: "local-b" }
  }
}, null, now);
assert("one cruise draft does not replace another", stored.drafts[cruiseA].draft.headline === "A" && stored.drafts[cruiseB].draft.headline === "B");

const secret = draftRecordForStorage({ draft: { headline: "A", access_token: "secret" }, refresh_token: "secret" });
assert("draft records do not keep session tokens", secret.refresh_token == null && secret.draft.access_token == null && secret.draft.headline === "A");

assert(
  "an older local draft does not overwrite a newer database row",
  localDraftConflictsWithDatabase(
    { editingFeaturedCruiseId: "cruise-a", baseUpdatedAt: "2026-10-08T01:00:00Z" },
    "2026-10-08T02:00:00Z"
  ) === true
);
assert(
  "the same database version can accept the local draft",
  localDraftConflictsWithDatabase(
    { editingFeaturedCruiseId: "cruise-a", baseUpdatedAt: "2026-10-08T01:00:00Z" },
    "2026-10-08T01:00:00Z"
  ) === false
);
assert("a newer edit makes an in-flight save stale", saveGenerationIsStale(4, 5) === true);
assert("the current edit can still be saved", saveGenerationIsStale(5, 5) === false);
assert("network failures can be retried", saveFailureKind("Failed to fetch", 0) === "network");
assert("authentication failures are not retried as network errors", saveFailureKind("Admin session expired", 401) === "session");
assert("validation failures are not retried forever", saveFailureKind("Headline is required before publishing.", 400) === "validation");
assert("drafts are stored per cruise", /localDrafts\.v2/.test(adminJs));
assert("autosave checks the edit generation", /saveGenerationIsStale/.test(adminJs));
assert("published slug is left unchanged on autosave", /preservePublication/.test(adminJs));

console.log("test-newsletter-session-recovery.mjs: all checks passed");
