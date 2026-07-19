/**
 * Shared Admin authentication for Netlify functions.
 * Validates Supabase JWT, profiles.is_admin, and optional admin_users.active.
 */

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase server configuration is missing');
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ''), serviceKey };
}

async function requireAdmin(event) {
  const { supabaseUrl, serviceKey } = getConfig();
  const token = String(event.headers.authorization || event.headers.Authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) {
    const error = new Error('Admin authentication is required');
    error.statusCode = 401;
    throw error;
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) {
    const error = new Error('Admin session is invalid or has expired');
    error.statusCode = 401;
    throw error;
  }

  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const profiles = await profileResponse.json().catch(() => []);
  if (!profileResponse.ok || profiles?.[0]?.is_admin !== true) {
    const error = new Error('This account does not have admin access');
    error.statusCode = 403;
    throw error;
  }

  // Optional allow-list: if an admin_users row exists for this user/email and is inactive, deny.
  const email = String(user.email || '').trim().toLowerCase();
  const adminQuery = email
    ? `admin_users?or=(auth_user_id.eq.${encodeURIComponent(user.id)},email.eq.${encodeURIComponent(email)})&select=id,active,role,email,auth_user_id&limit=5`
    : `admin_users?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,active,role,email,auth_user_id&limit=5`;

  try {
    const adminResponse = await fetch(`${supabaseUrl}/rest/v1/${adminQuery}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (adminResponse.ok) {
      const rows = await adminResponse.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) {
        const active = rows.some((row) => row.active === true);
        if (!active) {
          const error = new Error('This admin account has been deactivated');
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

module.exports = { requireAdmin, getConfig };
