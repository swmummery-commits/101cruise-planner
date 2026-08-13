#!/usr/bin/env node
/**
 * Static checks for featured cruise admin save API + RLS migration.
 * Run: node scripts/test-featured-cruises-admin.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function assert(label, ok) {
  if (!ok) throw new Error(label);
  console.log(`ok: ${label}`);
}

const adminJs = read("js/admin.js");
const fnJs = read("netlify/functions/featured-cruises-admin.js");
const migration = read("supabase/migrations/20260813_featured_cruises_admin_access.sql");

assert("featured-cruises-admin function exists", /exports\.handler/.test(fnJs));
assert("save_cruise action", /action === "save_cruise"/.test(fnJs));
assert("replace_pricing action", /action === "replace_pricing"/.test(fnJs));
assert("requires admin JWT", /requireAdmin/.test(fnJs));
assert("uses service role writes", /SUPABASE_SERVICE_ROLE_KEY/.test(fnJs));

assert("admin.js calls featured-cruises-admin", /featured-cruises-admin/.test(adminJs));
assert("admin.js uses featuredCruisesAdminApi for cruise row", /featuredCruisesAdminApi\([\s\S]*?save_cruise/.test(adminJs));
assert("admin.js uses featuredCruisesAdminApi for pricing", /featuredCruisesAdminApi\([\s\S]*?replace_pricing/.test(adminJs));

assert("migration defines is_active_admin()", /CREATE OR REPLACE FUNCTION public\.is_active_admin/.test(migration));
assert("migration updates featured_cruises insert policy", /Admins can insert featured_cruises/.test(migration));
assert("migration checks admin_users", /admin_users au/.test(migration));

console.log("test-featured-cruises-admin.mjs: all checks passed");
