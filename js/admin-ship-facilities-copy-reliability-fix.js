/*
 * Reliability guard for Admin ship facilities class/fleet copy.
 *
 * 1. The responsive target list renders one desktop checkbox and one mobile
 *    checkbox for the same ship. After a re-render both can be checked, so the
 *    request used to contain duplicate ship IDs even though the review plan was
 *    correctly de-duplicated. Normalise the request before it leaves Admin.
 * 2. The legacy result renderer always says "Copy complete", even when the
 *    function rejected the request. Correct that result state and surface the
 *    server error/counts so Admin never reports a failed copy as successful.
 */
(function (global) {
  "use strict";

  const ENDPOINT = "/.netlify/functions/ci-ship-facilities-copy";
  const nativeFetch = global.fetch && global.fetch.bind(global);
  if (!nativeFetch || global.__ciShipFacilitiesCopyReliabilityInstalled) return;
  global.__ciShipFacilitiesCopyReliabilityInstalled = true;

  let lastCopyResponse = null;

  function isCopyRequest(input) {
    const url = typeof input === "string"
      ? input
      : (input && typeof input.url === "string" ? input.url : "");
    return url.includes(ENDPOINT);
  }

  function uniqueShipIds(value) {
    if (!Array.isArray(value)) return value;
    return [...new Set(value.map(function (id) {
      return String(id == null ? "" : id).trim();
    }).filter(Boolean))];
  }

  function normaliseCopyInit(init) {
    if (!init || typeof init.body !== "string") return init;
    try {
      const body = JSON.parse(init.body);
      if (!body || typeof body !== "object") return init;
      const original = Array.isArray(body.target_ship_ids) ? body.target_ship_ids : null;
      if (!original) return init;
      const targetShipIds = uniqueShipIds(original);
      if (targetShipIds.length === original.length) return init;
      return {
        ...init,
        body: JSON.stringify({ ...body, target_ship_ids: targetShipIds })
      };
    } catch (_error) {
      return init;
    }
  }

  function copyFailureMessage(snapshot) {
    const data = snapshot && snapshot.data && typeof snapshot.data === "object"
      ? snapshot.data
      : {};
    const detail = data.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (Array.isArray(detail) && detail.length) return detail.join(", ");
    if (data.error) return String(data.error);
    if (snapshot && snapshot.error) return String(snapshot.error);
    return "The facilities copy did not complete successfully.";
  }

  function copyOutcomeMessage(snapshot) {
    const data = snapshot && snapshot.data && typeof snapshot.data === "object"
      ? snapshot.data
      : {};
    const updated = Number(data.updated_count);
    const failed = Number(data.failed_count);
    if (Number.isFinite(updated) && Number.isFinite(failed)) {
      if (updated === 0) return "No target ships were updated.";
      if (failed > 0) {
        return `${updated} target ship${updated === 1 ? " was" : "s were"} updated, but ${failed} failed.`;
      }
    }
    return "Check the target ships before retrying the copy.";
  }

  function updateResultModal() {
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (!overlay) return;
    const wrap = overlay.querySelector(".ci-item-copy-result-wrap");
    if (!wrap) return;

    const autosave = document.getElementById("ciAutosaveStatus");
    const autosaveFailed = /facilities copy failed/i.test(String(autosave && autosave.textContent || ""));
    const failedCard = Boolean(wrap.querySelector(".ci-item-copy-result-card.is-failed"));
    const responseFailed = Boolean(
      lastCopyResponse &&
      (lastCopyResponse.ok === false || lastCopyResponse.data && lastCopyResponse.data.success === false)
    );
    if (!autosaveFailed && !failedCard && !responseFailed) return;

    const heading = wrap.querySelector("p strong");
    if (heading) heading.textContent = "Copy failed";

    let detail = wrap.querySelector(".ci-facilities-copy-failure-detail");
    if (!detail) {
      detail = document.createElement("div");
      detail.className = "ci-facilities-copy-failure-detail";
      detail.setAttribute("role", "alert");
      const first = wrap.firstElementChild;
      if (first && first.nextSibling) wrap.insertBefore(detail, first.nextSibling);
      else wrap.appendChild(detail);
    }

    const message = copyFailureMessage(lastCopyResponse);
    const outcome = copyOutcomeMessage(lastCopyResponse);
    detail.innerHTML = "";
    const errorLine = document.createElement("p");
    errorLine.className = "admin-small ci-item-copy-result-fail";
    errorLine.textContent = message;
    const outcomeLine = document.createElement("p");
    outcomeLine.className = "admin-small";
    outcomeLine.textContent = outcome;
    detail.appendChild(errorLine);
    detail.appendChild(outcomeLine);
  }

  global.fetch = async function (input, init) {
    if (!isCopyRequest(input)) return nativeFetch(input, init);

    const nextInit = normaliseCopyInit(init);
    try {
      const response = await nativeFetch(input, nextInit);
      const snapshot = {
        ok: response.ok,
        status: response.status,
        data: null,
        error: null
      };
      lastCopyResponse = snapshot;
      response.clone().json().then(function (data) {
        snapshot.data = data || {};
        lastCopyResponse = snapshot;
        global.__ciShipFacilitiesCopyLastResponse = snapshot;
        updateResultModal();
      }).catch(function () {
        updateResultModal();
      });
      global.__ciShipFacilitiesCopyLastResponse = snapshot;
      return response;
    } catch (error) {
      lastCopyResponse = {
        ok: false,
        status: 0,
        data: null,
        error: String(error && error.message || error)
      };
      global.__ciShipFacilitiesCopyLastResponse = lastCopyResponse;
      updateResultModal();
      throw error;
    }
  };

  const observer = new MutationObserver(function () {
    updateResultModal();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})(window);
