function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function buildCachePayload(booking) {
  return {
    base44_booking_id: booking.base44_booking_id || null,
    booking_reference: booking.booking_reference || null,

    passenger1_first_name: booking.passenger1_first_name || null,
    passenger1_last_name: booking.passenger1_last_name || null,
    passenger1_email: booking.passenger1_email || null,
    passenger1_mobile: booking.passenger1_mobile || null,

    passenger2_first_name: booking.passenger2_first_name || null,
    passenger2_last_name: booking.passenger2_last_name || null,
    passenger2_email: booking.passenger2_email || null,
    passenger2_mobile: booking.passenger2_mobile || null,

    cruise_line: booking.cruise_line || null,
    cruise_ship: booking.cruise_ship || null,

    departing_date: booking.departing_date || null,
    arriving_date: booking.arriving_date || null,

    departing_port: booking.departing_port || null,
    arriving_port: booking.arriving_port || null,

    room_number: booking.room_number || null,
    room_type: booking.room_type || null,
    category_class: booking.category_class || null,

    booking_status: booking.booking_status || null,
    raw_payload: booking
  };
}

async function saveBookingToSupabase(booking) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return {
      saved: false,
      error: "Supabase server save is not configured"
    };
  }

  const cachePayload = buildCachePayload(booking);

  const response = await fetch(`${supabaseUrl}/rest/v1/base44_booking_cache?on_conflict=base44_booking_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseServiceRoleKey,
      "Authorization": `Bearer ${supabaseServiceRoleKey}`,
      "Prefer": "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(cachePayload)
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    return {
      saved: false,
      error: typeof data === "string" ? data : (data?.message || `Supabase HTTP ${response.status}`)
    };
  }

  const savedRow = Array.isArray(data) ? data[0] : data;

  return {
    saved: true,
    cache_id: savedRow?.id || null
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {});
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const bookingReference = body.booking_reference;
    const bookingId = body.booking_id;

    if (!bookingReference && !bookingId) {
      return jsonResponse(400, {
        success: false,
        error: "booking_reference or booking_id is required"
      });
    }

    const base44Url = process.env.BASE44_BOOKING_FUNCTION_URL;
    const base44ApiKey = process.env.BASE44_API_KEY;

    if (!base44Url || !base44ApiKey) {
      return jsonResponse(500, {
        success: false,
        error: "Base44 integration is not configured"
      });
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

    if (!response.ok || data.success === false || !data.booking) {
      return jsonResponse(response.status || 500, data);
    }

    const saveResult = await saveBookingToSupabase(data.booking);

    if (!saveResult.saved) {
      return jsonResponse(500, {
        success: false,
        error: saveResult.error || "Booking retrieved but could not be saved to 101CRUISE"
      });
    }

    return jsonResponse(200, {
      success: true,
      booking: data.booking,
      cache_id: saveResult.cache_id,
      saved_to_101cruise: true
    });
  } catch (error) {
    return jsonResponse(500, {
      success: false,
      error: error.message || "Unexpected server error"
    });
  }
};
