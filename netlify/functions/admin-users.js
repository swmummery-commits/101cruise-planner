/**
 * Admin Settings — list users and grant/revoke admin access.
 *
 * POST /.netlify/functions/admin-users
 * Body: { action: "list" | "grant" | "revoke", ... }
 *
 * Updates both profiles.is_admin and admin_users (allow-list).
 */

const { requireAdmin, getConfig } = require("./admin-auth");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

async function rest(path, options = {}) {
  const { supabaseUrl, serviceKey } = getConfig();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function authAdmin(path, options = {}) {
  const { supabaseUrl, serviceKey } = getConfig();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.msg || data?.message || data?.error_description || `Auth HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    throw err;
  }
  return data;
}

async function loadActorContext(user) {
  const email = String(user.email || "").trim().toLowerCase();
  const rows = await rest(
    email
      ? `admin_users?or=(auth_user_id.eq.${encodeURIComponent(user.id)},email.eq.${encodeURIComponent(email)})&select=id,role,active,email,auth_user_id&limit=5`
      : `admin_users?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,role,active,email,auth_user_id&limit=5`
  );
  const active = (Array.isArray(rows) ? rows : []).filter((row) => row.active === true);
  const isOwner = active.some((row) => row.role === "owner");
  return { email, isOwner, adminRows: active };
}

async function findAuthUserByEmail(email) {
  const safe = String(email || "").trim().toLowerCase();
  if (!safe) return null;
  // Prefer filter endpoint when available; fall back to page scan.
  try {
    const filtered = await authAdmin(`users?email=${encodeURIComponent(safe)}`, { method: "GET" });
    if (Array.isArray(filtered?.users) && filtered.users.length) {
      const exact = filtered.users.find((u) => String(u.email || "").toLowerCase() === safe);
      return exact || filtered.users[0];
    }
    if (filtered?.id && String(filtered.email || "").toLowerCase() === safe) return filtered;
  } catch (_error) {
    /* continue to page scan */
  }

  for (let page = 1; page <= 10; page += 1) {
    const batch = await authAdmin(`users?page=${page}&per_page=200`, { method: "GET" });
    const users = Array.isArray(batch?.users) ? batch.users : Array.isArray(batch) ? batch : [];
    const match = users.find((u) => String(u.email || "").toLowerCase() === safe);
    if (match) return match;
    if (users.length < 200) break;
  }
  return null;
}

async function listUsers(body) {
  const page = Math.max(1, Number(body.page) || 1);
  const perPage = Math.min(100, Math.max(10, Number(body.per_page) || 50));
  const search = String(body.search || "").trim().toLowerCase();

  const authPayload = await authAdmin(`users?page=${page}&per_page=${perPage}`, { method: "GET" });
  let users = Array.isArray(authPayload?.users)
    ? authPayload.users
    : Array.isArray(authPayload)
      ? authPayload
      : [];

  if (search) {
    users = users.filter((u) => {
      const email = String(u.email || "").toLowerCase();
      const name = String(u.user_metadata?.full_name || u.user_metadata?.first_name || "").toLowerCase();
      return email.includes(search) || name.includes(search);
    });
  }

  const ids = users.map((u) => u.id).filter(Boolean);
  const profilesById = new Map();
  const adminByUserId = new Map();
  const adminByEmail = new Map();

  if (ids.length) {
    const filter = ids.join(",");
    const profiles = await rest(`profiles?id=in.(${filter})&select=id,is_admin,first_name`);
    for (const row of profiles || []) profilesById.set(row.id, row);
  }

  const adminRows = await rest(
    `admin_users?select=id,auth_user_id,email,display_name,role,active,created_at&order=email.asc&limit=500`
  );
  for (const row of adminRows || []) {
    if (row.auth_user_id) adminByUserId.set(row.auth_user_id, row);
    if (row.email) adminByEmail.set(String(row.email).toLowerCase(), row);
  }

  const mapped = users.map((u) => {
    const email = String(u.email || "").toLowerCase();
    const profile = profilesById.get(u.id) || null;
    const allow = adminByUserId.get(u.id) || adminByEmail.get(email) || null;
    const isAdmin = profile?.is_admin === true && (!allow || allow.active === true);
    return {
      id: u.id,
      email: u.email || "",
      display_name:
        allow?.display_name ||
        profile?.first_name ||
        u.user_metadata?.full_name ||
        u.user_metadata?.first_name ||
        "",
      is_admin: Boolean(isAdmin),
      profile_is_admin: profile?.is_admin === true,
      admin_user: allow
        ? {
            id: allow.id,
            role: allow.role,
            active: allow.active === true
          }
        : null,
      created_at: u.created_at || null,
      last_sign_in_at: u.last_sign_in_at || null
    };
  });

  // Also surface allow-list-only emails (invited before first sign-in)
  const listedEmails = new Set(mapped.map((u) => String(u.email || "").toLowerCase()).filter(Boolean));
  const pending = (adminRows || [])
    .filter((row) => row.active === true && row.email && !listedEmails.has(String(row.email).toLowerCase()))
    .filter((row) => !search || String(row.email).toLowerCase().includes(search) || String(row.display_name || "").toLowerCase().includes(search))
    .map((row) => ({
      id: row.auth_user_id || null,
      email: row.email,
      display_name: row.display_name || "",
      is_admin: true,
      profile_is_admin: false,
      pending_invite: true,
      admin_user: { id: row.id, role: row.role, active: true },
      created_at: row.created_at || null,
      last_sign_in_at: null
    }));

  return {
    success: true,
    page,
    per_page: perPage,
    users: [...pending, ...mapped]
  };
}

async function upsertAdminUser({ authUserId, email, displayName, role = "admin", active = true }) {
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail) throw Object.assign(new Error("email is required"), { statusCode: 400 });

  const existing = await rest(
    `admin_users?or=(email.eq.${encodeURIComponent(safeEmail)}${
      authUserId ? `,auth_user_id.eq.${encodeURIComponent(authUserId)}` : ""
    })&select=id,role,active&limit=5`
  );
  const row = Array.isArray(existing) && existing.length ? existing[0] : null;
  const payload = {
    email: safeEmail,
    display_name: displayName || null,
    auth_user_id: authUserId || null,
    role: row?.role === "owner" ? "owner" : role,
    active: Boolean(active)
  };

  if (row?.id) {
    await rest(`admin_users?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload)
    });
    return row.id;
  }

  const created = await rest("admin_users", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload)
  });
  return created?.[0]?.id || null;
}

