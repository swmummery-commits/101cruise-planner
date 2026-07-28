/**
 * AU date inputs: replace native type=date segment tabbing with DD / MM / YYYY
 * fields that auto-advance when each part is complete.
 *
 * Keeps the original <input type="date"> in sync (ISO yyyy-mm-dd) and fires
 * input/change so existing handlers continue to work.
 */
(function (global) {
  "use strict";

  const ENHANCED = "data-au-date-enhanced";
  const WRAP_ATTR = "data-au-date-wrap";

  function digitsOnly(value) {
    return String(value || "").replace(/\D+/g, "");
  }

  function pad2(value) {
    const d = digitsOnly(value);
    if (!d) return "";
    return d.length === 1 ? d : d.slice(0, 2);
  }

  function parseIso(value) {
    const m = String(value || "")
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { y: m[1], m: m[2], d: m[3] };
  }

  function toIso(day, month, year) {
    const d = digitsOnly(day);
    const m = digitsOnly(month);
    const y = digitsOnly(year);
    if (d.length < 1 || m.length < 1 || y.length !== 4) return "";
    const dd = Number(d);
    const mm = Number(m);
    const yy = Number(y);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) return "";
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yy < 1000) return "";
    const dt = new Date(yy, mm - 1, dd);
    if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) {
      return "";
    }
    return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  function parseLooseDate(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const iso = parseIso(raw);
    if (iso) return iso;
    const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (dmy) {
      return {
        d: String(dmy[1]).padStart(2, "0"),
        m: String(dmy[2]).padStart(2, "0"),
        y: dmy[3]
      };
    }
    const digits = digitsOnly(raw);
    if (digits.length === 8) {
      // Prefer DMY for AU when ambiguous (ddmmyyyy)
      return {
        d: digits.slice(0, 2),
        m: digits.slice(2, 4),
        y: digits.slice(4, 8)
      };
    }
    return null;
  }

  function fillParts(dayEl, monthEl, yearEl, parts) {
    if (!parts) return;
    dayEl.value = parts.d || "";
    monthEl.value = parts.m || "";
    yearEl.value = parts.y || "";
  }

  function enhance(native) {
    if (!(native instanceof HTMLInputElement)) return null;
    if (native.type !== "date") return null;
    if (native.getAttribute(ENHANCED) === "1") return native.closest(`[${WRAP_ATTR}]`);
    if (native.readOnly || native.disabled) return null;

    native.setAttribute(ENHANCED, "1");
    native.classList.add("au-date-native");

    const wrap = document.createElement("div");
    wrap.className = "au-date-input";
    wrap.setAttribute(WRAP_ATTR, "1");
    if (native.id) wrap.setAttribute("data-for", native.id);

    const dayEl = document.createElement("input");
    dayEl.type = "text";
    dayEl.inputMode = "numeric";
    dayEl.autocomplete = "off";
    dayEl.maxLength = 2;
    dayEl.placeholder = "DD";
    dayEl.className = "au-date-part au-date-day";
    dayEl.setAttribute("aria-label", "Day");
    dayEl.dataset.auPart = "d";

    const monthEl = document.createElement("input");
    monthEl.type = "text";
    monthEl.inputMode = "numeric";
    monthEl.autocomplete = "off";
    monthEl.maxLength = 2;
    monthEl.placeholder = "MM";
    monthEl.className = "au-date-part au-date-month";
    monthEl.setAttribute("aria-label", "Month");
    monthEl.dataset.auPart = "m";

    const yearEl = document.createElement("input");
    yearEl.type = "text";
    yearEl.inputMode = "numeric";
    yearEl.autocomplete = "off";
    yearEl.maxLength = 4;
    yearEl.placeholder = "YYYY";
    yearEl.className = "au-date-part au-date-year";
    yearEl.setAttribute("aria-label", "Year");
    yearEl.dataset.auPart = "y";

    const slash1 = document.createElement("span");
    slash1.className = "au-date-sep";
    slash1.textContent = "/";
    slash1.setAttribute("aria-hidden", "true");
    const slash2 = document.createElement("span");
    slash2.className = "au-date-sep";
    slash2.textContent = "/";
    slash2.setAttribute("aria-hidden", "true");

    wrap.append(dayEl, slash1, monthEl, slash2, yearEl);

    const parent = native.parentNode;
    if (!parent) return null;
    parent.insertBefore(wrap, native);
    // Keep native in DOM for form ids / handlers; visually hide.
    native.tabIndex = -1;
    native.setAttribute("aria-hidden", "true");

    const initial = parseIso(native.value);
    if (initial) fillParts(dayEl, monthEl, yearEl, initial);

    const parts = [dayEl, monthEl, yearEl];
    let syncingFromParts = false;

    function focusPart(el) {
      el.focus();
      el.select();
    }

    function onPartInput(el, next) {
      const part = el.dataset.auPart;
      let value = digitsOnly(el.value);
      if (part === "y") value = value.slice(0, 4);
      else value = value.slice(0, 2);
      el.value = value;

      const complete =
        (part === "d" && value.length === 2) ||
        (part === "m" && value.length === 2) ||
        (part === "y" && value.length === 4) ||
        (part === "d" && value.length === 1 && Number(value) > 3) ||
        (part === "m" && value.length === 1 && Number(value) > 1);

      if (complete && next) {
        focusPart(next);
      }
      syncFromParts(
        Boolean(toIso(dayEl.value, monthEl.value, yearEl.value)) ||
          !digitsOnly(dayEl.value + monthEl.value + yearEl.value)
      );
    }

    function writeNativeValue(next, fireChange) {
      syncingFromParts = true;
      try {
        if (native.value !== next) {
          native.value = next;
          native.dispatchEvent(new Event("input", { bubbles: true }));
          if (fireChange) native.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (fireChange && next) {
          native.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } finally {
        syncingFromParts = false;
      }
      return next;
    }

    function syncFromParts(fireChange) {
      const iso = toIso(dayEl.value, monthEl.value, yearEl.value);
      const blank =
        !digitsOnly(dayEl.value) && !digitsOnly(monthEl.value) && !digitsOnly(yearEl.value);
      return writeNativeValue(blank ? "" : iso, fireChange);
    }

    dayEl.addEventListener("input", () => onPartInput(dayEl, monthEl));
    monthEl.addEventListener("input", () => onPartInput(monthEl, yearEl));
    yearEl.addEventListener("input", () => onPartInput(yearEl, null));

    parts.forEach((el, index) => {
      el.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !el.value && index > 0) {
          event.preventDefault();
          focusPart(parts[index - 1]);
          return;
        }
        if (event.key === "ArrowLeft" && el.selectionStart === 0 && index > 0) {
          event.preventDefault();
          focusPart(parts[index - 1]);
          return;
        }
        if (
          event.key === "ArrowRight" &&
          el.selectionStart === el.value.length &&
          index < parts.length - 1
        ) {
          event.preventDefault();
          focusPart(parts[index + 1]);
        }
      });

      el.addEventListener("paste", (event) => {
        const text = event.clipboardData?.getData("text") || "";
        const parsed = parseLooseDate(text);
        if (!parsed) return;
        event.preventDefault();
        fillParts(dayEl, monthEl, yearEl, parsed);
        syncFromParts(true);
        focusPart(yearEl);
      });

      el.addEventListener("blur", () => {
        if (el.dataset.auPart !== "y" && el.value.length === 1) {
          el.value = pad2(el.value);
        }
        syncFromParts(true);
      });
    });

    // Keep custom parts in sync if code sets native.value directly.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor && descriptor.set) {
      Object.defineProperty(native, "value", {
        configurable: true,
        enumerable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(next) {
          descriptor.set.call(this, next);
          if (wrap.isConnected && !syncingFromParts) {
            const partsIso = parseIso(next);
            if (partsIso) fillParts(dayEl, monthEl, yearEl, partsIso);
            else if (!String(next || "").trim()) {
              fillParts(dayEl, monthEl, yearEl, { d: "", m: "", y: "" });
            }
          }
        }
      });
    }

    return wrap;
  }

  function enhanceAll(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input[type="date"]').forEach((el) => enhance(el));
  }

  let scheduled = false;
  function scheduleEnhance() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceAll(document);
    });
  }

  function boot() {
    enhanceAll(document);
    if (typeof MutationObserver === "function") {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "childList" && mutation.addedNodes.length) {
            scheduleEnhance();
            return;
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  global.AuDateInput = {
    enhance,
    enhanceAll,
    toIso,
    parseLooseDate
  };
})(typeof window !== "undefined" ? window : globalThis);
