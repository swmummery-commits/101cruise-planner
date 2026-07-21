/**
 * Weekly Cruise Discovery orchestrator (Netlify Scheduled Function).
 *
 * 1. Expires sailings with departure_date before today (status → expired; never hard-delete).
 * 2. Kicks the background wave across all active sold-by-101cruise lines.
 *
 * Schedule: Monday 06:00 UTC (see netlify.toml).
 * Requires DISCOVERY_CRON_SECRET in Netlify env for the background wave.
 */

const {
  expireSailedCruises,
  listActiveSoldCruiseLineIds
} = require("./lib/cruise-discovery-runner");

function siteBaseUrl() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || "").trim();
}

async function kickBackgroundWave(lineIds, waveId) {
  const base = siteBaseUrl();
  const secret = cronSecret();
  if (!base) {
    console.warn("cruise-discovery-cron: no site URL; cannot kick wave");
    return { kicked: false, reason: "missing_site_url" };
  }
  if (!secret) {
    console.warn(
      "cruise-discovery-cron: DISCOVERY_CRON_SECRET not set; expire-only (wave skipped)"
    );
    return { kicked: false, reason: "missing_cron_secret" };
  }

  // Background functions acknowledge immediately (202) then continue up to ~15 minutes.
  const url = `${base}/.netlify/functions/cruise-discovery-wave-background`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({
      wave_id: waveId,
      line_ids: lineIds
    })
  });

  if (response.status !== 202 && !response.ok) {
    const text = await response.text().catch(() => "");
    console.error("cruise-discovery-cron: wave kick failed", response.status, text);
    return { kicked: false, reason: `wave_http_${response.status}`, detail: text.slice(0, 300) };
  }

  return {
    kicked: true,
    status: response.status,
    line_count: lineIds.length
  };
}

exports.handler = async (event) => {
  const started = Date.now();
  const waveId = `weekly-${new Date().toISOString().slice(0, 10)}-${started}`;

  try {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    console.log("cruise-discovery-cron start", {
      waveId,
      next_run: body.next_run || null
    });

    const expire = await expireSailedCruises();
    console.log("cruise-discovery-cron expired", expire);

    const lines = await listActiveSoldCruiseLineIds();
    const lineIds = lines.map((l) => l.id);
    console.log("cruise-discovery-cron lines", {
      count: lineIds.length,
      names: lines.map((l) => l.name)
    });

    let wave = { kicked: false, reason: "no_lines" };
    if (lineIds.length) {
      wave = await kickBackgroundWave(lineIds, waveId);
    }

    const result = {
      success: true,
      wave_id: waveId,
      expired: expire,
      line_count: lineIds.length,
      wave,
      elapsed_ms: Date.now() - started
    };
    console.log("cruise-discovery-cron done", result);
    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error("cruise-discovery-cron failed", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message || "Weekly discovery cron failed"
      })
    };
  }
};
