const { rest, authorizedWorker, dispatchWorker } = require("./lib/newsletter-route-map-jobs");
const { generateRouteMap } = require("./route-map-generate");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" || !authorizedWorker(event.headers)) return { statusCode: 401 };
  const [job] = await rest("rpc/claim_newsletter_route_map", { method: "POST", body: {} });
  if (!job) return { statusCode: 200 };

  const { cruise_id: cruise, newsletter_id: issue, claim_token: token, fingerprint } = job;
  const filter = `newsletter_route_map_jobs?cruise_id=eq.${cruise}&claim_token=eq.${token}`;
  let outcome;
  try {
    const [linked] = await rest(`featured_cruises?id=eq.${cruise}&newsletter_id=eq.${issue}&select=id,route_map_media_id,route_map_image_url,publication_status`);
    if (!linked || linked.publication_status === "archived" || linked.route_map_media_id || linked.route_map_image_url?.trim()) {
      await rest(`${filter}&newsletter_id=eq.${issue}`, { method: "DELETE" });
      await rest("rpc/finish_newsletter_route_map", { method: "POST", body: {
        target: cruise, token, started_fingerprint: fingerprint, started_issue: issue,
        outcome: "failed", outcome_message: null
      } });
      return { statusCode: 200 };
    }
    const response = await generateRouteMap(cruise, { style: "classic", allow_approximate_locations: true });
    const result = JSON.parse(response.body);
    const code = result.errors?.[0]?.code;
    outcome = result.ok
      ? { status: "ready", message: result.warnings?.some((warning) => warning.code === "approximate_location")
        ? "The map uses an approximate coastal location." : null }
      : { status: response.statusCode === 400 ? "needs_attention" : "failed",
          message: response.statusCode === 400 ? result.errors?.[0]?.message || "Check the itinerary and port coordinates."
            : "Map generation failed. Retry from the newsletter." };
    console.info("newsletter_route_map_result", JSON.stringify({ cruise_id: cruise, status: outcome.status, code, timings: result.timings }));
  } catch (error) {
    console.error("newsletter route map worker failed", cruise, error.message);
    outcome = { status: "failed", message: "Map generation failed. Retry from the newsletter." };
  }
  await rest("rpc/finish_newsletter_route_map", { method: "POST", body: {
    target: cruise, token, started_fingerprint: fingerprint, started_issue: issue,
    outcome: outcome.status, outcome_message: outcome.message
  } });
  await dispatchWorker().catch((error) => console.warn("Newsletter map continuation deferred", error.message));
  return { statusCode: 200 };
};
