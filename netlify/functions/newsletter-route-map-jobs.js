const { requireAdmin } = require("./admin-auth");
const { rest } = require("./lib/newsletter-route-map-jobs");

function reply(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST required." });
  try {
    await requireAdmin(event);
  } catch (error) {
    return reply(error.statusCode || 401, { error: "Admin sign-in required." });
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid request." }); }
  const { newsletter_id: issue, cruise_id: cruise, action } = body || {};
  if (!uuid.test(issue || "") || (cruise && !uuid.test(cruise)) || !["status", "enqueue"].includes(action)) {
    return reply(400, { error: "Invalid newsletter map request." });
  }
  try {
    if (action === "enqueue") {
      await rest("rpc/enqueue_newsletter_route_maps", { method: "POST", body: { issue, retry_cruise: cruise || null } });
    }
    const jobs = await rest(`newsletter_route_map_jobs?newsletter_id=eq.${issue}&select=cruise_id,status,message,featured_cruises!inner(newsletter_id,route_map_png_path,route_map_svg_path,route_map_generated_at,route_map_status)&featured_cruises.newsletter_id=eq.${issue}`);
    return reply(200, { jobs });
  } catch (error) {
    console.error("newsletter map queue request failed", error.message);
    return reply(503, { error: "Route map queue is unavailable. Try saving the newsletter again." });
  }
};
