#!/usr/bin/env node
/**
 * Destination schema backward-compatibility tests.
 * Run: npm run test:destination-schema-compat
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const dq = require(path.join(root, "netlify/functions/lib/destination-queries"));
const mode = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const missingColErr = {
  statusCode: 400,
  message: 'column destinations.classification_enabled does not exist',
  body: { code: '42703', message: 'column destinations.classification_enabled does not exist' }
};

assert(dq.isMissingClassificationEnabledColumnError(missingColErr), "detects production missing column");
assert(!dq.isMissingClassificationEnabledColumnError({ message: 'permission denied' }), "ignores auth errors");
assert(!dq.isMissingClassificationEnabledColumnError({ body: { code: '42703', message: 'column foo does not exist' } }), "ignores unrelated 42703");

// Pre-migration fetch
let call = 0;
const preMigrationFetch = async (path) => {
  call += 1;
  if (path.includes('classification_enabled')) throw missingColErr;
  return [{ id: '1', name: 'Alaska', slug: 'alaska', status: 'published' }];
};
const pre = await dq.loadInventoryDestinationBySlug(preMigrationFetch, 'alaska');
assert(pre?.slug === 'alaska', 'Cruise Finder inventory pre-migration');
assert(call === 2, 'pre-migration retries once');

// Post-migration fetch
call = 0;
const postMigrationFetch = async (path) => {
  call += 1;
  if (path.includes('classification_enabled')) {
    return [{ id: '1', name: 'Alaska', slug: 'alaska', status: 'published', classification_enabled: true }];
  }
  throw new Error('should not fallback');
};
const post = await dq.loadInventoryDestinationBySlug(postMigrationFetch, 'alaska');
assert(post?.slug === 'alaska', 'Cruise Finder inventory post-migration');
assert(call === 1, 'post-migration no retry');

// Hidden excluded pre-migration
const hiddenFetch = async (path) => {
  if (path.includes('classification_enabled')) throw missingColErr;
  return [{ id: '2', name: 'Hidden', slug: 'hidden', status: 'hidden' }];
};
assert(!(await dq.loadInventoryDestinationBySlug(hiddenFetch, 'hidden')), 'hidden excluded pre-migration');

// Archived excluded
const archivedFetch = async (path) => {
  if (path.includes('classification_enabled')) throw missingColErr;
  return [{ id: '3', name: 'Old', slug: 'old', status: 'archived' }];
};
assert(!(await dq.loadInventoryDestinationBySlug(archivedFetch, 'old')), 'archived excluded');

// Disabled post-migration
const disabledFetch = async () => [
  { id: '4', name: 'Off', slug: 'off', status: 'published', classification_enabled: false }
];
assert(!(await dq.loadInventoryDestinationBySlug(disabledFetch, 'off')), 'disabled excluded post-migration');

// Classification destinations load
const allPre = await dq.loadClassificationDestinations(async (path) => {
  if (path.includes('classification_enabled')) throw missingColErr;
  return [
    { id: '1', slug: 'alaska', name: 'Alaska', status: 'published' },
    { id: '2', slug: 'x', name: 'X', status: 'hidden' }
  ];
});
assert(allPre.length === 1 && allPre[0].slug === 'alaska', 'classification load pre-migration');

// Unrelated error propagates
let propagated = false;
try {
  await dq.loadClassificationDestinations(async () => {
    throw new Error('network down');
  });
} catch (e) {
  propagated = e.message === 'network down';
}
assert(propagated, 'unrelated errors propagate');

// Public safe inventory shape
assert(!('classification_enabled' in (pre || {})), 'inventory shape omits editorial flag');

// Write modes
assert(mode.resolveHalDiscoveryMode('production_read_only').writes_allowed === false, 'read-only blocked');
assert(mode.resolveHalDiscoveryMode('production_write').writes_allowed === false, 'write flag blocked');

// Smoke handler rejects write mode
const smoke = require(path.join(root, "netlify/functions/hal-discovery-smoke"));
process.env.DISCOVERY_CRON_SECRET = 'test-secret';
const badMode = await smoke.handler({
  httpMethod: 'POST',
  headers: { 'x-discovery-cron-secret': 'test-secret' },
  body: JSON.stringify({ mode: 'production_write' })
});
assert(JSON.parse(badMode.body).error === 'smoke_read_only_only', 'smoke rejects write mode');

console.log(`test-destination-schema-compat: ${passed} passed`);
