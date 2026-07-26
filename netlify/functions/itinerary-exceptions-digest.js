/**
 * Historical compatibility stub.
 * Journey-map itinerary extraction was retired — digest schedule removed from netlify.toml.
 * This handler must not scan, email, or mutate exceptions.
 */

exports.handler = async function () {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      success: true,
      sent: false,
      reason: "itinerary_map_feature_retired",
      count: 0
    })
  };
};
