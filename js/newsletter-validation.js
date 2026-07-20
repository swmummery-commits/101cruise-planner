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

  /** Estimate wrapped lines for a centred headline at its max width. */
  function estimateWrappedLines(text, maxCharsPerLine = 42) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    let lines = 1;
    let current = 0;
    for (const word of words) {
      const next = current === 0 ? word.length : current + 1 + word.length;
      if (next > maxCharsPerLine && current > 0) {
        lines += 1;
        current = word.length;
      } else {
        current = next;
      }
    }
    return lines;
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
      const lines = estimateWrappedLines(headline, headlineRules.approxCharsPerLine || 42);
      const maxWords = headlineRules.maxWords || 12;
      const maxLines = headlineRules.maxLines || 3;
      if (words > maxWords || lines > maxLines) {
        warnings.push({
          level: "warning",
          field: "headline",
          message: "Headline should be no more than 12 words or 3 lines."
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
    estimateWrappedLines,
    validateNewsletterPreview
  };
})(typeof window !== "undefined" ? window : globalThis);
