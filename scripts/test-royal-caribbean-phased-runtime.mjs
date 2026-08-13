import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const phased = require('../netlify/functions/lib/royal-caribbean-phased-enumeration');
const store = require('../netlify/functions/lib/royal-caribbean-phased-enumeration-store');
const phasedWeekly = require('../netlify/functions/lib/royal-caribbean-phased-weekly-dry-run');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

test('six deterministic source phases', () => {
  assert.deepEqual(phased.PHASE_SPECS.map((p) => p.id), ['a-25','a-50','a-100','b-25','b-50','b-100']);
});
test('page size 100 is until-empty phase in both passes', () => {
  const rows = phased.PHASE_SPECS.filter((p) => p.page_size === 100);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((p) => p.until_empty === true && p.stop_at_total === false));
});
test('next phase is deterministic', () => {
  assert.equal(phased.nextPhaseId('a-25'), 'a-50');
  assert.equal(phased.nextPhaseId('b-100'), null);
});
test('invalid phase is rejected by lookup', () => {
  assert.equal(phased.phaseSpec('x-25'), null);
});
test('raw products dedupe on official sailing identity', () => {
  const merged = phased.mergeRawProducts([
    { products: [{ official_sailing_id: 'A_2027-01-01', departure_date: '2027-01-01' }] },
    { products: [{ official_sailing_id: 'A_2027-01-01', departure_date: '2027-01-01' }, { official_sailing_id: 'B_2027-01-02', departure_date: '2027-01-02' }] }
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((p) => p.official_sailing_id), ['A_2027-01-01','B_2027-01-02']);
});
test('product shards are deliberately small', () => {
  assert.ok(store.PRODUCT_SHARD_SIZE > 0 && store.PRODUCT_SHARD_SIZE <= 200);
});
test('phased weekly module exposes dry-run only entry point', () => {
  assert.equal(typeof phasedWeekly.runRoyalCaribbeanPhasedWeeklyDryRun, 'function');
  assert.equal(Object.prototype.hasOwnProperty.call(phasedWeekly, 'apply'), false);
});
test('phase store exposes no production write method', () => {
  assert.equal(typeof store.saveEnumerationPhase, 'function');
  assert.equal(Object.keys(store).some((key) => /supabase|cruise.*write|apply/i.test(key)), false);
});

console.log(`Royal Caribbean phased runtime tests: ${passed} passed`);
