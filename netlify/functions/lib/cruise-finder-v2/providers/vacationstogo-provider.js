/**
 * Vacations To Go provider — Phase 1D feasibility probe result.
 *
 * Outcome: NOT suitable as an automated structured discovery provider.
 * robots.txt disallows ticker/fastdeal/pinfo (primary deal & product paths).
 * Search is form/session oriented; no stable public cruise detail URLs found.
 * This module does not scrape, crawl, or bypass restrictions.
 */

const { CruiseDiscoveryProvider } = require("./provider-base");

const FEASIBILITY = Object.freeze({
  suitable: false,
  recommendation: "DO_NOT_PROCEED_WITH_THIS_PROVIDER",
  reasons: [
    "robots.txt Disallow covers /ticker.cfm, /fastdeal.cfm, /pinfo.cfm, /pinfo/, /cfc/, /secure/",
    "Custom Search posts toward ticker.cfm (robots-disallowed deal listing path)",
    "No stable public cruise detail URL or providerCruiseId pattern found in allowed pages",
    "Pages set session cookies; listing content appears form/session dependent",
    "No JSON-LD / structured itinerary endpoints observed on allowed GETs",
    "Terms and anti-bot posture make automated harvesting operationally unsuitable"
  ],
  reliablyAvailable: [],
  unavailableOrInconsistent: [
    "cruise line",
    "ship",
    "departure date",
    "nights",
    "departure port",
    "arrival port",
    "ordered itinerary",
    "stable source URL / cruise id"
  ],
  probeSummary: {
    robotsFetched: true,
    captchaObserved: false,
    cloudflareChallengeObserved: false,
    setCookieObserved: true,
    jsonLdObserved: false,
    maxRequestsUsed: 9
  }
});

class VacationstogoProvider extends CruiseDiscoveryProvider {
  get id() {
    return "vacationstogo";
  }

  getFeasibility() {
    return { ...FEASIBILITY };
  }

  async search(_request) {
    return {
      ok: false,
      candidates: [],
      error: {
        code: "provider_unsuitable",
        message:
          "Vacationstogo is not suitable for automated Engine V2 discovery (robots + form/session + no stable cruise ids)."
      },
      meta: { feasibility: this.getFeasibility() }
    };
  }

  async getCruiseDetails(_ref) {
    return {
      ok: false,
      error: {
        code: "provider_unsuitable",
        message: "Vacationstogo getCruiseDetails is not implemented (provider unsuitable)."
      }
    };
  }

  normalise(rawCruise) {
    return rawCruise;
  }
}

module.exports = {
  VacationstogoProvider,
  FEASIBILITY
};
