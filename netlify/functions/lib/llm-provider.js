/**
 * Thin LLM provider abstraction for Netlify functions.
 * Currently supports OpenAI Responses API (already used by admin-itinerary).
 */

function getOpenAIConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const model = String(
    process.env.OPENAI_RESEARCH_MODEL || process.env.OPENAI_ITINERARY_MODEL || "gpt-4.1-mini"
  ).trim();
  return {
    provider: "openai",
    apiKey,
    model,
    configured: Boolean(apiKey)
  };
}

function getLlmConfig() {
  // Prefer OpenAI — the only configured text-generation provider in this project.
  return getOpenAIConfig();
}

function extractOutputText(payload) {
  if (!payload) return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (block && (block.type === "output_text" || block.type === "text") && block.text) {
        parts.push(String(block.text));
      }
    }
  }
  if (parts.length) return parts.join("\n").trim();
  if (payload.choices?.[0]?.message?.content) {
    return String(payload.choices[0].message.content).trim();
  }
  return "";
}

/**
 * Generate structured JSON text from a prompt.
 * @returns {Promise<{ text: string, provider: string, model: string, usage: object|null, raw: object }>}
 */
async function generateStructuredJson({ systemPrompt, userPrompt, schemaName = "research_content" }) {
  const cfg = getLlmConfig();
  if (!cfg.configured) {
    const err = new Error(
      "OPENAI_API_KEY has not been added to Netlify environment variables. Research generation cannot run until it is configured."
    );
    err.code = "ai_provider_unavailable";
    err.statusCode = 503;
    throw err;
  }

  if (cfg.provider !== "openai") {
    const err = new Error(`Unsupported generation provider: ${cfg.provider}`);
    err.code = "ai_provider_unavailable";
    err.statusCode = 503;
    throw err;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      store: false,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }]
        }
      ],
      text: {
        format: {
          type: "json_object"
        }
      }
    })
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(raw?.error?.message || `OpenAI request failed (${response.status})`);
    err.code = "ai_provider_unavailable";
    err.statusCode = response.status >= 500 ? 503 : 502;
    err.raw = raw;
    throw err;
  }

  const text = extractOutputText(raw);
  if (!text) {
    const err = new Error("AI provider returned an empty response");
    err.code = "invalid_model_response";
    err.statusCode = 502;
    throw err;
  }

  return {
    text,
    provider: cfg.provider,
    model: cfg.model,
    usage: raw.usage || null,
    raw,
    schemaName
  };
}

module.exports = {
  getLlmConfig,
  getOpenAIConfig,
  generateStructuredJson,
  extractOutputText
};
