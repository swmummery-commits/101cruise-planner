/**
 * Shared Admin authentication for Netlify functions.
 * Validates Supabase JWT, profiles.is_admin, and optional admin_users.active.
 */

const crypto = require("crypto");

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
    publishableKey: String(publishableKey || "").trim(),
    jwtSecret: String(process.env.SUPABASE_JWT_SECRET || "").trim()
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

function base64UrlToBuffer(value) {
  const str = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(str + pad, "base64");
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    const error = new Error("Invalid access token");
    error.statusCode = 401;
    throw error;
  }
  try {
    const header = JSON.parse(base64UrlToBuffer(parts[0]).toString("utf8"));
    const payload = JSON.parse(base64UrlToBuffer(parts[1]).toString("utf8"));
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2]
    };
  } catch (_error) {
    const error = new Error("Invalid access token");
    error.statusCode = 401;
    throw error;
  }
}

let jwksCache = { at: 0, keys: [] };

async function getJwks() {
  if (jwksCache.keys.length && Date.now() - jwksCache.at < 10 * 60 * 1000) {
    return jwksCache.keys;
  }
  const { supabaseUrl, publishableKey } = getConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, {
    headers: { apikey: publishableKey }
  });
  const data = await response.json().catch(() => ({}));
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { at: Date.now(), keys };
  return keys;
}

async function verifyAccessTokenSignature(token) {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (!payload?.sub) {
    const error = new Error("Invalid access token (missing subject)");
    error.statusCode = 401;
    throw error;
  }
  if (payload.exp && Number(payload.exp) * 1000 <= Date.now()) {
    const error = new Error("Admin session is invalid or has expired");
    error.statusCode = 401;
    throw error;
  }

  const alg = String(header.alg || "HS256");
  const dataBuf = Buffer.from(signingInput, "utf8");
  const sigBuf = base64UrlToBuffer(signature);

  if (alg === "HS256") {
    const { jwtSecret } = getConfig();
    if (!jwtSecret) {
      const error = new Error("Cannot verify access token (JWT secret not configured)");
      error.statusCode = 401;
      throw error;
    }
    const expected = crypto.createHmac("sha256", jwtSecret).update(dataBuf).digest();
    if (expected.length !== sigBuf.length || !crypto.timingSafeEqual(expected, sigBuf)) {
      const error = new Error("Invalid access token signature");
      error.statusCode = 401;
      throw error;
    }
    return payload;
  }

  if (alg === "ES256" || alg === "RS256") {
    const keys = await getJwks();
    const jwk = (header.kid && keys.find((key) => key.kid === header.kid)) || keys[0];
    if (!jwk) {
      const error = new Error("Cannot verify access token (no signing keys available)");
      error.statusCode = 401;
      throw error;
    }
    const keyObject = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const verified = crypto.verify(
      "SHA256",
      dataBuf,
      alg === "ES256" ? { key: keyObject, dsaEncoding: "ieee-p1363" } : keyObject,
      sigBuf
    );
    if (!verified) {
      const error = new Error("Invalid access token signature");
      error.statusCode = 401;
      throw error;
    }
    return payload;
  }

  const error = new Error(`Unsupported access token algorithm (${alg})`);
  error.statusCode = 401;
  throw error;
}

async function fetchUserById(userId) {
  const { supabaseUrl } = getConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: serviceHeaders()
  });
  const user = await response.json().catch(() => null);
  if (!response.ok || !user?.id) {
    const msg = user?.msg || user?.message || "Could not load auth user";
    const error = new Error(msg);
    error.statusCode = response.status >= 400 ? response.status : 401;
    throw error;
  }
  return user;
}

function isMissingSessionError(body) {
  const detail = String(
    body?.msg || body?.message || body?.error_description || body?.error || ""
  ).toLowerCase();
  const code = String(body?.error_code || body?.code || "").toLowerCase();
  return (
    code.includes("session_not_found") ||
    detail.includes("session_id claim") ||
    detail.includes("session from session_id")
  );
}

/**
 * Resolve the signed-in Auth user from a bearer access token.
 * Prefer /auth/v1/user (includes live session check). If Auth says the
 * session row is gone but the JWT is still signature-valid and unexpired —
 * common after session cleanup while PostgREST still accepts the token —
 * fall back to local JWT verify + Auth Admin getUserById.
 */
async function fetchAuthUser(token) {
  const { supabaseUrl, serviceKey, publishableKey } = getConfig();
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

  if (isMissingSessionError(lastBody)) {
    try {
      const claims = await verifyAccessTokenSignature(token);
      const user = await fetchUserById(claims.sub);
      return {
        id: user.id,
        email: user.email || claims.email || "",
        user_metadata: user.user_metadata || claims.user_metadata || {},
        app_metadata: user.app_metadata || claims.app_metadata || {},
        role: claims.role || "authenticated",
        session_missing: true
      };
    } catch (verifyError) {
      const error = new Error(
        "Your admin session was revoked. Sign out and sign in again."
      );
      error.statusCode = 401;
      error.cause = verifyError;
      throw error;
    }
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

module.exports = {
  requireAdmin,
  getConfig,
  getBearerToken,
  serviceHeaders,
  fetchAuthUser
};