async function setProfileAdmin(userId, isAdmin) {
  if (!userId) return;
  await rest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_admin: Boolean(isAdmin) })
  });
}

async function grantAccess(body, actor) {
  const email = String(body.email || "").trim().toLowerCase();
  const userId = String(body.user_id || "").trim();
  if (!email && !userId) {
    throw Object.assign(new Error("email or user_id is required"), { statusCode: 400 });
  }

  let authUser = null;
  if (userId) {
    authUser = await authAdmin(`users/${encodeURIComponent(userId)}`, { method: "GET" });
  } else {
    authUser = await findAuthUserByEmail(email);
  }

  const targetEmail = String(authUser?.email || email || "").trim().toLowerCase();
  if (!targetEmail) {
    throw Object.assign(new Error("Could not resolve that user email"), { statusCode: 404 });
  }

  const displayName =
    String(body.display_name || "").trim() ||
    authUser?.user_metadata?.full_name ||
    authUser?.user_metadata?.first_name ||
    targetEmail.split("@")[0];

  await upsertAdminUser({
    authUserId: authUser?.id || null,
    email: targetEmail,
    displayName,
    role: "admin",
    active: true
  });

  if (authUser?.id) {
    // Ensure profile row exists for login gate
    const profiles = await rest(`profiles?id=eq.${encodeURIComponent(authUser.id)}&select=id&limit=1`);
    if (!profiles?.length) {
      await rest("profiles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          id: authUser.id,
          first_name: displayName,
          is_admin: true
        })
      });
    } else {
      await setProfileAdmin(authUser.id, true);
    }
  }

  return {
    success: true,
    message: authUser?.id
      ? `${targetEmail} now has admin access.`
      : `${targetEmail} is on the admin allow-list. They will get full access after their first sign-in once a profile exists — ask them to sign in, then grant again if needed.`,
    email: targetEmail,
    user_id: authUser?.id || null
  };
}

