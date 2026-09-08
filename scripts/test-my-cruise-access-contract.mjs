import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const access = read('netlify/functions/customer-access.js');
const refresh = read('netlify/functions/customer-refresh-booking.js');
const resolver = read('netlify/functions/customer-booking-access-service.js');
const sessionAuth = read('netlify/functions/lib/customer-session-auth.js');
const preflight = read('js/customer-session-preflight.js');

// Customer login must use the hardened resolver that accepts either traveller.
assert.match(
  access,
  /require\(['"]\.\/customer-booking-access-service['"]\)/,
  'customer-access.js must use customer-booking-access-service'
);
assert.doesNotMatch(
  access,
  /syncDocumentsForBooking/,
  'customer login must never run document synchronisation on the authentication path'
);
assert.match(
  access,
  /CACHE_WRITE_BUDGET_MS/,
  'customer login cache work must stay bounded and non-critical'
);

// Remembered-session restoration must also stay lightweight.
assert.doesNotMatch(
  refresh,
  /syncDocumentsForBooking/,
  'customer-refresh-booking must not synchronise or process documents during page startup'
);
assert.match(
  refresh,
  /CACHE_WRITE_BUDGET_MS/,
  'customer refresh cache work must stay bounded and non-critical'
);

// Both travellers, including cached raw payloads, are valid surname candidates.
assert.match(resolver, /booking\.passenger1_last_name/);
assert.match(resolver, /booking\.passenger2_last_name/);
assert.match(resolver, /raw\?\.passenger1_last_name/);
assert.match(resolver, /raw\?\.passenger2_last_name/);
assert.match(resolver, /normalize\("NFKD"\)/);
assert.match(resolver, /replace\(\/\[\^A-Z0-9\]\+\/g, ""\)/);

// Old customer sessions must not silently survive authentication changes.
assert.match(sessionAuth, /CUSTOMER_SESSION_VERSION\s*=\s*2/);
assert.match(preflight, /CUSTOMER_SESSION_VERSION\s*=\s*2/);
assert.match(preflight, /recoverImpossibleEmptyDashboard/);
assert.match(preflight, /clearLegacySupabaseAuth/);

console.log('My Cruise access contract: PASS');
