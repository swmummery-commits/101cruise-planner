const { rest, dispatchWorker } = require("./lib/newsletter-route-map-jobs");

// Netlify scheduled functions are invoked by the scheduler in production.
exports.handler = async () => {
  const active = await rest("newsletter_route_map_jobs?status=in.(queued,generating)&select=status,lease_until&limit=2&order=status.asc");
  if (active?.length && !active.some((job) => job.status === "generating" && Date.parse(job.lease_until) > Date.now())) {
    await dispatchWorker();
  }
  return { statusCode: 200, body: "" };
};
