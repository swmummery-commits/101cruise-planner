/**
 * Lightweight phase timing for Holland America batch runs.
 */

function createHalBatchTiming() {
  const phases = {};
  const order = [];
  let batchStarted = null;

  return {
    startBatch() {
      batchStarted = Date.now();
    },
    start(phase) {
      phases[phase] = { started_at: Date.now(), ended_at: null, ms: 0 };
      if (!order.includes(phase)) order.push(phase);
    },
    end(phase) {
      const row = phases[phase];
      if (!row?.started_at) return;
      row.ended_at = Date.now();
      row.ms = row.ended_at - row.started_at;
    },
    add(phase, ms) {
      phases[phase] = phases[phase] || { started_at: null, ended_at: null, ms: 0 };
      phases[phase].ms += Math.max(0, Number(ms) || 0);
      if (!order.includes(phase)) order.push(phase);
    },
    snapshot() {
      const breakdown = {};
      for (const phase of order) {
        breakdown[phase] = phases[phase]?.ms || 0;
      }
      const tracked = Object.values(breakdown).reduce((a, b) => a + b, 0);
      const total_ms = batchStarted ? Date.now() - batchStarted : tracked;
      return {
        breakdown,
        tracked_ms: tracked,
        total_ms,
        unaccounted_ms: Math.max(0, total_ms - tracked)
      };
    }
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const list = items || [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let index = 0;
  const workers = Math.min(Math.max(1, limit), list.length);

  async function worker() {
    while (index < list.length) {
      const i = index;
      index += 1;
      results[i] = await fn(list[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

module.exports = {
  createHalBatchTiming,
  mapWithConcurrency
};