async function revokeAccess(body, actor, actorContext) {
  const email = String(body.email || "").trim().toLowerCase();
  const userId = String(body.user_id || "").trim();
  if (!email && !userId) {
    throw Object.assign(new Error("email or user_id is required"), { statusCode: 400 });
  }

  if (userId && userId === actor.id) {
    throw Object.assign(new Error("You cannot revoke your own admin access."), { statusCode: 400 });
  }
  if (email && actorContext.email && email === actorContext.email) {
    throw Object.assign(new Error("You cannot revoke your own admin access."), { statusCode: 400 });
  }

  let authUser = null;
  if (userId) {
    try {
      authUser = await authAdmin(`users/${encodeURIComponent(userId)}`, { method: "GET" });
    } catch (_error) {
      authUser = null;
    }
  } else if (email) {
    authUser = await findAuthUserByEmail(email);
  }

  const targetEmail = String(authUser?.email || email || "").trim().toLowerCase();
  const targetId = authUser?.id || userId || null;

  const existing = await rest(
    `admin_users?or=(${[
      targetEmail ? `email.eq.${encodeURIComponent(targetEmail)}` : "",
      targetId ? `auth_user_id.eq.${encodeURIComponent(targetId)}` : ""
    ]
      .filter(Boolean)
      .join(",")})&select=id,role,active,email,auth_user_id&limit=5`
  );
  const rows = Array.isArray(existing) ? existing : [];
  if (rows.some((row) => row.role === "owner") && !actorContext.isOwner) {
    throw Object.assign(new Error("Only an owner can revoke another owner."), { statusCode: 403 });
  }

  for (const row of rows) {
    await rest(`admin_users?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ active: false })
    });
  }

  if (targetId) await setProfileAdmin(targetId, false);

  return {
    success: true,
    message: `${targetEmail || targetId} no longer has admin access.`,
    email: targetEmail || null,
    user_id: targetId
  };
}

/**
 * For invited admins: if allow-listed in admin_users but profiles.is_admin is still false,
 * activate the profile after their first successful Auth sign-in.
 * Does not require is_admin yet (unlike other actions).
 */
async function claimInvite(event) {
  const { supabaseUrl, serviceKey } = getConfig();
  const token = String(event.headers.authorization || event.headers.Authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) {
    throw Object.assign(new Error("Authentication is required"), { statusCode: 401 });
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) {
    throw Object.assign(new Error("Session is invalid or has expired"), { statusCode: 401 });
  }

  const email = String(user.email || "").trim().toLowerCase();
  if (!email) {
    throw Object.assign(new Error("Account email is missing"), { statusCode: 400 });
  }

  const allow = await rest(
    `admin_users?or=(auth_user_id.eq.${encodeURIComponent(user.id)},email.eq.${encodeURIComponent(email)})&select=id,active,role&limit=5`
  );
  const active = (Array.isArray(allow) ? allow : []).filter((row) => row.active === true);
  if (!active.length) {
    return { success: false, claimed: false, message: "No admin invite found for this account." };
  }

  await upsertAdminUser({
    authUserId: user.id,
    email,
    displayName: user.user_metadata?.full_name || user.user_metadata?.first_name || email.split("@")[0],
    role: active.some((row) => row.role === "owner") ? "owner" : "admin",
    active: true
  });

  const profiles = await rest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`);
  if (!profiles?.length) {
    await rest("profiles", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: user.id,
        first_name: user.user_metadata?.first_name || email.split("@")[0],
        is_admin: true
      })
    });
  } else {
    await setProfileAdmin(user.id, true);
  }

  return { success: true, claimed: true, message: "Admin access activated for this account." };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "claim_invite") {
      return jsonResponse(200, await claimInvite(event));
    }

    const actor = await requireAdmin(event);
    const actorContext = await loadActorContext(actor);

    if (action === "list") return jsonResponse(200, await listUsers(body));
    if (action === "grant") return jsonResponse(200, await grantAccess(body, actor));
    if (action === "revoke") return jsonResponse(200, await revokeAccess(body, actor, actorContext));

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    console.error("admin-users", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Admin users request failed"
    });
  }
};
