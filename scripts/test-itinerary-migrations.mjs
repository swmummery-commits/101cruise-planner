/**
 * Offline validation of itinerary auto-processing / exception migrations.
 * Does NOT connect to Supabase. Does NOT apply SQL.
 *
 * Run: node scripts/test-itinerary-migrations.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const autoPath = path.join(root, "supabase/migrations/20260726_itinerary_auto_processing.sql");
const excPath = path.join(root, "supabase/migrations/20260726_itinerary_exceptions_notifications.sql");
const adminUsersPath = path.join(
  root,
  "supabase/migrations/20260719_admin_users_and_booking_documents.sql"
);
const autoProcessLib = path.join(root, "netlify/functions/lib/itinerary-auto-process.js");
const notifyLib = path.join(root, "netlify/functions/lib/itinerary-notify.js");
const adminAuth = path.join(root, "netlify/functions/admin-auth.js");

const autoSql = readFileSync(autoPath, "utf8");
const excSql = readFileSync(excPath, "utf8");
const adminUsersSql = readFileSync(adminUsersPath, "utf8");
const autoLib = readFileSync(autoProcessLib, "utf8");
const notifySrc = readFileSync(notifyLib, "utf8");
const authSrc = readFileSync(adminAuth, "utf8");

/* Confirmed live Original admin_users identity (from 20260719 + OpenAPI audit) */
assert(/auth_user_id uuid NULL REFERENCES auth\.users\(id\)/.test(adminUsersSql), "admin_users auth_user_id defined");
assert(/active boolean NOT NULL DEFAULT true/.test(adminUsersSql), "admin_users.active defined");
assert(/id uuid PRIMARY KEY/.test(adminUsersSql), "admin_users.id PK");
assert(!/\buser_id\b/.test(adminUsersSql.split("CREATE TABLE IF NOT EXISTS public.admin_users")[1]?.slice(0, 800) || ""), "admin_users create has no user_id column");

/* No invalid au.user_id / au.is_active in either pending migration */
for (const [name, sql] of [
  ["auto_processing", autoSql],
  ["exceptions_notifications", excSql]
]) {
  assert(!/au\.user_id/.test(sql), `${name}: must not reference au.user_id`);
  assert(!/au\.is_active/.test(sql), `${name}: must not reference au.is_active`);
  assert(/au\.auth_user_id\s*=\s*auth\.uid\(\)/.test(sql), `${name}: RLS uses au.auth_user_id`);
  assert(/au\.active\s*=\s*true/.test(sql), `${name}: RLS uses au.active`);
}

/* Auto-processing objects are IF NOT EXISTS / DROP POLICY IF EXISTS (rerunnable) */
assert(/ADD COLUMN IF NOT EXISTS content_fingerprint/.test(autoSql), "fingerprint IF NOT EXISTS");
assert(/ADD COLUMN IF NOT EXISTS approval_method/.test(autoSql), "approval_method IF NOT EXISTS");
assert(/CREATE TABLE IF NOT EXISTS public\.cruise_itinerary_versions/.test(autoSql), "versions IF NOT EXISTS");
assert(/CREATE INDEX IF NOT EXISTS cruise_itineraries_source_hash_idx/.test(autoSql), "source hash index IF NOT EXISTS");
assert(/CREATE INDEX IF NOT EXISTS cruise_itineraries_processing_status_idx/.test(autoSql), "processing index IF NOT EXISTS");
assert(/CREATE INDEX IF NOT EXISTS booking_documents_itinerary_status_idx/.test(autoSql), "doc status index IF NOT EXISTS");
assert(/DROP POLICY IF EXISTS "Admins can select cruise_itinerary_versions"/.test(autoSql), "policy drop before create");
assert(!/DROP TABLE/.test(autoSql), "auto migration does not drop tables");
assert(!/UPDATE\s+public\.cruise_itineraries\s+SET/i.test(autoSql), "auto migration does not mutate itinerary rows");
assert(!/10175811/.test(autoSql), "auto migration does not hardcode booking 10175811");

/* Exceptions: FK type matches admin_users.id (uuid); recipients configurable */
assert(
  /assigned_admin_user_id uuid NULL REFERENCES public\.admin_users\(id\)/.test(excSql),
  "assignment FK → admin_users(id) uuid"
);
assert(/ADD COLUMN IF NOT EXISTS notify_itinerary_exceptions/.test(excSql), "notify flag IF NOT EXISTS");
assert(/CREATE TABLE IF NOT EXISTS public\.itinerary_exceptions/.test(excSql), "exceptions table IF NOT EXISTS");
assert(/CREATE TABLE IF NOT EXISTS public\.itinerary_exception_notifications/.test(excSql), "notifications table IF NOT EXISTS");
assert(!/steve@|paul@101cruise|stevem101/i.test(excSql), "no hardcoded Steve/Paul in exceptions migration");
assert(!/DROP TABLE/.test(excSql), "exceptions migration does not drop tables");

/* App auth uses same identity columns */
assert(/auth_user_id\.eq\./.test(authSrc), "admin-auth queries auth_user_id");
assert(/select=id,active,role/.test(authSrc), "admin-auth uses active not is_active");

/* System actor: text label only; uuid columns stay null for automation */
assert(/SYSTEM_APPROVER\s*=\s*"system:itinerary-auto-approve"/.test(autoLib), "system actor label defined");
assert(/function uuidActorOrNull/.test(autoLib), "uuid-safe actor helper present");
assert(/approved_by:\s*approve\s*\?\s*uuidActorOrNull\(actorId\)\s*:\s*null/.test(autoLib), "approved_by null for system");
assert(/approval_method:\s*approve\s*\?\s*"automated"/.test(autoLib), "approval_method marks automation");
assert(!/approved_by:\s*approve\s*\?\s*SYSTEM_APPROVER/.test(autoLib), "must not write SYSTEM_APPROVER into approved_by");
assert(/notify_itinerary_exceptions=eq\.true/.test(notifySrc), "recipients from admin_users flag");
assert(!/steve@|paul@101cruise|stevem101/i.test(notifySrc), "no hardcoded recipient emails");

/* Documented strategy in SQL */
assert(/approval_method = 'automated'/.test(autoSql) || /approved_by = NULL/.test(autoSql), "documents nullable system actor");
assert(/auth_user_id/.test(autoSql) && /NOT user_id/.test(autoSql), "documents correct auth column");

/* Lightweight SQL shape checks (no Postgres available locally) */
assert(/CREATE POLICY "Admins can select cruise_itinerary_versions"/.test(autoSql), "versions select policy");
assert(/ENABLE ROW LEVEL SECURITY/.test(autoSql), "RLS enabled on versions");
assert(/ENABLE ROW LEVEL SECURITY/.test(excSql), "RLS enabled on exception tables");

console.log("test-itinerary-migrations: ok");
console.log("  - no au.user_id / au.is_active");
console.log("  - RLS uses admin_users.auth_user_id + active");
console.log("  - assignment FK uuid → admin_users(id)");
console.log("  - IF NOT EXISTS / DROP POLICY IF EXISTS (rerunnable)");
console.log("  - system actor: approval_method + nullable approved_by");
console.log("  - no live SQL apply performed");
