/**
 * Newsletter editor session and draft decisions.
 * Loaded before admin.js. Also required by node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NewsletterSessionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const AUTOSAVE_DEBOUNCE_MS = 2500;
  const SESSION_REFRESH_LEAD_MS = 4 * 60 * 1000;
  const LOCAL_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  function decodeJwtPayload(token) {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    try {
      const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
      const json = typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
      return JSON.parse(json);
    } catch (_error) {
      return null;
    }
  }

  function accessTokenExpiryMs(session) {
    const fromField = Number(session?.expires_at || 0);
    const fieldMs = fromField > 0 ? fromField * 1000 : 0;
    const exp = Number(decodeJwtPayload(session?.access_token)?.exp || 0);
    const jwtMs = exp > 0 ? exp * 1000 : 0;
    if (fieldMs && jwtMs) return Math.min(fieldMs, jwtMs);
    return fieldMs || jwtMs || 0;
  }

  function accessTokenNeedsRefresh(session, nowMs, leadMs) {
    const token = session?.access_token || "";
    if (!token) return true;
    const expiry = accessTokenExpiryMs(session);
    if (!expiry) return false;
    const lead = Number.isFinite(Number(leadMs)) ? Number(leadMs) : SESSION_REFRESH_LEAD_MS;
    return expiry <= Number(nowMs) + lead;
  }

  function isPersistedRowId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || "").trim()
    );
  }

  function refreshRaceError(error) {
    const text = String(error?.message || error || "").toLowerCase();
    if (!text) return false;
    return (
      text.includes("already used") ||
      text.includes("invalid refresh token") ||
      text.includes("session missing") ||
      text.includes("refresh_token")
    );
  }

  function shouldRetryProtectedSave(attempt, statusCode) {
    return Number(attempt) === 0 && Number(statusCode) === 401;
  }

  function createRefreshGate(refreshFn) {
    let inflight = null;
    return function refreshOnce() {
      if (!inflight) {
        inflight = Promise.resolve()
          .then(() => refreshFn())
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    };
  }

  function isSessionFailureMessage(message) {
    const text = String(message || "").toLowerCase();
    return (
      text.includes("session expired") ||
      text.includes("session missing") ||
      text.includes("session is invalid") ||
      text.includes("invalid refresh token") ||
      text.includes("refresh token") ||
      text.includes("sign in again") ||
      text.includes("admin authentication is required") ||
      text.includes("jwt expired") ||
      text.includes("invalid jwt")
    );
  }

  function nextAutosaveDelay(failureCount) {
    const n = Math.max(0, Number(failureCount) || 0);
    if (n === 0) return AUTOSAVE_DEBOUNCE_MS;
    return Math.min(30000, AUTOSAVE_DEBOUNCE_MS * 2 ** Math.min(n, 4));
  }

  function publicationChanged(loaded, next) {
    return (
      String(loaded?.public_slug || "") !== String(next?.public_slug || "") ||
      String(loaded?.publication_status || "draft") !== String(next?.publication_status || "draft") ||
      Boolean(loaded?.create_public_page) !== Boolean(next?.create_public_page)
    );
  }

  function shouldWriteCruiseRecord({ cruiseId, headline } = {}) {
    if (cruiseId) return true;
    return Boolean(String(headline || "").trim());
  }

  function draftHasSaveableContent(draft, pricing) {
    const row = draft || {};
    if (String(row.headline || "").trim()) return true;
    if (String(row.departure_port || "").trim()) return true;
    if (String(row.arrival_port || "").trim()) return true;
    if (String(row.short_editorial || "").trim()) return true;
    if (String(row.full_description || "").trim()) return true;
    if (String(row.itinerary_summary || "").trim()) return true;
    if (String(row.other_information || "").trim()) return true;
    return (Array.isArray(pricing) ? pricing : []).some((price) => {
      if (String(price?.room_label || "").trim()) return true;
      if (String(price?.brochure_price || "").trim()) return true;
      if (String(price?.cruise_101_price || "").trim()) return true;
      if (String(price?.airline_price || "").trim()) return true;
      return false;
    });
  }

  function localDraftIsFresh(savedAt, nowMs) {
    const age = Number(nowMs) - Number(savedAt);
    return Number.isFinite(age) && age >= 0 && age <= LOCAL_DRAFT_MAX_AGE_MS;
  }

  const SAVE_STATUS_TEXT = {
    "saving-local": "Saving...",
    local: "Unsaved changes.",
    saving: "Saving...",
    saved: "All changes saved.",
    offline: "Unable to save. Your changes are preserved.",
    session: "Session expired. Sign in to continue.",
    failed: "Unable to save. Your changes are preserved."
  };

  function saveStatusText(state) {
    return SAVE_STATUS_TEXT[state] || "";
  }

  function draftIdentity({ cruiseId, clientKey } = {}) {
    if (cruiseId) return `cruise:${cruiseId}`;
    if (clientKey) return `new:${clientKey}`;
    return "";
  }

  function draftRecordForStorage(record) {
    const copy = { ...(record || {}) };
    delete copy.access_token;
    delete copy.refresh_token;
    delete copy.session;
    delete copy.token;
    if (copy.draft && typeof copy.draft === "object") {
      copy.draft = { ...copy.draft };
      delete copy.draft.access_token;
      delete copy.draft.refresh_token;
      delete copy.draft.session;
      delete copy.draft.token;
    }
    return copy;
  }

  function normalizeDraftStore(parsed, legacy, nowMs) {
    const incoming = parsed && typeof parsed.drafts === "object" && parsed.drafts ? parsed.drafts : {};
    const drafts = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!value?.draft || !localDraftIsFresh(value.savedAt, nowMs)) continue;
      drafts[key] = draftRecordForStorage({ ...value, identity: value.identity || key });
    }
    if (legacy?.draft && localDraftIsFresh(legacy.savedAt, nowMs)) {
      const identity = draftIdentity({
        cruiseId: legacy.editingFeaturedCruiseId,
        clientKey: legacy.clientKey || "legacy"
      });
      if (identity && !drafts[identity]) {
        drafts[identity] = draftRecordForStorage({ ...legacy, identity, clientKey: legacy.clientKey || "legacy" });
      }
    }
    return { drafts };
  }

  function sameDatabaseInstant(left, right) {
    const a = Date.parse(left);
    const b = Date.parse(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
    return String(left) === String(right);
  }

  function localDraftConflictsWithDatabase(draft, serverUpdatedAt) {
    if (!draft?.editingFeaturedCruiseId || !draft.baseUpdatedAt || !serverUpdatedAt) return false;
    return !sameDatabaseInstant(draft.baseUpdatedAt, serverUpdatedAt);
  }

  function serverUpdatedAtIsOwnWrite(baseUpdatedAt, ownUpdatedAt, serverUpdatedAt) {
    if (!serverUpdatedAt) return false;
    if (ownUpdatedAt && sameDatabaseInstant(ownUpdatedAt, serverUpdatedAt)) return true;
    if (baseUpdatedAt && sameDatabaseInstant(baseUpdatedAt, serverUpdatedAt)) return true;
    return false;
  }

  function userMessageForSaveFailure(kind) {
    if (kind === "session") return SAVE_STATUS_TEXT.session;
    if (kind === "network") return SAVE_STATUS_TEXT.offline;
    if (kind === "validation") return "";
    return SAVE_STATUS_TEXT.failed;
  }

  function saveGenerationIsStale(startedGeneration, currentGeneration) {
    return Number(startedGeneration) !== Number(currentGeneration);
  }

  function saveFailureKind(message, statusCode) {
    const status = Number(statusCode) || 0;
    if (status === 401 || status === 403 || isSessionFailureMessage(message)) return "session";
    const text = String(message || "").toLowerCase();
    if (
      status === 0 ||
      status >= 500 ||
      text.includes("failed to fetch") ||
      text.includes("network") ||
      text.includes("offline") ||
      text.includes("timeout") ||
      text.includes("load failed")
    ) {
      return "network";
    }
    if (
      text.includes("headline is required") ||
      text.includes("nights must") ||
      text.includes("slug") ||
      text.includes("validation") ||
      text.includes("room type is required")
    ) {
      return "validation";
    }
    return "permanent";
  }

  return {
    AUTOSAVE_DEBOUNCE_MS,
    SESSION_REFRESH_LEAD_MS,
    LOCAL_DRAFT_MAX_AGE_MS,
    SAVE_STATUS_TEXT,
    DRAFT_STORE_KEY: "101cruise.featuredCruise.localDrafts.v2",
    LEGACY_DRAFT_KEY: "101cruise.featuredCruise.localDraft.v1",
    RESUME_KEY: "101cruise.featuredCruise.resume.v1",
    accessTokenNeedsRefresh,
    accessTokenExpiryMs,
    isPersistedRowId,
    refreshRaceError,
    shouldRetryProtectedSave,
    createRefreshGate,
    isSessionFailureMessage,
    nextAutosaveDelay,
    publicationChanged,
    shouldWriteCruiseRecord,
    draftHasSaveableContent,
    localDraftIsFresh,
    saveStatusText,
    draftIdentity,
    draftRecordForStorage,
    normalizeDraftStore,
    localDraftConflictsWithDatabase,
    serverUpdatedAtIsOwnWrite,
    sameDatabaseInstant,
    userMessageForSaveFailure,
    saveGenerationIsStale,
    saveFailureKind
  };
});
