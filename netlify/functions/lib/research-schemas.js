/**
 * Research content schemas, freshness defaults, and public-safe projections.
 */

const SCHEMA_VERSION = "1.0";

const ENTITY_TYPES = ["ship", "destination", "port", "cruise_line"];

const REFRESH_MONTHS = {
  ship: 12,
  destination: 18,
  port: 12,
  cruise_line: 9
};

const SHIP_FIELDS = [
  "overview",
  "personality",
  "best_for",
  "not_ideal_for",
  "dining_summary",
  "entertainment_summary",
  "wellness_summary",
  "accommodation_summary",
  "accessibility_summary",
  "connectivity_summary",
  "dress_code_summary",
  "included_summary",
  "extra_cost_summary",
  "family_summary",
  "solo_traveller_summary",
  "key_highlights",
  "frequently_asked_questions",
  "research_notes"
];

const DESTINATION_FIELDS = [
  "overview",
  "why_visit",
  "best_time_to_visit",
  "climate_summary",
  "ideal_for",
  "key_highlights",
  "signature_experiences",
  "food_and_drink",
  "culture_and_etiquette",
  "currency",
  "languages",
  "transport_summary",
  "accessibility_summary",
  "family_summary",
  "packing_summary",
  "frequently_asked_questions",
  "research_notes"
];

const PORT_FIELDS = [
  "overview",
  "why_visit",
  "must_see",
  "typical_cruise_day",
  "getting_from_port",
  "walking_difficulty",
  "accessibility_summary",
  "currency",
  "languages",
  "transport",
  "food_to_try",
  "shopping",
  "shore_excursion_ideas",
  "independent_exploration",
  "practical_tips",
  "tender_port",
  "frequently_asked_questions",
  "research_notes"
];

const CRUISE_LINE_FIELDS = [
  "overview",
  "market_position",
  "brand_personality",
  "best_for",
  "not_ideal_for",
  "dining_style",
  "dress_code",
  "entertainment_style",
  "family_friendly",
  "solo_friendly",
  "accessibility_summary",
  "drinks_summary",
  "wifi_summary",
  "gratuities_summary",
  "included_summary",
  "extra_cost_summary",
  "loyalty_program_summary",
  "frequently_asked_questions",
  "research_notes"
];

const LIST_FIELDS = new Set([
  "best_for",
  "not_ideal_for",
  "ideal_for",
  "key_highlights",
  "signature_experiences",
  "must_see",
  "shore_excursion_ideas",
  "practical_tips",
  "included_summary",
  "extra_cost_summary"
]);

const FAQ_FIELD = "frequently_asked_questions";

function fieldsForEntityType(entityType) {
  switch (entityType) {
    case "ship":
      return SHIP_FIELDS;
    case "destination":
      return DESTINATION_FIELDS;
    case "port":
      return PORT_FIELDS;
    case "cruise_line":
      return CRUISE_LINE_FIELDS;
    default:
      return [];
  }
}

function emptyContent(entityType) {
  const out = { schema_version: SCHEMA_VERSION, entity_type: entityType };
  for (const key of fieldsForEntityType(entityType)) {
    if (key === FAQ_FIELD) out[key] = [];
    else if (LIST_FIELDS.has(key)) out[key] = [];
    else if (key === "tender_port") out[key] = { status: "varies", note: "" };
    else out[key] = "";
  }
  return out;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 12);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\n|;|\|/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function asFaqArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => ({
      question: String(row?.question || "").trim(),
      answer: String(row?.answer || "").trim()
    }))
    .filter((row) => row.question && row.answer)
    .slice(0, 10);
}

function normaliseContentJson(entityType, raw) {
  const base = emptyContent(entityType);
  const input = raw && typeof raw === "object" ? raw : {};
  for (const key of fieldsForEntityType(entityType)) {
    if (key === FAQ_FIELD) {
      base[key] = asFaqArray(input[key]);
    } else if (LIST_FIELDS.has(key)) {
      base[key] = asStringArray(input[key]);
    } else if (key === "tender_port") {
      const t = input.tender_port && typeof input.tender_port === "object" ? input.tender_port : {};
      base.tender_port = {
        status: ["yes", "no", "varies"].includes(String(t.status || "").toLowerCase())
          ? String(t.status).toLowerCase()
          : "varies",
        note: String(t.note || "").trim().slice(0, 400)
      };
    } else {
      base[key] = String(input[key] || "").trim().slice(0, 4000);
    }
  }
  base.schema_version = SCHEMA_VERSION;
  base.entity_type = entityType;
  return base;
}

function validateContentJson(entityType, raw) {
  if (!ENTITY_TYPES.includes(entityType)) {
    return { ok: false, error: "Unsupported entity type" };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Content JSON must be an object" };
  }
  const normalised = normaliseContentJson(entityType, raw);
  if (!String(normalised.overview || "").trim()) {
    return { ok: false, error: "overview is required", content: normalised };
  }
  return { ok: true, content: normalised };
}

