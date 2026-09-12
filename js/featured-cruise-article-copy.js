/**
 * Copy helpers for Featured Cruise Article V2.
 * Browser global: FeaturedCruiseArticleCopy
 */
(function (root) {
  "use strict";

  var HERO_INTRO_MAX = 220;
  var REASON_BODY_MAX = 300;
  var EDITORIAL_EXCERPT_MAX = 520;

  function normalizeSpace(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitSentences(text) {
    var normalized = normalizeSpace(text);
    if (!normalized) return [];
    var parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    if (!parts) return [normalized];
    return parts.map(function (part) {
      return normalizeSpace(part);
    }).filter(Boolean);
  }

  function firstCompleteSentence(text, maxChars) {
    var limit = maxChars != null ? Number(maxChars) : HERO_INTRO_MAX;
    var sentences = splitSentences(text);
    if (!sentences.length) return "";
    var first = sentences[0];
    if (first.length <= limit) return first;
    if (limit < 40) return first.slice(0, limit).trim();
    var clipped = first.slice(0, limit);
    var lastSpace = clipped.lastIndexOf(" ");
    if (lastSpace > 24) clipped = clipped.slice(0, lastSpace);
    return normalizeSpace(clipped);
  }

  function capCompleteText(text, maxChars) {
    var normalized = normalizeSpace(text);
    if (!normalized) return "";
    var limit = Number(maxChars) || REASON_BODY_MAX;
    if (normalized.length <= limit) return normalized;
    var sentences = splitSentences(normalized);
    var out = "";
    for (var i = 0; i < sentences.length; i += 1) {
      var next = out ? out + " " + sentences[i] : sentences[i];
      if (next.length <= limit) out = next;
      else break;
    }
    if (out) return out;
    return firstCompleteSentence(normalized, limit);
  }

  function buildHeroIntro(cruise) {
    var tagline = normalizeSpace(cruise.short_tagline || cruise.hero_tagline || "");
    if (tagline) return capCompleteText(tagline, HERO_INTRO_MAX);

    var summary = normalizeSpace(cruise.short_summary || cruise.cruise_summary || "");
    if (summary) return capCompleteText(summary, HERO_INTRO_MAX);

    // Do not reuse the newsletter editorial or full description in the hero.
    // The Explore page should only show the optional full description below the hero.
    return "";
  }

  function buildEditorialBlocks(cruise) {
    var source = String(cruise.full_description || "").trim();
    if (!source) return { paragraphs: [], excerpt: "", remainder: "", isLong: false };

    var paragraphs = source
      .split(/\n{2,}/)
      .map(function (paragraph) {
        return normalizeSpace(paragraph);
      })
      .filter(Boolean);

    if (!paragraphs.length) {
      var normalized = normalizeSpace(source);
      if (normalized) paragraphs = [normalized];
    }

    var joined = paragraphs.join("\n\n");
    return { paragraphs: paragraphs, excerpt: joined, remainder: "", isLong: false };
  }

  function reasonsHeading(count) {
    if (count >= 3) return "Three reasons this sailing stands out";
    if (count === 2) return "Why this sailing stands out";
    return "";
  }

  function registerTextBlock(registry, text) {
    var key = normalizeSpace(text).toLowerCase();
    if (!key || key.length < 48) return true;
    if (registry[key]) return false;
    registry[key] = true;
    return true;
  }

  root.FeaturedCruiseArticleCopy = {
    HERO_INTRO_MAX: HERO_INTRO_MAX,
    REASON_BODY_MAX: REASON_BODY_MAX,
    EDITORIAL_EXCERPT_MAX: EDITORIAL_EXCERPT_MAX,
    normalizeSpace: normalizeSpace,
    splitSentences: splitSentences,
    firstCompleteSentence: firstCompleteSentence,
    capCompleteText: capCompleteText,
    buildHeroIntro: buildHeroIntro,
    buildEditorialBlocks: buildEditorialBlocks,
    reasonsHeading: reasonsHeading,
    registerTextBlock: registerTextBlock
  };
})(typeof window !== "undefined" ? window : globalThis);
