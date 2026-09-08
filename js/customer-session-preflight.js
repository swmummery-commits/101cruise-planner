(function () {
  "use strict";

  const CUSTOMER_SESSION_STORAGE_KEY = "101cruise_customer_session";
  const CUSTOMER_SESSION_VERSION = 2;
  const LEGACY_SUPABASE_AUTH_PREFIX = "sb-xikbibxyinttllxamgao-auth-token";
  const RECOVERY_KEY = "101cruise_customer_recovery_v2";

  function removeFromBoth(key) {
    try { localStorage.removeItem(key); } catch (_e) { /* ignore */ }
    try { sessionStorage.removeItem(key); } catch (_e) { /* ignore */ }
  }

  function decodeTokenPayload(token) {
    try {
      const encoded = String(token || "").split(".")[0];
      if (!encoded) return null;
      const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encoded.length + 3) % 4);
      return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(padded), function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join("")));
    } catch (_e) {
      return null;
    }
  }

  function storedSessionFrom(storage) {
    try {
      const raw = storage.getItem(CUSTOMER_SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) {
      return null;
    }
  }

  function sessionIsCurrent(session) {
    if (!session || !session.token || !session.booking) return false;
    if (!session.booking.booking_reference && !session.booking.base44_booking_id) return false;
    const payload = decodeTokenPayload(session.token);
    if (!payload) return false;
    if (payload.v !== CUSTOMER_SESSION_VERSION) return false;
    if (!Number.isFinite(Number(payload.exp)) || Date.now() >= Number(payload.exp)) return false;
    return Boolean(payload.booking_id || payload.booking_reference);
  }

  function clearLegacySupabaseAuth() {
    [localStorage, sessionStorage].forEach(function (storage) {
      try {
        const keys = [];
        for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
        keys.filter(Boolean).forEach(function (key) {
          if (key.indexOf(LEGACY_SUPABASE_AUTH_PREFIX) === 0) storage.removeItem(key);
        });
      } catch (_e) {
        /* ignore */
      }
    });
  }

  function validateStoredSession() {
    const localSession = storedSessionFrom(localStorage);
    const tabSession = storedSessionFrom(sessionStorage);

    if (localSession && !sessionIsCurrent(localSession)) {
      try { localStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY); } catch (_e) { /* ignore */ }
    }
    if (tabSession && !sessionIsCurrent(tabSession)) {
      try { sessionStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY); } catch (_e) { /* ignore */ }
    }
  }

  function polishAccessCopy() {
    const surnameLabel = document.querySelector('label[for="customerSurname"]');
    if (surnameLabel && surnameLabel.textContent !== "Traveller surname") {
      surnameLabel.textContent = "Traveller surname";
    }

    const accessPage = document.querySelector(".customer-access-page");
    const copy = accessPage && accessPage.querySelector(".planner-muted");
    if (copy && /lead traveller/i.test(copy.textContent || "")) {
      copy.textContent = "Access your personalised cruise planner using your booking number and a traveller’s surname.";
    }
  }

  function recoverImpossibleEmptyDashboard() {
    const emptyHero = document.querySelector(".dashboard-empty-hero");
    if (!emptyHero || !/add your cruise to activate your personal dashboard/i.test(emptyHero.textContent || "")) return false;

    let alreadyRecovered = false;
    try { alreadyRecovered = sessionStorage.getItem(RECOVERY_KEY) === "1"; } catch (_e) { /* ignore */ }
    if (alreadyRecovered) return false;

    try { sessionStorage.setItem(RECOVERY_KEY, "1"); } catch (_e) { /* ignore */ }
    removeFromBoth(CUSTOMER_SESSION_STORAGE_KEY);
    clearLegacySupabaseAuth();

    if (typeof window.changeCustomerBooking === "function") {
      window.changeCustomerBooking();
      return true;
    }

    window.location.reload();
    return true;
  }

  // The customer portal no longer uses Supabase email/password accounts.
  // Remove that retired authentication state before planner.js can restore it.
  clearLegacySupabaseAuth();
  validateStoredSession();

  function inspect() {
    polishAccessCopy();
    recoverImpossibleEmptyDashboard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inspect, { once: true });
  } else {
    inspect();
  }

  const observer = new MutationObserver(inspect);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
