/**
 * Shared Booking Confirmation → structured itinerary extraction (OpenAI).
 * Single implementation used by admin-itinerary and itinerary-auto-process.
 */

"use strict";

const itinerarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cruise_line: { type: ["string", "null"] },
    ship: { type: ["string", "null"] },
    voyage_name: { type: ["string", "null"] },
    embarkation_date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD" },
    disembarkation_date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    review_notes: { type: "array", items: { type: "string" } },
    stops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          date: { type: "string", description: "ISO date YYYY-MM-DD" },
          name: { type: "string" },
          entry_type: {
            type: "string",
            enum: ["embarkation", "port", "sea_day", "scenic_cruising", "disembarkation"]
          },
          arrival_time: { type: ["string", "null"], description: "24-hour HH:MM or null" },
          departure_time: { type: ["string", "null"], description: "24-hour HH:MM or null" },
          notes: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["date", "name", "entry_type", "arrival_time", "departure_time", "notes", "confidence"]
      }
    }
  },
  required: [
    "cruise_line",
    "ship",
    "voyage_name",
    "embarkation_date",
    "disembarkation_date",
    "confidence",
    "review_notes",
    "stops"
  ]
};

function extractOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function estimateCostUsd(model, usage) {
  // Rough list prices for reporting only — update when models change.
  const rates = {
    "gpt-5.5": { input: 0.000005, output: 0.000015 },
    "gpt-4.1": { input: 0.000002, output: 0.000008 },
    "gpt-4o": { input: 0.0000025, output: 0.00001 }
  };
  const rate = rates[model] || rates["gpt-4.1"];
  const input = Number(usage?.input_tokens || usage?.prompt_tokens || 0);
  const output = Number(usage?.output_tokens || usage?.completion_tokens || 0);
  if (!input && !output) return null;
  return Number((input * rate.input + output * rate.output).toFixed(6));
}

/**
 * @returns {Promise<{ itinerary: object, model: string, usage: object|null, estimated_cost_usd: number|null, raw: object }>}
 */
async function extractItineraryWithOpenAI(booking, document, options = {}) {
  const openaiKey = options.openaiKey || process.env.OPENAI_API_KEY;
  const model = options.model || process.env.OPENAI_ITINERARY_MODEL || "gpt-5.5";
  const fetchImpl = options.fetchImpl || fetch;

  if (!openaiKey) {
    const error = new Error("OPENAI_API_KEY has not been added to Netlify environment variables");
    error.statusCode = 503;
    throw error;
  }
  if (!document?.file_url) {
    const error = new Error("Booking Confirmation file URL is required for extraction");
    error.statusCode = 400;
    throw error;
  }

  const lowerUrl = String(document.file_url).toLowerCase();
  const isImage = /\.(png|jpe?g|webp)(\?|$)/i.test(lowerUrl);
  const fileContent = isImage
    ? { type: "input_image", image_url: document.file_url, detail: "high" }
    : { type: "input_file", file_url: document.file_url, detail: "high" };

  const prompt = `Extract only the cruise itinerary from this cruise booking confirmation.\n\nKnown Base44 booking facts for validation:\n- Cruise line: ${booking.cruise_line || "unknown"}\n- Ship: ${booking.cruise_ship || "unknown"}\n- Embarkation: ${booking.departing_date || "unknown"} from ${booking.departing_port || "unknown"}\n- Disembarkation: ${booking.arriving_date || "unknown"} at ${booking.arriving_port || "unknown"}\n\nRules:\n- Return every genuine cruise itinerary day in chronological order.\n- Ignore transfer rows such as “No Transfer To Ship” and “No Transfer From Ship”.\n- Keep scenic cruising locations as entry_type scenic_cruising.\n- Use sea_day only for At Sea entries.\n- Infer a missing year from the confirmed embarkation/disembarkation dates.\n- Preserve repeated dates if they represent genuine itinerary entries.\n- Do not invent ports or times. Use null when a time is not supplied.\n- Flag uncertainty in review_notes and per-stop confidence.\n- The official PDF remains the source of truth; this output must be reviewed by an administrator when confidence is low or ports are unclear.`;

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model,
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }, fileContent] }],
      text: {
        format: {
          type: "json_schema",
          name: "cruise_itinerary",
          strict: true,
          schema: itinerarySchema
        }
      }
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `Itinerary extraction failed (HTTP ${response.status})`);
  }
  const text = extractOutputText(data);
  if (!text) throw new Error("The extraction service returned no itinerary data");
  const itinerary = JSON.parse(text);
  const usage = data?.usage || null;
  return {
    itinerary,
    model,
    usage,
    estimated_cost_usd: estimateCostUsd(model, usage),
    raw: data
  };
}

module.exports = {
  itinerarySchema,
  extractItineraryWithOpenAI,
  extractOutputText,
  estimateCostUsd
};
