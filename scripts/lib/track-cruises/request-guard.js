/**
 * Sprint 15A — hard cap on live Track.cruises API calls (free tier: 100/mo).
 */

const DEFAULT_MAX_LIVE_CALLS = 5;

class TrackCruisesRequestGuard {
  /**
   * @param {{ maxLiveCalls?: number, persistPath?: string }} [options]
   */
  constructor(options = {}) {
    this.maxLiveCalls = Number(options.maxLiveCalls) || DEFAULT_MAX_LIVE_CALLS;
    this.liveCalls = 0;
    this.log = [];
    this.persistPath = options.persistPath || null;
  }

  remaining() {
    return Math.max(0, this.maxLiveCalls - this.liveCalls);
  }

  assertLiveAllowed(reason) {
    if (this.liveCalls >= this.maxLiveCalls) {
      throw new Error(
        `Track.cruises live call refused: already used ${this.liveCalls}/${this.maxLiveCalls} (${reason}).`
      );
    }
  }

  assertNotPagination(params) {
    if (params && (params.starting_after || params.cursor || params.page || params.offset)) {
      throw new Error("Track.cruises pagination is refused by the validation guard.");
    }
  }

  assertNotBulk(params) {
    const limit = params && params.limit != null ? Number(params.limit) : null;
    if (limit != null && limit > 10) {
      throw new Error("Track.cruises bulk import / large limit is refused by the validation guard.");
    }
    if (params && (params.bulk === true || params.import === true)) {
      throw new Error("Track.cruises bulk import is refused by the validation guard.");
    }
  }

  record(endpoint, ok) {
    this.liveCalls += 1;
    this.log.push({
      n: this.liveCalls,
      endpoint,
      ok: Boolean(ok),
      at: new Date().toISOString()
    });
  }
}

module.exports = {
  DEFAULT_MAX_LIVE_CALLS,
  TrackCruisesRequestGuard
};
