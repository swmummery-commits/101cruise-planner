(function (global) {
  "use strict";

  // Capitalise the first letter of each word while preserving brand names and acronyms.
  function headline(value) {
    return String(value ?? "").replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu,
      (_, prefix, letter) => prefix + letter.toUpperCase());
  }

  function eyebrow(value) {
    return String(value ?? "").toUpperCase();
  }

  global.NewsletterHeadingCase = { headline, eyebrow };
})(typeof window !== "undefined" ? window : globalThis);
