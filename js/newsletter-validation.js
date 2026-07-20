/**
 * Lightweight newsletter content validation.
 * Warnings only — never block save or preview.
 */
(function (global) {
  "use strict";

  function wordCount(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }

  function charCount(value) {
    return String(value || "").trim().length;
  }

  /**
   * @param {object} model Newsletter content model from NewsletterPreview.buildModel
   * @returns {{ level: 'warning', field: string, message: string }[]}
   */
  function validateNewsletterPreview(model) {
    const typo = global.NewsletterTypography || {};
    const warnings = [];
    const strip = String(model?.destinationStrip || "").trim();
    const headline = String(model?.headline || "").trim();
    const description = String(model?.description || "").trim();

    const stripRules = typo.destinationStrip || {};
    if (strip) {
      const stripWords = wordCount(strip);
      const stripChars = charCount(strip);
      if (
        stripChars > (stripRules.maxPreferredChars || 55) ||
        stripWords > (stripRules.maxPreferredWords || 9)
      ) {
        warnings.push({
          level: "warning",
          field: "destination_strip",
          message: "Destination strip may wrap to two lines."
        });
      }
    }

    const headlineRules = typo.headline || {};
    if (headline) {
      const words = wordCount(headline);
      if (words > (headlineRules.maxWords || 14)) {
        warnings.push({
          level: "warning",
          field: "headline",
          message: "Headline may become too tall for the newsletter."
        });
      }
    }

    const descriptionRules = typo.description || {};
    if (description) {
      const words = wordCount(description);
      if (words > (descriptionRules.maxRecommendedWords || 100)) {
        warnings.push({
          level: "warning",
          field: "description",
          message: "Cruise description is longer than the recommended 100 words."
        });
      }
    }

    return warnings;
  }

  global.NewsletterValidation = {
    wordCount,
    charCount,
    validateNewsletterPreview
  };
})(typeof window !== "undefined" ? window : globalThis);
