/**
 * Provider base interface for Engine V2.
 */

class CruiseDiscoveryProvider {
  /** @returns {string} */
  get id() {
    throw new Error("Provider id getter not implemented.");
  }

  /** @returns {{ suitable: boolean, recommendation: string, reasons: string[] }} */
  getFeasibility() {
    return {
      suitable: false,
      recommendation: "DO_NOT_PROCEED",
      reasons: ["Not implemented."]
    };
  }

  /**
   * @param {import("../contracts").NormalisedSearchRequest} _request
   * @returns {Promise<{ ok: boolean, candidates?: object[], error?: object, meta?: object }>}
   */
  async search(_request) {
    throw new Error("Provider search() not implemented.");
  }

  /**
   * @param {object} _candidateReference
   * @returns {Promise<{ ok: boolean, details?: object, error?: object }>}
   */
  async getCruiseDetails(_candidateReference) {
    throw new Error("Provider getCruiseDetails() not implemented.");
  }

  /**
   * @param {object} rawCruise
   * @returns {object}
   */
  normalise(rawCruise) {
    return rawCruise;
  }
}

module.exports = {
  CruiseDiscoveryProvider
};