function refreshAfterDate(entityType, fromDate = new Date()) {
  const months = REFRESH_MONTHS[entityType] || 12;
  const d = new Date(fromDate.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

function freshnessLabel(refreshAfterIso, now = new Date()) {
  if (!refreshAfterIso) return "unknown";
  const due = new Date(refreshAfterIso);
  if (Number.isNaN(due.getTime())) return "unknown";
  const ms = due.getTime() - now.getTime();
  if (ms < 0) return "overdue";
  if (ms <= 30 * 24 * 60 * 60 * 1000) return "review_soon";
  return "current";
}

/** Strip internal-only fields for public API responses. */
function toPublicResearchTeaser(row, { maxHighlights = 4 } = {}) {
  if (!row || row.content_status !== "published") return null;
  const content = normaliseContentJson(row.entity_type, row.content_json || {});
  const highlights = Array.isArray(content.key_highlights)
    ? content.key_highlights.slice(0, maxHighlights)
    : [];
  const ideal =
    Array.isArray(content.ideal_for) && content.ideal_for.length
      ? content.ideal_for.slice(0, 4)
      : Array.isArray(content.best_for)
        ? content.best_for.slice(0, 4)
        : [];

  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id || null,
    entity_key: row.entity_key || null,
    entity_name: row.entity_name,
    summary_text: row.summary_text || content.overview.slice(0, 280),
    overview: content.overview.slice(0, 600),
    personality: content.personality ? String(content.personality).slice(0, 400) : "",
    key_highlights: highlights,
    ideal_for: ideal,
    pauls_tip: row.pauls_tip ? String(row.pauls_tip).trim().slice(0, 500) : "",
    seo_title: row.seo_title || null,
    meta_description: row.meta_description || null,
    canonical_slug: row.canonical_slug || null,
    media_id: row.media_id || null,
    published_at: row.published_at || null,
    refresh_after: row.refresh_after || null
  };
}

function buildSystemPrompt(entityType) {
  return [
    "You are an experienced travel consultant writing for 101cruise (Australian English).",
    "Readers are primarily in Australia. Never assume northern-hemisphere seasons are understood without clarification.",
    "SEASONS RULE (critical): Prefer calendar months over bare season names.",
    "Good: \"April to June\", \"July (European summer)\", \"December to February (Australian summer / northern winter)\".",
    "Acceptable if a season is used: always pair it with months and/or hemisphere, e.g. \"April to May (northern spring)\".",
    "Bad: \"Spring and early autumn are ideal\" with no months or hemisphere.",
    "Apply this especially in best_time_to_visit, climate_summary, packing_summary, and any weather/season guidance.",
    "Write warmly and helpfully — like advice to a client — not like a Wikipedia or encyclopedia entry.",
    "Prefer natural sentences that name the ship/destination and explain who it suits.",
    "Good example tone: \"Adventure of the Seas offers Broadway-style theatre productions, live music venues, bars and family entertainment throughout the day. The ship is particularly well suited to travellers who enjoy lively evenings without the atmosphere feeling overwhelming.\"",
    "Avoid dry encyclopedic openings such as \"Entertainment includes...\", \"Dining features...\", \"The ship is known for...\" or catalogue-style lists dressed as prose.",
    "Do not sound like a brochure either — no hype, no unsupported superlatives, no hard sell.",
    "Synthesise only from the provided source excerpts. Do not invent facts.",
    "Do not include prices unless clearly described as typical/may vary and present in sources.",
    "Qualify cruise-line policies (Wi-Fi, drinks, gratuities, dress code) as typically/generally/may vary by fare.",
    "For tender ports and operational logistics, use cautious wording when details vary.",
    "Keep sections concise but readable: usually 2–4 short sentences for prose fields.",
    "Return a single JSON object matching the requested schema fields.",
    "FAQs must be grounded, useful and conversational — no generic filler.",
    `Entity type: ${entityType}.`,
    `Required keys: ${fieldsForEntityType(entityType).join(", ")}.`,
    "List fields must be JSON arrays of short plain phrases (not full essays).",
    "frequently_asked_questions must be an array of {question, answer}.",
    "research_notes may summarise conflicts or uncertainty for internal editors."
  ].join(" ");
}

function buildUserPrompt({ entityType, entityName, contextFacts, sources }) {
  const sourceBlock = (sources || [])
    .map((s, i) => {
      return [
        `SOURCE ${i + 1}`,
        `title: ${s.title || ""}`,
        `url: ${s.url || ""}`,
        `domain: ${s.domain || ""}`,
        `excerpt: ${String(s.excerpt || "").slice(0, 1800)}`
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Create structured ${entityType} research content for: ${entityName}`,
    contextFacts ? `Canonical database facts (do not invent extras):\n${contextFacts}` : "",
    "Voice: travel consultant speaking to a guest — clear, human, useful. Not encyclopedia. Not sales brochure.",
    "Audience: Australian travellers. Use months for timing (e.g. April–June). If you mention a season, qualify with months and hemisphere.",
    "Source excerpts follow. Synthesise; do not copy large passages.",
    sourceBlock ||
      "(No source excerpts available — return cautious, clearly uncertain content and note gaps in research_notes.)",
    `Respond with JSON only. Include all keys: ${fieldsForEntityType(entityType).join(", ")}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = {
  SCHEMA_VERSION,
  ENTITY_TYPES,
  REFRESH_MONTHS,
  SHIP_FIELDS,
  DESTINATION_FIELDS,
  PORT_FIELDS,
  CRUISE_LINE_FIELDS,
  LIST_FIELDS,
  FAQ_FIELD,
  fieldsForEntityType,
  emptyContent,
  normaliseContentJson,
  validateContentJson,
  refreshAfterDate,
  freshnessLabel,
  toPublicResearchTeaser,
  buildSystemPrompt,
  buildUserPrompt
};
