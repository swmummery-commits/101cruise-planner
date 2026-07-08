exports.handler = async function (event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, error: "Method not allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const bookingReference = body.booking_reference;
    const bookingId = body.booking_id;

    if (!bookingReference && !bookingId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: "booking_reference or booking_id is required"
        })
      };
    }

    const base44Url = process.env.BASE44_BOOKING_FUNCTION_URL;
    const base44ApiKey = process.env.BASE44_API_KEY;

    if (!base44Url || !base44ApiKey) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: "Server integration is not configured"
        })
      };
    }

    const response = await fetch(base44Url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": base44ApiKey
      },
      body: JSON.stringify({
        booking_reference: bookingReference || undefined,
        booking_id: bookingId || undefined
      })
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, error: text };
    }

    return {
      statusCode: response.status,
      headers: corsHeaders,
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: error.message || "Unexpected server error"
      })
    };
  }
};