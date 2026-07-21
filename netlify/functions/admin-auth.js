/**
 * Shared Admin authentication for Netlify functions.
 * Validates Supabase JWT, profiles.is_admin, and optional admin_users.active.
 */

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase server configuration is missing");
  // Prefer env; fall back to the same public publishable key used by Admin JS
  // so /auth/v1/user validation matches Supabase's recommended apikey type.
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "sb_publishable_MEFg6spz5_Uod7sZGU8whw_UvOQDW60";
  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    serviceKey,
    publishableKey: String(publishableKey || "").trim()
  };
}

function readHeader(event, name) {
  const headers = event?.headers || {};
  const multi = event?.multiValueHeaders || {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) {
      return Array.isArray(value) ? String(value[0] || "") : String(value || "");
    }
  }
  for (const [key, value] of Object.entries(multi)) {
    if (String(key).toLowerCase() === lower) {
      return Array.isArray(value) ? String(value[0] || "") : String(value || "");
    }
  }
  return "";
}

function getBearerToken(event) {
  const raw = readHeader(event, "authorization");
  return String(raw || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

/**
 * Headers for service-role / secret-key calls to Supabase.
 * Legacy service_role keys are JWTs. New sb_secret_* keys are not; the API
 * gateway rewrites Bearer sb_* into a short-lived service JWT when apikey matches.
 */
function serviceHeaders(extra = {}) {
  const { serviceKey } = getConfig();
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
    ...extra
  };
}

async function fetchAuthUser(token) {
  const { supabaseUrl, serviceKey, publishableKey } = getConfig();
  // Prefer publishable/anon for /auth/v1/user (matches Supabase docs), then secret/service.
  const apiKeys = [...new Set([publishableKey, serviceKey].filter(Boolean))];

  let lastStatus = 0;
  let lastBody = null;
  for (const apikey of apiKeys) {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` }
    });
    const user = await userResponse.json().catch(() => null);
    if (userResponse.ok && user?.id) return user;
    lastStatus = userResponse.status;
    lastBody = user;
  }

  const detail =
    lastBody?.msg || lastBody?.message || lastBody?.error_description || lastBody?.error || "";
  const error = new Error(
    detail
      ? `Admin session is invalid or has expired (${detail})`
      : "Admin session is invalid or has expired"
  );
  error.statusCode = lastStatus >= 400 && lastStatus < 500 ? lastStatus : 401;
  error.body = lastBody;
  throw error;
}

async function requireAdmin(event) {
  const { supabaseUrl } = getConfig();
  const token = getBearerToken(event);
  if (!token) {
    const error = new Error("Admin authentication is required");
    error.statusCode = 401;
    throw error;
  }

  const user = await fetchAuthUser(token);

  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin&limit=1`,
    { headers: serviceHeaders() }
  );
  const profiles = await profileResponse.json().catch(() => []);
  if (!profileResponse.ok || profiles?.[0]?.is_admin !== true) {
    const error = new Error("This account does not have admin access");
    error.statusCode = 403;
    throw error;
  }

  // Optional allow-list: if an admin_users row exists for this user/email and is inactive, deny.
  const email = String(user.email || "").trim().toLowerCase();
  const adminQuery = email
    ? `admin_users?or=(auth_user_id.eq.${encodeURIComponent(user.id)},email.eq.${encodeURIComponent(email)})&select=id,active,role,email,auth_user_id&limit=5`
    : `admin_users?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,active,role,email,auth_user_id&limit=5`;

  try {
    const adminResponse = await fetch(`${supabaseUrl}/rest/v1/${adminQuery}`, {
      headers: serviceHeaders()
    });
    if (adminResponse.ok) {
      const rows = await adminResponse.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) {
        const active = rows.some((row) => row.active === true);
        if (!active) {
          const error = new Error("This admin account has been deactivated");
          error.statusCode = 403;
          throw error;
        }
      }
    }
  } catch (error) {
    if (error.statusCode) throw error;
    // Table may not exist yet before migration — fall back to profiles.is_admin only.
  }

  return user;
}

module.exports = { requireAdmin, getConfig, getBearerToken, serviceHeaders, fetchAuthUser };
