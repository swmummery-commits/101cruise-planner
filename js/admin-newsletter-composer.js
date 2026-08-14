/**
 * Newsletter Issue Composer — newsletter-first workspace.
 *
 * Newsletters are persisted in public.newsletters. Each Featured Cruise links via
 * newsletter_id (canonical) with newsletter_number/date kept in sync for legacy queries.
 */
(function (global) {
  "use strict";

  /** @deprecated Migrated to newsletters.design_template — read once for legacy browser data. */
  const TEMPLATE_STORAGE_KEY = "101cruise.newsletterIssue.templateByNumber.temporary";

  let newsletters = [];
  let activeNewsletterId = null;
  let preferCreatePanel = false;
  let issueNumber = null;
  let issueDate = "";
  let issueTemplate = "green-price-cards";
  let issuePricingByCruiseId = {};
  let issuePricingLoadedFor = "";
  let issueBusy = false;
  let issueMessage = "";
  let issueMessageTone = "";
  let issueWarnings = [];
  let routeMapSaveResults = [];
  let routeMapSaveBusy = false;
  let routeMapBatchId = 0;
  const ROUTE_MAP_FETCH_MS = 120000;
  let issueHtml = {
    airline: "",
    general: "",
    previewMode: "",
    previewHtml: "",
    filename: "",
    label: ""
  };
  let issueCache = { key: "", airline: null, general: null };
  let addPickerOpen = false;
  let addPickerSelected = new Set();
  let draggedCruiseId = null;
  let dragFromHandle = false;

  function esc(value) {
    if (typeof global.esc === "function") return global.esc(value);
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (typeof global.formatAdminDate === "function") return global.formatAdminDate(value);
    return value || "—";
  }

  function getCruises() {
    return Array.isArray(global.featuredCruises) ? global.featuredCruises : [];
  }

  function getDefaults() {
    return (
      global.featuredNewsletterDefaults || {
        newsletter_number: null,
        newsletter_publication_date: null
      }
    );
  }

  function getCruiseLines() {
    return Array.isArray(global.ciCruiseLines) ? global.ciCruiseLines : [];
  }

  function getCruiseShips() {
    return Array.isArray(global.ciCruiseShips) ? global.ciCruiseShips : [];
  }

  function invalidateCache() {
    issueCache = { key: "", airline: null, general: null };
    issueHtml = {
      airline: "",
      general: "",
      previewMode: "",
      previewHtml: "",
      filename: "",
      label: ""
    };
  }

  function loadTemplateMap() {
    // TEMPORARY: browser-only until a newsletter_issues table (or similar) exists.
    try {
      const primary = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || "{}") || {};
      // Migrate once from the pre-marked temporary key if present.
      const legacyKey = "101cruise.newsletterIssue.templateByNumber";
      if (!Object.keys(primary).length) {
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || "{}") || {};
        if (Object.keys(legacy).length) {
          localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(legacy));
          return legacy;
        }
      }
      return primary;
    } catch {
      return {};
    }
  }

  function saveTemplateForNumber(number, template) {
    // TEMPORARY: browser-only until issue-level DB persistence exists.
    const map = loadTemplateMap();
    map[String(number)] = template;
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(map));
  }

  function templateForNumber(number) {
    const map = loadTemplateMap();
    const stored = map[String(number)];
    if (stored === "classic-editorial" || stored === "green-price-cards") return stored;
    return "green-price-cards";
  }

  function getActiveNewsletter() {
    if (activeNewsletterId) {
      const row = newsletters.find((n) => n.id === activeNewsletterId);
      if (row) return row;
    }
    if (issueNumber != null) {
      return newsletters.find((n) => Number(n.newsletter_number) === Number(issueNumber)) || null;
    }
    return null;
  }

  async function loadNewslettersFromDb() {
    const client = global.supabaseClient;
    if (!client) {
      newsletters = [];
      return newsletters;
    }
    const { data, error } = await client
      .from("newsletters")
      .select("id,newsletter_number,newsletter_date,design_template,created_at,updated_at")
      .order("newsletter_number", { ascending: false });
    if (error) {
      // Table may not exist until migration is applied — fall back to cruise-derived issues.
      console.warn("newsletters load skipped", error.message);
      newsletters = [];
      return newsletters;
    }
    newsletters = data || [];
    global.newsletters = newsletters;
    return newsletters;
  }

  function migrateTemplateFromLocalStorage(number) {
    try {
      const map = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || "{}") || {};
      const stored = map[String(number)];
      if (stored === "classic-editorial" || stored === "green-price-cards") return stored;
    } catch {
      /* ignore */
    }
    return null;
  }

  function availableNewsletterNumbers() {
    const set = new Set(newsletters.map((n) => Number(n.newsletter_number)).filter(Number.isFinite));
    for (const row of getCruises()) {
      if (row.newsletter_number != null && row.newsletter_number !== "") {
        set.add(Number(row.newsletter_number));
      }
    }
    const defaults = getDefaults();
    if (defaults.newsletter_number != null && defaults.newsletter_number !== "") {
      set.add(Number(defaults.newsletter_number));
    }
    if (issueNumber != null) set.add(Number(issueNumber));
    return [...set].filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
  }

  function syncActiveFromNewsletter(row) {
    if (!row) {
      activeNewsletterId = null;
      issueNumber = null;
      issueDate = "";
      issueTemplate = "green-price-cards";
      return;
    }
    activeNewsletterId = row.id;
    issueNumber = Number(row.newsletter_number);
    issueDate = row.newsletter_date || resolveIssueDate(issueNumber) || "";
    issueTemplate =
      row.design_template === "classic-editorial" ? "classic-editorial" : "green-price-cards";
  }

  function cruisesForCurrentIssue() {
    const cruises = getCruises();
    const num = issueNumber != null && issueNumber !== "" ? Number(issueNumber) : null;
    const seen = new Set();
    const matched = [];
    for (const row of cruises) {
      const inIssue =
        (activeNewsletterId && row.newsletter_id === activeNewsletterId) ||
        (num != null && Number(row.newsletter_number) === num);
      if (!inIssue || seen.has(row.id)) continue;
      seen.add(row.id);
      matched.push(row);
    }
    if (!matched.length) return [];
    return matched.sort((a, b) => {
      const order = Number(a.display_order || 0) - Number(b.display_order || 0);
      if (order) return order;
      return String(a.headline || "").localeCompare(String(b.headline || ""), "en");
    });
  }

  function unassignedCruises() {
    const num = Number(issueNumber);
    return getCruises()
      .filter((row) => {
        if ((row.publication_status || "draft") === "archived") return false;
        if (row.newsletter_number == null || row.newsletter_number === "") return true;
        if (issueNumber == null || issueNumber === "") return false;
        return Number(row.newsletter_number) !== num;
      })
      .sort((a, b) => String(a.headline || "").localeCompare(String(b.headline || ""), "en"));
  }

  function unnumberedCruises() {
    return getCruises()
      .filter((row) => {
        if ((row.publication_status || "draft") === "archived") return false;
        return row.newsletter_number == null || row.newsletter_number === "";
      })
      .sort((a, b) => String(a.headline || "").localeCompare(String(b.headline || ""), "en"));
  }

  function resolveIssueDate(number) {
    const cruises = getCruises().filter((row) => Number(row.newsletter_number) === Number(number));
    const dates = cruises.map((c) => c.newsletter_publication_date).filter(Boolean);
    if (dates.length) {
      const counts = {};
      for (const d of dates) counts[d] = (counts[d] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];
    }
    const defaults = getDefaults();
    if (Number(defaults.newsletter_number) === Number(number) && defaults.newsletter_publication_date) {
      return defaults.newsletter_publication_date;
    }
    return "";
  }

  function ensureIssueSelected() {
    if (!newsletters.length && global.supabaseClient) {
      /* async load happens in onCruisesReloaded / render prep */
    }
    if (preferCreatePanel) return;
    if (activeNewsletterId) {
      const row = newsletters.find((n) => n.id === activeNewsletterId);
      if (row) {
        syncActiveFromNewsletter(row);
        return;
      }
    }
    const numbers = availableNewsletterNumbers();
    const defaults = getDefaults();
    if (issueNumber == null || issueNumber === "") {
      if (newsletters.length) {
        syncActiveFromNewsletter(newsletters[0]);
      } else if (defaults.newsletter_number != null && defaults.newsletter_number !== "") {
        issueNumber = Number(defaults.newsletter_number);
        issueDate = resolveIssueDate(issueNumber) || defaults.newsletter_publication_date || "";
        const migrated = migrateTemplateFromLocalStorage(issueNumber);
        issueTemplate = migrated || templateForNumber(issueNumber);
      } else if (numbers.length) {
        issueNumber = numbers[0];
        issueDate = resolveIssueDate(issueNumber) || "";
        issueTemplate = templateForNumber(issueNumber);
      } else {
        issueNumber = null;
        activeNewsletterId = null;
      }
    } else if (issueNumber != null) {
      const row = newsletters.find((n) => Number(n.newsletter_number) === Number(issueNumber));
      if (row) syncActiveFromNewsletter(row);
      else {
        issueDate = resolveIssueDate(issueNumber) || defaults.newsletter_publication_date || "";
        issueTemplate = templateForNumber(issueNumber);
      }
    }
  }

  async function createNewsletter() {
    const numberInput = document.getElementById("newsletterCreateNumber");
    const dateInput = document.getElementById("newsletterCreateDate");
    const rawNumber = numberInput?.value ?? "";
    const nextNumber = Number(rawNumber);
    if (!Number.isFinite(nextNumber) || nextNumber < 1) {
      issueMessage = "Enter a newsletter number (for example 77).";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const nextDate = String(dateInput?.value || "").trim();
    if (!nextDate) {
      issueMessage = "Enter the newsletter date.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const duplicate = newsletters.find((n) => Number(n.newsletter_number) === nextNumber);
    if (duplicate) {
      issueMessage = `Newsletter ${nextNumber} already exists. Open it from the list or choose another number.`;
      issueMessageTone = "error";
      rerender();
      return;
    }
    const client = global.supabaseClient;
    if (!client) {
      issueMessage = "Database client is not ready.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    try {
      issueBusy = true;
      issueMessage = "Creating newsletter…";
      issueMessageTone = "running";
      rerender();
      const migratedTemplate = migrateTemplateFromLocalStorage(nextNumber) || "green-price-cards";
      const { data, error } = await client
        .from("newsletters")
        .insert({
          newsletter_number: nextNumber,
          newsletter_date: nextDate,
          design_template: migratedTemplate
        })
        .select("id,newsletter_number,newsletter_date,design_template")
        .single();
      if (error) {
        if (/duplicate|unique/i.test(error.message || "")) {
          throw new Error(`Newsletter ${nextNumber} already exists. Choose another number.`);
        }
        throw new Error(error.message || "Could not create newsletter.");
      }
      newsletters.unshift(data);
      global.newsletters = newsletters;
      syncActiveFromNewsletter(data);
      preferCreatePanel = false;
      invalidateCache();
      issuePricingLoadedFor = "";
      await client.from("featured_cruise_newsletter_defaults").upsert({
        id: 1,
        newsletter_number: nextNumber,
        newsletter_publication_date: nextDate
      });
      global.featuredNewsletterDefaults = {
        newsletter_number: nextNumber,
        newsletter_publication_date: nextDate
      };
      issueMessage = `Newsletter ${nextNumber} created. Add cruises below.`;
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not create newsletter.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  /** @deprecated Use createNewsletter — kept for any stale onclick handlers. */
  async function startIssue() {
    return createNewsletter();
  }

  async function saveNewsletter() {
    if (issueBusy || routeMapSaveBusy) return;
    const active = getActiveNewsletter();
    if (!active?.id) {
      issueMessage = "Create or open a newsletter before saving.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const numberInput = document.getElementById("newsletterWorkspaceNumber");
    const dateInput = document.getElementById("newsletterWorkspaceDate");
    const templateSelect = document.getElementById("newsletterIssueTemplate");
    const rawNumber = numberInput?.value ?? active.newsletter_number;
    const nextNumber = Number(rawNumber);
    const nextDate = String(dateInput?.value || "").trim();
    const nextTemplate =
      templateSelect?.value === "classic-editorial" ? "classic-editorial" : "green-price-cards";

    if (!Number.isFinite(nextNumber) || nextNumber < 1) {
      issueMessage = "Newsletter number must be a whole number of at least 1.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    if (!nextDate) {
      issueMessage = "Newsletter date is required.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const duplicate = newsletters.find(
      (n) => Number(n.newsletter_number) === nextNumber && n.id !== active.id
    );
    if (duplicate) {
      issueMessage = `Newsletter number ${nextNumber} is already used by another issue.`;
      issueMessageTone = "error";
      rerender();
      return;
    }

    const client = global.supabaseClient;
    if (!client) {
      issueMessage = "Database client is not ready.";
      issueMessageTone = "error";
      rerender();
      return;
    }

    const batchId = ++routeMapBatchId;

    const runSave = async () => {
    try {
      issueBusy = true;
      routeMapSaveBusy = true;
      routeMapSaveResults = [];
      issueMessage = "Saving newsletter…";
      issueMessageTone = "running";
      rerender();

      const { data: savedNewsletter, error: newsletterError } = await client
        .from("newsletters")
        .update({
          newsletter_number: nextNumber,
          newsletter_date: nextDate,
          design_template: nextTemplate
        })
        .eq("id", active.id)
        .select("id,newsletter_number,newsletter_date,design_template")
        .single();
      if (newsletterError) {
        if (/duplicate|unique/i.test(newsletterError.message || "")) {
          throw new Error(`Newsletter number ${nextNumber} is already in use.`);
        }
        throw new Error(newsletterError.message || "Could not save newsletter.");
      }
      const idx = newsletters.findIndex((n) => n.id === active.id);
      if (idx >= 0) newsletters[idx] = savedNewsletter;
      else newsletters.unshift(savedNewsletter);
      global.newsletters = newsletters;
      syncActiveFromNewsletter(savedNewsletter);
      issueTemplate = nextTemplate;

      // Sync linkage fields only — never overwrite unrelated cruise content.
      const { data: linkedById, error: linkedByIdError } = await client
        .from("featured_cruises")
        .select("id")
        .eq("newsletter_id", savedNewsletter.id);
      if (linkedByIdError) throw new Error(linkedByIdError.message);

      const { data: linkedByNumber, error: linkedByNumberError } = await client
        .from("featured_cruises")
        .select("id")
        .eq("newsletter_number", nextNumber)
        .is("newsletter_id", null);
      if (linkedByNumberError) throw new Error(linkedByNumberError.message);

      const cruiseIds = [
        ...new Set([...(linkedById || []).map((r) => r.id), ...(linkedByNumber || []).map((r) => r.id)])
      ];

      if (cruiseIds.length) {
        const syncPayload = {
          newsletter_id: savedNewsletter.id,
          newsletter_number: nextNumber,
          newsletter_publication_date: nextDate
        };
        const updates = cruiseIds.map((id) =>
          client.from("featured_cruises").update(syncPayload).eq("id", id)
        );
        const results = await Promise.all(updates);
        const failed = results.find((r) => r.error);
        if (failed) throw new Error(failed.error.message);
        for (const cruise of getCruises()) {
          if (!cruiseIds.includes(cruise.id)) continue;
          cruise.newsletter_id = savedNewsletter.id;
          cruise.newsletter_number = nextNumber;
          cruise.newsletter_publication_date = nextDate;
        }
      }

      await client.from("featured_cruise_newsletter_defaults").upsert({
        id: 1,
        newsletter_number: nextNumber,
        newsletter_publication_date: nextDate
      });
      global.featuredNewsletterDefaults = {
        newsletter_number: nextNumber,
        newsletter_publication_date: nextDate
      };

      invalidateCache();
      issueMessage = "Newsletter saved. Generating missing route maps…";
      issueMessageTone = "running";
      rerender();

      if (batchId !== routeMapBatchId) return;

      const cruises = cruisesForCurrentIssue();
      const mapResults = await generateMissingRouteMaps(cruises, { batchId });
      if (batchId !== routeMapBatchId) return;

      routeMapSaveResults = mapResults;

      if (typeof global.loadFeaturedCruises === "function") {
        await global.loadFeaturedCruises();
      }

      const generated = mapResults.filter((r) => r.status === "generated").length;
      const retained = mapResults.filter((r) => r.status === "retained").length;
      const needsCoords = mapResults.filter((r) => r.status === "needs_coordinates").length;
      const failedMaps = mapResults.filter((r) => r.status === "failed");

      const parts = ["Newsletter saved"];
      if (generated) parts.push(`${generated} route map${generated === 1 ? "" : "s"} generated`);
      if (retained) parts.push(`${retained} existing route map${retained === 1 ? "" : "s"} retained`);
      if (needsCoords) parts.push(`${needsCoords} cruise${needsCoords === 1 ? "" : "s"} need coordinates`);
      if (failedMaps.length) parts.push(`${failedMaps.length} route map failure${failedMaps.length === 1 ? "" : "s"}`);

      issueMessage = parts.join(" · ");
      issueMessageTone = failedMaps.length ? "error" : "success";
    } catch (error) {
      issueMessage = error.message || "Could not save newsletter.";
      issueMessageTone = "error";
    } finally {
      if (batchId === routeMapBatchId) {
        issueBusy = false;
        routeMapSaveBusy = false;
        rerender();
      }
    }
    };

    if (typeof global.AdminLoading?.withSaving === "function") {
      await global.AdminLoading.withSaving(runSave, {
        key: "newsletter-save",
        supportMessage: "Saving newsletter…"
      });
    } else {
      await runSave();
    }
  }

  async function fetchRouteMapGenerate(body, { batchId } = {}) {
    if (batchId != null && batchId !== routeMapBatchId) {
      throw new Error("Route map batch superseded.");
    }
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
        : { "Content-Type": "application/json" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROUTE_MAP_FETCH_MS);
    try {
      const response = await fetch("/.netlify/functions/route-map-generate", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Route map generation timed out. Try again or use Generate on the cruise form.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generateMissingRouteMaps(cruises, { batchId } = {}) {
    const results = [];
    const inFlight = new Set();
    for (const cruise of cruises) {
      if (batchId != null && batchId !== routeMapBatchId) break;
      const name = cruise.headline || "Untitled cruise";
      const hasGenerated =
        Boolean(cruise.route_map_png_path && cruise.route_map_svg_path) ||
        Boolean(cruise.route_map_generated_at);
      const hasManual = Boolean(cruise.route_map_media_id || cruise.route_map_image_url);
      if (hasGenerated || hasManual) {
        results.push({ cruiseId: cruise.id, name, status: "retained" });
        continue;
      }
      const canGenerate =
        typeof global.featuredCruiseCanGenerateRouteMap === "function"
          ? global.featuredCruiseCanGenerateRouteMap(cruise)
          : false;
      if (!canGenerate) {
        results.push({
          cruiseId: cruise.id,
          name,
          status: "needs_coordinates",
          message: "Add itinerary port coordinates before a route map can be generated."
        });
        continue;
      }
      if (inFlight.has(cruise.id)) continue;
      inFlight.add(cruise.id);
      try {
        const { response, data } = await fetchRouteMapGenerate(
          {
            action: "generate",
            featured_cruise_id: cruise.id,
            png_width: 2000,
            force_reroute: false
          },
          { batchId }
        );
        if (response.ok && data.ok) {
          results.push({ cruiseId: cruise.id, name, status: "generated" });
          if (typeof global.loadFeaturedCruises === "function") {
            await global.loadFeaturedCruises();
          }
        } else {
          const errMsg =
            data.errors?.[0]?.message || data.error || "Route map generation failed.";
          results.push({ cruiseId: cruise.id, name, status: "failed", message: errMsg });
        }
      } catch (error) {
        results.push({
          cruiseId: cruise.id,
          name,
          status: "failed",
          message: error.message || "Route map generation failed."
        });
      } finally {
        inFlight.delete(cruise.id);
      }
    }
    return results;
  }

  async function retryRouteMapForCruise(cruiseId) {
    const cruise = getCruises().find((c) => c.id === cruiseId);
    if (!cruise) return;
    try {
      issueBusy = true;
      routeMapSaveBusy = true;
      issueMessage = `Generating route map for ${cruise.headline || "cruise"}…`;
      issueMessageTone = "running";
      rerender();
      const [result] = await generateMissingRouteMaps([cruise], { batchId: ++routeMapBatchId });
      routeMapSaveResults = [result];
      if (typeof global.loadFeaturedCruises === "function") await global.loadFeaturedCruises();
      issueMessage =
        result.status === "generated"
          ? `Route map generated for ${result.name}.`
          : result.message || "Route map generation failed.";
      issueMessageTone = result.status === "generated" ? "success" : "error";
    } catch (error) {
      issueMessage = error.message || "Route map generation failed.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      routeMapSaveBusy = false;
      rerender();
    }
  }

  function heroThumbUrl(cruise) {
    if (typeof global.resolveFeaturedCruiseImages === "function") {
      const resolved = global.resolveFeaturedCruiseImages(cruise);
      if (resolved?.hero?.url) return resolved.hero.url;
    }
    return (
      cruise.hero_image_url ||
      cruise.ci_cruise_ships?.hero_image_url ||
      ""
    );
  }

  function collectWarnings(cruises) {
    const warnings = [];
    for (const cruise of cruises) {
      const name = cruise.headline || "Untitled cruise";
      const pricing = issuePricingByCruiseId[cruise.id] || [];
      const hasPrice = pricing.some(
        (p) =>
          p.brochure_price != null ||
          p.cruise_101_price != null ||
          p.airline_price != null
      );
      const hero = heroThumbUrl(cruise);
      if (!hero) warnings.push(`${name}: missing hero image`);
      if (!hasPrice) warnings.push(`${name}: missing pricing`);
      if (!String(cruise.public_slug || "").trim()) warnings.push(`${name}: missing public slug`);
      if (String(cruise.public_slug || "").trim() && !hero) {
        warnings.push(`${name}: has a public slug but is missing a hero image`);
      }
    }
    return warnings;
  }

  function issueStatus(cruises, warnings) {
    if (!cruises.length) return { key: "draft", label: "Draft" };
    if (warnings.length) return { key: "draft", label: "Draft" };
    if (!issueTemplate) return { key: "draft", label: "Draft" };
    return { key: "ready", label: "Ready" };
  }

  async function ensurePricingLoaded(cruises) {
    const ids = cruises.map((c) => c.id).filter(Boolean);
    const key = `${issueNumber}:${ids.join(",")}`;
    if (key === issuePricingLoadedFor && Object.keys(issuePricingByCruiseId).length) return;
    if (!ids.length) {
      issuePricingByCruiseId = {};
      issuePricingLoadedFor = key;
      return;
    }
    const client = global.supabaseClient;
    if (!client) throw new Error("Database client is not ready.");
    const { data, error } = await client
      .from("featured_cruise_pricing")
      .select("*")
      .in("featured_cruise_id", ids)
      .order("display_order", { ascending: true });
    if (error) throw new Error(error.message);
    const map = {};
    for (const id of ids) map[id] = [];
    for (const row of data || []) {
      if (!map[row.featured_cruise_id]) map[row.featured_cruise_id] = [];
      map[row.featured_cruise_id].push(row);
    }
    issuePricingByCruiseId = map;
    issuePricingLoadedFor = key;
  }

  function formatMoneyCell(value) {
    if (value === "" || value == null) return "—";
    const num = Number(value);
    if (!Number.isFinite(num)) return "—";
    const shared = global.NewsletterCruiseShared;
    if (shared?.formatMoney) return `$${shared.formatMoney(num)}`;
    return `$${Math.round(num).toLocaleString("en-AU")}`;
  }

  function cruiseDateRange(cruise) {
    const departure = cruise.departure_date || "";
    const nightsNum = cruise.nights == null || cruise.nights === "" ? null : Number(cruise.nights);
    const returnDate =
      (typeof global.addCalendarDays === "function"
        ? global.addCalendarDays(departure, nightsNum)
        : "") ||
      cruise.return_date ||
      "";
    if (global.NewsletterPreview?.formatNewsletterDateRange) {
      const range = global.NewsletterPreview.formatNewsletterDateRange(departure, returnDate);
      if (range) return range;
    }
    if (departure && returnDate) return `${formatDate(departure)} – ${formatDate(returnDate)}`;
    return formatDate(departure || returnDate || "");
  }

  function destinationForCruise(cruise) {
    if (typeof global.buildFeaturedDestinationStrip === "function") {
      const strip = global.buildFeaturedDestinationStrip(
        cruise.departure_port,
        cruise.arrival_port,
        cruise.destination_strip
      );
      if (strip) return strip;
    }
    if (global.NewsletterCruiseShared?.buildDestinationStrip) {
      return (
        global.NewsletterCruiseShared.buildDestinationStrip(
          cruise.departure_port,
          cruise.arrival_port,
          cruise.destination_strip
        ) || "—"
      );
    }
    return String(cruise.destination_strip || "").trim().toUpperCase() || "—";
  }

  function lineNameForCruise(cruise) {
    return (
      cruise.ci_cruise_lines?.name ||
      getCruiseLines().find((row) => row.id === cruise.cruise_line_id)?.name ||
      "—"
    );
  }

  function shipNameForCruise(cruise) {
    return (
      cruise.ci_cruise_ships?.name ||
      getCruiseShips().find((row) => row.id === cruise.cruise_ship_id)?.name ||
      "—"
    );
  }

  function buildPrintRecordHtml(cruises) {
    const shared = global.NewsletterCruiseShared;
    const cruiseBlocks = cruises
      .map((cruise, index) => {
        const pricing = shared?.sortPricingRows
          ? shared.sortPricingRows(issuePricingByCruiseId[cruise.id] || [])
          : [...(issuePricingByCruiseId[cruise.id] || [])];
        const nightsLabel =
          cruise.nights != null && cruise.nights !== ""
            ? `${Number(cruise.nights)} night${Number(cruise.nights) === 1 ? "" : "s"}`
            : "";
        const rowsHtml = pricing.length
          ? pricing
              .map((row) => {
                const cabin = String(row.room_label || "").trim() || "—";
                return `<tr>
                  <td>${esc(cabin)}</td>
                  <td class="num">${esc(formatMoneyCell(row.brochure_price))}</td>
                  <td class="num">${esc(formatMoneyCell(row.cruise_101_price))}</td>
                  <td class="num">${esc(formatMoneyCell(row.airline_price))}</td>
                </tr>`;
              })
              .join("")
          : `<tr><td colspan="4">No cabin pricing entered</td></tr>`;

        return `
          <section class="cruise">
            <h2>${esc(String(index + 1))}. ${esc(destinationForCruise(cruise))}</h2>
            <dl>
              <div class="pair">
                <dt>Cruise line</dt><dd>${esc(lineNameForCruise(cruise))}</dd>
                <dt>Ship</dt><dd>${esc(shipNameForCruise(cruise))}</dd>
              </div>
              <div>
                <dt>Cruise dates</dt>
                <dd>${esc(cruiseDateRange(cruise))}${nightsLabel ? ` (${esc(nightsLabel)})` : ""}</dd>
              </div>
            </dl>
            <table>
              <thead>
                <tr>
                  <th>Cabin</th>
                  <th class="num">Brochure</th>
                  <th class="num">101cruise</th>
                  <th class="num">Airline</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </section>
        `;
      })
      .join("");

    return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <title>Newsletter ${esc(String(issueNumber))} — cruise record</title>
  <style>
    @page { margin: 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: #000;
      background: #fff;
      font-family: Helvetica, Arial, sans-serif;
      font-size: 10px;
      line-height: 1.3;
    }
    h1 {
      margin: 0 0 2px;
      font-size: 15px;
      font-weight: 700;
    }
    .eyebrow {
      margin: 0 0 2px;
      font-size: 9px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .meta {
      margin: 0 0 10px;
      font-size: 10px;
    }
    .cruise {
      margin: 0 0 10px;
      padding: 0;
      page-break-inside: avoid;
    }
    h2 {
      margin: 0 0 4px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    dl {
      margin: 0 0 6px;
      display: grid;
      gap: 2px;
    }
    dl div {
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 6px;
      align-items: baseline;
    }
    dl div.pair {
      grid-template-columns: 72px 1fr 40px 1fr;
      gap: 6px 8px;
    }
    dt { margin: 0; font-weight: 700; }
    dd { margin: 0; }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border: 0.5px solid #bbb;
      padding: 3px 6px;
      text-align: left;
      vertical-align: top;
      font-size: 10px;
    }
    th { font-weight: 700; }
    .num { text-align: right; white-space: nowrap; }
    .screen-toolbar {
      position: sticky;
      top: 0;
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 0 0 12px;
      padding: 8px 0;
      background: #fff;
      border-bottom: 0.5px solid #bbb;
    }
    .screen-toolbar button {
      font: inherit;
      font-size: 11px;
      font-weight: 700;
      padding: 6px 10px;
      border: 0.5px solid #bbb;
      background: #fff;
      color: #000;
      cursor: pointer;
    }
    .screen-toolbar .hint {
      font-size: 10px;
    }
    .doc-body { padding: 4px 2px 16px; }
    @media print {
      .screen-toolbar { display: none !important; }
      .doc-body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="screen-toolbar">
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
    <span class="hint">In the print dialog choose “Save as PDF” to keep a file.</span>
  </div>
  <div class="doc-body">
    <p class="eyebrow">101cruise · Weekly cruise record</p>
    <h1>Newsletter ${esc(String(issueNumber))}</h1>
    <p class="meta">Published ${esc(issueDate ? formatDate(issueDate) : "—")} · ${esc(String(cruises.length))} cruise${cruises.length === 1 ? "" : "s"}</p>
    ${cruiseBlocks}
  </div>
</body>
</html>`;
  }

  function openPrintRecordDocument(html) {
    // Blob URL keeps a real document in the new tab (about:blank + noopener was blank).
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const printWindow = window.open(url, "_blank");
    if (!printWindow) {
      URL.revokeObjectURL(url);
      throw new Error("Pop-up blocked. Allow pop-ups for Admin, then try Print again.");
    }

    let printed = false;
    const triggerPrint = () => {
      if (printed) return;
      printed = true;
      try {
        printWindow.focus();
        printWindow.print();
      } catch (_error) {
        /* User can use the on-page Print / Save as PDF button. */
      }
    };

    // Prefer load event; one delayed fallback only if load never fires.
    try {
      printWindow.addEventListener(
        "load",
        () => {
          window.setTimeout(triggerPrint, 150);
        },
        { once: true }
      );
    } catch (_error) {
      /* ignore */
    }
    window.setTimeout(triggerPrint, 800);
    window.setTimeout(() => URL.revokeObjectURL(url), 120000);
    return printWindow;
  }

  async function printRecord() {
    if (issueNumber == null) {
      issueMessage = "Select a newsletter number before printing.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const cruises = cruisesForCurrentIssue();
    if (!cruises.length) {
      issueMessage = "Add at least one cruise to this issue before printing.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    try {
      issueBusy = true;
      issueMessage = "Preparing print record…";
      issueMessageTone = "running";
      rerender();
      await ensurePricingLoaded(cruises);
      const html = buildPrintRecordHtml(cruises);
      openPrintRecordDocument(html);
      issueMessage =
        "Cruise record opened. Use Print / Save as PDF in the dialog (or the button on that page).";
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not prepare the print record.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  function buildModelForCruise(cruise, outputMode) {
    const departure = cruise.departure_date || "";
    const nightsNum = cruise.nights == null || cruise.nights === "" ? null : Number(cruise.nights);
    const returnDate =
      (typeof global.addCalendarDays === "function"
        ? global.addCalendarDays(departure, nightsNum)
        : "") ||
      cruise.return_date ||
      "";
    const destinationStrip =
      (typeof global.buildFeaturedDestinationStrip === "function"
        ? global.buildFeaturedDestinationStrip(
            cruise.departure_port,
            cruise.arrival_port,
            cruise.destination_strip
          )
        : global.NewsletterCruiseShared?.buildDestinationStrip?.(
            cruise.departure_port,
            cruise.arrival_port,
            cruise.destination_strip
          )) ||
      cruise.destination_strip ||
      "";
    const line =
      cruise.ci_cruise_lines ||
      (global.ciCruiseLines || []).find((row) => row.id === cruise.cruise_line_id);
    const ship =
      cruise.ci_cruise_ships ||
      (global.ciCruiseShips || []).find((row) => row.id === cruise.cruise_ship_id);
    const resolved =
      typeof global.resolveFeaturedCruiseImages === "function"
        ? global.resolveFeaturedCruiseImages(cruise)
        : { hero: null, routeMap: null };
    const pricingRows = issuePricingByCruiseId[cruise.id] || [];

    return global.NewsletterPreview.buildModel({
      destinationStrip,
      departurePort: cruise.departure_port || "",
      arrivalPort: cruise.arrival_port || "",
      headline: cruise.headline || "",
      hero: resolved.hero,
      heroImageUrl: resolved.hero?.url || cruise.hero_image_url || "",
      heroImageAlt:
        resolved.hero?.altText || cruise.hero_image_alt || cruise.headline || "Cruise image",
      departureDate: departure,
      returnDate,
      nights: nightsNum,
      cruiseLineName: line?.name || "",
      shipName: ship?.name || "",
      itinerarySummary: cruise.itinerary_summary || "",
      short_editorial: cruise.short_editorial || "",
      full_description: cruise.full_description || "",
      description: cruise.short_editorial || "",
      publicSlug: cruise.public_slug || "",
      routeMap: resolved.routeMap,
      routeMapUrl: resolved.routeMap?.url || cruise.route_map_image_url || "",
      pricingRows,
      alcohol_package: cruise.alcohol_package,
      wifi: cruise.wifi,
      gratuities: cruise.gratuities,
      all_tours: cruise.all_tours,
      all_dining: cruise.all_dining,
      laundry: cruise.laundry,
      onboard_credit: cruise.onboard_credit,
      other_information: cruise.other_information || "",
      outputMode
    });
  }

  function buildPayloads(cruises, outputMode) {
    return cruises.map((cruise) => ({
      name: cruise.headline || "Untitled cruise",
      model: buildModelForCruise(cruise, outputMode),
      pricingRows: issuePricingByCruiseId[cruise.id] || [],
      publicSlug: cruise.public_slug || ""
    }));
  }

  function cacheKey(outputMode) {
    const ids = cruisesForCurrentIssue().map((c) => c.id).join(",");
    return `${issueNumber}|${issueTemplate}|${outputMode}|${ids}|${issuePricingLoadedFor}`;
  }

  async function compose(outputMode, { soft = false } = {}) {
    if (!global.NewsletterMailchimpExport || !global.NewsletterPreview) {
      throw new Error("Mailchimp export modules failed to load.");
    }
    const cruises = cruisesForCurrentIssue();
    await ensurePricingLoaded(cruises);
    issueWarnings = collectWarnings(cruises);
    const key = cacheKey(outputMode);
    if (!soft && issueCache.key === key && issueCache[outputMode === "airline_staff" ? "airline" : "general"]) {
      return issueCache[outputMode === "airline_staff" ? "airline" : "general"];
    }
    const result = global.NewsletterMailchimpExport.composeIssueHtml(buildPayloads(cruises, outputMode), {
      outputMode,
      templateKey: issueTemplate,
      newsletterNumber: issueNumber,
      softValidation: soft
    });
    if (result.ok && !soft) {
      issueCache.key = key;
      if (outputMode === "airline_staff") issueCache.airline = result;
      else issueCache.general = result;
    }
    return result;
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  async function selectIssueNumber(value) {
    const next = value === "" || value == null ? null : Number(value);
    issueNumber = Number.isFinite(next) ? next : null;
    const row = issueNumber != null ? newsletters.find((n) => Number(n.newsletter_number) === issueNumber) : null;
    if (row) syncActiveFromNewsletter(row);
    else {
      activeNewsletterId = null;
      issueDate = issueNumber != null ? resolveIssueDate(issueNumber) : "";
      issueTemplate = issueNumber != null ? templateForNumber(issueNumber) : "green-price-cards";
    }
    issuePricingLoadedFor = "";
    issuePricingByCruiseId = {};
    invalidateCache();
    routeMapSaveResults = [];
    issueMessage = "";
    addPickerOpen = false;
    try {
      const cruises = cruisesForCurrentIssue();
      await ensurePricingLoaded(cruises);
      issueWarnings = collectWarnings(cruises);
    } catch {
      issueWarnings = [];
    }
    rerender();
  }

  function startNewNewsletter() {
    preferCreatePanel = true;
    syncActiveFromNewsletter(null);
    issuePricingLoadedFor = "";
    issuePricingByCruiseId = {};
    invalidateCache();
    routeMapSaveResults = [];
    issueMessage = "";
    issueWarnings = [];
    rerender();
  }

  async function openNewsletterById(newsletterId) {
    if (!newsletterId) {
      startNewNewsletter();
      return;
    }
    preferCreatePanel = false;
    const row = newsletters.find((n) => n.id === newsletterId);
    if (!row) return;
    syncActiveFromNewsletter(row);
    issuePricingLoadedFor = "";
    issuePricingByCruiseId = {};
    invalidateCache();
    routeMapSaveResults = [];
    issueMessage = "";
    try {
      const cruises = cruisesForCurrentIssue();
      await ensurePricingLoaded(cruises);
      issueWarnings = collectWarnings(cruises);
    } catch {
      issueWarnings = [];
    }
    rerender();
  }

  function setTemplate(value) {
    issueTemplate = value === "classic-editorial" ? "classic-editorial" : "green-price-cards";
    if (issueNumber != null) saveTemplateForNumber(issueNumber, issueTemplate);
    invalidateCache();
    issueHtml.previewHtml = "";
    issueHtml.label = "";
    issueHtml.filename = "";
    issueHtml.airline = "";
    issueHtml.general = "";
    issueHtml.previewMode = "";
    issueMessage = `Design template set to ${issueTemplate === "classic-editorial" ? "Classic Editorial" : "Green Price Cards"}. Save the newsletter to persist, then Preview to refresh.`;
    issueMessageTone = "info";
    rerender();
  }

  async function persistOrder(orderedIds) {
    const client = global.supabaseClient;
    if (!client) throw new Error("Database client is not ready.");
    const updates = orderedIds.map((id, index) => {
      const nextOrder = index + 1;
      const local = getCruises().find((c) => c.id === id);
      if (local) local.display_order = nextOrder;
      return client.from("featured_cruises").update({ display_order: nextOrder }).eq("id", id);
    });
    const results = await Promise.all(updates);
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(failed.error.message);
    invalidateCache();
  }

  function onDragStart(event, cruiseId) {
    if (!dragFromHandle) {
      event.preventDefault();
      return;
    }
    draggedCruiseId = cruiseId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", cruiseId);
    event.currentTarget.classList.add("is-dragging");
  }

  function onDragEnd(event) {
    event.currentTarget?.classList.remove("is-dragging");
    document.querySelectorAll(".newsletter-issue-card.is-drop-target").forEach((el) => {
      el.classList.remove("is-drop-target");
    });
    draggedCruiseId = null;
    dragFromHandle = false;
  }

  function onDragHandleDown() {
    dragFromHandle = true;
  }

  function allowDrop(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const list = event.currentTarget;
    const dragged = document.querySelector(
      `.newsletter-issue-card[data-cruise-id="${CSS.escape(String(draggedCruiseId || ""))}"]`
    );
    if (!dragged || dragged.parentElement !== list) return;
    const cards = Array.from(list.querySelectorAll(".newsletter-issue-card:not(.is-dragging)"));
    const after = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (after) list.insertBefore(dragged, after);
    else list.appendChild(dragged);
  }

  async function onDrop(event) {
    event.preventDefault();
    const list = event.currentTarget;
    const orderedIds = Array.from(list.querySelectorAll(".newsletter-issue-card")).map(
      (card) => card.dataset.cruiseId
    );
    try {
      issueBusy = true;
      await persistOrder(orderedIds);
      issueMessage = "Cruise order saved.";
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not save cruise order.";
      issueMessageTone = "error";
      if (typeof global.loadFeaturedCruises === "function") await global.loadFeaturedCruises();
    } finally {
      issueBusy = false;
      onDragEnd({ currentTarget: null });
      rerender();
    }
  }

  async function removeCruise(cruiseId) {
    const cruise = getCruises().find((c) => c.id === cruiseId);
    if (!cruise) return;
    const ok = window.confirm(
      `Remove “${cruise.headline || "this cruise"}” from Newsletter ${issueNumber}?\n\nThe cruise itself will not be deleted or unpublished.`
    );
    if (!ok) return;
    try {
      issueBusy = true;
      const { error } = await global.supabaseClient
        .from("featured_cruises")
        .update({ newsletter_id: null, newsletter_number: null, newsletter_publication_date: null })
        .eq("id", cruiseId);
      if (error) throw new Error(error.message);
      cruise.newsletter_id = null;
      cruise.newsletter_number = null;
      cruise.newsletter_publication_date = null;
      invalidateCache();
      issuePricingLoadedFor = "";
      issueMessage = "Cruise removed from this newsletter.";
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not remove cruise.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  function openAddPicker() {
    addPickerOpen = true;
    addPickerSelected = new Set();
    rerender();
  }

  function closeAddPicker() {
    addPickerOpen = false;
    addPickerSelected = new Set();
    rerender();
  }

  function toggleAddPicker(id, checked) {
    if (checked) addPickerSelected.add(id);
    else addPickerSelected.delete(id);
    rerender();
  }

  async function confirmAddPicker() {
    const ids = [...addPickerSelected];
    if (!ids.length || issueNumber == null) {
      closeAddPicker();
      return;
    }
    try {
      issueBusy = true;
      const existing = cruisesForCurrentIssue();
      let nextOrder = existing.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0);
      const active = getActiveNewsletter();
      const date = issueDate || getDefaults().newsletter_publication_date || null;
      for (const id of ids) {
        nextOrder += 1;
        const { error } = await global.supabaseClient
          .from("featured_cruises")
          .update({
            newsletter_id: active?.id || null,
            newsletter_number: Number(issueNumber),
            newsletter_publication_date: date,
            display_order: nextOrder
          })
          .eq("id", id);
        if (error) throw new Error(error.message);
        const local = getCruises().find((c) => c.id === id);
        if (local) {
          local.newsletter_id = active?.id || null;
          local.newsletter_number = Number(issueNumber);
          local.newsletter_publication_date = date;
          local.display_order = nextOrder;
        }
      }
      invalidateCache();
      issuePricingLoadedFor = "";
      issueMessage = `Added ${ids.length} cruise${ids.length === 1 ? "" : "s"} to Newsletter ${issueNumber}.`;
      issueMessageTone = "success";
      addPickerOpen = false;
      addPickerSelected = new Set();
    } catch (error) {
      issueMessage = error.message || "Could not add cruises.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  async function preview(outputMode) {
    const run = async () => {
    try {
      issueBusy = true;
      issueMessage = "Building preview…";
      issueMessageTone = "running";
      rerender();
      const result = await compose(outputMode, { soft: true });
      issueHtml.previewMode = outputMode;
      issueHtml.previewHtml = result.previewHtml || "";
      issueHtml.label = result.label || "";
      issueHtml.filename = result.filename || "";
      if (outputMode === "airline_staff") issueHtml.airline = result.html || "";
      else issueHtml.general = result.html || "";
      issueWarnings = [...new Set([...(issueWarnings || []), ...(result.warnings || [])])];
      if (result.ok) {
        issueMessage = `${result.label} preview ready.`;
        issueMessageTone = "success";
      } else {
        issueMessage = "Preview incomplete — see warnings below.";
        issueMessageTone = "error";
      }
    } catch (error) {
      issueMessage = error.message || "Preview failed.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
    };
    if (typeof global.AdminLoading?.withLoading === "function") {
      await global.AdminLoading.withLoading(run, {
        key: "newsletter-preview",
        delayMs: 0,
        message: "Building the newsletter preview…",
        supportMessage: "Please wait while we assemble this issue."
      });
    } else {
      await run();
    }
  }

  async function exportHtml(outputMode, action) {
    const run = async () => {
    try {
      issueBusy = true;
      issueMessage = "Preparing HTML…";
      issueMessageTone = "running";
      rerender();
      const result = await compose(outputMode, { soft: false });
      if (!result.ok) {
        issueMessage = "Fix the issues below before exporting.";
        issueMessageTone = "error";
        issueWarnings = result.errors || [];
        issueHtml.previewHtml = "";
        return;
      }
      if (outputMode === "airline_staff") issueHtml.airline = result.html;
      else issueHtml.general = result.html;
      issueHtml.label = result.label || "";
      issueHtml.filename = result.filename || "";
      issueHtml.previewHtml = result.previewHtml || result.html || "";
      issueHtml.previewMode = outputMode;
      if (action === "copy") {
        await navigator.clipboard.writeText(result.html || "");
        issueMessage = "HTML copied to clipboard.";
        issueMessageTone = "success";
      } else {
        const blob = new Blob([result.html || ""], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename || "newsletter.html";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        issueMessage = "HTML downloaded.";
        issueMessageTone = "success";
      }
    } catch (error) {
      issueMessage = error.message || "Export failed.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
    };
    if (typeof global.AdminLoading?.withLoading === "function") {
      await global.AdminLoading.withLoading(run, {
        key: "newsletter-export",
        delayMs: 0,
        message: "Preparing newsletter HTML…",
        supportMessage: "Please wait while we build the Mailchimp fragment."
      });
    } else {
      await run();
    }
  }

  async function addCruiseToIssue(cruiseId) {
    if (issueNumber == null) {
      issueMessage = "Start a newsletter number first, then add cruises.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    try {
      issueBusy = true;
      const existing = cruisesForCurrentIssue();
      const nextOrder =
        existing.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0) + 1;
      const active = getActiveNewsletter();
      const date = issueDate || getDefaults().newsletter_publication_date || null;
      const { error } = await global.supabaseClient
        .from("featured_cruises")
        .update({
          newsletter_id: active?.id || null,
          newsletter_number: Number(issueNumber),
          newsletter_publication_date: date,
          display_order: nextOrder
        })
        .eq("id", cruiseId);
      if (error) throw new Error(error.message);
      const local = getCruises().find((c) => c.id === cruiseId);
      if (local) {
        local.newsletter_id = active?.id || null;
        local.newsletter_number = Number(issueNumber);
        local.newsletter_publication_date = date;
        local.display_order = nextOrder;
      }
      invalidateCache();
      issuePricingLoadedFor = "";
      issueMessage = `Added “${local?.headline || "cruise"}” to Newsletter ${issueNumber}.`;
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not add cruise.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  function renderUnassignedSection() {
    const orphaned = unnumberedCruises();
    if (!orphaned.length) return "";
    return `
      <section class="newsletter-issue-section">
        <div class="admin-list-top">
          <h4>Cruises not in a newsletter yet</h4>
          <span class="admin-pill">${orphaned.length}</span>
        </div>
        <p class="admin-muted">These cruises still exist. They just do not have a newsletter number assigned, so they did not appear in an issue.</p>
        <div class="newsletter-issue-unassigned-list">
          ${orphaned
            .map((cruise) => {
              const id = esc(cruise.id);
              const line = cruise.ci_cruise_lines?.name || "Cruise line not set";
              const ship = cruise.ci_cruise_ships?.name || "Ship not set";
              return `
              <article class="newsletter-issue-card newsletter-issue-card--static">
                <button type="button" class="newsletter-issue-card-main" onclick="editFeaturedCruise('${id}')">
                  <span class="newsletter-issue-thumb" aria-hidden="true">
                    ${heroThumbUrl(cruise) ? `<img src="${esc(heroThumbUrl(cruise))}" alt="">` : ""}
                  </span>
                  <span class="newsletter-issue-card-copy">
                    <strong>${esc(cruise.headline || "Untitled cruise")}</strong>
                    <span class="admin-muted">${esc(line)} · ${esc(ship)}</span>
                    <span class="admin-small">Departure ${esc(formatDate(cruise.departure_date))}</span>
                  </span>
                </button>
                <div class="admin-actions-row">
                  <button type="button" class="admin-button secondary small" onclick="editFeaturedCruise('${id}')">Open</button>
                  <button type="button" class="admin-button black small" onclick="NewsletterIssueComposer.addCruiseToIssue('${id}')" ${issueBusy || issueNumber == null ? "disabled" : ""}>${issueNumber == null ? "Start issue first" : "Add to this issue"}</button>
                </div>
              </article>`;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderCreateNewsletterPanel() {
    const defaults = getDefaults();
    const suggestedNumber = defaults.newsletter_number || "";
    const suggestedDate = defaults.newsletter_publication_date || "";
    const active = getActiveNewsletter();
    if (active) return "";
    return `
      <div class="newsletter-workspace-create">
        <h4>Create Newsletter</h4>
        <p class="admin-muted">Enter the newsletter number and date once. All cruises you add will inherit this issue.</p>
        <div class="newsletter-issue-start">
          <div class="admin-field">
            <label for="newsletterCreateNumber">Newsletter Number <span class="admin-required">*</span></label>
            <input id="newsletterCreateNumber" type="number" min="1" step="1" value="${esc(String(suggestedNumber || ""))}" placeholder="77">
          </div>
          <div class="admin-field">
            <label for="newsletterCreateDate">Newsletter Date <span class="admin-required">*</span></label>
            <input id="newsletterCreateDate" type="date" value="${esc(suggestedDate || "")}">
          </div>
          <div class="admin-field" style="align-self:end">
            <button type="button" class="admin-button black" onclick="NewsletterIssueComposer.createNewsletter()" ${issueBusy ? "disabled" : ""}>Create Newsletter</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderOpenNewsletterPanel() {
    if (newsletters.length) {
      return `
        <div class="admin-field newsletter-open-field">
          <label for="newsletterOpenSelect">Open existing newsletter</label>
          <div class="newsletter-open-row">
            <select id="newsletterOpenSelect" onchange="NewsletterIssueComposer.openNewsletterById(this.value)" ${issueBusy ? "disabled" : ""}>
              <option value="">Choose…</option>
              ${newsletters
                .map(
                  (n) =>
                    `<option value="${esc(n.id)}" ${n.id === activeNewsletterId ? "selected" : ""}>Newsletter ${esc(String(n.newsletter_number))}${n.newsletter_date ? ` · ${esc(formatDate(n.newsletter_date))}` : ""}</option>`
                )
                .join("")}
            </select>
            <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.startNewNewsletter()" ${issueBusy ? "disabled" : ""}>+ New Newsletter</button>
          </div>
        </div>
      `;
    }
    return "";
  }

  function renderRouteMapSaveResults() {
    if (!routeMapSaveResults.length) return "";
    return `
      <ul class="newsletter-route-map-results">
        ${routeMapSaveResults
          .map((row) => {
            const statusLabel =
              row.status === "generated"
                ? "Generated"
                : row.status === "retained"
                  ? "Existing map kept"
                  : row.status === "needs_coordinates"
                    ? "Needs coordinates"
                    : "Failed";
            const tone =
              row.status === "failed"
                ? "admin-error"
                : row.status === "needs_coordinates"
                  ? "admin-muted"
                  : "admin-success";
            const retry =
              row.status === "failed"
                ? `<button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.retryRouteMapForCruise('${esc(row.cruiseId)}')" ${routeMapSaveBusy || issueBusy ? "disabled" : ""}>Retry</button>`
                : "";
            return `<li class="${tone}"><strong>${esc(row.name)}</strong>: ${esc(statusLabel)}${row.message ? ` — ${esc(row.message)}` : ""} ${retry}</li>`;
          })
          .join("")}
      </ul>
    `;
  }

  function renderAddPicker() {
    if (!addPickerOpen) return "";
    const rows = unassignedCruises();
    return `
      <div class="newsletter-issue-picker-overlay" onclick="if(event.target===this) NewsletterIssueComposer.closeAddPicker()">
        <div class="newsletter-issue-picker" role="dialog" aria-modal="true" aria-label="Add cruises to newsletter">
          <div class="admin-list-top">
            <div>
              <h3>Add Cruise</h3>
              <p class="admin-muted">Select cruises not already in Newsletter ${esc(String(issueNumber))}.</p>
            </div>
            <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.closeAddPicker()">Close</button>
          </div>
          <div class="newsletter-issue-picker-list">
            ${
              rows.length
                ? rows
                    .map((row) => {
                      const checked = addPickerSelected.has(row.id);
                      return `<label class="newsletter-issue-picker-row">
                        <input type="checkbox" ${checked ? "checked" : ""} onchange="NewsletterIssueComposer.toggleAddPicker('${esc(row.id)}', this.checked)">
                        <span>
                          <strong>${esc(row.headline || "Untitled")}</strong>
                          <span class="admin-muted">${esc(row.ci_cruise_lines?.name || "—")} · ${esc(formatDate(row.departure_date))}${
                            row.newsletter_number != null && row.newsletter_number !== ""
                              ? ` · currently Newsletter ${esc(String(row.newsletter_number))}`
                              : ""
                          }</span>
                        </span>
                      </label>`;
                    })
                    .join("")
                : `<p class="admin-muted">${
                    getCruises().length
                      ? "Every existing cruise is already in this newsletter (or archived)."
                      : "No Featured Cruises were found in the database. Use + New Cruise to create one, or check that cruises were saved under Newsletter."
                  }</p>
                  <p class="admin-helper">Loaded cruises: ${esc(String(getCruises().length))} · In this issue: ${esc(String(cruisesForCurrentIssue().length))} · Available to add: 0</p>`
            }
          </div>
          <div class="admin-actions-row">
            <button type="button" class="admin-button black" onclick="NewsletterIssueComposer.confirmAddPicker()" ${!addPickerSelected.size || issueBusy ? "disabled" : ""}>Add selected</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderCruiseCard(cruise) {
    const thumb = heroThumbUrl(cruise);
    const line = cruise.ci_cruise_lines?.name || "Cruise line not set";
    const ship = cruise.ci_cruise_ships?.name || "Ship not set";
    const slug = String(cruise.public_slug || "").trim();
    const publicHint = slug ? `<span class="admin-small">Public page</span>` : "";
    const id = esc(cruise.id);
    return `
      <article
        class="newsletter-issue-card"
        data-cruise-id="${id}"
        draggable="true"
        ondragstart="NewsletterIssueComposer.onDragStart(event, '${id}')"
        ondragend="NewsletterIssueComposer.onDragEnd(event)"
      >
        <button type="button" class="newsletter-issue-handle" aria-label="Drag to reorder" onmousedown="NewsletterIssueComposer.onDragHandleDown()" title="Drag to reorder">☰</button>
        <button type="button" class="newsletter-issue-card-main" onclick="editFeaturedCruise('${id}')">
          <span class="newsletter-issue-thumb" aria-hidden="true">
            ${thumb ? `<img src="${esc(thumb)}" alt="">` : ""}
          </span>
          <span class="newsletter-issue-card-copy">
            <strong>${esc(cruise.headline || "Untitled cruise")}</strong>
            <span class="admin-muted">${esc(line)} · ${esc(ship)}</span>
            <span class="admin-small">Departure ${esc(formatDate(cruise.departure_date))}${publicHint ? ` · ${publicHint}` : ""}</span>
          </span>
        </button>
        <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.removeCruise('${id}')" ${issueBusy ? "disabled" : ""}>Remove</button>
      </article>
    `;
  }

  function render() {
    ensureIssueSelected();
    const active = getActiveNewsletter();
    const numbers = availableNewsletterNumbers();
    const cruises = cruisesForCurrentIssue();
    if (!issueWarnings.length && cruises.length && Object.keys(issuePricingByCruiseId).length) {
      issueWarnings = collectWarnings(cruises);
    }
    const status = issueStatus(cruises, issueWarnings);
    const msgClass =
      issueMessageTone === "error"
        ? "admin-error"
        : issueMessageTone === "success"
          ? "admin-success"
          : issueMessageTone === "running"
            ? "admin-running"
            : "";

    const workspaceBanner = active
      ? `<div class="newsletter-workspace-active">
          <span class="newsletter-workspace-badge">Editing Newsletter ${esc(String(active.newsletter_number))}</span>
          ${active.newsletter_date ? `<span class="admin-muted">${esc(formatDate(active.newsletter_date))}</span>` : ""}
        </div>`
      : `<div class="admin-message" style="margin:0 0 14px">No newsletter is open. Create a new newsletter or open an existing one to add cruises.</div>`;

    return `
      <div class="admin-card newsletter-issue-composer">
        <div class="admin-list-top">
          <div>
            <h3>Newsletter Content</h3>
            <p class="admin-muted">Create or open a newsletter, add cruises, then save. Route maps generate automatically when coordinates allow.</p>
          </div>
          <div class="admin-actions-row">
            ${active ? `<button type="button" class="admin-button black" onclick="NewsletterIssueComposer.saveNewsletter()" ${issueBusy || routeMapSaveBusy ? "disabled" : ""}>${routeMapSaveBusy ? "Generating maps…" : "Save Newsletter"}</button>` : ""}
            <button type="button" class="admin-button secondary" onclick="startNewFeaturedCruise()" ${issueBusy || !active ? "disabled" : ""} title="${active ? "" : "Open a newsletter first"}">+ Add Cruise</button>
          </div>
        </div>

        ${workspaceBanner}

        <div class="newsletter-workspace-toolbar">
          ${renderOpenNewsletterPanel()}
          ${renderCreateNewsletterPanel()}
        </div>

        ${
          active
            ? `<div class="newsletter-issue-header newsletter-workspace-fields">
          <div class="admin-field">
            <label for="newsletterWorkspaceNumber">Newsletter Number</label>
            <input id="newsletterWorkspaceNumber" type="number" min="1" step="1" value="${esc(String(active.newsletter_number))}" ${issueBusy ? "disabled" : ""}>
          </div>
          <div class="admin-field">
            <label for="newsletterWorkspaceDate">Newsletter Date</label>
            <input id="newsletterWorkspaceDate" type="date" value="${esc(active.newsletter_date || issueDate || "")}" ${issueBusy ? "disabled" : ""}>
          </div>
          <div class="admin-field">
            <label for="newsletterIssueTemplate">Design Template</label>
            <select id="newsletterIssueTemplate" onchange="NewsletterIssueComposer.setTemplate(this.value)" ${issueBusy ? "disabled" : ""}>
              <option value="green-price-cards" ${issueTemplate === "green-price-cards" ? "selected" : ""}>Green Price Cards</option>
              <option value="classic-editorial" ${issueTemplate === "classic-editorial" ? "selected" : ""}>Classic Editorial</option>
            </select>
          </div>
          <div class="admin-field newsletter-issue-date-field">
            <label>Export tools</label>
            <div class="newsletter-issue-date-row">
              <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.printRecord()" ${issueBusy || !cruises.length ? "disabled" : ""} title="Open cruise record and print or save as PDF">Print / PDF</button>
            </div>
          </div>
          <div class="admin-field">
            <label>Status</label>
            <div class="newsletter-issue-static"><span class="newsletter-issue-status status-${esc(status.key)}">${esc(status.label)}</span></div>
          </div>
        </div>`
            : numbers.length
              ? `<div class="admin-field">
            <label for="newsletterIssueNumber">Quick open by number</label>
            <select id="newsletterIssueNumber" onchange="NewsletterIssueComposer.selectIssueNumber(this.value)" ${issueBusy ? "disabled" : ""}>
              <option value="">Choose…</option>
              ${numbers
                .map(
                  (n) =>
                    `<option value="${esc(String(n))}" ${Number(n) === Number(issueNumber) ? "selected" : ""}>Newsletter ${esc(String(n))}</option>`
                )
                .join("")}
            </select>
          </div>`
              : ""
        }

        ${issueMessage ? `<div class="admin-message ${msgClass}">${esc(issueMessage)}</div>` : ""}
        ${renderRouteMapSaveResults()}
        ${
          issueWarnings.length
            ? `<ul class="newsletter-issue-warnings">${issueWarnings
                .map((w) => `<li>${esc(w)}</li>`)
                .join("")}</ul>`
            : ""
        }

        ${renderUnassignedSection()}

        <section class="newsletter-issue-section">
          <div class="admin-list-top">
            <h4>Cruises in this newsletter</h4>
            <button type="button" class="admin-button secondary small" onclick="startNewFeaturedCruise()" ${issueBusy || !active ? "disabled" : ""}>+ Add Cruise</button>
          </div>
          ${
            !active
              ? `<p class="admin-muted">Create or open a newsletter to see its cruises here.</p>`
              : !cruises.length
                ? `<p class="admin-muted">No cruises in this newsletter yet. Use Add Cruise to create a new cruise for this newsletter.</p>`
                : `<div class="newsletter-issue-list" ondragover="NewsletterIssueComposer.allowDrop(event)" ondrop="NewsletterIssueComposer.onDrop(event)">
                  ${cruises.map(renderCruiseCard).join("")}
                </div>
                <p class="admin-helper">Drag ☰ to reorder. Order is saved when you reorder; use Save Newsletter to persist issue details and generate route maps.</p>`
          }
        </section>

        <section class="newsletter-issue-section newsletter-issue-actions">
          <h4>Preview</h4>
          <div class="admin-actions-row">
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.preview('airline_staff')" ${issueBusy || !cruises.length ? "disabled" : ""}>Preview Airline Newsletter</button>
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.preview('general')" ${issueBusy || !cruises.length ? "disabled" : ""}>Preview General Newsletter</button>
          </div>
        </section>

        <section class="newsletter-issue-section newsletter-issue-actions">
          <h4>Export</h4>
          <div class="admin-actions-row">
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('airline_staff','copy')" ${issueBusy || !cruises.length ? "disabled" : ""}>Copy Airline HTML</button>
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('general','copy')" ${issueBusy || !cruises.length ? "disabled" : ""}>Copy General HTML</button>
          </div>
          <div class="admin-actions-row" style="margin-top:8px">
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('airline_staff','download')" ${issueBusy || !cruises.length ? "disabled" : ""}>Download Airline HTML</button>
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('general','download')" ${issueBusy || !cruises.length ? "disabled" : ""}>Download General HTML</button>
          </div>
          <p class="admin-helper">Export includes every cruise in this newsletter, in list order. Each cruise needs a hero, route map, pricing, and public slug for Explore More to link to <code>https://www.101cruise.com.au/cruise?slug={slug}</code>. Cruises without a slug omit Explore More.</p>
        </section>

        ${
          issueHtml.previewHtml
            ? `<section class="newsletter-issue-section">
                <p class="admin-helper"><strong>${esc(issueHtml.label || "Preview")}</strong>${issueHtml.filename ? ` · <code>${esc(issueHtml.filename)}</code>` : ""}</p>
                <div class="mailchimp-poc-preview newsletter-issue-preview">${issueHtml.previewHtml}</div>
              </section>`
            : ""
        }
      </div>
      ${renderAddPicker()}
    `;
  }

  async function onCruisesReloaded() {
    issuePricingLoadedFor = "";
    invalidateCache();
    await loadNewslettersFromDb();
    ensureIssueSelected();
    const cruises = cruisesForCurrentIssue();
    ensurePricingLoaded(cruises)
      .then(() => {
        issueWarnings = collectWarnings(cruises);
        rerender();
      })
      .catch(() => {});
  }

  global.NewsletterIssueComposer = {
    render,
    onCruisesReloaded,
    loadNewslettersFromDb,
    getActiveNewsletter,
    getSelectedIssue() {
      ensureIssueSelected();
      const active = getActiveNewsletter();
      return {
        id: active?.id || null,
        number: issueNumber,
        date: issueDate,
        template: issueTemplate
      };
    },
    selectIssueNumber,
    openNewsletterById,
    startNewNewsletter,
    createNewsletter,
    startIssue,
    saveNewsletter,
    setTemplate,
    openAddPicker,
    closeAddPicker,
    toggleAddPicker,
    confirmAddPicker,
    addCruiseToIssue,
    removeCruise,
    onDragStart,
    onDragEnd,
    onDragHandleDown,
    allowDrop,
    onDrop,
    preview,
    exportHtml,
    printRecord,
    retryRouteMapForCruise,
    generateMissingRouteMaps
  };
})(typeof window !== "undefined" ? window : globalThis);
