const SUPABASE_URL = "https://xikbibxyinttllxamgao.supabase.co";
const SUPABASE_KEY = "sb_publishable_MEFg6spz5_Uod7sZGU8whw_UvOQDW60";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("cruise-admin-app");

let currentUser = null;
let currentProfile = null;
let cruiseLines = [];
let ships = [];
let checklistSections = [];
let checklistItems = [];
let packingCategories = [];
let packingItems = [];
let smartProfileGroups = [];
let smartProfiles = [];
let smartProfileMembers = [];
let packingItemProfiles = [];
let activeTab = "cruise-intelligence";
let editingShipId = null;
let shipSearchQuery = "";
let editingCruiseLineId = null;
let editingChecklistItemId = null;
let editingChecklistSectionId = null;
let selectedChecklistSectionId = "all";
let editingPackingCategoryId = null;
let editingPackingItemId = null;
let selectedPackingCategoryId = "by-category";
let packingReorderMode = false;
let draggedPackingItemId = null;
let activePackingAdminView = "items";
let showPackingCategoryForm = false;
let showPackingItemForm = false;
let showImportDataPanel = false;
let selectedSmartProfileType = "climate";
let editingSmartProfileId = null;
let showSmartProfileForm = false;
let crmSyncResult = null;
let crmSyncMessage = "";
let crmSyncLoading = false;
let crmBookingReferenceInput = "";
let itineraryReview = null;
let itineraryMessage = "";
let itineraryLoading = false;
let calculatorRates = [];
let calculatorRateSearchQuery = "";
let calculatorRateActiveFilter = "active";
let editingCalculatorRateId = null;
let activeCalculatorRateId = null;
let showCalculatorRateForm = false;
let showCalculatorNotesPanel = false;
let calculatorRateMessage = "";
let calculatorRateMessageTone = "";
let showCalculatorVerifyForm = false;
let calculatorVerifyDate = "";
let calculatorVerifyLoading = false;
let calculatorInlineSaving = false;
let calculatorInlineSnapshot = null;
let calculatorInlineStatus = "";
let beveragePackages = [];
let beveragePackageSearchQuery = "";
let beveragePackageLineFilter = "all";
let beveragePackageActiveFilter = "active";
let activeBeveragePackageId = null;
let showBeveragePackageForm = false;
let showBeveragePackageNotesPanel = false;
let beveragePackageMessage = "";
let beveragePackageMessageTone = "";
let beveragePackageInlineSaving = false;
let beveragePackageInlineSnapshot = null;
let beveragePackageInlineStatus = "";
let usageInsightsRange = "7d";
let usageInsightsCustomFrom = "";
let usageInsightsCustomTo = "";
let usageInsightsSearch = "";
let usageInsightsData = null;
let usageInsightsLoading = false;
let usageInsightsMessage = "";
let usageInsightsSelectedCustomerKey = "";
let usageInsightsPanelCustomer = null;
let adminSettingsUsers = [];
let adminSettingsLoading = false;
let adminSettingsMessage = "";
let adminSettingsMessageTone = "";
let adminSettingsSearch = "";
let adminSettingsGrantEmail = "";
let adminSettingsBusyKey = "";
let ciCruiseLines = [];
let ciCruiseShips = [];
let ciLineSearchQuery = "";
let ciLineFilter = "sold";
let ciShipSearchQuery = "";
let ciShipLineFilter = "all";
let ciShipStatusFilter = "all";
let ciSubView = "lines";
let editingCiLineId = null;
let editingCiShipId = null;
let ciLineCreating = false;
let ciShipCreating = false;
let ciLineMasterScrollTop = 0;
let ciShipMasterScrollTop = 0;
let ciAutosaveStatus = "";
let ciSaving = false;
let ciMessage = "";
let ciMessageTone = "";
let ciLoading = false;

/* ========== Featured Cruises (Sprint 9 workflow refinement) ========== */
let featuredCruises = [];
let featuredCruisePricing = [];
let featuredCruiseRoomTypes = [];
let featuredNewsletterDefaults = { newsletter_number: null, newsletter_publication_date: null };
let editingFeaturedCruiseId = null;
let showFeaturedCruiseForm = false;
let featuredCruiseLoading = false;
let featuredCruiseMessage = "";
let featuredCruiseMessageTone = "";
let featuredCruiseSearchQuery = "";
let featuredCruiseStatusFilter = "all"; // all = Draft + Published (Archived only when selected)
let featuredCruiseSaving = false;
let featuredSlugManuallyEdited = false;
let featuredFormPricing = [];
let featuredFormDraft = null; // parent field snapshot for new/edit
let featuredNewsletterDefaultsBaseline = { newsletter_number: null, newsletter_publication_date: null };
let featuredItineraryFallback = "";
let featuredRoomTypePromptIndex = null;
let draggedFeaturedPricingLocalId = null;
let featuredPricingDragFromHandle = false;
let showFeaturedNewsletterPreview = false;
let featuredNewsletterPreviewMode = "general"; // general | airline_staff

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

const PACKING_DESTINATION_OPTIONS = [
  "Caribbean / Bahamas",
  "Mediterranean / Greek Isles",
  "Alaska",
  "Norway / Northern Europe",
  "Bermuda",
  "Mexican Riviera",
  "Hawaii",
  "Asia / Southeast Asia",
  "UK & Ireland",
  "Canary Islands",
  "Australia & New Zealand",
  "Transatlantic Crossing",
  "Transpacific Crossing",
  "Canada & New England",
  "Panama Canal",
  "Antarctica"
];

const PACKING_CLIMATE_OPTIONS = ["Tropical", "Warm", "Temperate", "Cool", "Cold", "Polar"];
const PACKING_TRAVELLER_OPTIONS = ["Solo", "Couple", "Family"];
const PACKING_DRESS_CODE_OPTIONS = ["Casual", "Semi Formal", "Formal"];

function parseAdminTags(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function renderAdminMultiSelect({ id, label, allLabel, options, value }) {
  const selectedValues = parseAdminTags(value);
  const isAll = selectedValues.length === 0;
  const optionHtml = options.map(option => {
    const checked = isAll || selectedValues.includes(option);
    return `
      <label class="admin-check-chip ${checked ? "is-selected" : ""}" data-multiselect-option="${esc(id)}">
        <input type="checkbox" value="${esc(option)}" ${checked ? "checked" : ""} ${isAll ? "disabled" : ""} onchange="updateAdminMultiSelect('${esc(id)}')">
        <span>${esc(option)}</span>
      </label>
    `;
  }).join("");

  return `
    <div class="admin-field admin-multiselect-field" data-multiselect="${esc(id)}">
      <label>${esc(label)}</label>
      <label class="admin-check-chip admin-all-chip ${isAll ? "is-selected" : ""}">
        <input type="checkbox" id="${esc(id)}All" ${isAll ? "checked" : ""} onchange="toggleAdminMultiSelectAll('${esc(id)}')">
        <span>${esc(allLabel)}</span>
      </label>
      <div class="admin-check-grid" id="${esc(id)}Options">${optionHtml}</div>
      <input type="hidden" id="${esc(id)}" value="${esc(isAll ? "" : selectedValues.join(", "))}">
      <div class="admin-helper">Leave <strong>${esc(allLabel)}</strong> selected unless this item should only appear for specific options.</div>
    </div>
  `;
}

function toggleAdminMultiSelectAll(id) {
  const allInput = document.getElementById(`${id}All`);
  const hidden = document.getElementById(id);
  const wrapper = document.querySelector(`[data-multiselect="${id}"]`);
  const optionInputs = wrapper ? Array.from(wrapper.querySelectorAll(`[data-multiselect-option="${id}"] input`)) : [];

  if (!allInput || !hidden) return;

  if (allInput.checked) {
    hidden.value = "";
    optionInputs.forEach(input => {
      input.checked = true;
      input.disabled = true;
      input.closest(".admin-check-chip")?.classList.add("is-selected");
    });
  } else {
    optionInputs.forEach(input => {
      input.disabled = false;
      input.checked = false;
      input.closest(".admin-check-chip")?.classList.remove("is-selected");
    });
    hidden.value = "";
  }

  allInput.closest(".admin-check-chip")?.classList.toggle("is-selected", allInput.checked);
}

function updateAdminMultiSelect(id) {
  const wrapper = document.querySelector(`[data-multiselect="${id}"]`);
  const hidden = document.getElementById(id);
  const allInput = document.getElementById(`${id}All`);
  if (!wrapper || !hidden || !allInput) return;

  const optionInputs = Array.from(wrapper.querySelectorAll(`[data-multiselect-option="${id}"] input`));
  const selected = optionInputs.filter(input => input.checked).map(input => input.value);

  optionInputs.forEach(input => {
    input.closest(".admin-check-chip")?.classList.toggle("is-selected", input.checked);
  });

  hidden.value = selected.join(", ");
  allInput.checked = selected.length === 0;
  allInput.closest(".admin-check-chip")?.classList.toggle("is-selected", allInput.checked);
}


let adminLoginMode = "signin";
let crmDocuments = [];
let crmDocumentsLoading = false;
let crmDocumentsMessage = "";

function renderLogin(message = "") {
  app.classList.remove("is-calculator-data");
  const resetMode = adminLoginMode === "reset";
  app.innerHTML = `
    <div class="admin-card">
      <h2>101cruise Admin</h2>
      <p class="admin-muted">${resetMode
        ? "Enter your admin email and we will send a secure password reset link."
        : "Sign in with your individual admin account to manage planner content."}</p>

      <div class="admin-field">
        <label>Email address</label>
        <input type="email" id="adminEmail" placeholder="you@example.com" autocomplete="username">
      </div>

      ${resetMode ? "" : `
      <div class="admin-field">
        <label>Password</label>
        <input type="password" id="adminPassword" autocomplete="current-password">
      </div>
      `}

      <button class="admin-button black" onclick="${resetMode ? "adminRequestPasswordReset()" : "adminSignIn()"}">
        ${resetMode ? "Send reset link" : "Sign In"}
      </button>
      <button class="admin-button secondary" style="margin-top:10px" onclick="toggleAdminLoginMode()">
        ${resetMode ? "Back to sign in" : "Forgot password?"}
      </button>

      <div id="admin-login-message" class="admin-message ${message ? "admin-error" : ""}">${esc(message)}</div>
    </div>
  `;
}

function toggleAdminLoginMode() {
  adminLoginMode = adminLoginMode === "reset" ? "signin" : "reset";
  renderLogin();
}

async function adminRequestPasswordReset() {
  const email = document.getElementById("adminEmail")?.value.trim();
  const messageEl = document.getElementById("admin-login-message");
  if (!email) {
    if (messageEl) {
      messageEl.className = "admin-message admin-error";
      messageEl.innerText = "Enter your admin email address.";
    }
    return;
  }
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    if (messageEl) {
      messageEl.className = "admin-message admin-error";
      messageEl.innerText = error.message;
    }
    return;
  }
  adminLoginMode = "signin";
  renderLogin();
  const success = document.getElementById("admin-login-message");
  if (success) {
    success.className = "admin-message";
    success.innerText = "If that email belongs to an admin account, a reset link has been sent.";
  }
}

async function assertAdminAccess() {
  if (!currentProfile || currentProfile.is_admin !== true) {
    return { ok: false, message: "This account does not have admin access." };
  }

  // Optional allow-list: if admin_users rows exist for this user/email and all are inactive, deny.
  try {
    const email = String(currentUser?.email || "").trim().toLowerCase();
    let query = supabaseClient.from("admin_users").select("id,active,role,email").limit(5);
    if (email) {
      query = query.or(`auth_user_id.eq.${currentUser.id},email.eq.${email}`);
    } else {
      query = query.eq("auth_user_id", currentUser.id);
    }
    const { data, error } = await query;
    if (!error && Array.isArray(data) && data.length) {
      const active = data.some((row) => row.active === true);
      if (!active) return { ok: false, message: "This admin account has been deactivated." };
    }
  } catch (_error) {
    // Table may not exist until migration is applied — fall back to profiles.is_admin.
  }

  return { ok: true };
}

async function adminSignIn() {
  const email = document.getElementById("adminEmail").value.trim();
  const password = document.getElementById("adminPassword").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    document.getElementById("admin-login-message").innerText = error.message;
    return;
  }

  currentUser = data.user;
  await loadProfile();

  // If this email was allow-listed in Settings before first admin login, activate access now.
  if (!currentProfile?.is_admin) {
    try {
      const headers = await adminAuthHeaders();
      const claimResponse = await fetch("/.netlify/functions/admin-users", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "claim_invite" })
      });
      const claimData = await claimResponse.json().catch(() => ({}));
      if (claimData?.claimed) await loadProfile();
    } catch (_error) {
      /* ignore — assertAdminAccess will report the real outcome */
    }
  }

  const access = await assertAdminAccess();
  if (!access.ok) {
    await supabaseClient.auth.signOut();
    currentUser = null;
    currentProfile = null;
    renderLogin(access.message);
    return;
  }

  await loadAdminData();
  renderAdmin();
}

async function adminSignOut() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  crmSyncResult = null;
  crmDocuments = [];
  renderLogin();
}

async function loadProfile() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  currentProfile = error ? null : data;
}

async function adminAuthHeaders(extra = {}) {
  let { data } = await supabaseClient.auth.getSession();
  const expiresAt = Number(data.session?.expires_at || 0);
  const stale =
    !data.session?.access_token || (expiresAt > 0 && expiresAt * 1000 <= Date.now() + 60_000);
  if (stale) {
    const refreshed = await supabaseClient.auth.refreshSession();
    if (refreshed.error) {
      throw new Error("Admin session expired. Sign out and sign in again.");
    }
    data = refreshed.data;
  }
  const token = data.session?.access_token || "";
  if (!token) {
    throw new Error("Admin session missing. Sign out and sign in again.");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...extra
  };
}

/**
 * Load every beverage package row from Supabase.
 * Pages through results so the Admin grid is never silently capped by the
 * PostgREST default max-rows setting (commonly 1000).
 */
async function fetchAllBeveragePackages() {
  const pageSize = 1000;
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabaseClient
      .from("cruise_line_beverage_packages")
      .select("*, cruise_lines(id, name)")
      .order("display_order", { ascending: true })
      .order("package_name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      return { rows: [], error };
    }

    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return { rows, error: null };
}

async function reloadBeveragePackages() {
  const result = await fetchAllBeveragePackages();
  if (result.error) {
    beveragePackages = [];
    beveragePackageMessage = result.error.message || "Beverage packages could not be loaded.";
    beveragePackageMessageTone = "error";
    return false;
  }
  beveragePackages = result.rows;
  return true;
}

async function loadAdminData() {
  const { data: lines, error: linesError } = await supabaseClient
    .from("cruise_lines")
    .select("*")
    .order("name", { ascending: true });

  const { data: shipRows, error: shipsError } = await supabaseClient
    .from("ships")
    .select("*, cruise_lines(name)")
    .order("name", { ascending: true });

  const { data: sectionRows, error: sectionsError } = await supabaseClient
    .from("checklist_sections")
    .select("*")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  const { data: itemRows, error: itemsError } = await supabaseClient
    .from("checklist_items")
    .select("*, checklist_sections(name)")
    .order("display_order", { ascending: true })
    .order("title", { ascending: true });

  const { data: packingCategoryRows, error: packingCategoriesError } = await supabaseClient
    .from("packing_categories")
    .select("*")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  const { data: packingItemRows, error: packingItemsError } = await supabaseClient
    .from("packing_items")
    .select("*, packing_categories(name)")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });


  const { data: smartProfileGroupRows, error: smartProfileGroupsError } = await supabaseClient
    .from("smart_profile_groups")
    .select("*")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  const { data: smartProfileRows, error: smartProfilesError } = await supabaseClient
    .from("smart_profiles")
    .select("*")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  const { data: smartProfileMemberRows, error: smartProfileMembersError } = await supabaseClient
    .from("smart_profile_members")
    .select("*")
    .order("member_type", { ascending: true })
    .order("member_value", { ascending: true });

  const { data: packingItemProfileRows, error: packingItemProfilesError } = await supabaseClient
    .from("packing_item_profiles")
    .select("*");

  const { data: calculatorRateRows, error: calculatorRatesError } = await supabaseClient
    .from("cruise_line_calculator_rates")
    .select("*, cruise_lines(id, name)")
    .order("created_at", { ascending: true });

  const beveragePackagesResult = await fetchAllBeveragePackages();

  if (linesError) {
    console.error("Cruise line load error", linesError);
    cruiseLines = [];
  } else {
    cruiseLines = lines || [];
  }

  if (shipsError) {
    console.error("Ship load error", shipsError);
    ships = [];
  } else {
    ships = shipRows || [];
  }

  if (sectionsError) {
    console.error("Checklist section load error", sectionsError);
    checklistSections = [];
  } else {
    checklistSections = sectionRows || [];
  }

  if (itemsError) {
    console.error("Checklist item load error", itemsError);
    checklistItems = [];
  } else {
    checklistItems = itemRows || [];
  }

  if (packingCategoriesError) {
    console.error("Packing category load error", packingCategoriesError);
    packingCategories = [];
  } else {
    packingCategories = packingCategoryRows || [];
  }

  if (packingItemsError) {
    console.error("Packing item load error", packingItemsError);
    packingItems = [];
  } else {
    packingItems = packingItemRows || [];
  }

  if (smartProfileGroupsError) {
    console.warn("Smart profile group load skipped", smartProfileGroupsError);
    smartProfileGroups = [];
  } else {
    smartProfileGroups = smartProfileGroupRows || [];
  }

  if (smartProfilesError) {
    console.warn("Smart profile load skipped", smartProfilesError);
    smartProfiles = [];
  } else {
    smartProfiles = smartProfileRows || [];
  }

  if (smartProfileMembersError) {
    console.warn("Smart profile member load skipped", smartProfileMembersError);
    smartProfileMembers = [];
  } else {
    smartProfileMembers = smartProfileMemberRows || [];
  }

  if (packingItemProfilesError) {
    console.warn("Packing item profile mapping load skipped", packingItemProfilesError);
    packingItemProfiles = [];
  } else {
    packingItemProfiles = packingItemProfileRows || [];
  }

  if (calculatorRatesError) {
    console.warn("Calculator rates load skipped", calculatorRatesError);
    calculatorRates = [];
    if (!calculatorRateMessage) {
      calculatorRateMessage = calculatorRatesError.message || "Calculator rates could not be loaded. Confirm the Supabase migration has been applied.";
      calculatorRateMessageTone = "error";
    }
  } else {
    calculatorRates = calculatorRateRows || [];
  }

  if (beveragePackagesResult.error) {
    console.warn("Beverage packages load skipped", beveragePackagesResult.error);
    beveragePackages = [];
    if (!beveragePackageMessage) {
      beveragePackageMessage = beveragePackagesResult.error.message || "Beverage packages could not be loaded. Confirm the packages migration has been applied.";
      beveragePackageMessageTone = "error";
    }
  } else {
    beveragePackages = beveragePackagesResult.rows;
  }

  const { data: ciLineRows, error: ciLinesError } = await supabaseClient
    .from("ci_cruise_lines")
    .select("*")
    .order("name", { ascending: true });

  const { data: ciShipRows, error: ciShipsError } = await supabaseClient
    .from("ci_cruise_ships")
    .select("*, ci_cruise_lines(id, name, slug)")
    .order("name", { ascending: true });

  if (ciLinesError) {
    console.warn("Cruise Intelligence lines load skipped", ciLinesError);
    ciCruiseLines = [];
    if (!ciMessage) {
      ciMessage = ciLinesError.message || "Cruise Intelligence lines could not be loaded. Confirm migration 20260716 has been applied.";
      ciMessageTone = "error";
    }
  } else {
    ciCruiseLines = ciLineRows || [];
  }

  if (ciShipsError) {
    console.warn("Cruise Intelligence ships load skipped", ciShipsError);
    ciCruiseShips = [];
  } else {
    ciCruiseShips = ciShipRows || [];
  }
}

async function setTab(tab) {
  if (activeTab === "cruise-intelligence" && tab !== "cruise-intelligence") {
    const ok = await flushCiCurrentForm();
    if (!ok) return;
  }
  activeTab = tab;
  editingShipId = null;
  editingCruiseLineId = null;
  editingChecklistItemId = null;
  editingChecklistSectionId = null;
  editingPackingCategoryId = null;
  editingPackingItemId = null;
  showPackingCategoryForm = false;
  showPackingItemForm = false;
  editingSmartProfileId = null;
  showSmartProfileForm = false;
  editingCalculatorRateId = null;
  activeCalculatorRateId = null;
  showCalculatorRateForm = false;
  showCalculatorNotesPanel = false;
  calculatorRateMessage = "";
  calculatorRateMessageTone = "";
  showCalculatorVerifyForm = false;
  calculatorVerifyDate = "";
  calculatorVerifyLoading = false;
  calculatorInlineSaving = false;
  calculatorInlineSnapshot = null;
  calculatorInlineStatus = "";
  activeBeveragePackageId = null;
  showBeveragePackageForm = false;
  showBeveragePackageNotesPanel = false;
  beveragePackageMessage = "";
  beveragePackageMessageTone = "";
  beveragePackageInlineSaving = false;
  beveragePackageInlineSnapshot = null;
  beveragePackageInlineStatus = "";
  crmSyncMessage = "";
  crmSyncLoading = false;
  editingCiLineId = null;
  editingCiShipId = null;
  ciLineCreating = false;
  ciShipCreating = false;
  if (tab !== "cruise-intelligence") {
    ciMessage = "";
    ciMessageTone = "";
  }
  if (tab !== "featured-cruises") {
    showFeaturedCruiseForm = false;
    editingFeaturedCruiseId = null;
    featuredCruiseMessage = "";
    featuredCruiseMessageTone = "";
    featuredSlugManuallyEdited = false;
    featuredFormPricing = [];
    featuredFormDraft = null;
    featuredRoomTypePromptIndex = null;
    showFeaturedNewsletterPreview = false;
  }
  renderAdmin();
  if (tab === "calculator-data") {
    refreshBeveragePackagesGrid();
  }
  if (tab === "usage-insights") {
    loadUsageInsights();
  }
  if (tab === "featured-cruises") {
    ensureFeaturedCruisesLoaded();
    if (window.MediaLibraryAdmin) window.MediaLibraryAdmin.ensureLoaded({ quiet: true });
  }
  if (tab === "media-library") {
    if (window.MediaLibraryAdmin) window.MediaLibraryAdmin.ensureLoaded();
  }
  if (tab === "research-content") {
    if (window.ResearchContentAdmin) window.ResearchContentAdmin.ensureLoaded();
    if (window.CruiseLineAuditAdmin) window.CruiseLineAuditAdmin.ensureLoaded({ quiet: true });
  }
  if (tab === "settings") {
    loadAdminSettingsUsers();
  }
}

function getAdminCiCruiseLines() {
  return ciCruiseLines;
}

function getAdminCiCruiseShips() {
  return ciCruiseShips;
}

function getAdminSupabaseClient() {
  return supabaseClient;
}

/**
 * Single production Admin navigation source of truth.
 * Newsletter (featured cruises) must remain immediately after Cruise Lines/Ships.
 * Tab id stays "featured-cruises" — UI label only is "Newsletter".
 * setTab(id) sets activeTab; renderAdmin() paints buttons + matching panel.
 */
const ADMIN_MAIN_TABS = [
  { id: "cruise-intelligence", label: "Cruise Lines/Ships", render: () => renderCruiseIntelligencePanel() },
  { id: "featured-cruises", label: "Newsletter", render: () => renderFeaturedCruisesPanel() },
  {
    id: "media-library",
    label: "Media Library",
    render: () =>
      window.MediaLibraryAdmin
        ? window.MediaLibraryAdmin.renderPanel()
        : `<div class="admin-card"><p class="admin-muted">Media Library failed to load.</p></div>`
  },
  {
    id: "research-content",
    label: "Research Content",
    render: () =>
      window.ResearchContentAdmin
        ? window.ResearchContentAdmin.renderPanel()
        : `<div class="admin-card"><p class="admin-muted">Research Content failed to load.</p></div>`
  },
  { id: "checklist", label: "Checklist", render: () => renderChecklistPanel() },
  { id: "packing", label: "Packing", render: () => renderPackingPanel() },
  { id: "smart-profiles", label: "Smart Profiles", render: () => renderSmartProfilesPanel() },
  { id: "calculator-data", label: "Drinks Calculator", render: () => renderCalculatorDataPanel() },
  { id: "usage-insights", label: "Usage & Insights", render: () => renderUsageInsightsPanel() },
  { id: "settings", label: "Settings", render: () => renderSettingsPanel() }
];

function renderAdminTabNavigation() {
  return ADMIN_MAIN_TABS.map(
    (tab) =>
      `<button type="button" class="admin-tab ${activeTab === tab.id ? "active" : ""}" onclick="setTab('${tab.id}')">${esc(tab.label)}</button>`
  ).join("");
}

function renderAdminActivePanel() {
  const tab = ADMIN_MAIN_TABS.find((entry) => entry.id === activeTab);
  if (tab) return tab.render();

  // Legacy redirects (older bookmarks / stale state)
  if (activeTab === "ships" || activeTab === "cruise-lines") {
    return `
      <div class="admin-card">
        <h3>Moved to Cruise Lines/Ships</h3>
        <p class="admin-muted">Logos, ship images, and catalogue data are now managed in the Cruise Lines/Ships tab.</p>
        <button class="admin-button" onclick="setTab('cruise-intelligence')">Open Cruise Lines/Ships</button>
      </div>
    `;
  }
  if (activeTab === "crm-sync" || activeTab === "planner-preview") {
    return `
      <div class="admin-card">
        <h3>${activeTab === "planner-preview" ? "Planner Preview removed" : "CRM Sync moved"}</h3>
        <p class="admin-muted">${
          activeTab === "planner-preview"
            ? "Use the live My Cruise planner for the customer experience. Admin planner preview has been removed."
            : "Emergency Base44 sync is available under Import Data → CRM recovery."
        }</p>
        <button class="admin-button" onclick="openImportDataMaintenance()">Open Import Data</button>
      </div>
    `;
  }
  return "";
}

function renderAdmin() {
  app.classList.toggle("is-calculator-data", activeTab === "calculator-data");
  app.innerHTML = `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h2>101cruise Admin</h2>
          <p class="admin-muted">Manage the content used throughout My Cruise Planner.</p>
        </div>
        <div class="admin-actions-row">
          <button class="admin-button secondary small" onclick="toggleImportDataPanel()">${showImportDataPanel ? "Close Tools" : "Import Data"}</button>
          <button class="admin-button black small" onclick="adminSignOut()">Sign Out</button>
        </div>
      </div>
    </div>

    ${showImportDataPanel ? renderImportDataPanel() : ""}

    <div class="admin-tabs" role="tablist" aria-label="101cruise Admin sections">
      ${renderAdminTabNavigation()}
    </div>

    ${renderAdminActivePanel()}
  `;
}

function toggleImportDataPanel() {
  showImportDataPanel = !showImportDataPanel;
  renderAdmin();
}

function openImportDataMaintenance() {
  showImportDataPanel = true;
  if (activeTab === "crm-sync" || activeTab === "planner-preview") {
    activeTab = "cruise-intelligence";
  }
  renderAdmin();
}

function renderCrmSyncPanel() {
  const booking = crmSyncResult && crmSyncResult.booking ? crmSyncResult.booking : null;
  const isRunning = crmSyncLoading || /syncing/i.test(String(crmSyncMessage || ""));
  const messageClass = crmSyncMessage && crmSyncMessage.toLowerCase().includes("error")
    ? "admin-error"
    : isRunning
      ? "admin-running"
      : "";

  return `
    <div class="admin-card crm-sync-card">
      <div class="admin-list-top">
        <div>
          <h3>Emergency CRM recovery</h3>
          <p class="admin-muted">Manual Base44 sync for ops recovery only. Live My Cruise login uses customer-access automatically — this tool is not part of normal booking flow.</p>
        </div>
      </div>

      <div class="crm-sync-form">
        <div class="admin-field crm-sync-input">
          <label>Booking reference</label>
          <input type="text" id="crmBookingReference" value="${esc(crmBookingReferenceInput)}" placeholder="Example: SWM123456" oninput="crmBookingReferenceInput=this.value" onkeydown="handleCrmSyncKeydown(event)">
        </div>
        <button class="admin-button black" onclick="syncCrmBooking()" ${crmSyncLoading ? "disabled" : ""}>${crmSyncLoading ? "Syncing..." : "Sync Booking"}</button>
        ${isRunning && crmSyncMessage ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(crmSyncMessage)}</span>` : ""}
      </div>

      ${!isRunning ? `<div id="crm-sync-message" class="admin-message ${messageClass}">${esc(crmSyncMessage)}</div>` : `<div id="crm-sync-message" class="admin-message" hidden></div>`}
    </div>

    ${booking ? renderCrmBookingPreview(booking) : `
      <div class="admin-card crm-empty-card">
        <p class="admin-muted">Enter a booking reference above to pull Base44 data into 101CRUISE for recovery checks, itinerary review, or document library work.</p>
      </div>
    `}
  `;
}

function handleCrmSyncKeydown(event) {
  if (event.key === "Enter") {
    syncCrmBooking();
  }
}

function renderCrmBookingPreview(booking) {
  const passenger1 = [booking.passenger1_first_name, booking.passenger1_last_name].filter(Boolean).join(" ");
  const passenger2 = [booking.passenger2_first_name, booking.passenger2_last_name].filter(Boolean).join(" ");
  const sailingDate = formatAdminDate(booking.departing_date);
  const returnDate = formatAdminDate(booking.arriving_date);

  return `
    <div class="admin-card crm-booking-preview">
      <div class="admin-list-top">
        <div>
          <h3>Booking Retrieved</h3>
          <p class="admin-muted">This is the booking data returned from Base44.</p>
        </div>
        <span class="admin-pill">${esc(booking.booking_status || "Status unknown")}</span>
      </div>

      <div class="crm-booking-grid">
        <div class="crm-detail-card">
          <span>Booking Reference</span>
          <strong>${esc(booking.booking_reference || "Not supplied")}</strong>
        </div>
        <div class="crm-detail-card">
          <span>Primary Passenger</span>
          <strong>${esc(passenger1 || "Not supplied")}</strong>
          <small>${esc(booking.passenger1_email || "")}</small>
        </div>
        <div class="crm-detail-card">
          <span>Second Passenger</span>
          <strong>${esc(passenger2 || "Not supplied")}</strong>
          <small>${esc(booking.passenger2_email || "")}</small>
        </div>
        <div class="crm-detail-card">
          <span>Cruise</span>
          <strong>${esc([booking.cruise_line, booking.cruise_ship].filter(Boolean).join(" - ") || "Not supplied")}</strong>
        </div>
        <div class="crm-detail-card">
          <span>Dates</span>
          <strong>${esc(sailingDate)} to ${esc(returnDate)}</strong>
        </div>
        <div class="crm-detail-card">
          <span>Ports</span>
          <strong>${esc([booking.departing_port, booking.arriving_port].filter(Boolean).join(" to ") || "Not supplied")}</strong>
        </div>
        <div class="crm-detail-card">
          <span>Cabin</span>
          <strong>${esc(booking.room_number || "Not supplied")}</strong>
          <small>${esc([booking.room_type, booking.category_class].filter(Boolean).join(" • "))}</small>
        </div>
        <div class="crm-detail-card">
          <span>Base44 Booking ID</span>
          <strong>${esc(booking.base44_booking_id || "Not supplied")}</strong>
        </div>
      </div>
      <div class="admin-actions-row crm-preview-actions">
        <button class="admin-button secondary" onclick="loadItineraryReview('${esc(booking.base44_booking_id || '')}')">Review Itinerary</button>
        <button class="admin-button secondary" onclick="extractBookingItinerary()" ${itineraryLoading ? "disabled" : ""}>${itineraryLoading ? "Extracting…" : "Extract Booking Confirmation"}</button>
        ${itineraryLoading || /extracting/i.test(String(itineraryMessage || "")) ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(itineraryMessage || "Extracting…")}</span>` : ""}
      </div>
      ${renderItineraryReview(booking)}
      ${renderCrmDocumentsPanel(booking)}
    </div>
  `;
}

function sourceLabel(source) {
  if (source === "base44") return "Base44";
  if (source === "admin") return "101cruise Admin";
  if (source === "customer") return "Customer";
  return source || "Unknown";
}

function renderCrmDocumentsPanel(booking) {
  const isRunning = crmDocumentsLoading || /^(Uploading|Loading|Deleting)/i.test(String(crmDocumentsMessage || ""));
  const messageClass = crmDocumentsMessage.toLowerCase().includes("error")
    ? "admin-error"
    : isRunning
      ? "admin-running"
      : "";
  const docs = crmDocuments || [];
  return `
    <section class="itinerary-review-panel crm-documents-panel">
      <div class="admin-list-top">
        <div>
          <h4>Document Library</h4>
          <p class="admin-muted">Base44 documents are synced as read-only. Upload Admin documents here when they should live in 101cruise.</p>
        </div>
        <div class="admin-actions-row" style="align-items:center">
          <button class="admin-button secondary small" onclick="loadCrmDocuments()" ${crmDocumentsLoading ? "disabled" : ""}>
            ${crmDocumentsLoading ? "Loading…" : "Refresh documents"}
          </button>
          ${isRunning && /^(Loading)/i.test(String(crmDocumentsMessage || "")) ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(crmDocumentsMessage)}</span>` : ""}
        </div>
      </div>
      ${!(isRunning && /^(Loading|Uploading)/i.test(String(crmDocumentsMessage || ""))) ? `<div class="admin-message ${messageClass}">${esc(crmDocumentsMessage)}</div>` : ""}
      ${docs.length ? `
        <div class="crm-documents-list">
          ${docs.map((doc) => `
            <article class="crm-document-row">
              <div>
                <strong>${esc(doc.document_type || "Other")}</strong>
                <span class="admin-pill">${esc(sourceLabel(doc.source_system))}</span>
                ${doc.document_visible_to_customer === false ? '<span class="admin-pill">Hidden from customer</span>' : ""}
                <p class="admin-muted">${esc(doc.filename || "Untitled file")}</p>
                ${doc.note ? `<p class="crm-document-note">${esc(doc.note)}</p>` : ""}
                <p class="admin-small">Uploaded ${esc(formatAdminDate(String(doc.uploaded_at || "").slice(0, 10)))}</p>
              </div>
              <div class="admin-actions-row">
                ${doc.file_url ? `<a class="admin-button secondary small" href="${esc(doc.file_url)}" target="_blank" rel="noopener noreferrer">Open</a>` : `<span class="admin-muted">File unavailable</span>`}
                ${doc.editable ? `<button class="admin-button secondary small" onclick="deleteAdminBookingDocument('${esc(doc.id)}')">Delete</button>` : `<span class="admin-small">Managed in Base44</span>`}
              </div>
            </article>
          `).join("")}
        </div>
      ` : `<p class="admin-muted">No synced documents yet for this booking.</p>`}

      <div class="admin-card" style="margin-top:16px">
        <h4>Upload Admin document</h4>
        <p class="admin-muted">Stored in 101cruise. Does not write back to Base44.</p>
        <div class="admin-field">
          <label>Document type</label>
          <input type="text" id="adminDocType" placeholder="e.g. Travel Insurance" value="Other">
        </div>
        <div class="admin-field">
          <label>File</label>
          <input type="file" id="adminDocFile" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png">
        </div>
        <div class="admin-field">
          <label>Note (shown to customer when document is visible)</label>
          <textarea id="adminDocNote" rows="2" placeholder="Optional customer-facing note"></textarea>
        </div>
        <label class="admin-check-chip" style="display:inline-flex;margin:8px 0 14px">
          <input type="checkbox" id="adminDocVisible" checked>
          <span>Visible to client on 101cruise website</span>
        </label>
        <div class="admin-actions-row" style="align-items:center">
          <button class="admin-button black" onclick="uploadAdminBookingDocument()" ${/Uploading/i.test(String(crmDocumentsMessage || "")) ? "disabled" : ""}>Upload document</button>
          ${/Uploading/i.test(String(crmDocumentsMessage || "")) ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(crmDocumentsMessage)}</span>` : ""}
        </div>
      </div>
    </section>
  `;
}

async function loadCrmDocuments() {
  const booking = crmSyncResult?.booking;
  if (!booking) return;
  crmDocumentsLoading = true;
  crmDocumentsMessage = "Loading documents…";
  renderAdmin();
  try {
    const headers = await adminAuthHeaders();
    const response = await fetch("/.netlify/functions/booking-documents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "list",
        booking_reference: booking.booking_reference,
        base44_booking_id: booking.base44_booking_id
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    crmDocuments = data.documents || [];
    crmDocumentsMessage = `${crmDocuments.length} document${crmDocuments.length === 1 ? "" : "s"} loaded.`;
  } catch (error) {
    crmDocuments = [];
    crmDocumentsMessage = `Error: ${error.message || error}`;
  } finally {
    crmDocumentsLoading = false;
    renderAdmin();
  }
}

async function uploadAdminBookingDocument() {
  const booking = crmSyncResult?.booking;
  if (!booking) return;
  const file = document.getElementById("adminDocFile")?.files?.[0];
  const documentType = document.getElementById("adminDocType")?.value.trim() || "Other";
  const note = document.getElementById("adminDocNote")?.value.trim() || "";
  const visible = document.getElementById("adminDocVisible")?.checked !== false;
  if (!file) {
    crmDocumentsMessage = "Error: Choose a file to upload.";
    renderAdmin();
    return;
  }
  try {
    crmDocumentsMessage = "Uploading…";
    renderAdmin();
    const headers = await adminAuthHeaders();
    const preparedResponse = await fetch("/.netlify/functions/booking-documents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "create_upload",
        booking_reference: booking.booking_reference,
        base44_booking_id: booking.base44_booking_id,
        filename: file.name,
        document_type: documentType,
        mime_type: file.type,
        size_bytes: file.size
      })
    });
    const prepared = await preparedResponse.json().catch(() => ({}));
    if (!preparedResponse.ok || !prepared.success) throw new Error(prepared.error || "Could not prepare upload.");
    const upload = prepared.upload;
    if (!upload.token) throw new Error("Secure upload token was not returned.");
    const { error: storageError } = await supabaseClient.storage
      .from("booking-documents")
      .uploadToSignedUrl(upload.storage_path, upload.token, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false
      });
    if (storageError) throw storageError;
    const completeResponse = await fetch("/.netlify/functions/booking-documents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "complete_upload",
        id: upload.id,
        storage_path: upload.storage_path,
        booking_reference: booking.booking_reference,
        base44_booking_id: booking.base44_booking_id,
        document_type: documentType,
        filename: file.name,
        note,
        document_visible_to_customer: visible,
        note_visible_to_customer: visible
      })
    });
    const complete = await completeResponse.json().catch(() => ({}));
    if (!completeResponse.ok || !complete.success) throw new Error(complete.error || "Could not save document.");
    crmDocumentsMessage = "Admin document uploaded.";
    await loadCrmDocuments();
  } catch (error) {
    crmDocumentsMessage = `Error: ${error.message || error}`;
    renderAdmin();
  }
}

async function deleteAdminBookingDocument(id) {
  if (!window.confirm("Delete this Admin document from 101cruise?")) return;
  try {
    const headers = await adminAuthHeaders();
    const response = await fetch("/.netlify/functions/booking-documents", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "delete", id })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    crmDocumentsMessage = "Document deleted.";
    await loadCrmDocuments();
  } catch (error) {
    crmDocumentsMessage = `Error: ${error.message || error}`;
    renderAdmin();
  }
}


function itineraryAuthHeaders() {
  return supabaseClient.auth.getSession().then(({ data }) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.session?.access_token || ""}`
  }));
}

function renderItineraryReview(booking) {
  const isRunning =
    itineraryLoading ||
    /extracting|approving|saving draft/i.test(String(itineraryMessage || ""));
  const messageClass = itineraryMessage.toLowerCase().includes("error")
    ? "admin-error"
    : isRunning
      ? "admin-running"
      : "";
  const data = itineraryReview?.itinerary_data || null;
  const inlineRunning =
    isRunning && itineraryMessage
      ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(itineraryMessage)}</span>`
      : "";
  return `
    <section class="itinerary-review-panel">
      <div class="admin-list-top">
        <div>
          <h4>Smart Itinerary Review</h4>
          <p class="admin-muted">Extract the Booking Confirmation, inspect the structured itinerary, correct anything necessary, then approve it. The customer map is not included in this first release.</p>
        </div>
        ${itineraryReview?.status ? `<span class="admin-pill">${esc(itineraryReview.status.replaceAll("_", " "))}</span>` : ""}
      </div>
      ${!isRunning ? `<div class="admin-message ${messageClass}">${esc(itineraryMessage)}</div>` : ""}
      ${data ? `
        <div class="itinerary-source-note">
          <strong>Source:</strong> ${esc(itineraryReview.source_filename || "Booking Confirmation")}
          ${itineraryReview.extraction_confidence != null ? `<span>Overall confidence: ${Math.round(Number(itineraryReview.extraction_confidence) * 100)}%</span>` : ""}
        </div>
        <div class="admin-field">
          <label>Extracted itinerary JSON</label>
          <textarea id="itineraryJsonEditor" class="itinerary-json-editor" spellcheck="false">${esc(JSON.stringify(data, null, 2))}</textarea>
          <div class="admin-helper">Dates must use YYYY-MM-DD and times must use 24-hour HH:MM. Keep the official Booking Confirmation as the source of truth.</div>
        </div>
        <div class="admin-actions-row">
          <button class="admin-button secondary" onclick="saveItineraryReview(false)" ${isRunning ? "disabled" : ""}>Save Draft</button>
          <button class="admin-button black" onclick="saveItineraryReview(true)" ${isRunning ? "disabled" : ""}>Approve Itinerary</button>
          ${/approving|saving draft/i.test(String(itineraryMessage || "")) ? inlineRunning : ""}
        </div>
      ` : `<p class="admin-muted itinerary-empty">No extracted itinerary has been loaded for this booking yet.</p>`}
    </section>
  `;
}

async function loadItineraryReview(bookingId) {
  if (!bookingId) {
    itineraryMessage = "Error: Base44 booking ID is missing.";
    renderAdmin();
    return;
  }
  itineraryLoading = true;
  itineraryMessage = "Loading saved itinerary…";
  renderAdmin();
  try {
    const headers = await itineraryAuthHeaders();
    const response = await fetch(`/.netlify/functions/admin-itinerary?booking_id=${encodeURIComponent(bookingId)}`, { headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    itineraryReview = data.itinerary;
    itineraryMessage = itineraryReview ? "Saved itinerary loaded." : "No itinerary has been extracted yet.";
  } catch (error) {
    itineraryMessage = `Error: ${error.message || error}`;
  } finally {
    itineraryLoading = false;
    renderAdmin();
  }
}

async function extractBookingItinerary() {
  const booking = crmSyncResult?.booking;
  if (!booking) return;
  itineraryLoading = true;
  itineraryMessage = "Reading the Booking Confirmation and extracting the itinerary. This can take up to a minute…";
  renderAdmin();
  try {
    const headers = await itineraryAuthHeaders();
    const response = await fetch("/.netlify/functions/admin-itinerary", {
      method: "POST",
      headers,
      body: JSON.stringify({ booking_id: booking.base44_booking_id, booking_reference: booking.booking_reference })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    itineraryReview = data.itinerary;
    itineraryMessage = "Extraction complete. Review every stop before approving.";
  } catch (error) {
    itineraryMessage = `Error: ${error.message || error}`;
  } finally {
    itineraryLoading = false;
    renderAdmin();
  }
}

async function saveItineraryReview(approve) {
  const booking = crmSyncResult?.booking;
  const editor = document.getElementById("itineraryJsonEditor");
  if (!booking || !editor) return;
  try {
    const itineraryData = JSON.parse(editor.value);
    if (!Array.isArray(itineraryData.stops)) throw new Error("The itinerary must contain a stops array.");
    itineraryMessage = approve ? "Approving itinerary…" : "Saving draft…";
    renderAdmin();
    const headers = await itineraryAuthHeaders();
    const response = await fetch("/.netlify/functions/admin-itinerary", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        booking_id: booking.base44_booking_id,
        status: approve ? "approved" : "review_required",
        itinerary_data: itineraryData
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    itineraryReview = data.itinerary;
    itineraryMessage = approve ? "Itinerary approved." : "Draft saved.";
  } catch (error) {
    itineraryMessage = `Error: ${error.message || error}`;
  }
  renderAdmin();
}

function formatAdminDate(value) {
  if (!value) return "Not supplied";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

async function syncCrmBooking() {
  const input = document.getElementById("crmBookingReference");
  const bookingReference = (input ? input.value.trim() : crmBookingReferenceInput).trim();
  crmBookingReferenceInput = bookingReference;

  if (!bookingReference) {
    crmSyncMessage = "Enter a booking reference first.";
    crmSyncResult = null;
    renderAdmin();
    return;
  }

  crmSyncLoading = true;
  itineraryReview = null;
  itineraryMessage = "";
  crmDocuments = [];
  crmDocumentsMessage = "";
  crmSyncMessage = "Syncing booking from Base44...";
  renderAdmin();

  try {
    const headers = await adminAuthHeaders();
    if (!headers.Authorization || headers.Authorization === "Bearer ") {
      throw new Error("Admin session missing. Sign out and sign in again, then retry CRM Sync.");
    }

    const response = await fetch("/.netlify/functions/get-booking", {
      method: "POST",
      headers,
      body: JSON.stringify({ booking_reference: bookingReference })
    });

    const data = await response.json().catch(() => ({ success: false, error: "Invalid response from server" }));

    if (!response.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    crmSyncResult = data;

    const saveResult = await saveBase44BookingToSupabase(data.booking);

    if (!saveResult.success) {
      throw new Error(saveResult.error || "Booking retrieved but could not be saved.");
    }

    const sync = data.document_sync;
    const syncNote = sync
      ? ` Documents: ${sync.upserted || 0} synced` +
        (sync.error_count ? `, ${sync.error_count} sync error(s)` : "") +
        "."
      : "";
    crmSyncMessage = `Booking retrieved from Base44 and saved to 101CRUISE.${syncNote}`;
    try {
      await loadCrmDocuments();
    } catch (docError) {
      crmDocumentsMessage = `Error: ${docError.message || docError}`;
    }
  } catch (error) {
    console.error("CRM sync failed", error);
    crmSyncResult = null;
    crmSyncMessage = `Error: ${error.message || "Unable to sync booking"}`;
  } finally {
    crmSyncLoading = false;
    renderAdmin();
  }
}

async function saveBase44BookingToSupabase(booking) {
  if (!booking) {
    return { success: false, error: "No booking data supplied." };
  }

  const payload = {
    base44_booking_id: booking.base44_booking_id || null,
    booking_reference: booking.booking_reference || null,

    passenger1_first_name: booking.passenger1_first_name || null,
    passenger1_last_name: booking.passenger1_last_name || null,
    passenger1_email: booking.passenger1_email || null,
    passenger1_mobile: booking.passenger1_mobile || null,

    passenger2_first_name: booking.passenger2_first_name || null,
    passenger2_last_name: booking.passenger2_last_name || null,
    passenger2_email: booking.passenger2_email || null,
    passenger2_mobile: booking.passenger2_mobile || null,

    cruise_line: booking.cruise_line || null,
    cruise_ship: booking.cruise_ship || null,

    departing_date: booking.departing_date || null,
    arriving_date: booking.arriving_date || null,

    departing_port: booking.departing_port || null,
    arriving_port: booking.arriving_port || null,

    room_number: booking.room_number || null,
    room_type: booking.room_type || null,
    category_class: booking.category_class || null,

    booking_status: booking.booking_status || null,

    raw_payload: booking
  };

  const { error } = await supabaseClient
    .from("base44_booking_cache")
    .upsert(payload, { onConflict: "base44_booking_id" });

  if (error) {
    console.error("Base44 booking save error", error);
    return { success: false, error: error.message };
  }

  return { success: true };
}

function renderImportDataPanel() {
  return `
    <div class="admin-card admin-import-panel">
      <div class="admin-list-top">
        <div>
          <h3>Import Data &amp; Maintenance</h3>
          <p class="admin-muted">Bulk import tools and emergency recovery utilities. Day-to-day CRM booking retrieval happens automatically through My Cruise login.</p>
        </div>
      </div>

      <div class="admin-field">
        <label>What are you importing?</label>
        <select id="globalImportType" onchange="renderAdmin()">
          <option value="packing-library">Packing Library</option>
        </select>
      </div>

      ${renderPackingImportPanel()}
    </div>

    ${renderCrmSyncPanel()}
  `;
}

function renderCruiseLinesPanel() {
  const sortedLines = [...cruiseLines].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  return `
    <div class="admin-card">
      <h3>Cruise Lines</h3>
      <p class="admin-muted">Manage cruise line names and logos. Lines display alphabetically.</p>
      <div id="line-global-message" class="admin-message"></div>

      <div class="admin-compact-list">
        ${sortedLines.length ? sortedLines.map(line => renderCruiseLineRow(line)).join("") : `<p>No cruise lines found.</p>`}
      </div>

      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">

      <h3>Add New Cruise Line</h3>
      <p class="admin-small">Use this only for a brand-new cruise line that is not already listed above.</p>

      <div class="admin-field">
        <label>Cruise line name</label>
        <input type="text" id="newLineName" placeholder="Example: Azamara">
      </div>

      <div class="admin-field">
        <label>Logo URL</label>
        <textarea id="newLineLogoUrl" placeholder="Paste the Squarespace logo URL here"></textarea>
      </div>

      <button class="admin-button" onclick="addNewCruiseLine()">Add Cruise Line</button>
      <div id="new-line-message" class="admin-message"></div>
    </div>
  `;
}

function renderCruiseLineRow(line) {
  const isEditing = editingCruiseLineId === line.id || !line.logo_url;

  if (!isEditing) {
    return `
      <div class="admin-list-item admin-line-compact" id="line-card-${line.id}">
        <div class="admin-line-summary">
          <img class="admin-logo-thumb" src="${esc(line.logo_url)}" alt="${esc(line.name)} logo" onerror="this.outerHTML='<div class=&quot;admin-logo-thumb placeholder&quot;>No logo</div>'">
          <div>
            <strong>${esc(line.name)}</strong>
            ${line.active ? `<span class="admin-pill">Active</span>` : `<span class="admin-pill inactive">Inactive</span>`}
          </div>
        </div>
        <button class="admin-button secondary small" onclick="editCruiseLineLogo(${line.id})">Change Logo</button>
      </div>
    `;
  }

  return `
    <div class="admin-list-item" id="line-card-${line.id}">
      <div class="admin-inline-grid">
        <div>
          <h3 style="margin-bottom:4px;">${esc(line.name)}</h3>
          ${line.active ? `<span class="admin-pill">Active</span>` : `<span class="admin-pill inactive">Inactive</span>`}

          <div class="admin-field" style="margin-top:14px;">
            <label>Logo URL</label>
            <textarea id="logo-url-${line.id}" placeholder="Paste the Squarespace logo URL here">${esc(line.logo_url || "")}</textarea>
          </div>

          <button class="admin-button" onclick="saveLineLogo(${line.id})">Save Logo</button>
          ${line.logo_url ? `<button class="admin-button secondary" onclick="cancelCruiseLineLogoEdit()">Cancel</button>` : ""}
          <div id="line-message-${line.id}" class="admin-message"></div>
        </div>
        <div>
          ${line.logo_url
            ? `<img class="admin-logo-preview" src="${esc(line.logo_url)}" alt="${esc(line.name)} logo" onerror="this.outerHTML='<div class=&quot;admin-empty-preview&quot;>Image could not load</div>'">`
            : `<div class="admin-empty-preview">No logo saved yet</div>`
          }
        </div>
      </div>
    </div>
  `;
}

function editCruiseLineLogo(lineId) {
  editingCruiseLineId = lineId;
  renderAdmin();
}

function cancelCruiseLineLogoEdit() {
  editingCruiseLineId = null;
  renderAdmin();
}

function getFilteredShips() {
  const query = String(shipSearchQuery || "").trim().toLowerCase();
  const filtered = ships.filter(ship => {
    if (!query) return true;
    const name = String(ship.name || "").toLowerCase();
    const cruiseLine = String(ship.cruise_lines?.name || "").toLowerCase();
    return name.includes(query) || cruiseLine.includes(query);
  });

  return [...filtered].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" })
  );
}

function getShipsCountLabel(filteredCount) {
  const total = ships.length;
  if (!total) return "";

  const queryActive = String(shipSearchQuery || "").trim().length > 0;
  if (!queryActive) {
    return filteredCount === 1 ? "1 ship" : `${filteredCount} ships`;
  }

  if (filteredCount === 1 && total === 1) return "1 of 1 ship";
  return `${filteredCount} of ${total} ships`;
}

function renderShipThumb(ship) {
  if (!ship.hero_image_url) {
    return `<div class="admin-ships-thumb-placeholder" aria-hidden="true"></div>`;
  }

  return `<img class="admin-ships-thumb" src="${esc(ship.hero_image_url)}" alt="" onerror="this.outerHTML='<div class=&quot;admin-ships-thumb-placeholder&quot; aria-hidden=&quot;true&quot;></div>'">`;
}

function renderShipRow(ship) {
  return `
    <div class="admin-ships-row">
      ${renderShipThumb(ship)}
      <div class="admin-ships-meta">
        <strong>${esc(ship.name)}</strong>
        <span class="admin-ships-line">${esc(ship.cruise_lines?.name || "Cruise line not found")}</span>
      </div>
      <div class="admin-ships-actions">
        ${ship.active ? `<span class="admin-pill">Active</span>` : `<span class="admin-pill inactive">Inactive</span>`}
        <button class="admin-button secondary small" onclick="editShip(${ship.id})">Edit</button>
      </div>
    </div>
  `;
}

function renderShipsResultsHtml() {
  if (!ships.length) return `<p class="admin-muted">No ships found.</p>`;

  const filtered = getFilteredShips();
  if (!filtered.length) return `<p class="admin-muted">No ships match your search.</p>`;

  return filtered.map(renderShipRow).join("");
}

function updateShipsResults() {
  const countEl = document.getElementById("shipsCount");
  const resultsEl = document.getElementById("shipsResults");
  if (!countEl || !resultsEl) return;

  const filtered = getFilteredShips();
  countEl.textContent = getShipsCountLabel(filtered.length);
  resultsEl.innerHTML = renderShipsResultsHtml();
}

function setShipSearchQuery(value) {
  shipSearchQuery = value || "";
  updateShipsResults();
}

function renderShipsPanel() {
  const editing = ships.find(ship => ship.id === editingShipId);
  const filtered = getFilteredShips();

  return `
    <div class="admin-ships-layout">
      <div class="admin-card admin-ships-list-card">
        <div class="admin-ships-list-header">
          <h3>Ships</h3>
          <p id="shipsCount" class="admin-ships-count">${esc(getShipsCountLabel(filtered.length))}</p>
          <div class="admin-field admin-ships-search">
            <label class="admin-visually-hidden" for="shipSearch">Search ships</label>
            <input
              id="shipSearch"
              type="search"
              value="${esc(shipSearchQuery)}"
              placeholder="Search ships…"
              aria-label="Search ships"
              autocomplete="off"
              oninput="setShipSearchQuery(this.value)"
            >
          </div>
        </div>
        <div id="shipsResults" class="admin-ships-results">
          ${renderShipsResultsHtml()}
        </div>
      </div>

      <div class="admin-card admin-ships-form-card">
        <h3>${editing ? "Edit Ship" : "Add Ship"}</h3>

        <input type="hidden" id="shipId" value="${editing ? editing.id : ""}">

        <div class="admin-field">
          <label>Cruise line</label>
          <select id="shipCruiseLineId">
            <option value="">Select cruise line</option>
            ${cruiseLines.map(line => `
              <option value="${line.id}" ${editing && editing.cruise_line_id === line.id ? "selected" : ""}>${esc(line.name)}</option>
            `).join("")}
          </select>
        </div>

        <div class="admin-field">
          <label>Ship name</label>
          <input type="text" id="shipName" value="${editing ? esc(editing.name) : ""}" placeholder="Ovation of the Seas">
        </div>

        <div class="admin-field">
          <label>Hero image URL</label>
          <textarea id="shipHeroImageUrl" placeholder="Paste the Squarespace ship image URL here">${editing ? esc(editing.hero_image_url || "") : ""}</textarea>
          <p class="admin-small">Use a wide landscape image where possible.</p>
        </div>

        <button class="admin-button" onclick="saveShip()">${editing ? "Save Ship Changes" : "Add Ship"}</button>
        ${editing ? `<button class="admin-button secondary" onclick="cancelShipEdit()">Cancel</button>` : ""}
        <div id="ship-message" class="admin-message"></div>

        ${editing && editing.hero_image_url
          ? `<img class="admin-hero-preview" src="${esc(editing.hero_image_url)}" alt="${esc(editing.name)} image" onerror="this.style.display='none'">`
          : ""
        }
      </div>
    </div>
  `;
}

function getPriorityEmoji(priority) {
  if (priority === "Essential") return "🔴";
  if (priority === "Tip") return "💡";
  return "⚪";
}

function getFilteredChecklistItems() {
  if (selectedChecklistSectionId === "all" || selectedChecklistSectionId === "by-section") return checklistItems;
  return checklistItems.filter(item => String(item.section_id) === String(selectedChecklistSectionId));
}

function getChecklistItemsBySection() {
  return [...checklistSections]
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0) || String(a.name || "").localeCompare(String(b.name || "")))
    .map(section => ({
      section,
      items: checklistItems
        .filter(item => String(item.section_id) === String(section.id))
        .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0) || String(a.title || "").localeCompare(String(b.title || "")))
    }));
}

function renderChecklistPanel() {
  const editingSection = checklistSections.find(section => section.id === editingChecklistSectionId);
  const filteredItems = getFilteredChecklistItems();

  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Cruise Preparation Checklist</h3>
          <p class="admin-muted">Add and edit the checklist sections and tasks shown in My Cruise Planner.</p>
        </div>
        <div>
          <button class="admin-button secondary" onclick="refreshAdminData()">Refresh</button>
        </div>
      </div>
    </div>

    <div class="admin-grid">
      <div class="admin-card">
        <h3>${editingSection ? "Edit Section" : "Add Section"}</h3>

        <input type="hidden" id="sectionId" value="${editingSection ? editingSection.id : ""}">

        <div class="admin-field">
          <label>Section name</label>
          <input type="text" id="sectionName" value="${editingSection ? esc(editingSection.name) : ""}" placeholder="After Booking">
        </div>

        <div class="admin-field">
          <label>Description</label>
          <textarea id="sectionDescription" placeholder="Short introduction shown at the top of the section">${editingSection ? esc(editingSection.description || "") : ""}</textarea>
        </div>

        <div class="admin-grid compact">
          <div class="admin-field">
            <label>Display order</label>
            <input type="number" id="sectionDisplayOrder" value="${editingSection ? esc(editingSection.display_order || 0) : "0"}">
          </div>
          <div class="admin-field">
            <label>Status</label>
            <select id="sectionActive">
              <option value="true" ${!editingSection || editingSection.active ? "selected" : ""}>Published</option>
              <option value="false" ${editingSection && !editingSection.active ? "selected" : ""}>Unpublished</option>
            </select>
          </div>
        </div>

        <button class="admin-button" onclick="saveChecklistSection()">${editingSection ? "Save Section" : "Add Section"}</button>
        ${editingSection ? `<button class="admin-button secondary" onclick="cancelChecklistSectionEdit()">Cancel</button>` : ""}
        <div id="section-message" class="admin-message"></div>
      </div>

      <div class="admin-card">
        <h3>Sections</h3>
        ${checklistSections.length ? checklistSections.map(section => `
          <div class="admin-list-item compact-item">
            <div class="admin-list-top">
              <div>
                <strong>${esc(section.name)}</strong>
                <div class="admin-small">Order: ${esc(section.display_order || 0)}</div>
                <div class="admin-small">${esc(section.description || "No description")}</div>
                ${section.active ? `<span class="admin-pill">Published</span>` : `<span class="admin-pill inactive">Unpublished</span>`}
              </div>
              <div>
                <button class="admin-button secondary small" onclick="editChecklistSection(${section.id})">Edit</button>
              </div>
            </div>
          </div>
        `).join("") : `<p>No checklist sections found.</p>`}
      </div>
    </div>

    <div class="admin-card">
      <h3>Add Checklist Item</h3>
      ${renderChecklistItemForm(null)}
    </div>

    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Checklist Items</h3>
          <p class="admin-muted">Filter by section, display items grouped by section order, edit wording, and publish/unpublish items.</p>
        </div>
        <div class="admin-field admin-filter-field">
          <label>Display</label>
          <select id="checklistSectionFilter" onchange="setChecklistSectionFilter(this.value)">
            <option value="all" ${selectedChecklistSectionId === "all" ? "selected" : ""}>All items</option>
            <option value="by-section" ${selectedChecklistSectionId === "by-section" ? "selected" : ""}>Display by Section order</option>
            ${checklistSections.map(section => `
              <option value="${section.id}" ${String(selectedChecklistSectionId) === String(section.id) ? "selected" : ""}>${esc(section.name)}</option>
            `).join("")}
          </select>
        </div>
      </div>

      ${selectedChecklistSectionId === "by-section" ? renderChecklistItemsBySection() : renderChecklistItemsList(filteredItems)}
    </div>
  `;
}

function renderChecklistItemForm(editingItem) {
  return `
    <input type="hidden" id="checklistItemId" value="${editingItem ? editingItem.id : ""}">

    <div class="admin-grid">
      <div class="admin-field">
        <label>Section</label>
        <select id="itemSectionId">
          <option value="">Select section</option>
          ${checklistSections.map(section => `
            <option value="${section.id}" ${editingItem && editingItem.section_id === section.id ? "selected" : ""}>${esc(section.name)}</option>
          `).join("")}
        </select>
      </div>

      <div class="admin-field">
        <label>Priority</label>
        <select id="itemPriority">
          ${["Essential", "Tip", "Optional"].map(priority => `
            <option value="${priority}" ${editingItem && editingItem.priority === priority ? "selected" : ""}>${priority}</option>
          `).join("")}
        </select>
      </div>
    </div>

    <div class="admin-field">
      <label>Title</label>
      <input type="text" id="itemTitle" value="${editingItem ? esc(editingItem.title) : ""}" placeholder="Purchase travel insurance">
    </div>

    <div class="admin-field">
      <label>Description</label>
      <textarea id="itemDescription" placeholder="Short description shown under the task">${editingItem ? esc(editingItem.description || "") : ""}</textarea>
    </div>

    <div class="admin-field">
      <label>Why it matters</label>
      <textarea id="itemWhyItMatters" placeholder="Explain why this task is important">${editingItem ? esc(editingItem.why_it_matters || "") : ""}</textarea>
    </div>

    <div class="admin-grid">
      <div class="admin-field">
        <label>Button 1 text</label>
        <input type="text" id="itemButton1Text" value="${editingItem ? esc(editingItem.button1_text || "") : ""}" placeholder="Compare Travel Insurance">
      </div>
      <div class="admin-field">
        <label>Button 1 URL</label>
        <input type="text" id="itemButton1Url" value="${editingItem ? esc(editingItem.button1_url || "") : ""}" placeholder="/travel-insurance">
      </div>
    </div>

    <div class="admin-grid">
      <div class="admin-field">
        <label>Button 2 text</label>
        <input type="text" id="itemButton2Text" value="${editingItem ? esc(editingItem.button2_text || "") : ""}" placeholder="Read our guide">
      </div>
      <div class="admin-field">
        <label>Button 2 URL</label>
        <input type="text" id="itemButton2Url" value="${editingItem ? esc(editingItem.button2_url || "") : ""}" placeholder="/cruise-guides">
      </div>
    </div>

    <div class="admin-grid compact">
      <div class="admin-field">
        <label>Display order</label>
        <input type="number" id="itemDisplayOrder" value="${editingItem ? esc(editingItem.display_order || 0) : "0"}">
      </div>
      <div class="admin-field">
        <label>Status</label>
        <select id="itemActive">
          <option value="true" ${!editingItem || editingItem.active ? "selected" : ""}>Published</option>
          <option value="false" ${editingItem && !editingItem.active ? "selected" : ""}>Unpublished</option>
        </select>
      </div>
    </div>

    <button class="admin-button" onclick="saveChecklistItem()">${editingItem ? "Save Item" : "Add Item"}</button>
    ${editingItem ? `<button class="admin-button secondary" onclick="cancelChecklistItemEdit()">Cancel</button>` : ""}
    <div id="item-message" class="admin-message"></div>
  `;
}

function renderChecklistItemsBySection() {
  const groups = getChecklistItemsBySection();
  return groups.map(group => `
    <div class="admin-section-group">
      <h4>${esc(group.section.name)}</h4>
      ${group.items.length ? renderChecklistItemsList(group.items) : `<p class="admin-small">No checklist items in this section.</p>`}
    </div>
  `).join("");
}

function renderChecklistItemsList(items) {
  return items.length ? items.map(item => `
    <div class="admin-list-item checklist-admin-item" id="checklist-item-${item.id}">
      ${editingChecklistItemId === item.id ? `
        <h3>Edit Checklist Item</h3>
        ${renderChecklistItemForm(item)}
      ` : `
        <div class="admin-list-top">
          <div>
            <div class="checklist-admin-title">${getPriorityEmoji(item.priority)} ${esc(item.title)}</div>
            <div class="admin-small"><strong>Section:</strong> ${esc(item.checklist_sections?.name || "Section not found")}</div>
            <div class="admin-small"><strong>Priority:</strong> ${esc(item.priority || "Tip")} | <strong>Order:</strong> ${esc(item.display_order || 0)}</div>
            ${item.description ? `<div class="admin-small checklist-admin-copy">${esc(item.description)}</div>` : ""}
            ${item.why_it_matters ? `<div class="admin-small checklist-admin-copy"><strong>Why:</strong> ${esc(item.why_it_matters)}</div>` : ""}
            ${item.button1_text || item.button2_text ? `<div class="admin-small checklist-admin-copy"><strong>Links:</strong> ${esc([item.button1_text, item.button2_text].filter(Boolean).join(" / "))}</div>` : ""}
            ${item.active ? `<span class="admin-pill">Published</span>` : `<span class="admin-pill inactive">Unpublished</span>`}
          </div>
          <div>
            <button class="admin-button secondary small" onclick="editChecklistItem(${item.id})">Edit</button>
            <button class="admin-button secondary small" onclick="toggleChecklistItemActive(${item.id}, ${item.active ? "false" : "true"})">${item.active ? "Unpublish" : "Publish"}</button>
          </div>
        </div>
      `}
    </div>
  `).join("") : `<p>No checklist items found.</p>`;
}

async function saveLineLogo(lineId) {
  const logoUrl = normalizeUrl(document.getElementById(`logo-url-${lineId}`).value);
  const message = document.getElementById(`line-message-${lineId}`);

  message.className = "admin-message admin-running";
  message.innerText = "Saving...";

  const { data, error } = await supabaseClient
    .from("cruise_lines")
    .update({
      logo_url: logoUrl || null,
      active: true
    })
    .eq("id", lineId)
    .select("id, name, logo_url, active");

  if (error) {
    console.error("Save logo error", error);
    message.className = "admin-message admin-error";
    message.innerText = error.message;
    return;
  }

  if (!data || !data.length) {
    message.className = "admin-message admin-error";
    message.innerText = "Nothing was saved. Check that your admin SQL policies were added correctly.";
    return;
  }

  message.className = "admin-message admin-success";
  message.innerText = "Saved successfully.";

  await loadAdminData();
  renderAdmin();
}

async function addNewCruiseLine() {
  const name = document.getElementById("newLineName").value.trim();
  const logoUrl = normalizeUrl(document.getElementById("newLineLogoUrl").value);
  const message = document.getElementById("new-line-message");

  if (!name) {
    message.className = "admin-message admin-error";
    message.innerText = "Please enter the cruise line name.";
    return;
  }

  message.className = "admin-message admin-running";
  message.innerText = "Saving...";

  const { data, error } = await supabaseClient
    .from("cruise_lines")
    .insert({ name, logo_url: logoUrl || null, display_order: 999, active: true })
    .select();

  if (error) {
    console.error("Add cruise line error", error);
    message.className = "admin-message admin-error";
    message.innerText = error.message;
    return;
  }

  message.className = "admin-message admin-success";
  message.innerText = "Cruise line added.";
  await loadAdminData();
  renderAdmin();
}

function editShip(id) {
  editingShipId = id;
  activeTab = "ships";
  renderAdmin();
}

function cancelShipEdit() {
  editingShipId = null;
  renderAdmin();
}

async function saveShip() {
  const id = document.getElementById("shipId").value;
  const cruiseLineId = Number(document.getElementById("shipCruiseLineId").value);
  const name = document.getElementById("shipName").value.trim();
  const heroImageUrl = normalizeUrl(document.getElementById("shipHeroImageUrl").value);
  const message = document.getElementById("ship-message");

  if (!cruiseLineId) {
    message.className = "admin-message admin-error";
    message.innerText = "Please select a cruise line.";
    return;
  }

  if (!name) {
    message.className = "admin-message admin-error";
    message.innerText = "Please enter the ship name.";
    return;
  }

  const payload = {
    cruise_line_id: cruiseLineId,
    name,
    hero_image_url: heroImageUrl || null,
    active: true
  };

  message.className = "admin-message admin-running";
  message.innerText = "Saving...";

  let result;
  if (id) {
    result = await supabaseClient
      .from("ships")
      .update(payload)
      .eq("id", Number(id))
      .select();
  } else {
    result = await supabaseClient
      .from("ships")
      .insert(payload)
      .select();
  }

  if (result.error) {
    console.error("Save ship error", result.error);
    message.className = "admin-message admin-error";
    message.innerText = result.error.message;
    return;
  }

  if (!result.data || !result.data.length) {
    message.className = "admin-message admin-error";
    message.innerText = "Nothing was saved. Check that your admin SQL policies were added correctly.";
    return;
  }

  message.className = "admin-message admin-success";
  message.innerText = "Saved successfully.";

  editingShipId = null;
  await loadAdminData();
  renderAdmin();
}

function editChecklistSection(id) {
  editingChecklistSectionId = id;
  activeTab = "checklist";
  renderAdmin();
}

function cancelChecklistSectionEdit() {
  editingChecklistSectionId = null;
  renderAdmin();
}

async function saveChecklistSection() {
  const id = document.getElementById("sectionId").value;
  const name = document.getElementById("sectionName").value.trim();
  const description = document.getElementById("sectionDescription").value.trim();
  const displayOrder = Number(document.getElementById("sectionDisplayOrder").value) || 0;
  const active = document.getElementById("sectionActive").value === "true";
  const message = document.getElementById("section-message");

  if (!name) {
    message.className = "admin-message admin-error";
    message.innerText = "Please enter the section name.";
    return;
  }

  const payload = {
    name,
    description: description || null,
    display_order: displayOrder,
    active
  };

  message.className = "admin-message admin-running";
  message.innerText = "Saving...";

  let result;
  if (id) {
    result = await supabaseClient
      .from("checklist_sections")
      .update(payload)
      .eq("id", Number(id))
      .select();
  } else {
    result = await supabaseClient
      .from("checklist_sections")
      .insert(payload)
      .select();
  }

  if (result.error) {
    console.error("Save checklist section error", result.error);
    message.className = "admin-message admin-error";
    message.innerText = result.error.message;
    return;
  }

  message.className = "admin-message admin-success";
  message.innerText = "Saved successfully.";

  editingChecklistSectionId = null;
  await loadAdminData();
  renderAdmin();
}

function editChecklistItem(id) {
  editingChecklistItemId = id;
  activeTab = "checklist";
  renderAdmin();
  setTimeout(() => {
    const el = document.getElementById(`checklist-item-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 0);
}

function cancelChecklistItemEdit() {
  editingChecklistItemId = null;
  renderAdmin();
}

function setChecklistSectionFilter(value) {
  selectedChecklistSectionId = value;
  renderAdmin();
}

async function saveChecklistItem() {
  const id = document.getElementById("checklistItemId").value;
  const sectionId = Number(document.getElementById("itemSectionId").value);
  const priority = document.getElementById("itemPriority").value;
  const title = document.getElementById("itemTitle").value.trim();
  const description = document.getElementById("itemDescription").value.trim();
  const whyItMatters = document.getElementById("itemWhyItMatters").value.trim();
  const button1Text = document.getElementById("itemButton1Text").value.trim();
  const button1Url = normalizeUrl(document.getElementById("itemButton1Url").value);
  const button2Text = document.getElementById("itemButton2Text").value.trim();
  const button2Url = normalizeUrl(document.getElementById("itemButton2Url").value);
  const displayOrder = Number(document.getElementById("itemDisplayOrder").value) || 0;
  const active = document.getElementById("itemActive").value === "true";
  const message = document.getElementById("item-message");

  if (!sectionId) {
    message.className = "admin-message admin-error";
    message.innerText = "Please select a section.";
    return;
  }

  if (!title) {
    message.className = "admin-message admin-error";
    message.innerText = "Please enter the item title.";
    return;
  }

  const payload = {
    section_id: sectionId,
    title,
    description: description || null,
    priority,
    why_it_matters: whyItMatters || null,
    button1_text: button1Text || null,
    button1_url: button1Url || null,
    button2_text: button2Text || null,
    button2_url: button2Url || null,
    display_order: displayOrder,
    active
  };

  message.className = "admin-message admin-running";
  message.innerText = "Saving...";

  let result;
  if (id) {
    result = await supabaseClient
      .from("checklist_items")
      .update(payload)
      .eq("id", Number(id))
      .select();
  } else {
    result = await supabaseClient
      .from("checklist_items")
      .insert(payload)
      .select();
  }

  if (result.error) {
    console.error("Save checklist item error", result.error);
    message.className = "admin-message admin-error";
    message.innerText = result.error.message;
    return;
  }

  message.className = "admin-message admin-success";
  message.innerText = "Saved successfully.";

  editingChecklistItemId = null;
  await loadAdminData();
  renderAdmin();
}

async function toggleChecklistItemActive(itemId, newActiveValue) {
  const { error } = await supabaseClient
    .from("checklist_items")
    .update({ active: newActiveValue })
    .eq("id", itemId);

  if (error) {
    alert(error.message);
    return;
  }

  await loadAdminData();
  renderAdmin();
}

async function refreshAdminData() {
  await loadAdminData();
  renderAdmin();
}


function getFilteredPackingItems() {
  if (selectedPackingCategoryId === "all" || selectedPackingCategoryId === "by-category") return packingItems;
  return packingItems.filter(item => String(item.category_id) === String(selectedPackingCategoryId));
}

function getPackingItemsByCategory() {
  return [...packingCategories]
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0) || String(a.name || "").localeCompare(String(b.name || "")))
    .map(category => ({
      category,
      items: packingItems
        .filter(item => String(item.category_id) === String(category.id))
        .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0) || String(a.name || "").localeCompare(String(b.name || "")))
    }));
}



function getPackingCategoryName(categoryId) {
  const category = packingCategories.find(item => String(item.id) === String(categoryId));
  return category ? category.name : "Uncategorised";
}

function getPackingCategoryIcon(categoryId) {
  const category = packingCategories.find(item => String(item.id) === String(categoryId));
  return category ? (category.icon || "🧳") : "🧳";
}

function formatPackingRule(value, fallback = "Applies to all") {
  const text = String(value || "").trim();
  return text ? esc(text) : fallback;
}

function profileTypeIcon(type) {
  return {
    climate: "🌍",
    traveller: "👥",
    dress: "🎩",
    cruise_type: "🚢",
    destination: "📍"
  }[type] || "⭐";
}

function profileTypeLabel(type) {
  const group = smartProfileGroups.find(item => item.profile_type === type);
  return group ? group.name : String(type || "Smart Profiles").replaceAll("_", " ");
}

function getProfilesByType(type) {
  return smartProfiles
    .filter(profile => profile.profile_type === type)
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0) || String(a.name || "").localeCompare(String(b.name || "")));
}

function getSmartProfileMembers(profileId) {
  return smartProfileMembers
    .filter(member => String(member.profile_id) === String(profileId))
    .sort((a, b) => String(a.member_type || "").localeCompare(String(b.member_type || "")) || String(a.member_value || "").localeCompare(String(b.member_value || "")));
}

function getPackingProfileIdsForItem(itemId) {
  return packingItemProfiles
    .filter(row => String(row.packing_item_id) === String(itemId))
    .map(row => String(row.profile_id));
}

function getProfileUsageCount(profileId) {
  return packingItemProfiles.filter(row => String(row.profile_id) === String(profileId)).length;
}

function profileKeyFromName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseMemberLines(value) {
  return String(value || "")
    .split(/\n|;/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(":");
      if (parts.length >= 2) {
        return { member_type: parts.shift().trim() || "value", member_value: parts.join(":").trim() };
      }
      return { member_type: "value", member_value: line };
    })
    .filter(item => item.member_value);
}

function smartProfileMemberConfig(profileType) {
  const cruiseTypeOptions = ["Ocean", "River", "Expedition", "Luxury", "Small Ship", "World Cruise", "Family Cruise"];
  const cruiseLineOptions = cruiseLines.map(line => line.name).filter(Boolean).sort((a, b) => a.localeCompare(b));

  if (profileType === "climate") {
    return {
      title: "Applies to destinations / regions",
      helper: "Tick every destination or region that should use this climate profile.",
      memberType: "destination",
      options: PACKING_DESTINATION_OPTIONS
    };
  }

  if (profileType === "destination") {
    return {
      title: "Destinations included",
      helper: "Tick the destination names that belong to this destination profile.",
      memberType: "destination",
      options: PACKING_DESTINATION_OPTIONS
    };
  }

  if (profileType === "traveller") {
    return {
      title: "Applies to traveller types",
      helper: "Tick the traveller types this profile should apply to.",
      memberType: "traveller",
      options: PACKING_TRAVELLER_OPTIONS
    };
  }

  if (profileType === "dress") {
    return {
      title: "Applies to cruise lines",
      helper: "Tick cruise lines where this dress profile is relevant.",
      memberType: "cruise_line",
      options: cruiseLineOptions
    };
  }

  if (profileType === "cruise_type") {
    return {
      title: "Applies to cruise types",
      helper: "Tick the cruise styles that should use this profile.",
      memberType: "cruise_type",
      options: cruiseTypeOptions
    };
  }

  return {
    title: "Applies to",
    helper: "Tick every option this profile should apply to.",
    memberType: "value",
    options: []
  };
}

function getSmartProfileSelectedMemberValues(profileId, memberType) {
  return getSmartProfileMembers(profileId)
    .filter(member => String(member.member_type || "") === String(memberType || "value"))
    .map(member => String(member.member_value || ""));
}

function getPackingItemIdsForProfile(profileId) {
  return packingItemProfiles
    .filter(row => String(row.profile_id) === String(profileId))
    .map(row => String(row.packing_item_id));
}

function isEssentialPackingItem(item) {
  return item && (item.include_on_every_cruise === true || String(item.include_on_every_cruise).toLowerCase() === "true");
}

function togglePackingEssentialMode() {
  const checkbox = document.getElementById("packingItemEssential");
  const intelligence = document.getElementById("packingItemSmartProfileBlock");
  if (!checkbox || !intelligence) return;

  intelligence.classList.toggle("is-hidden", checkbox.checked);
  intelligence.querySelectorAll("input[type='checkbox']").forEach(input => {
    input.disabled = checkbox.checked;
    if (checkbox.checked) {
      input.checked = false;
      input.closest(".admin-check-chip")?.classList.remove("is-selected");
    }
  });
}

function toggleSmartProfileChip(input) {
  if (!input) return;
  input.closest(".admin-check-chip")?.classList.toggle("is-selected", input.checked);
}

function setSmartProfileSelectorGroup(selector, checked) {
  document.querySelectorAll(selector).forEach(input => {
    input.checked = checked;
    toggleSmartProfileChip(input);
  });
}

function setSmartProfileMemberCheckboxes(checked) {
  setSmartProfileSelectorGroup(".smartProfileMemberCheckbox", checked);
}

function setSmartProfilePackingCheckboxes(checked) {
  setSmartProfileSelectorGroup(".smartProfilePackingCheckbox", checked);
}

function canonicalPackingCategoryName(name) {
  const raw = String(name || "Uncategorised").trim();
  const normalised = raw.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

  const aliases = {
    "documents": "Travel Documents",
    "travel documents": "Travel Documents",
    "money payments": "Money & Payments",
    "money and payments": "Money & Payments",
    "shoes": "Footwear",
    "footwear": "Footwear",
    "swimwear pool": "Pool & Beach",
    "swimwear and pool": "Pool & Beach",
    "pool beach": "Pool & Beach",
    "pool and beach": "Pool & Beach",
    "toiletries": "Toiletries & Personal Care",
    "toiletries personal care": "Toiletries & Personal Care",
    "toiletries and personal care": "Toiletries & Personal Care",
    "medication": "Health & Medication",
    "health medication": "Health & Medication",
    "health and medication": "Health & Medication",
    "electronics": "Electronics and Charging",
    "electronics charging": "Electronics and Charging",
    "electronics and charging": "Electronics and Charging",
    "bags luggage": "Bags & Luggage",
    "bags and luggage": "Bags & Luggage",
    "cabin comfort": "Cabin Essentials",
    "cabin essentials": "Cabin Essentials",
    "laundry care": "Laundry & Care",
    "laundry and care": "Laundry & Care",
    "kids family": "Kids & Family",
    "kids and family": "Kids & Family",
    "cold weather gear": "Cold Weather Gear",
    "polar expedition": "Polar & Expedition",
    "polar and expedition": "Polar & Expedition",
    "last minute": "Last Minute",
    "last minute items": "Last Minute",
    "shore excursions": "Shore Excursions",
    "evening wear": "Evening Wear",
    "clothing": "Clothing"
  };

  return aliases[normalised] || raw;
}

function canonicalPackingCategoryIcon(categoryName) {
  const icons = {
    "Travel Documents": "📄",
    "Money & Payments": "💳",
    "Clothing": "👕",
    "Footwear": "👞",
    "Pool & Beach": "🏖️",
    "Toiletries & Personal Care": "🧴",
    "Health & Medication": "💊",
    "Evening Wear": "🎩",
    "Electronics and Charging": "🔌",
    "Bags & Luggage": "🧳",
    "Cabin Essentials": "🛏️",
    "Laundry & Care": "🧺",
    "Kids & Family": "👶",
    "Cold Weather Gear": "🧥",
    "Polar & Expedition": "🧳",
    "Last Minute": "🚨",
    "Shore Excursions": "🎒"
  };
  return icons[categoryName] || "🧳";
}

function setSmartProfilePackingCategoryCheckboxes(categoryKey, checked) {
  const selector = `.smartProfilePackingCheckbox[data-category-key="${CSS.escape(categoryKey)}"]`;
  setSmartProfileSelectorGroup(selector, checked);
}


function filterSmartProfilePackingItems() {
  const search = String(document.getElementById("smartProfilePackingSearch")?.value || "").trim().toLowerCase();
  document.querySelectorAll(".smart-profile-packing-row").forEach(row => {
    const text = String(row.getAttribute("data-search") || "").toLowerCase();
    row.style.display = !search || text.includes(search) ? "" : "none";
  });
}

function renderSmartProfileMemberSelector(editingProfile, profileType) {
  const config = smartProfileMemberConfig(profileType);
  const selectedValues = editingProfile ? getSmartProfileSelectedMemberValues(editingProfile.id, config.memberType) : [];

  if (!config.options.length) {
    return `
      <div class="admin-profile-selector">
        <div class="admin-section-mini-title">${esc(config.title)}</div>
        <p class="admin-helper">No options are available yet.</p>
      </div>
    `;
  }

  return `
    <div class="admin-profile-selector smart-profile-member-selector">
      <div class="admin-list-top compact-list-top">
        <div>
          <div class="admin-section-mini-title">${esc(config.title)}</div>
          <p class="admin-helper">${esc(config.helper)}</p>
        </div>
        <div class="admin-actions-row compact-actions">
          <button type="button" class="admin-button secondary small" onclick="setSmartProfileMemberCheckboxes(true)">Select All</button>
          <button type="button" class="admin-button secondary small" onclick="setSmartProfileMemberCheckboxes(false)">Clear All</button>
        </div>
      </div>
      <input type="hidden" id="smartProfileMemberType" value="${esc(config.memberType)}">
      <div class="admin-check-grid smart-profile-member-grid">
        ${config.options.map(option => {
          const checked = selectedValues.includes(option);
          return `
            <label class="admin-check-chip ${checked ? "is-selected" : ""}">
              <input type="checkbox" class="smartProfileMemberCheckbox" value="${esc(option)}" ${checked ? "checked" : ""} onchange="toggleSmartProfileChip(this)">
              <span>${esc(option)}</span>
            </label>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function renderSmartProfilePackingItemSelector(editingProfile) {
  if (!editingProfile) {
    return `
      <div class="admin-profile-selector">
        <div class="admin-section-mini-title">Packing Items</div>
        <p class="admin-helper">Save the profile first, then reopen it to assign packing items.</p>
      </div>
    `;
  }

  const selectedItemIds = getPackingItemIdsForProfile(editingProfile.id);
  const categoryById = new Map(packingCategories.map(category => [String(category.id), category]));
  const categoryGroups = new Map();

  packingItems.filter(item => !isEssentialPackingItem(item)).forEach(item => {
    const originalCategory = categoryById.get(String(item.category_id));
    const canonicalName = canonicalPackingCategoryName(originalCategory?.name || "Uncategorised");
    const categoryKey = profileKeyFromName(canonicalName || "uncategorised");

    if (!categoryGroups.has(categoryKey)) {
      categoryGroups.set(categoryKey, {
        key: categoryKey,
        name: canonicalName,
        icon: canonicalPackingCategoryIcon(canonicalName),
        displayOrder: Number(originalCategory?.display_order || 999),
        items: []
      });
    }

    categoryGroups.get(categoryKey).items.push({ item, originalCategory });
  });

  const sortedGroups = Array.from(categoryGroups.values()).sort((a, b) => {
    const orderCompare = Number(a.displayOrder || 0) - Number(b.displayOrder || 0);
    if (orderCompare !== 0) return orderCompare;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  if (!sortedGroups.length) {
    return `
      <div class="admin-profile-selector smart-profile-packing-selector">
        <div class="admin-section-mini-title">Additional Packing Items</div>
        <p class="admin-helper">All packing items are currently marked as Essential, so there are no profile-specific items to assign.</p>
      </div>
    `;
  }

  return `
    <div class="admin-profile-selector smart-profile-packing-selector">
      <div class="admin-list-top compact-list-top">
        <div>
          <div class="admin-section-mini-title">Additional Packing Items</div>
          <p class="admin-helper">Tick only the extra items that should appear when this profile applies. Essential items are included on every cruise and are hidden here.</p>
        </div>
        <div class="admin-actions-row compact-actions">
          <button type="button" class="admin-button secondary small" onclick="setSmartProfilePackingCheckboxes(true)">Select All</button>
          <button type="button" class="admin-button secondary small" onclick="setSmartProfilePackingCheckboxes(false)">Clear All</button>
        </div>
      </div>

      <div class="admin-field smart-profile-search-field">
        <label>Search packing items</label>
        <input type="text" id="smartProfilePackingSearch" placeholder="Search by item or category" oninput="filterSmartProfilePackingItems()">
      </div>

      <div class="smart-profile-packing-groups">
        ${sortedGroups.map(group => {
          const items = group.items
            .sort((a, b) => Number(a.item.display_order || 0) - Number(b.item.display_order || 0) || String(a.item.name || "").localeCompare(String(b.item.name || "")));
          if (!items.length) return "";
          const selectedCount = items.filter(({ item }) => selectedItemIds.includes(String(item.id))).length;
          return `
            <div class="smart-profile-packing-group" data-category-key="${esc(group.key)}">
              <div class="smart-profile-packing-group-header">
                <h4>${esc(group.icon)} ${esc(group.name)} <span class="admin-small">(${selectedCount}/${items.length})</span></h4>
                <div class="admin-actions-row compact-actions">
                  <button type="button" class="admin-button secondary mini" onclick="setSmartProfilePackingCategoryCheckboxes('${esc(group.key)}', true)">Select All</button>
                  <button type="button" class="admin-button secondary mini" onclick="setSmartProfilePackingCategoryCheckboxes('${esc(group.key)}', false)">Clear All</button>
                </div>
              </div>
              <div class="admin-check-grid smart-profile-packing-grid">
                ${items.map(({ item, originalCategory }) => {
                  const checked = selectedItemIds.includes(String(item.id));
                  const searchText = `${item.name || ""} ${group.name || ""} ${originalCategory?.name || ""} ${item.description || ""}`;
                  return `
                    <label class="admin-check-chip smart-profile-packing-row ${checked ? "is-selected" : ""}" data-search="${esc(searchText)}">
                      <input type="checkbox" class="smartProfilePackingCheckbox" data-category-key="${esc(group.key)}" value="${esc(item.id)}" ${checked ? "checked" : ""} onchange="toggleSmartProfileChip(this)">
                      <span>${esc(item.name)}</span>
                    </label>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function renderPackingProfileSelector(item) {
  if (!smartProfiles.length) {
    return `<div class="admin-message">Smart Profiles are not loaded yet. Run the Smart Profiles SQL foundation first, then refresh Admin.</div>`;
  }
  const selectedIds = item ? getPackingProfileIdsForItem(item.id) : [];
  const groups = smartProfileGroups.length ? [...smartProfileGroups].sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0)) : [];
  const essential = isEssentialPackingItem(item);
  return `
    <div class="admin-profile-selector ${essential ? "is-hidden" : ""}" id="packingItemSmartProfileBlock">
      <div class="admin-section-mini-title">When should this item be added?</div>
      <p class="admin-helper">Use this only for items that vary by destination, climate, traveller type, cruise type or dress profile. Essential items do not need Smart Profiles.</p>
      ${groups.map(group => {
        const profiles = getProfilesByType(group.profile_type);
        if (!profiles.length) return "";
        return `
          <div class="admin-profile-picker-group">
            <div class="admin-small"><strong>${profileTypeIcon(group.profile_type)} ${esc(group.name)}</strong></div>
            <div class="admin-check-grid compact-chips">
              ${profiles.map(profile => {
                const checked = selectedIds.includes(String(profile.id));
                return `
                  <label class="admin-check-chip ${checked ? "is-selected" : ""}">
                    <input type="checkbox" class="packingProfileCheckbox" value="${profile.id}" ${checked ? "checked" : ""} ${essential ? "disabled" : ""} onchange="this.closest('.admin-check-chip').classList.toggle('is-selected', this.checked)">
                    <span>${esc(profile.name)}</span>
                  </label>
                `;
              }).join("")}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}


function renderSmartProfilesPanel() {
  const groups = smartProfileGroups.length ? smartProfileGroups : [
    { profile_type: "climate", name: "Climate Profiles", description: "Climate rules used by packing and future planner intelligence." },
    { profile_type: "traveller", name: "Traveller Profiles", description: "Solo, couple and family profiles." },
    { profile_type: "dress", name: "Dress Profiles", description: "Casual, semi-formal and formal dress expectations." },
    { profile_type: "cruise_type", name: "Cruise Type Profiles", description: "Ocean, river, expedition and other cruise styles." },
    { profile_type: "destination", name: "Destination Profiles", description: "Reusable destination and region profiles." }
  ];
  const profiles = getProfilesByType(selectedSmartProfileType);
  const editingProfile = smartProfiles.find(profile => String(profile.id) === String(editingSmartProfileId));

  return `
    <div class="admin-card admin-packing-hero-card">
      <div class="admin-list-top">
        <div>
          <h3>Smart Profiles</h3>
          <p class="admin-muted">Reusable profile rules that will power packing, preparation, documents and readiness intelligence.</p>
        </div>
        <div class="admin-actions-row compact-actions">
          <button class="admin-button secondary" onclick="showNewSmartProfileForm()">Add Profile</button>
          <button class="admin-button secondary" onclick="refreshAdminData()">Refresh</button>
        </div>
      </div>
    </div>

    <div class="admin-card">
      <div class="admin-profile-type-grid">
        ${groups.map(group => {
          const count = getProfilesByType(group.profile_type).length;
          return `
            <button class="admin-profile-type-card ${selectedSmartProfileType === group.profile_type ? "active" : ""}" onclick="setSmartProfileType('${esc(group.profile_type)}')">
              <span class="profile-type-icon">${profileTypeIcon(group.profile_type)}</span>
              <span>
                <strong>${esc(group.name)}</strong>
                <small>${count} profile${count === 1 ? "" : "s"}</small>
              </span>
            </button>
          `;
        }).join("")}
      </div>
    </div>

    ${showSmartProfileForm ? renderSmartProfileForm(editingProfile) : ""}

    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>${profileTypeIcon(selectedSmartProfileType)} ${esc(profileTypeLabel(selectedSmartProfileType))}</h3>
          <p class="admin-muted">Click a profile to edit its rules and assigned packing items.</p>
        </div>
      </div>
      ${profiles.length ? `<div class="admin-packing-item-grid">${profiles.map(renderSmartProfileCard).join("")}</div>` : `<p class="admin-muted">No profiles found for this type.</p>`}
    </div>
  `;
}

function setSmartProfileType(type) {
  selectedSmartProfileType = type;
  editingSmartProfileId = null;
  showSmartProfileForm = false;
  crmSyncMessage = "";
  crmSyncLoading = false;
  renderAdmin();
}

function showNewSmartProfileForm() {
  editingSmartProfileId = null;
  showSmartProfileForm = true;
  renderAdmin();
}

function editSmartProfile(profileId) {
  editingSmartProfileId = profileId;
  showSmartProfileForm = true;
  renderAdmin();
}

function cancelSmartProfileEdit() {
  editingSmartProfileId = null;
  showSmartProfileForm = false;
  crmSyncMessage = "";
  crmSyncLoading = false;
  renderAdmin();
}

function renderSmartProfileCard(profile) {
  const members = getSmartProfileMembers(profile.id);
  const usage = getProfileUsageCount(profile.id);
  return `
    <div class="admin-list-item admin-clickable-row packing-item-row" onclick="editSmartProfile(${profile.id})">
      <div class="admin-list-top">
        <div>
          <strong class="checklist-admin-title">${profileTypeIcon(profile.profile_type)} ${esc(profile.name)}</strong>
          <div class="admin-small">Key: ${esc(profile.profile_key)}</div>
          ${profile.description ? `<div class="admin-small">${esc(profile.description)}</div>` : ""}
          ${members.length ? `<div class="admin-small"><strong>Applies to:</strong> ${members.slice(0, 4).map(member => esc(member.member_value)).join(", ")}${members.length > 4 ? ` +${members.length - 4} more` : ""}</div>` : `<div class="admin-small">No members yet.</div>`}
          <span class="admin-pill">Used by ${usage} packing item${usage === 1 ? "" : "s"}</span>
          ${profile.active ? `<span class="admin-pill">Published</span>` : `<span class="admin-pill inactive">Unpublished</span>`}
        </div>
        <span class="admin-row-hint">Click to edit</span>
      </div>
    </div>
  `;
}

function renderSmartProfileForm(editingProfile) {
  const profileType = editingProfile ? editingProfile.profile_type : selectedSmartProfileType;
  const profileLabel = profileTypeLabel(profileType).replace(/ Profiles$/i, " Profile");

  return `
    <div class="admin-card admin-form-card smart-profile-editor-card">
      <h3>${editingProfile ? esc(profileLabel) : "Add Smart Profile"}</h3>
      <input type="hidden" id="smartProfileId" value="${editingProfile ? editingProfile.id : ""}">

      <div class="admin-grid compact">
        <div class="admin-field">
          <label>Profile type</label>
          <select id="smartProfileType" onchange="selectedSmartProfileType=this.value; renderAdmin()">
            ${smartProfileGroups.map(group => `<option value="${esc(group.profile_type)}" ${profileType === group.profile_type ? "selected" : ""}>${esc(group.name)}</option>`).join("")}
          </select>
        </div>
        <div class="admin-field">
          <label>Status</label>
          <select id="smartProfileActive">
            <option value="true" ${!editingProfile || editingProfile.active ? "selected" : ""}>Published</option>
            <option value="false" ${editingProfile && !editingProfile.active ? "selected" : ""}>Unpublished</option>
          </select>
        </div>
      </div>

      <div class="admin-grid compact">
        <div class="admin-field">
          <label>Name</label>
          <input type="text" id="smartProfileName" value="${editingProfile ? esc(editingProfile.name) : ""}" placeholder="Cold Climate">
        </div>
        <div class="admin-field">
          <label>Profile key</label>
          <input type="text" id="smartProfileKey" value="${editingProfile ? esc(editingProfile.profile_key) : ""}" placeholder="cold_climate">
          <div class="admin-helper">Leave blank for a new profile and Admin will generate it from the name.</div>
        </div>
      </div>

      <div class="admin-field">
        <label>Description</label>
        <textarea id="smartProfileDescription" placeholder="What this profile means and when it should be used.">${editingProfile ? esc(editingProfile.description || "") : ""}</textarea>
      </div>

      ${renderSmartProfileMemberSelector(editingProfile, profileType)}

      ${renderSmartProfilePackingItemSelector(editingProfile)}

      <div class="admin-field">
        <label>Display order</label>
        <input type="number" id="smartProfileDisplayOrder" value="${editingProfile ? esc(editingProfile.display_order || 0) : "0"}">
      </div>

      <button class="admin-button" onclick="saveSmartProfile()">${editingProfile ? "Save Profile" : "Add Profile"}</button>
      <button class="admin-button secondary" onclick="cancelSmartProfileEdit()">Cancel</button>
      <div id="smart-profile-message" class="admin-message"></div>
    </div>
  `;
}

async function saveSmartProfile() {
  const id = document.getElementById("smartProfileId").value;
  const name = document.getElementById("smartProfileName").value.trim();
  const profileType = document.getElementById("smartProfileType").value;
  const message = document.getElementById("smart-profile-message");

  if (!name) {
    if (message) message.innerText = "Please enter a profile name.";
    return;
  }

  const payload = {
    profile_type: profileType,
    profile_key: document.getElementById("smartProfileKey").value.trim() || profileKeyFromName(name),
    name,
    description: document.getElementById("smartProfileDescription").value.trim() || null,
    display_order: Number(document.getElementById("smartProfileDisplayOrder").value || 0),
    active: document.getElementById("smartProfileActive").value === "true"
  };

  let savedId = id;
  const result = id
    ? await supabaseClient.from("smart_profiles").update(payload).eq("id", id).select("id").single()
    : await supabaseClient.from("smart_profiles").insert(payload).select("id").single();

  if (result.error) {
    console.error("Save smart profile error", result.error);
    if (message) message.innerText = result.error.message;
    return;
  }

  savedId = result.data?.id || savedId;

  const memberType = document.getElementById("smartProfileMemberType")?.value || "value";
  const selectedMemberValues = Array.from(document.querySelectorAll(".smartProfileMemberCheckbox"))
    .filter(input => input.checked)
    .map(input => input.value)
    .filter(Boolean);

  const deleteResult = await supabaseClient.from("smart_profile_members").delete().eq("profile_id", savedId);
  if (deleteResult.error) {
    console.error("Smart profile member delete error", deleteResult.error);
    if (message) message.innerText = deleteResult.error.message;
    return;
  }

  if (selectedMemberValues.length) {
    const memberRows = selectedMemberValues.map(value => ({ profile_id: savedId, member_type: memberType, member_value: value }));
    const insertResult = await supabaseClient.from("smart_profile_members").insert(memberRows);
    if (insertResult.error) {
      console.error("Smart profile member insert error", insertResult.error);
      if (message) message.innerText = insertResult.error.message;
      return;
    }
  }

  if (savedId) {
    const selectedPackingItemIds = Array.from(document.querySelectorAll(".smartProfilePackingCheckbox"))
      .filter(input => input.checked)
      .map(input => Number(input.value))
      .filter(Boolean);

    const deletePackingResult = await supabaseClient.from("packing_item_profiles").delete().eq("profile_id", savedId);
    if (deletePackingResult.error) {
      console.error("Smart profile packing mapping delete error", deletePackingResult.error);
      if (message) message.innerText = deletePackingResult.error.message;
      return;
    }

    if (selectedPackingItemIds.length) {
      const packingRows = selectedPackingItemIds.map(itemId => ({ packing_item_id: itemId, profile_id: Number(savedId) }));
      const insertPackingResult = await supabaseClient.from("packing_item_profiles").insert(packingRows);
      if (insertPackingResult.error) {
        console.error("Smart profile packing mapping insert error", insertPackingResult.error);
        if (message) message.innerText = insertPackingResult.error.message;
        return;
      }
    }
  }

  selectedSmartProfileType = profileType;
  editingSmartProfileId = null;
  showSmartProfileForm = false;
  await loadAdminData();
  renderAdmin();
}


function formatPackingPrintValue(value, fallback = "—") {
  if (Array.isArray(value)) {
    const cleaned = value.map(item => String(item || "").trim()).filter(Boolean);
    return cleaned.length ? cleaned.join(", ") : fallback;
  }

  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "all") return fallback;
  return text;
}

function getPackingProfileNamesForItem(itemId) {
  const profileIds = getPackingProfileIdsForItem(itemId).map(String);
  if (!profileIds.length) return [];

  return smartProfiles
    .filter(profile => profileIds.includes(String(profile.id)))
    .map(profile => profile.name || profile.profile_name || `Profile ${profile.id}`)
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function printPackingItemLibrary() {
  const sortedItems = [...(packingItems || [])].sort((a, b) => {
    const categoryCompare = String(getPackingCategoryName(a.category_id)).localeCompare(String(getPackingCategoryName(b.category_id)));
    if (categoryCompare !== 0) return categoryCompare;
    const orderCompare = Number(a.display_order || 0) - Number(b.display_order || 0);
    if (orderCompare !== 0) return orderCompare;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  if (!sortedItems.length) {
    alert("There are no packing items to print.");
    return;
  }

  const rows = sortedItems.map(item => {
    const profiles = getPackingProfileNamesForItem(item.id);
    const essential = isEssentialPackingItem(item);
    return `
      <tr>
        <td>${esc(getPackingCategoryName(item.category_id))}</td>
        <td><strong>${esc(item.name || "")}</strong></td>
        <td>${esc(item.item_type || "—")}</td>
        <td>${essential ? "Yes" : "No"}</td>
        <td class="number">${esc(Number(item.weight_kg || 0).toFixed(2))}</td>
        <td>${item.active ? "Published" : "Unpublished"}</td>
        <td class="number">${esc(item.display_order ?? 0)}</td>
        <td>${esc(formatPackingPrintValue(profiles))}</td>
        <td>${esc(formatPackingPrintValue(item.destination_tags))}</td>
        <td>${esc(formatPackingPrintValue(item.climate_tags))}</td>
        <td>${esc(formatPackingPrintValue(item.traveller_types))}</td>
        <td>${esc(formatPackingPrintValue(item.dress_codes))}</td>
        <td>${esc(formatPackingPrintValue(item.cruise_line_tags))}</td>
        <td>${esc(item.description || "—")}</td>
        <td>${esc(item.help_text || "—")}</td>
      </tr>`;
  }).join("");

  const generatedAt = new Date().toLocaleString();
  const printFrame = document.createElement("iframe");
  printFrame.setAttribute("title", "Packing item print view");
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "0";
  printFrame.style.height = "0";
  printFrame.style.border = "0";
  printFrame.style.visibility = "hidden";
  document.body.appendChild(printFrame);

  const printDocument = printFrame.contentDocument || printFrame.contentWindow?.document;
  if (!printDocument) {
    printFrame.remove();
    alert("The print view could not be created. Please reload the page and try again.");
    return;
  }

  printDocument.open();
  printDocument.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>101CRUISE Packing Item Library</title>
  <style>
    @page { size: A3 landscape; margin: 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
    h1 { margin: 0 0 3px; font-size: 18px; }
    .meta { margin: 0 0 10px; color: #4b5563; font-size: 9px; }
    table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 7px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td { border: 1px solid #cbd5e1; padding: 3px 4px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #eef2f7; font-weight: 700; white-space: nowrap; }
    tbody tr:nth-child(even) { background: #f8fafc; }
    .number { text-align: right; white-space: nowrap; }
    .screen-actions { margin-bottom: 12px; }
    button { appearance: none; border: 0; border-radius: 8px; background: #111827; color: white; padding: 8px 13px; font: inherit; cursor: pointer; }
    @media print { .screen-actions { display: none; } }
  </style>
</head>
<body>
  <div class="screen-actions"><button onclick="window.print()">Print</button></div>
  <h1>101CRUISE Packing Item Library</h1>
  <p class="meta">${sortedItems.length} items · Generated ${esc(generatedAt)} · One row per packing item</p>
  <table>
    <thead>
      <tr>
        <th>Category</th>
        <th>Item</th>
        <th>Type</th>
        <th>Essential</th>
        <th>Weight kg</th>
        <th>Status</th>
        <th>Order</th>
        <th>Smart Profiles</th>
        <th>Destinations</th>
        <th>Climates</th>
        <th>Travellers</th>
        <th>Dress Codes</th>
        <th>Cruise Lines</th>
        <th>Description</th>
        <th>Help Text</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
  printDocument.close();

  window.setTimeout(() => {
    try {
      printFrame.contentWindow?.focus();
      printFrame.contentWindow?.print();
    } catch (error) {
      console.error("Unable to print packing item library:", error);
      alert("The print dialog could not be opened. Please reload the page and try again.");
    }
  }, 250);

  window.setTimeout(() => printFrame.remove(), 60000);
}


function printPackingItemAuditList() {
  const sortedItems = [...(packingItems || [])].sort((a, b) => {
    const categoryCompare = String(getPackingCategoryName(a.category_id)).localeCompare(String(getPackingCategoryName(b.category_id)));
    if (categoryCompare !== 0) return categoryCompare;
    const orderCompare = Number(a.display_order || 0) - Number(b.display_order || 0);
    if (orderCompare !== 0) return orderCompare;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  if (!sortedItems.length) {
    alert("There are no packing items to print.");
    return;
  }

  const rows = sortedItems.map(item => {
    const profiles = getPackingProfileNamesForItem(item.id);
    return `
      <tr>
        <td>${esc(getPackingCategoryName(item.category_id))}</td>
        <td><strong>${esc(item.name || "")}</strong></td>
        <td>${esc(item.item_type || "—")}</td>
        <td class="number">${esc(Number(item.weight_kg || 0).toFixed(2))} kg</td>
        <td>${esc(formatPackingPrintValue(item.climate_tags))}</td>
        <td>${esc(formatPackingPrintValue(profiles))}</td>
      </tr>`;
  }).join("");

  const generatedAt = new Date().toLocaleString();
  const printFrame = document.createElement("iframe");
  printFrame.setAttribute("title", "Packing item audit print view");
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "0";
  printFrame.style.height = "0";
  printFrame.style.border = "0";
  printFrame.style.visibility = "hidden";
  document.body.appendChild(printFrame);

  const printDocument = printFrame.contentDocument || printFrame.contentWindow?.document;
  if (!printDocument) {
    printFrame.remove();
    alert("The print view could not be created. Please reload the page and try again.");
    return;
  }

  printDocument.open();
  printDocument.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>101CRUISE Packing Item Audit List</title>
  <style>
    @page { size: A4 landscape; margin: 9mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
    h1 { margin: 0 0 3px; font-size: 18px; }
    .meta { margin: 0 0 10px; color: #4b5563; font-size: 9px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td { border: 1px solid #cbd5e1; padding: 4px 5px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #eef2f7; font-weight: 700; white-space: nowrap; }
    tbody tr:nth-child(even) { background: #f8fafc; }
    .number { text-align: right; white-space: nowrap; }
    .screen-actions { margin-bottom: 12px; }
    button { appearance: none; border: 0; border-radius: 8px; background: #111827; color: white; padding: 8px 13px; font: inherit; cursor: pointer; }
    th:nth-child(1), td:nth-child(1) { width: 16%; }
    th:nth-child(2), td:nth-child(2) { width: 22%; }
    th:nth-child(3), td:nth-child(3) { width: 11%; }
    th:nth-child(4), td:nth-child(4) { width: 10%; }
    th:nth-child(5), td:nth-child(5) { width: 18%; }
    th:nth-child(6), td:nth-child(6) { width: 23%; }
    @media print { .screen-actions { display: none; } }
  </style>
</head>
<body>
  <div class="screen-actions"><button onclick="window.print()">Print</button></div>
  <h1>101CRUISE Packing Item Audit List</h1>
  <p class="meta">${sortedItems.length} items · Generated ${esc(generatedAt)} · One row per packing item</p>
  <table>
    <thead>
      <tr>
        <th>Category</th>
        <th>Item</th>
        <th>Item Type</th>
        <th>Weight</th>
        <th>Climates</th>
        <th>Smart Profiles</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
  printDocument.close();

  window.setTimeout(() => {
    try {
      printFrame.contentWindow?.focus();
      printFrame.contentWindow?.print();
    } catch (error) {
      console.error("Unable to print packing item audit list:", error);
      alert("The print dialog could not be opened. Please reload the page and try again.");
    }
  }, 250);

  window.setTimeout(() => printFrame.remove(), 60000);
}


function getPackingCategoryLocalOrder(item) {
  const categoryItems = (packingItems || [])
    .filter(candidate => String(candidate.category_id) === String(item.category_id))
    .sort((a, b) => {
      const orderCompare = Number(a.display_order || 0) - Number(b.display_order || 0);
      if (orderCompare !== 0) return orderCompare;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  const index = categoryItems.findIndex(candidate => String(candidate.id) === String(item.id));
  return index >= 0 ? index + 1 : "–";
}

function renderPackingItemCard(item) {
  const isEditing = String(editingPackingItemId || "") === String(item.id);
  const assignedProfileIds = getPackingProfileIdsForItem(item.id);
  const assignedProfiles = assignedProfileIds
    .map(profileId => smartProfiles.find(profile => String(profile.id) === String(profileId))?.name)
    .filter(Boolean);
  const profilePreview = assignedProfiles.length ? assignedProfiles.join(" • ") : "None assigned";
  const restriction = item.packing_restriction || "any";
  const restrictionLabel = restriction === "carry-on-only" ? "Carry-on only" : restriction === "checked-only" ? "Checked luggage only" : "Any location";
  const restrictionClass = restriction === "carry-on-only" ? "carry-on" : restriction === "checked-only" ? "checked-only" : "any-location";
  const assignedProfileCount = assignedProfileIds.length;
  const categoryLocalOrder = getPackingCategoryLocalOrder(item);
  const ruleText = isEssentialPackingItem(item)
    ? "Essential item included on every cruise"
    : (assignedProfileCount ? `Smart Profile item (${assignedProfileCount} profile${assignedProfileCount === 1 ? "" : "s"})` : formatPackingRule(item.destination_tags || item.climate_tags || item.traveller_types || item.dress_codes || item.cruise_line_tags, "Profile-specific item"));
  const reorderAttributes = packingReorderMode
    ? `draggable="true" data-category-id="${esc(item.category_id)}" ondragstart="startPackingItemDrag(event, ${item.id})" ondragend="endPackingItemDrag(event)" onclick="event.preventDefault()"`
    : `onclick="editPackingItem(${item.id})"`;
  return `
    <div class="admin-list-item ${packingReorderMode ? "packing-item-reorder-card" : "admin-clickable-row"} packing-item-row ${isEditing ? "is-editing" : ""}" data-packing-item-id="${item.id}" ${reorderAttributes}>
      ${isEditing && !packingReorderMode ? `
        <div onclick="event.stopPropagation()">
          ${renderPackingItemForm(item)}
        </div>
      ` : `
        <div class="admin-list-top">
          <div class="packing-card-main">
            <div class="packing-card-heading">
              <strong class="checklist-admin-title">${packingReorderMode ? `<span class="packing-drag-handle" aria-hidden="true">☰</span>` : ""}${esc(item.name)}</strong>
              <span class="packing-order-badge" title="Order within this category">${esc(categoryLocalOrder)}</span>
            </div>
            <div class="admin-small"><strong>Category:</strong> ${esc(getPackingCategoryName(item.category_id))}</div>
            <div class="admin-small"><strong>Smart Profiles:</strong> ${esc(profilePreview)}</div>
            <div class="admin-small"><strong>Weight:</strong> ${esc(Number(item.weight_kg || 0).toFixed(2))} kg each</div>
            ${item.description ? `<div class="admin-small">${esc(item.description)}</div>` : ""}
            ${item.help_text ? `<div class="admin-small"><strong>Why:</strong> ${esc(item.help_text)}</div>` : ""}
            <div class="admin-small"><strong>Logic:</strong> ${esc(ruleText)}</div>
            <span class="admin-pill packing-restriction-badge ${restrictionClass}">${esc(restrictionLabel)}</span>
            ${isEssentialPackingItem(item) ? `<span class="admin-pill essential-pill">Essential</span>` : ""}
            ${item.active ? `<span class="admin-pill">Published</span>` : `<span class="admin-pill inactive">Unpublished</span>`}
          </div>
          <div class="admin-row-actions" onclick="event.stopPropagation()">
            <span class="admin-row-hint">Click to edit</span>
            <button class="admin-button danger small" onclick="deletePackingItem(${item.id})">Delete</button>
          </div>
        </div>
      `}
    </div>
  `;
}

function renderPackingItemsList(items) {
  const sortedItems = [...(items || [])].sort((a, b) => {
    const catCompare = String(getPackingCategoryName(a.category_id)).localeCompare(String(getPackingCategoryName(b.category_id)));
    if (catCompare !== 0) return catCompare;
    const orderCompare = Number(a.display_order || 0) - Number(b.display_order || 0);
    if (orderCompare !== 0) return orderCompare;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  if (!sortedItems.length) return `<p class="admin-muted">No packing items found.</p>`;
  return `<div class="admin-packing-item-grid">${sortedItems.map(renderPackingItemCard).join("")}</div>`;
}

function renderPackingItemsByCategory() {
  const groups = getPackingItemsByCategory();
  const html = groups.map(({ category, items }) => `
    <div class="admin-category-block">
      <div class="admin-list-top admin-category-heading">
        <div>
          <h4>${esc(category.icon || "🧳")} ${esc(category.name)}</h4>
          ${category.description ? `<p class="admin-muted">${esc(category.description)}</p>` : ""}
        </div>
        <span class="admin-pill">${items.length} item${items.length === 1 ? "" : "s"}</span>
      </div>
      ${items.length ? `<div class="admin-packing-item-grid ${packingReorderMode ? "is-reordering" : ""}" data-packing-category-id="${esc(category.id)}" ondragover="allowPackingItemDrop(event)" ondrop="dropPackingItem(event, ${esc(category.id)})">${items.map(renderPackingItemCard).join("")}</div>` : `<p class="admin-muted">No items in this category.</p>`}
    </div>
  `).join("");

  return html || `<p class="admin-muted">No packing categories found.</p>`;
}


function togglePackingReorderMode() {
  packingReorderMode = !packingReorderMode;
  editingPackingItemId = null;
  showPackingItemForm = false;
  selectedPackingCategoryId = "by-category";
  renderAdmin();
}

function startPackingItemDrag(event, itemId) {
  if (!packingReorderMode) return;
  draggedPackingItemId = String(itemId);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedPackingItemId);
  event.currentTarget.classList.add("is-dragging");
}

function endPackingItemDrag(event) {
  event.currentTarget?.classList.remove("is-dragging");
  document.querySelectorAll(".packing-item-row.is-drop-target").forEach(card => card.classList.remove("is-drop-target"));
  draggedPackingItemId = null;
}

function allowPackingItemDrop(event) {
  if (!packingReorderMode) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";

  const grid = event.currentTarget;
  const dragged = document.querySelector(`.packing-item-row[data-packing-item-id="${CSS.escape(String(draggedPackingItemId || ""))}"]`);
  if (!dragged || dragged.parentElement !== grid) return;

  const cards = Array.from(grid.querySelectorAll(".packing-item-row:not(.is-dragging)"));
  const afterElement = cards.find(card => {
    const rect = card.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    return event.clientY < midpoint;
  });

  if (afterElement) grid.insertBefore(dragged, afterElement);
  else grid.appendChild(dragged);
}

async function dropPackingItem(event, categoryId) {
  if (!packingReorderMode) return;
  event.preventDefault();

  const grid = event.currentTarget;
  const dragged = grid.querySelector(`.packing-item-row[data-packing-item-id="${CSS.escape(String(draggedPackingItemId || ""))}"]`);
  if (!dragged || String(dragged.dataset.categoryId || categoryId) !== String(categoryId)) {
    endPackingItemDrag({ currentTarget: dragged });
    return;
  }

  const orderedCards = Array.from(grid.querySelectorAll(".packing-item-row"));
  const updates = orderedCards.map((card, index) => {
    const itemId = Number(card.dataset.packingItemId);
    const nextOrder = index + 1;
    const localItem = packingItems.find(item => String(item.id) === String(itemId));
    if (localItem) localItem.display_order = nextOrder;
    return supabaseClient.from("packing_items").update({ display_order: nextOrder }).eq("id", itemId);
  });

  const results = await Promise.all(updates);
  const failed = results.find(result => result.error);
  if (failed) {
    console.error("Packing reorder save error", failed.error);
    alert(`Could not save the new order: ${failed.error.message}`);
    await loadAdminData();
    renderAdmin();
    return;
  }

  draggedPackingItemId = null;
  renderAdmin();
  requestAnimationFrame(() => {
    const categoryGrid = document.querySelector(`[data-packing-category-id="${CSS.escape(String(categoryId))}"]`);
    categoryGrid?.classList.add("is-order-saved");
    window.setTimeout(() => categoryGrid?.classList.remove("is-order-saved"), 1400);
  });
}

function setPackingCategoryFilter(value) {
  selectedPackingCategoryId = value || "by-category";
  editingPackingItemId = null;
  renderAdmin();
}

function setPackingAdminView(view) {
  activePackingAdminView = view === "categories" ? "categories" : "items";
  editingPackingCategoryId = null;
  editingPackingItemId = null;
  showPackingCategoryForm = false;
  showPackingItemForm = false;
  renderAdmin();
}

function editPackingItem(itemId) {
  activePackingAdminView = "items";
  editingPackingItemId = itemId;
  editingPackingCategoryId = null;
  showPackingItemForm = false;
  showPackingCategoryForm = false;
  renderAdmin();
}

function cancelPackingItemEdit() {
  editingPackingItemId = null;
  showPackingItemForm = false;
  renderAdmin();
}

function showNewPackingCategoryForm() {
  activePackingAdminView = "categories";
  editingPackingCategoryId = null;
  editingPackingItemId = null;
  showPackingCategoryForm = true;
  showPackingItemForm = false;
  renderAdmin();
}

function showNewPackingItemForm() {
  activePackingAdminView = "items";
  editingPackingCategoryId = null;
  editingPackingItemId = null;
  showPackingItemForm = true;
  showPackingCategoryForm = false;
  renderAdmin();
}

function editPackingCategory(categoryId) {
  activePackingAdminView = "categories";
  editingPackingCategoryId = categoryId;
  editingPackingItemId = null;
  showPackingCategoryForm = true;
  showPackingItemForm = false;
  renderAdmin();
}

function cancelPackingCategoryEdit() {
  editingPackingCategoryId = null;
  showPackingCategoryForm = false;
  renderAdmin();
}

async function savePackingCategory() {
  const id = document.getElementById("packingCategoryId").value;
  const payload = {
    name: document.getElementById("packingCategoryName").value.trim(),
    description: document.getElementById("packingCategoryDescription").value.trim() || null,
    icon: document.getElementById("packingCategoryIcon").value.trim() || null,
    display_order: Number(document.getElementById("packingCategoryDisplayOrder").value || 0),
    active: document.getElementById("packingCategoryActive").value === "true"
  };

  const message = document.getElementById("packing-category-message");
  if (!payload.name) {
    if (message) message.innerText = "Please enter a category name.";
    return;
  }

  const result = id
    ? await supabaseClient.from("packing_categories").update(payload).eq("id", id)
    : await supabaseClient.from("packing_categories").insert(payload);

  if (result.error) {
    console.error("Save packing category error", result.error);
    if (message) message.innerText = result.error.message;
    return;
  }

  editingPackingCategoryId = null;
  showPackingCategoryForm = false;
  await loadAdminData();
  renderAdmin();
}

async function deletePackingCategory(categoryId) {
  const category = packingCategories.find(row => String(row.id) === String(categoryId));
  const categoryName = category ? category.name : "this category";
  const itemCount = packingItems.filter(item => String(item.category_id) === String(categoryId)).length;

  if (itemCount > 0) {
    alert(`Cannot delete "${categoryName}" because it still contains ${itemCount} packing item${itemCount === 1 ? "" : "s"}. Move or delete those items first.`);
    return;
  }

  const confirmed = window.confirm(`Delete "${categoryName}"?\n\nThis category is empty, so no packing items will be deleted.`);
  if (!confirmed) return;

  try {
    const result = await supabaseClient
      .from("packing_categories")
      .delete()
      .eq("id", categoryId);

    if (result.error) throw result.error;

    editingPackingCategoryId = null;
    showPackingCategoryForm = false;
    await loadAdminData();
    renderAdmin();
  } catch (error) {
    console.error("Delete packing category error", error);
    alert(error.message || "Unable to delete this packing category.");
  }
}


function renderPackingImportPanel() {
  return `
    <div class="admin-card packing-import-card">
      <div class="admin-list-top">
        <div>
          <h3>Bulk Import Packing Library</h3>
          <p class="admin-muted">Export the <strong>Packing Items</strong> tab from Google Sheets as CSV, then paste it here or upload the CSV file. This updates categories and packing items in bulk.</p>
        </div>
      </div>

      <div class="admin-grid">
        <div class="admin-field">
          <label>Upload CSV file</label>
          <input type="file" accept=".csv,text/csv" onchange="handlePackingCsvFile(this)">
        </div>
        <div class="admin-field">
          <label>Import mode</label>
          <select id="packingImportMode">
            <option value="upsert">Update existing items and add new ones</option>
            <option value="replace-active">Update/add items and mark missing imported items unpublished</option>
          </select>
        </div>
      </div>

      <div class="admin-field">
        <label>CSV content</label>
        <textarea id="packingImportCsv" rows="8" placeholder="Paste CSV exported from the Packing Items tab here"></textarea>
      </div>

      <div class="admin-actions-row">
        <button class="admin-button" onclick="importPackingLibraryCsv()">Import Packing Library</button>
        <button class="admin-button secondary" onclick="previewPackingLibraryCsv()">Preview CSV</button>
        <button class="admin-button secondary" onclick="clearPackingImportCsv()">Clear</button>
      </div>
      <div id="packing-import-message" class="admin-message"></div>
      <p class="admin-small">Required columns: Category and Item. Recommended columns: Priority, Weight kg, Traveller Type, Climate, Destination, Dress Code, Cruise Line, Paul's Tip, Why, Active.</p>
    </div>
  `;
}

function renderPackingCategoryForm(editingCategory) {
  return `
    <div class="admin-card admin-form-card">
      <h3>${editingCategory ? "Edit Packing Category" : "Add Packing Category"}</h3>
      <input type="hidden" id="packingCategoryId" value="${editingCategory ? editingCategory.id : ""}">

      <div class="admin-field">
        <label>Category name</label>
        <input type="text" id="packingCategoryName" value="${editingCategory ? esc(editingCategory.name) : ""}" placeholder="Clothing">
      </div>

      <div class="admin-field">
        <label>Description</label>
        <textarea id="packingCategoryDescription" placeholder="Short description shown above this category">${editingCategory ? esc(editingCategory.description || "") : ""}</textarea>
      </div>

      <div class="admin-grid compact">
        <div class="admin-field">
          <label>Icon</label>
          <input type="text" id="packingCategoryIcon" value="${editingCategory ? esc(editingCategory.icon || "") : ""}" placeholder="👕">
        </div>
        <div class="admin-field">
          <label>Display order</label>
          <input type="number" id="packingCategoryDisplayOrder" value="${editingCategory ? esc(editingCategory.display_order || 0) : "0"}">
        </div>
      </div>

      <div class="admin-field">
        <label>Status</label>
        <select id="packingCategoryActive">
          <option value="true" ${!editingCategory || editingCategory.active ? "selected" : ""}>Published</option>
          <option value="false" ${editingCategory && !editingCategory.active ? "selected" : ""}>Unpublished</option>
        </select>
      </div>

      <button class="admin-button" onclick="savePackingCategory()">${editingCategory ? "Save Category" : "Add Category"}</button>
      <button class="admin-button secondary" onclick="cancelPackingCategoryEdit()">Cancel</button>
      ${editingCategory ? `<button class="admin-button danger" onclick="deletePackingCategory(${editingCategory.id})">Delete Category</button>` : ""}
      <div id="packing-category-message" class="admin-message"></div>
    </div>
  `;
}

function renderPackingCategoryCard(category) {
  const count = packingItems.filter(item => String(item.category_id) === String(category.id)).length;
  return `
    <div class="admin-list-item compact-item admin-clickable-row admin-category-tile" onclick="editPackingCategory(${category.id})">
      <div class="admin-category-tile-icon">${esc(category.icon || "🧳")}</div>
      <div>
        <strong>${esc(category.name)}</strong>
        <div class="admin-small">${count} item${count === 1 ? "" : "s"}</div>
        ${category.description ? `<div class="admin-small">${esc(category.description)}</div>` : ""}
        ${category.active ? `<span class="admin-pill">Published</span>` : `<span class="admin-pill inactive">Unpublished</span>`}
      </div>
    </div>
  `;
}

function renderPackingPanel() {
  const editingCategory = packingCategories.find(category => category.id === editingPackingCategoryId);
  const filteredItems = getFilteredPackingItems();
  const showingItems = activePackingAdminView !== "categories";

  return `
    <div class="admin-card admin-packing-hero-card">
      <div class="admin-list-top">
        <div>
          <h3>Smart Packing Planner</h3>
          <p class="admin-muted">Manage packing categories, default items, quantities, weights and the rules that create each customer’s packing list.</p>
        </div>
        <div class="admin-actions-row compact-actions">
          <button class="admin-button secondary" onclick="showNewPackingItemForm()">Add Packing Item</button>
          <button class="admin-button secondary" onclick="showNewPackingCategoryForm()">Add Packing Category</button>
          <button class="admin-button secondary" onclick="printPackingItemLibrary()">Print Full Item List</button>
          <button class="admin-button secondary" onclick="printPackingItemAuditList()">Print Audit List</button>
          <button class="admin-button ${packingReorderMode ? "" : "secondary"}" onclick="togglePackingReorderMode()">${packingReorderMode ? "Done Reordering" : "Reorder Items"}</button>
          <button class="admin-button secondary" onclick="refreshAdminData()">Refresh</button>
        </div>
      </div>

      <div class="admin-subtabs packing-subtabs" role="tablist" aria-label="Packing admin sections">
        <button class="admin-subtab ${showingItems ? "active" : ""}" onclick="setPackingAdminView('items')" type="button">Packing Items</button>
        <button class="admin-subtab ${!showingItems ? "active" : ""}" onclick="setPackingAdminView('categories')" type="button">Packing Categories</button>
      </div>
    </div>

    ${!showingItems && showPackingCategoryForm ? renderPackingCategoryForm(editingCategory) : ""}

    ${showingItems && showPackingItemForm ? `
      <div class="admin-card admin-form-card">
        <h3>Add Packing Item</h3>
        ${renderPackingItemForm(null)}
      </div>
    ` : ""}

    ${!showingItems ? `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Packing Categories</h3>
            <p class="admin-muted">Click a category to edit it. These control how packing items are grouped in the customer planner.</p>
          </div>
        </div>
        ${packingCategories.length ? `<div class="admin-category-tile-grid">${packingCategories.map(renderPackingCategoryCard).join("")}</div>` : `<p>No packing categories found.</p>`}
      </div>
    ` : `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Packing Items</h3>
            <p class="admin-muted">${packingReorderMode ? "Drag items within a category to change their order. Changes save automatically." : "Items are displayed by category order. Essential items are included on every cruise; other items appear when the visibility rules in “Show this item for” match."}</p>
          </div>
          <div class="admin-field admin-filter-field">
            <label>Display</label>
            <select id="packingCategoryFilter" onchange="setPackingCategoryFilter(this.value)">
              <option value="all" ${selectedPackingCategoryId === "all" ? "selected" : ""}>All items</option>
              <option value="by-category" ${selectedPackingCategoryId === "by-category" ? "selected" : ""}>Display by Category order</option>
              ${packingCategories.map(category => `<option value="${category.id}" ${String(selectedPackingCategoryId) === String(category.id) ? "selected" : ""}>${esc(category.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        ${selectedPackingCategoryId === "by-category" ? renderPackingItemsByCategory() : renderPackingItemsList(filteredItems)}
      </div>
    `}
  `;
}

function renderPackingItemForm(editingItem) {
  const applies = key => editingItem ? (editingItem[key] || "") : "";
  const cruiseLineOptions = cruiseLines.map(line => line.name).filter(Boolean).sort((a, b) => a.localeCompare(b));

  return `
    <input type="hidden" id="packingItemId" value="${editingItem ? editingItem.id : ""}">

    <div class="admin-grid">
      <div class="admin-field">
        <label>Category</label>
        <select id="packingItemCategoryId">
          <option value="">Select category</option>
          ${packingCategories.map(category => `<option value="${category.id}" ${editingItem && editingItem.category_id === category.id ? "selected" : ""}>${esc(category.name)}</option>`).join("")}
        </select>
      </div>
      <div class="admin-field">
        <label>Type</label>
        <select id="packingItemType">
          ${["Required", "Recommended", "Optional"].map(type => `<option value="${type}" ${editingItem && editingItem.item_type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="admin-field">
      <label>Item name</label>
      <input type="text" id="packingItemName" value="${editingItem ? esc(editingItem.name) : ""}" placeholder="Polo shirts">
    </div>

    <div class="admin-field">
      <label>Description / packing note</label>
      <textarea id="packingItemDescription" placeholder="Short note shown under the item">${editingItem ? esc(editingItem.description || "") : ""}</textarea>
    </div>

    <div class="admin-field admin-essential-field">
      <label class="admin-check-line">
        <input type="checkbox" id="packingItemEssential" ${editingItem && isEssentialPackingItem(editingItem) ? "checked" : ""} onchange="togglePackingEssentialMode()">
        <span>Essential</span>
      </label>
      <div class="admin-helper">Tick this when the item should be included on every cruise. Essential items do not need destination, climate, traveller, cruise type or dress profile rules.</div>
    </div>

    <div class="admin-grid compact">
      <div class="admin-field">
        <label>Weight each (kg)</label>
        <input type="number" id="packingItemWeightKg" value="${editingItem ? esc(editingItem.weight_kg || 0) : "0"}" min="0" step="0.01">
      </div>
    </div>

    <div class="admin-field admin-packing-restriction">
      <label>Packing restriction</label>
      <select id="packingItemRestriction" onchange="togglePackingRestrictionHelp()">
        <option value="any" ${!editingItem || !editingItem.packing_restriction || editingItem.packing_restriction === "any" ? "selected" : ""}>Any location</option>
        <option value="carry-on-only" ${editingItem?.packing_restriction === "carry-on-only" ? "selected" : ""}>Carry-on only</option>
        <option value="checked-only" ${editingItem?.packing_restriction === "checked-only" ? "selected" : ""}>Checked luggage only</option>
      </select>
      <div id="packingRestrictionHelp" class="admin-restriction-help ${editingItem?.packing_restriction && editingItem.packing_restriction !== "any" ? "is-visible" : ""}">
        <strong>Airline safety notice</strong>
        <span>This restriction is enforced automatically in My Cruise. Use it only when an item must travel in a particular baggage location.</span>
      </div>
    </div>

    <div class="admin-form-section-intro">
      <div class="admin-section-mini-title">Show this item for</div>
      <p class="admin-helper">Choose when this item should appear in the customer packing list. Leave the relevant “All” option selected unless the item only applies to specific destinations, climates, traveller types, dress codes or cruise lines. These are the only visibility rules you need to set.</p>
    </div>

    ${renderAdminMultiSelect({
      id: "packingItemDestinations",
      label: "Applies to destinations",
      allLabel: "All destinations",
      options: PACKING_DESTINATION_OPTIONS,
      value: applies("destination_tags")
    })}

    ${renderAdminMultiSelect({
      id: "packingItemClimates",
      label: "Applies to climates",
      allLabel: "All climates",
      options: PACKING_CLIMATE_OPTIONS,
      value: applies("climate_tags")
    })}

    ${renderAdminMultiSelect({
      id: "packingItemTravellers",
      label: "Applies to traveller types",
      allLabel: "All traveller types",
      options: PACKING_TRAVELLER_OPTIONS,
      value: applies("traveller_types")
    })}

    ${renderAdminMultiSelect({
      id: "packingItemDressCodes",
      label: "Applies to dress codes",
      allLabel: "All dress codes",
      options: PACKING_DRESS_CODE_OPTIONS,
      value: applies("dress_codes")
    })}

    ${renderAdminMultiSelect({
      id: "packingItemCruiseLines",
      label: "Applies to cruise lines",
      allLabel: "All cruise lines",
      options: cruiseLineOptions,
      value: applies("cruise_line_tags")
    })}


    <div class="admin-field">
      <label>Why am I packing this?</label>
      <input type="text" id="packingItemHelpText" value="${editingItem ? esc(editingItem.help_text || "") : ""}" placeholder="Useful for glacier viewing, formal nights, etc.">
    </div>

    <div class="admin-grid compact">
      <div class="admin-field">
        <label>Display order</label>
        <input type="number" id="packingItemDisplayOrder" value="${editingItem ? esc(editingItem.display_order || 0) : "0"}">
      </div>
      <div class="admin-field">
        <label>Status</label>
        <select id="packingItemActive">
          <option value="true" ${!editingItem || editingItem.active ? "selected" : ""}>Published</option>
          <option value="false" ${editingItem && !editingItem.active ? "selected" : ""}>Unpublished</option>
        </select>
      </div>
    </div>

    <button class="admin-button" onclick="savePackingItem()">${editingItem ? "Save Item" : "Add Item"}</button>
    ${editingItem ? `<button class="admin-button secondary" onclick="cancelPackingItemEdit()">Cancel</button>` : ""}
    ${editingItem ? `<button class="admin-button danger" onclick="deletePackingItem(${editingItem.id})">Delete Item</button>` : ""}
    <div id="packing-item-message" class="admin-message"></div>
  `;
}

function togglePackingRestrictionHelp() {
  const value = document.getElementById("packingItemRestriction")?.value || "any";
  document.getElementById("packingRestrictionHelp")?.classList.toggle("is-visible", value !== "any");
}

async function savePackingItem() {
  const id = document.getElementById("packingItemId").value;
  const payload = {
    category_id: Number(document.getElementById("packingItemCategoryId").value),
    name: document.getElementById("packingItemName").value.trim(),
    description: document.getElementById("packingItemDescription").value.trim() || null,
    item_type: document.getElementById("packingItemType").value,
    weight_kg: Number(document.getElementById("packingItemWeightKg").value || 0),
    packing_restriction: document.getElementById("packingItemRestriction")?.value || "any",
    destination_tags: document.getElementById("packingItemDestinations").value.trim() || null,
    climate_tags: document.getElementById("packingItemClimates").value.trim() || null,
    traveller_types: document.getElementById("packingItemTravellers").value.trim() || null,
    dress_codes: document.getElementById("packingItemDressCodes").value.trim() || null,
    cruise_line_tags: document.getElementById("packingItemCruiseLines").value.trim() || null,
    help_text: document.getElementById("packingItemHelpText").value.trim() || null,
    include_on_every_cruise: document.getElementById("packingItemEssential")?.checked === true,
    display_order: Number(document.getElementById("packingItemDisplayOrder").value || 0),
    active: document.getElementById("packingItemActive").value === "true"
  };

  const message = document.getElementById("packing-item-message");
  if (!payload.category_id || !payload.name) {
    if (message) message.innerText = "Please select a category and enter an item name.";
    return;
  }

  const result = id
    ? await supabaseClient.from("packing_items").update(payload).eq("id", id).select("id").single()
    : await supabaseClient.from("packing_items").insert(payload).select("id").single();

  if (result.error) {
    console.error("Save packing item error", result.error);
    if (message) message.innerText = result.error.message;
    return;
  }

  const savedItemId = result.data?.id || id;
  await savePackingItemProfileSelections(savedItemId, message);

  editingPackingItemId = null;
  await loadAdminData();
  renderAdmin();
  requestAnimationFrame(() => {
    const savedCard = document.querySelector(`[data-packing-item-id="${CSS.escape(String(savedItemId))}"]`);
    if (!savedCard) return;
    savedCard.scrollIntoView({ behavior: "smooth", block: "center" });
    savedCard.classList.add("is-just-saved");
    window.setTimeout(() => savedCard.classList.remove("is-just-saved"), 2200);
  });
}

async function savePackingItemProfileSelections(itemId, message) {
  const checkboxes = Array.from(document.querySelectorAll(".packingProfileCheckbox"));
  if (!itemId || !checkboxes.length) return;

  const selectedProfileIds = checkboxes.filter(input => input.checked).map(input => Number(input.value)).filter(Boolean);
  const deleteResult = await supabaseClient.from("packing_item_profiles").delete().eq("packing_item_id", itemId);
  if (deleteResult.error) {
    console.error("Packing profile mapping delete error", deleteResult.error);
    if (message) message.innerText = deleteResult.error.message;
    throw deleteResult.error;
  }

  if (!selectedProfileIds.length) return;

  const rows = selectedProfileIds.map(profileId => ({ packing_item_id: Number(itemId), profile_id: profileId }));
  const insertResult = await supabaseClient.from("packing_item_profiles").insert(rows);
  if (insertResult.error) {
    console.error("Packing profile mapping insert error", insertResult.error);
    if (message) message.innerText = insertResult.error.message;
    throw insertResult.error;
  }
}



async function deletePackingItem(itemId) {
  const item = packingItems.find(row => String(row.id) === String(itemId));
  const itemName = item ? item.name : "this packing item";

  const confirmed = window.confirm(`Delete "${itemName}"?\n\nThis will permanently remove the item and remove it from any Smart Profiles.`);
  if (!confirmed) return;

  try {
    const profileDelete = await supabaseClient
      .from("packing_item_profiles")
      .delete()
      .eq("packing_item_id", itemId);

    if (profileDelete.error) throw profileDelete.error;

    const itemDelete = await supabaseClient
      .from("packing_items")
      .delete()
      .eq("id", itemId);

    if (itemDelete.error) throw itemDelete.error;

    editingPackingItemId = null;
    showPackingItemForm = false;
    await loadAdminData();
    renderAdmin();
  } catch (error) {
    console.error("Delete packing item error", error);
    alert(error.message || "Unable to delete this packing item.");
  }
}



function normalizeImportHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < String(text || "").length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some(value => String(value || "").trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some(value => String(value || "").trim() !== "")) rows.push(row);
  return rows;
}

function getImportValue(record, names) {
  for (const name of names) {
    const key = normalizeImportHeader(name);
    if (record[key] !== undefined && record[key] !== null) return String(record[key]).trim();
  }
  return "";
}

function csvRowsToRecords(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(normalizeImportHeader);
  return rows.slice(1).map(row => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row[index] === undefined ? "" : row[index];
    });
    return record;
  });
}

function normalizeImportList(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned || cleaned.toLowerCase() === "all" || cleaned.toLowerCase() === "any") return null;
  return cleaned.replace(/\s*;\s*/g, ", ");
}

function normalizePackingImportType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["essential", "required", "must have", "must-have", "musthave"].includes(type)) return "Required";
  if (["optional", "nice to have", "nice-to-have"].includes(type)) return "Optional";
  return "Recommended";
}

function parseImportNumber(value, fallback = 0) {
  const text = String(value || "").replace(/kg|g/gi, "").trim();
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function parseImportActive(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  return !["no", "false", "0", "inactive", "unpublished", "hide"].includes(text);
}

function getPackingCategoryIcon(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("document")) return "📄";
  if (value.includes("money") || value.includes("payment")) return "💳";
  if (value.includes("cloth")) return "👕";
  if (value.includes("evening") || value.includes("formal")) return "🎩";
  if (value.includes("swim") || value.includes("pool") || value.includes("beach")) return "🏖";
  if (value.includes("shoe") || value.includes("foot")) return "👞";
  if (value.includes("toiletr") || value.includes("health")) return "🧴";
  if (value.includes("medication") || value.includes("medicine")) return "💊";
  if (value.includes("tech") || value.includes("electronic")) return "📱";
  if (value.includes("bag") || value.includes("luggage")) return "🧳";
  if (value.includes("shore") || value.includes("excursion")) return "🎒";
  if (value.includes("cabin")) return "🛏";
  if (value.includes("kid") || value.includes("baby") || value.includes("family")) return "👶";
  if (value.includes("last")) return "🧳";
  return "🧳";
}

function buildPackingImportData(csvText) {
  const rows = parseCsvText(csvText);
  const records = csvRowsToRecords(rows);
  const categories = [];
  const categoryOrder = new Map();
  const items = [];
  const itemOrderByCategory = new Map();

  records.forEach((record, index) => {
    const category = getImportValue(record, ["Category"]);
    const name = getImportValue(record, ["Item", "Item Name", "Name"]);
    if (!category || !name) return;

    if (!categoryOrder.has(category)) {
      categoryOrder.set(category, categoryOrder.size + 1);
      categories.push({
        name: category,
        icon: getPackingCategoryIcon(category),
        description: null,
        display_order: categoryOrder.get(category),
        active: true
      });
    }

    const paulsTip = getImportValue(record, ["Paul's Tip", "Pauls Tip", "Description", "Packing Note"]);
    const why = getImportValue(record, ["Why", "Why Pack This", "Help Text"]);

    items.push({
      category_name: category,
      name,
      description: paulsTip || null,
      item_type: normalizePackingImportType(getImportValue(record, ["Priority", "Importance", "Type"])),
      weight_kg: parseImportNumber(getImportValue(record, ["Weight kg", "Weight (kg)", "Weight"]), 0),
      destination_tags: normalizeImportList(getImportValue(record, ["Destination", "Destinations"])),
      climate_tags: normalizeImportList(getImportValue(record, ["Climate", "Climates", "Climate Profile"])),
      traveller_types: normalizeImportList(getImportValue(record, ["Traveller Type", "Traveller", "Travellers"])),
      dress_codes: normalizeImportList(getImportValue(record, ["Dress Code", "Dress Codes"])),
      cruise_line_tags: normalizeImportList(getImportValue(record, ["Cruise Line", "Cruise Lines"])),
      help_text: why || null,
      display_order: (itemOrderByCategory.set(category, (itemOrderByCategory.get(category) || 0) + 1), itemOrderByCategory.get(category)),
      active: parseImportActive(getImportValue(record, ["Active", "Status", "Published"])),
      couple_multiplier: 1,
      family_multiplier: 1.5,
      group_multiplier: 1
    });
  });

  return { categories, items, rowCount: records.length };
}

async function handlePackingCsvFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const text = await file.text();
  const textarea = document.getElementById("packingImportCsv");
  if (textarea) textarea.value = text;
  previewPackingLibraryCsv();
}

function previewPackingLibraryCsv() {
  const textarea = document.getElementById("packingImportCsv");
  const message = document.getElementById("packing-import-message");
  try {
    const data = buildPackingImportData(textarea ? textarea.value : "");
    if (message) {
      message.className = "admin-message";
      message.innerText = `Preview: ${data.items.length} packing items across ${data.categories.length} categories found.`;
    }
  } catch (error) {
    if (message) {
      message.className = "admin-message admin-error";
      message.innerText = `Could not read CSV: ${error.message}`;
    }
  }
}

function clearPackingImportCsv() {
  const textarea = document.getElementById("packingImportCsv");
  if (textarea) textarea.value = "";
  const message = document.getElementById("packing-import-message");
  if (message) message.innerText = "";
}

async function importPackingLibraryCsv() {
  const textarea = document.getElementById("packingImportCsv");
  const message = document.getElementById("packing-import-message");
  const mode = document.getElementById("packingImportMode")?.value || "upsert";

  try {
    const data = buildPackingImportData(textarea ? textarea.value : "");
    if (!data.items.length) {
      if (message) {
        message.className = "admin-message admin-error";
        message.innerText = "No valid packing items found. Make sure the CSV includes Category and Item columns.";
      }
      return;
    }

    if (message) {
      message.className = "admin-message";
      message.innerText = `Importing ${data.items.length} items...`;
    }

    const { error: categoryError } = await supabaseClient
      .from("packing_categories")
      .upsert(data.categories, { onConflict: "name" });

    if (categoryError) throw categoryError;

    const { data: categoryRows, error: categoryLoadError } = await supabaseClient
      .from("packing_categories")
      .select("id,name");

    if (categoryLoadError) throw categoryLoadError;

    const categoryMap = new Map((categoryRows || []).map(category => [String(category.name).trim().toLowerCase(), category.id]));
    const itemPayloads = data.items
      .map(item => {
        const categoryId = categoryMap.get(String(item.category_name).trim().toLowerCase());
        if (!categoryId) return null;
        const { category_name, ...payload } = item;
        return { ...payload, category_id: categoryId };
      })
      .filter(Boolean);

    const batchSize = 100;
    for (let i = 0; i < itemPayloads.length; i += batchSize) {
      const batch = itemPayloads.slice(i, i + batchSize);
      const { error } = await supabaseClient
        .from("packing_items")
        .upsert(batch, { onConflict: "category_id,name" });
      if (error) throw error;
    }

    if (mode === "replace-active") {
      const importedNames = new Set(itemPayloads.map(item => `${item.category_id}::${String(item.name).trim().toLowerCase()}`));
      const { data: existingItems, error: existingError } = await supabaseClient
        .from("packing_items")
        .select("id,category_id,name");
      if (existingError) throw existingError;
      const missingIds = (existingItems || [])
        .filter(item => !importedNames.has(`${item.category_id}::${String(item.name).trim().toLowerCase()}`))
        .map(item => item.id);
      if (missingIds.length) {
        const { error: inactiveError } = await supabaseClient
          .from("packing_items")
          .update({ active: false })
          .in("id", missingIds);
        if (inactiveError) throw inactiveError;
      }
    }

    await loadAdminData();
    activeTab = "packing";
    selectedPackingCategoryId = "by-category";
    renderAdmin();

    setTimeout(() => {
      const doneMessage = document.getElementById("packing-import-message");
      if (doneMessage) {
        doneMessage.className = "admin-message";
        doneMessage.innerText = `Imported ${itemPayloads.length} packing items across ${data.categories.length} categories.`;
      }
    }, 50);
  } catch (error) {
    console.error("Packing import failed", error);
    if (message) {
      message.className = "admin-message admin-error";
      message.innerText = `Import failed: ${error.message || error}`;
    }
  }
}


function formatCalculatorVerifiedDate(value) {
  if (!value) return "Not listed";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatCalculatorNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(number);
}

function formatCalculatorGridNumber(value) {
  if (value === null || value === undefined || value === "") {
    return `<span class="calc-rate-null" aria-label="Not listed">—</span>`;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return `<span class="calc-rate-null" aria-label="Not listed">—</span>`;
  }
  return esc(String(number));
}

function getTodayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCalculatorWifiPrice(rate) {
  if (rate?.wifi_price_label) return esc(rate.wifi_price_label);
  if (rate?.wifi_package_price === null || rate?.wifi_package_price === undefined || rate?.wifi_package_price === "") {
    return `<span class="calc-rate-null" aria-label="Not listed">—</span>`;
  }
  return formatCalculatorGridNumber(rate.wifi_package_price);
}

function getCalculatorCruiseLineName(rate) {
  return rate?.cruise_lines?.name || cruiseLines.find(line => Number(line.id) === Number(rate?.cruise_line_id))?.name || "Unknown cruise line";
}

function cloneCalculatorRate(rate) {
  return rate ? JSON.parse(JSON.stringify(rate)) : null;
}

function getFilteredCalculatorRates() {
  const query = String(calculatorRateSearchQuery || "").trim().toLowerCase();
  return [...calculatorRates]
    .filter(rate => {
      if (calculatorRateActiveFilter === "active" && !rate.active) return false;
      if (calculatorRateActiveFilter === "inactive" && rate.active) return false;
      if (!query) return true;
      return getCalculatorCruiseLineName(rate).toLowerCase().includes(query);
    })
    .sort((a, b) => getCalculatorCruiseLineName(a).localeCompare(getCalculatorCruiseLineName(b), undefined, { sensitivity: "base" }));
}

function getCalculatorLinesWithoutRates() {
  const usedIds = new Set(calculatorRates.map(rate => Number(rate.cruise_line_id)));
  return [...cruiseLines]
    .filter(line => !usedIds.has(Number(line.id)))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
}

function updateCalculatorSearchFilter(value) {
  calculatorRateSearchQuery = value || "";
  const query = calculatorRateSearchQuery.trim().toLowerCase();
  document.querySelectorAll(".calc-rate-row[data-rate-id]").forEach(row => {
    const name = String(row.getAttribute("data-cruise-line-name") || "").toLowerCase();
    const active = row.getAttribute("data-rate-active") === "true";
    let visible = true;
    if (calculatorRateActiveFilter === "active" && !active) visible = false;
    if (calculatorRateActiveFilter === "inactive" && active) visible = false;
    if (query && !name.includes(query)) visible = false;
    row.hidden = !visible;
  });
}

async function setCalculatorRateActiveFilter(value) {
  const ok = await saveActiveCalculatorRow({ deactivate: true });
  if (!ok) return;
  calculatorRateActiveFilter = value || "all";
  renderAdmin();
}

async function startAddCalculatorRate() {
  const ok = await saveActiveCalculatorRow({ deactivate: true });
  if (!ok) return;
  editingCalculatorRateId = null;
  activeCalculatorRateId = null;
  showCalculatorNotesPanel = false;
  showCalculatorRateForm = true;
  showCalculatorVerifyForm = false;
  calculatorRateMessage = "";
  calculatorRateMessageTone = "";
  calculatorInlineStatus = "";
  renderAdmin();
}

function cancelCalculatorRateEdit() {
  editingCalculatorRateId = null;
  showCalculatorRateForm = false;
  calculatorRateMessage = "";
  calculatorRateMessageTone = "";
  renderAdmin();
}

function readCalculatorOptionalNumber(id) {
  const raw = String(document.getElementById(id)?.value ?? "").trim();
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function parseCalculatorNonNegativeInput(raw, label) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  const number = Number(text);
  if (!Number.isFinite(number)) {
    return { ok: false, error: `${label} must be a valid number, blank, or 0.` };
  }
  if (number < 0) {
    return { ok: false, error: `${label} cannot be negative.` };
  }
  return { ok: true, value: number };
}

function setCalculatorInlineStatus(text, tone = "") {
  calculatorInlineStatus = text || "";
  calculatorRateMessage = text || "";
  calculatorRateMessageTone = tone;
  const statusEl = document.getElementById("calculator-inline-status");
  const messageEl = document.getElementById("calculator-data-message");
  if (statusEl) {
    statusEl.textContent = text || "";
    const running = tone === "running" || /^(Saving|Refreshing)/i.test(String(text || ""));
    statusEl.className = `calc-inline-status ${
      tone === "success" ? "is-success" : tone === "error" ? "is-error" : running ? "is-running" : ""
    }`;
  }
  if (messageEl && !showCalculatorRateForm) {
    messageEl.textContent = text || "";
    messageEl.className = `admin-message ${tone === "success" ? "admin-success" : tone === "error" ? "admin-error" : ""}`;
  }
}

function collectCalculatorNotesFromPanel(rate) {
  if (!showCalculatorNotesPanel) {
    return {
      wifi_price_label: rate.wifi_price_label || null,
      wifi_notes: rate.wifi_notes || null,
      specialty_dining_notes: rate.specialty_dining_notes || null,
      general_notes: rate.general_notes || null
    };
  }
  return {
    wifi_price_label: String(document.getElementById("calcWifiPriceLabel")?.value || "").trim() || null,
    wifi_notes: String(document.getElementById("calcWifiNotes")?.value || "").trim() || null,
    specialty_dining_notes: String(document.getElementById("calcSpecialtyDiningNotes")?.value || "").trim() || null,
    general_notes: String(document.getElementById("calcGeneralNotes")?.value || "").trim() || null
  };
}

function collectActiveCalculatorRowPayload() {
  const rate = calculatorRates.find(item => String(item.id) === String(activeCalculatorRateId));
  if (!rate) return { ok: false, error: "Active rate row was not found." };

  const currency = String(document.getElementById("calcInlineCurrency")?.value || "").trim().toUpperCase();
  if (!currency) return { ok: false, error: "Currency is required." };

  const fields = [
    ["calcInlineBeer", "Beer"],
    ["calcInlineWine", "Wine"],
    ["calcInlineCocktail", "Cocktails"],
    ["calcInlineSpirits", "Spirits + Mixer"],
    ["calcInlineCoffee", "Premium Coffee"],
    ["calcInlineSoft", "Soft Drinks"],
    ["calcInlineJuice", "Juices"],
    ["calcInlineWater", "Bottled Water"],
    ["calcInlineGratuity", "Gratuity %"],
    ["calcInlineWifiPrice", "Wi-Fi Price"]
  ];

  const numbers = {};
  for (const [id, label] of fields) {
    const parsed = parseCalculatorNonNegativeInput(document.getElementById(id)?.value, label);
    if (!parsed.ok) return parsed;
    numbers[id] = parsed.value;
  }

  const notes = collectCalculatorNotesFromPanel(rate);
  const lastVerified = String(document.getElementById("calcInlineVerified")?.value || "").trim() || null;

  return {
    ok: true,
    payload: {
      cruise_line_id: rate.cruise_line_id,
      currency,
      beer_price: numbers.calcInlineBeer,
      wine_price: numbers.calcInlineWine,
      cocktail_price: numbers.calcInlineCocktail,
      spirits_mixer_price: numbers.calcInlineSpirits,
      premium_coffee_price: numbers.calcInlineCoffee,
      soft_drink_price: numbers.calcInlineSoft,
      juice_price: numbers.calcInlineJuice,
      bottled_water_price: numbers.calcInlineWater,
      gratuity_percent: numbers.calcInlineGratuity,
      drinks_included_in_fare: Boolean(document.getElementById("calcInlineDrinksIncluded")?.checked),
      wifi_included: Boolean(document.getElementById("calcInlineWifiIncluded")?.checked),
      wifi_package_price: numbers.calcInlineWifiPrice,
      wifi_price_label: notes.wifi_price_label,
      wifi_notes: notes.wifi_notes,
      specialty_dining_notes: notes.specialty_dining_notes,
      general_notes: notes.general_notes,
      last_verified_at: lastVerified,
      active: Boolean(document.getElementById("calcInlineActive")?.checked)
    }
  };
}

async function saveActiveCalculatorRow({ deactivate = false } = {}) {
  if (!activeCalculatorRateId) return true;
  if (calculatorInlineSaving) return false;

  const collected = collectActiveCalculatorRowPayload();
  if (!collected.ok) {
    setCalculatorInlineStatus(collected.error, "error");
    return false;
  }

  calculatorInlineSaving = true;
  setCalculatorInlineStatus("Saving…", "running");

  const { data, error } = await supabaseClient
    .from("cruise_line_calculator_rates")
    .update(collected.payload)
    .eq("id", activeCalculatorRateId)
    .select("*, cruise_lines(id, name)");

  calculatorInlineSaving = false;

  if (error) {
    console.error("Inline calculator save error", error);
    setCalculatorInlineStatus(error.message || "Save failed", "error");
    return false;
  }

  if (!data || !data.length) {
    setCalculatorInlineStatus("Save failed. Check admin SQL policies.", "error");
    return false;
  }

  const saved = data[0];
  calculatorRates = calculatorRates.map(rate => String(rate.id) === String(saved.id) ? saved : rate);
  calculatorInlineSnapshot = cloneCalculatorRate(saved);

  if (deactivate) {
    activeCalculatorRateId = null;
    showCalculatorNotesPanel = false;
    calculatorInlineSnapshot = null;
  }

  setCalculatorInlineStatus("Saved", "success");
  if (deactivate) {
    renderAdmin();
  } else {
    const messageEl = document.getElementById("calculator-data-message");
    const statusEl = document.getElementById("calculator-inline-status");
    if (messageEl) {
      messageEl.textContent = "Saved";
      messageEl.className = "admin-message admin-success";
    }
    if (statusEl) {
      statusEl.textContent = "Saved";
      statusEl.className = "calc-inline-status is-success";
    }
  }
  return true;
}

async function activateCalculatorRateRow(rateId) {
  if (calculatorInlineSaving) return;
  if (String(activeCalculatorRateId) === String(rateId)) return;

  if (activeCalculatorRateId) {
    const saved = await saveActiveCalculatorRow({ deactivate: false });
    if (!saved) return;
  }

  const rate = calculatorRates.find(item => String(item.id) === String(rateId));
  if (!rate) return;

  activeCalculatorRateId = rateId;
  showCalculatorNotesPanel = false;
  showCalculatorRateForm = false;
  calculatorInlineSnapshot = cloneCalculatorRate(rate);
  calculatorRateMessage = "";
  calculatorRateMessageTone = "";
  calculatorInlineStatus = "";
  renderAdmin();

  const currencyInput = document.getElementById("calcInlineCurrency");
  if (currencyInput) currencyInput.focus();
}

function cancelActiveCalculatorRowEdits() {
  if (!activeCalculatorRateId || !calculatorInlineSnapshot) return;
  calculatorRates = calculatorRates.map(rate =>
    String(rate.id) === String(activeCalculatorRateId) ? cloneCalculatorRate(calculatorInlineSnapshot) : rate
  );
  activeCalculatorRateId = null;
  showCalculatorNotesPanel = false;
  calculatorInlineSnapshot = null;
  calculatorInlineStatus = "";
  calculatorRateMessage = "Edits cancelled.";
  calculatorRateMessageTone = "";
  renderAdmin();
}

function openCalculatorNotesPanel(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!activeCalculatorRateId) return;
  showCalculatorNotesPanel = true;
  showCalculatorRateForm = false;
  renderAdmin();
  document.getElementById("calcWifiPriceLabel")?.focus();
}

function closeCalculatorNotesPanel() {
  showCalculatorNotesPanel = false;
  renderAdmin();
}

async function saveCalculatorNotesPanel() {
  const saved = await saveActiveCalculatorRow({ deactivate: false });
  if (!saved) return;
  showCalculatorNotesPanel = false;
  renderAdmin();
}

function handleCalculatorRowKeydown(event, rateId) {
  if (event.key === "Enter") {
    event.preventDefault();
    if (String(activeCalculatorRateId) === String(rateId)) {
      saveActiveCalculatorRow({ deactivate: false });
    } else {
      activateCalculatorRateRow(rateId);
    }
  }
  if (event.key === "Escape" && String(activeCalculatorRateId) === String(rateId)) {
    event.preventDefault();
    cancelActiveCalculatorRowEdits();
  }
}

function handleCalculatorInlineKeydown(event) {
  if (event.key === "Enter" && event.target?.tagName !== "TEXTAREA") {
    event.preventDefault();
    event.stopPropagation();
    saveActiveCalculatorRow({ deactivate: false });
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveCalculatorRowEdits();
  }
}

function handleCalculatorOutsidePointer(event) {
  if (!activeCalculatorRateId || calculatorInlineSaving) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".calc-rate-grid, .calc-notes-panel, .calc-rate-form-card, .calc-verify-card")) return;
  saveActiveCalculatorRow({ deactivate: true });
}

function bindCalculatorGridInteractions() {
  document.removeEventListener("pointerdown", handleCalculatorOutsidePointer, true);
  if (activeTab === "calculator-data" && activeCalculatorRateId) {
    document.addEventListener("pointerdown", handleCalculatorOutsidePointer, true);
  }
}

function renderInlineNumberInput(id, value, label) {
  return `<input
    id="${id}"
    class="calc-inline-input"
    type="number"
    step="0.01"
    min="0"
    value="${esc(formatCalculatorNumber(value))}"
    aria-label="${esc(label)}"
    onclick="event.stopPropagation()"
    onkeydown="handleCalculatorInlineKeydown(event)"
  >`;
}

function renderCalculatorRateRow(rate) {
  const isActive = String(activeCalculatorRateId) === String(rate.id);
  const includedClass = rate.drinks_included_in_fare ? " is-included" : "";
  const activeClass = isActive ? " is-editing" : "";
  const name = getCalculatorCruiseLineName(rate);

  if (!isActive) {
    return `
      <tr
        class="calc-rate-row${includedClass}${activeClass}"
        data-rate-id="${esc(rate.id)}"
        data-cruise-line-name="${esc(name)}"
        data-rate-active="${rate.active ? "true" : "false"}"
        tabindex="0"
        role="row"
        aria-label="Edit ${esc(name)} rates"
        onclick="activateCalculatorRateRow('${esc(rate.id)}')"
        onkeydown="handleCalculatorRowKeydown(event, '${esc(rate.id)}')"
      >
        <th scope="row" class="calc-rate-sticky-col">${esc(name)}</th>
        <td>${esc(rate.currency || "USD")}</td>
        <td>${formatCalculatorGridNumber(rate.beer_price)}</td>
        <td>${formatCalculatorGridNumber(rate.wine_price)}</td>
        <td>${formatCalculatorGridNumber(rate.cocktail_price)}</td>
        <td>${formatCalculatorGridNumber(rate.spirits_mixer_price)}</td>
        <td>${formatCalculatorGridNumber(rate.premium_coffee_price)}</td>
        <td>${formatCalculatorGridNumber(rate.soft_drink_price)}</td>
        <td>${formatCalculatorGridNumber(rate.juice_price)}</td>
        <td>${formatCalculatorGridNumber(rate.bottled_water_price)}</td>
        <td>${formatCalculatorGridNumber(rate.gratuity_percent)}</td>
        <td>${rate.drinks_included_in_fare ? "Yes" : "No"}</td>
        <td>${rate.wifi_included ? "Yes" : "No"}</td>
        <td>${formatCalculatorWifiPrice(rate)}</td>
        <td>${esc(formatCalculatorVerifiedDate(rate.last_verified_at))}</td>
        <td>${rate.active ? "Active" : "Inactive"}</td>
        <td><span class="calc-rate-notes-hint">${rate.wifi_notes || rate.specialty_dining_notes || rate.general_notes || rate.wifi_price_label ? "Notes" : "—"}</span></td>
      </tr>
    `;
  }

  return `
    <tr
      class="calc-rate-row${includedClass}${activeClass}"
      data-rate-id="${esc(rate.id)}"
      data-cruise-line-name="${esc(name)}"
      data-rate-active="${rate.active ? "true" : "false"}"
      tabindex="0"
      role="row"
      aria-label="Editing ${esc(name)} rates"
      onkeydown="handleCalculatorRowKeydown(event, '${esc(rate.id)}')"
    >
      <th scope="row" class="calc-rate-sticky-col">${esc(name)}</th>
      <td><input id="calcInlineCurrency" class="calc-inline-input calc-inline-currency" type="text" maxlength="8" value="${esc(rate.currency || "USD")}" aria-label="Currency" onclick="event.stopPropagation()" onkeydown="handleCalculatorInlineKeydown(event)"></td>
      <td>${renderInlineNumberInput("calcInlineBeer", rate.beer_price, "Beer")}</td>
      <td>${renderInlineNumberInput("calcInlineWine", rate.wine_price, "Wine")}</td>
      <td>${renderInlineNumberInput("calcInlineCocktail", rate.cocktail_price, "Cocktails")}</td>
      <td>${renderInlineNumberInput("calcInlineSpirits", rate.spirits_mixer_price, "Spirits + Mixer")}</td>
      <td>${renderInlineNumberInput("calcInlineCoffee", rate.premium_coffee_price, "Premium Coffee")}</td>
      <td>${renderInlineNumberInput("calcInlineSoft", rate.soft_drink_price, "Soft Drinks")}</td>
      <td>${renderInlineNumberInput("calcInlineJuice", rate.juice_price, "Juices")}</td>
      <td>${renderInlineNumberInput("calcInlineWater", rate.bottled_water_price, "Bottled Water")}</td>
      <td>${renderInlineNumberInput("calcInlineGratuity", rate.gratuity_percent, "Gratuity %")}</td>
      <td><label class="calc-inline-check" onclick="event.stopPropagation()"><input id="calcInlineDrinksIncluded" type="checkbox" ${rate.drinks_included_in_fare ? "checked" : ""} aria-label="Drinks included in fare" onkeydown="handleCalculatorInlineKeydown(event)"> Yes</label></td>
      <td><label class="calc-inline-check" onclick="event.stopPropagation()"><input id="calcInlineWifiIncluded" type="checkbox" ${rate.wifi_included ? "checked" : ""} aria-label="Wi-Fi included" onkeydown="handleCalculatorInlineKeydown(event)"> Yes</label></td>
      <td>${renderInlineNumberInput("calcInlineWifiPrice", rate.wifi_package_price, "Wi-Fi Price")}</td>
      <td><input id="calcInlineVerified" class="calc-inline-input calc-inline-date" type="date" value="${esc(rate.last_verified_at || "")}" aria-label="Last verified" onclick="event.stopPropagation()" onkeydown="handleCalculatorInlineKeydown(event)"></td>
      <td><label class="calc-inline-check" onclick="event.stopPropagation()"><input id="calcInlineActive" type="checkbox" ${rate.active ? "checked" : ""} aria-label="Active" onkeydown="handleCalculatorInlineKeydown(event)"> Active</label></td>
      <td><button type="button" class="admin-button secondary small" onclick="openCalculatorNotesPanel(event)">Notes</button></td>
    </tr>
  `;
}

function collectCalculatorRatePayload() {
  const selectedCruiseLineId = Number(document.getElementById("calcCruiseLineId")?.value);
  const currency = String(document.getElementById("calcCurrency")?.value || "USD").trim().toUpperCase() || "USD";
  const wifiPriceLabel = String(document.getElementById("calcWifiPriceLabel")?.value || "").trim();
  const lastVerified = String(document.getElementById("calcLastVerified")?.value || "").trim();

  return {
    cruise_line_id: selectedCruiseLineId || null,
    currency,
    beer_price: readCalculatorOptionalNumber("calcBeerPrice"),
    wine_price: readCalculatorOptionalNumber("calcWinePrice"),
    cocktail_price: readCalculatorOptionalNumber("calcCocktailPrice"),
    spirits_mixer_price: readCalculatorOptionalNumber("calcSpiritsMixerPrice"),
    premium_coffee_price: readCalculatorOptionalNumber("calcPremiumCoffeePrice"),
    soft_drink_price: readCalculatorOptionalNumber("calcSoftDrinkPrice"),
    juice_price: readCalculatorOptionalNumber("calcJuicePrice"),
    bottled_water_price: readCalculatorOptionalNumber("calcBottledWaterPrice"),
    gratuity_percent: readCalculatorOptionalNumber("calcGratuityPercent"),
    drinks_included_in_fare: Boolean(document.getElementById("calcDrinksIncluded")?.checked),
    wifi_included: Boolean(document.getElementById("calcWifiIncluded")?.checked),
    wifi_package_price: readCalculatorOptionalNumber("calcWifiPackagePrice"),
    wifi_price_label: wifiPriceLabel || null,
    wifi_notes: String(document.getElementById("calcWifiNotes")?.value || "").trim() || null,
    specialty_dining_notes: String(document.getElementById("calcSpecialtyDiningNotes")?.value || "").trim() || null,
    general_notes: String(document.getElementById("calcGeneralNotes")?.value || "").trim() || null,
    last_verified_at: lastVerified || null,
    active: Boolean(document.getElementById("calcActive")?.checked)
  };
}

async function saveCalculatorRate() {
  const payload = collectCalculatorRatePayload();
  const message = document.getElementById("calculator-rate-message");

  if (!payload.cruise_line_id) {
    calculatorRateMessage = "Please select a cruise line.";
    if (message) {
      message.className = "admin-message admin-error";
      message.innerText = calculatorRateMessage;
    }
    return;
  }

  const duplicate = calculatorRates.find(rate => Number(rate.cruise_line_id) === Number(payload.cruise_line_id));
  if (duplicate) {
    calculatorRateMessage = "A rate record already exists for that cruise line.";
    if (message) {
      message.className = "admin-message admin-error";
      message.innerText = calculatorRateMessage;
    }
    return;
  }

  if (message) {
    message.className = "admin-message admin-running";
    message.innerText = "Saving...";
  }

  const result = await supabaseClient
    .from("cruise_line_calculator_rates")
    .insert(payload)
    .select("*, cruise_lines(id, name)");

  if (result.error) {
    console.error("Save calculator rate error", result.error);
    calculatorRateMessage = result.error.message;
    if (message) {
      message.className = "admin-message admin-error";
      message.innerText = calculatorRateMessage;
    }
    return;
  }

  if (!result.data || !result.data.length) {
    calculatorRateMessage = "Nothing was saved. Check that your admin SQL policies were added correctly.";
    if (message) {
      message.className = "admin-message admin-error";
      message.innerText = calculatorRateMessage;
    }
    return;
  }

  calculatorRateMessage = "Saved successfully.";
  calculatorRateMessageTone = "success";
  editingCalculatorRateId = null;
  showCalculatorRateForm = false;
  await loadAdminData();
  renderAdmin();
}

function renderCalculatorRateForm() {
  if (!showCalculatorRateForm) return "";

  const availableLines = getCalculatorLinesWithoutRates();

  return `
    <div class="admin-card calc-rate-form-card">
      <div class="admin-list-top">
        <div>
          <h3>Add Drinks &amp; Wi-Fi Rates</h3>
          <p class="admin-muted">Create a new cruise-line rate record. Use the grid for ongoing edits.</p>
        </div>
        <button class="admin-button secondary small" onclick="cancelCalculatorRateEdit()">Cancel</button>
      </div>

      <div class="admin-grid">
        <div class="admin-field">
          <label>Cruise line</label>
          <select id="calcCruiseLineId">
            <option value="">Select cruise line</option>
            ${availableLines.map(line => `<option value="${line.id}">${esc(line.name)}</option>`).join("")}
          </select>
          ${!availableLines.length ? `<p class="admin-small">Every cruise line already has a rate record.</p>` : ""}
        </div>
        <div class="admin-field">
          <label>Currency</label>
          <input type="text" id="calcCurrency" value="USD" maxlength="8">
        </div>
      </div>

      <div class="calc-rate-price-grid">
        <div class="admin-field"><label>Beer</label><input type="number" step="0.01" min="0" id="calcBeerPrice"></div>
        <div class="admin-field"><label>Wine</label><input type="number" step="0.01" min="0" id="calcWinePrice"></div>
        <div class="admin-field"><label>Cocktails</label><input type="number" step="0.01" min="0" id="calcCocktailPrice"></div>
        <div class="admin-field"><label>Spirits + Mixer</label><input type="number" step="0.01" min="0" id="calcSpiritsMixerPrice"></div>
        <div class="admin-field"><label>Premium Coffee</label><input type="number" step="0.01" min="0" id="calcPremiumCoffeePrice"></div>
        <div class="admin-field"><label>Soft Drinks</label><input type="number" step="0.01" min="0" id="calcSoftDrinkPrice"></div>
        <div class="admin-field"><label>Juices</label><input type="number" step="0.01" min="0" id="calcJuicePrice"></div>
        <div class="admin-field"><label>Bottled Water</label><input type="number" step="0.01" min="0" id="calcBottledWaterPrice"></div>
        <div class="admin-field"><label>Gratuity %</label><input type="number" step="0.01" min="0" id="calcGratuityPercent"></div>
        <div class="admin-field"><label>Wi-Fi package price</label><input type="number" step="0.01" min="0" id="calcWifiPackagePrice"></div>
        <div class="admin-field"><label>Wi-Fi display label</label><input type="text" id="calcWifiPriceLabel" placeholder="Example: Free"></div>
        <div class="admin-field"><label>Last verified</label><input type="date" id="calcLastVerified" value="${esc(getTodayIsoDate())}"></div>
      </div>

      <div class="calc-rate-check-row">
        <label class="admin-check-inline"><input type="checkbox" id="calcDrinksIncluded"> Drinks included in fare</label>
        <label class="admin-check-inline"><input type="checkbox" id="calcWifiIncluded"> Wi-Fi included</label>
        <label class="admin-check-inline"><input type="checkbox" id="calcActive" checked> Active</label>
      </div>

      <div class="admin-field">
        <label>Wi-Fi notes</label>
        <textarea id="calcWifiNotes" rows="3"></textarea>
      </div>
      <div class="admin-field">
        <label>Specialty dining notes</label>
        <textarea id="calcSpecialtyDiningNotes" rows="3"></textarea>
      </div>
      <div class="admin-field">
        <label>General notes</label>
        <textarea id="calcGeneralNotes" rows="3"></textarea>
      </div>

      <button class="admin-button" onclick="saveCalculatorRate()">Add Rate Record</button>
      <button class="admin-button secondary" onclick="cancelCalculatorRateEdit()">Cancel</button>
      <div id="calculator-rate-message" class="admin-message">${esc(calculatorRateMessage)}</div>
    </div>
  `;
}

function renderCalculatorNotesPanel() {
  if (!showCalculatorNotesPanel || !activeCalculatorRateId) return "";
  const rate = calculatorRates.find(item => String(item.id) === String(activeCalculatorRateId));
  if (!rate) return "";

  return `
    <div class="admin-card calc-notes-panel">
      <div class="admin-list-top">
        <div>
          <h3>Notes · ${esc(getCalculatorCruiseLineName(rate))}</h3>
          <p class="admin-muted">Long-form details stay outside the spreadsheet grid.</p>
        </div>
        <button class="admin-button secondary small" onclick="closeCalculatorNotesPanel()">Close</button>
      </div>
      <div class="admin-field">
        <label for="calcWifiPriceLabel">Wi-Fi display label</label>
        <input type="text" id="calcWifiPriceLabel" value="${esc(rate.wifi_price_label || "")}" placeholder="Example: Free">
      </div>
      <div class="admin-field">
        <label for="calcWifiNotes">Wi-Fi notes</label>
        <textarea id="calcWifiNotes" rows="3">${esc(rate.wifi_notes || "")}</textarea>
      </div>
      <div class="admin-field">
        <label for="calcSpecialtyDiningNotes">Specialty dining notes</label>
        <textarea id="calcSpecialtyDiningNotes" rows="3">${esc(rate.specialty_dining_notes || "")}</textarea>
      </div>
      <div class="admin-field">
        <label for="calcGeneralNotes">General notes</label>
        <textarea id="calcGeneralNotes" rows="3">${esc(rate.general_notes || "")}</textarea>
      </div>
      <button class="admin-button" onclick="saveCalculatorNotesPanel()">Save Notes</button>
      <button class="admin-button secondary" onclick="closeCalculatorNotesPanel()">Cancel</button>
    </div>
  `;
}

async function openCalculatorVerifyForm() {
  const ok = await saveActiveCalculatorRow({ deactivate: true });
  if (!ok) return;
  showCalculatorVerifyForm = true;
  calculatorVerifyDate = getTodayIsoDate();
  calculatorRateMessage = "";
  calculatorRateMessageTone = "";
  renderAdmin();
}

function cancelCalculatorVerifyForm() {
  showCalculatorVerifyForm = false;
  calculatorVerifyDate = "";
  calculatorVerifyLoading = false;
  renderAdmin();
}

function renderCalculatorVerifyForm() {
  if (!showCalculatorVerifyForm) return "";

  return `
    <div class="admin-card calc-verify-card">
      <h4>Update verification date for all</h4>
      <p class="admin-muted">This will set <strong>Last Verified</strong> on every calculator-rate record. Drink prices, Wi-Fi details, notes and Active status will not change.</p>
      <div class="admin-field calc-verify-date-field">
        <label for="calcBulkVerifiedDate">Verification date</label>
        <input type="date" id="calcBulkVerifiedDate" value="${esc(calculatorVerifyDate || getTodayIsoDate())}">
      </div>
      <button class="admin-button" onclick="confirmCalculatorVerifyAll()" ${calculatorVerifyLoading ? "disabled" : ""}>${calculatorVerifyLoading ? "Updating…" : "Update all"}</button>
      <button class="admin-button secondary" onclick="cancelCalculatorVerifyForm()" ${calculatorVerifyLoading ? "disabled" : ""}>Cancel</button>
    </div>
  `;
}

async function confirmCalculatorVerifyAll() {
  const dateInput = document.getElementById("calcBulkVerifiedDate");
  const verifiedDate = String(dateInput?.value || "").trim();

  if (!verifiedDate) {
    calculatorRateMessage = "Please choose a verification date.";
    calculatorRateMessageTone = "error";
    renderAdmin();
    return;
  }

  calculatorVerifyLoading = true;
  calculatorRateMessage = "Updating Last Verified for all records…";
  calculatorRateMessageTone = "";
  renderAdmin();

  const { data, error } = await supabaseClient
    .from("cruise_line_calculator_rates")
    .update({ last_verified_at: verifiedDate })
    .not("id", "is", null)
    .select("id");

  calculatorVerifyLoading = false;

  if (error) {
    console.error("Bulk verification update error", error);
    calculatorRateMessage = error.message || "Could not update verification dates.";
    calculatorRateMessageTone = "error";
    renderAdmin();
    return;
  }

  const count = Array.isArray(data) ? data.length : 0;
  showCalculatorVerifyForm = false;
  calculatorVerifyDate = "";
  calculatorRateMessage = `Updated Last Verified to ${formatCalculatorVerifiedDate(verifiedDate)} for ${count} record${count === 1 ? "" : "s"}.`;
  calculatorRateMessageTone = "success";
  await loadAdminData();
  renderAdmin();
}

function renderCalculatorDataPanel() {
  const filtered = getFilteredCalculatorRates();
  const panelMessageClass = calculatorRateMessageTone === "success"
    ? "admin-success"
    : calculatorRateMessageTone === "error"
      ? "admin-error"
      : "";
  const statusText = calculatorInlineStatus || (!showCalculatorRateForm ? calculatorRateMessage : "");
  const statusRunning = /^(Saving|Refreshing)/i.test(String(statusText || "")) || calculatorRateMessageTone === "running";
  const statusClass =
    calculatorRateMessageTone === "success"
      ? "is-success"
      : calculatorRateMessageTone === "error"
        ? "is-error"
        : statusRunning
          ? "is-running"
          : "";

  queueMicrotask(() => bindCalculatorGridInteractions());

  return `
    <div class="admin-card calc-data-shell">
      <div class="admin-list-top">
        <div>
          <h3>Drinks &amp; Wi-Fi Rates</h3>
          <p class="admin-muted">Click a row to edit. Changes save when you leave the row, press Enter, or click outside the grid.</p>
        </div>
        <div class="calc-rate-actions">
          <button class="admin-button secondary small" onclick="openCalculatorVerifyForm()">Update verification date for all</button>
          <button class="admin-button small" onclick="startAddCalculatorRate()">Add Rate Record</button>
        </div>
      </div>

      ${renderCalculatorVerifyForm()}
      ${renderCalculatorNotesPanel()}

      <div class="calc-rate-toolbar">
        <div class="admin-field calc-rate-search">
          <label class="admin-visually-hidden" for="calcRateSearch">Search cruise lines</label>
          <input
            id="calcRateSearch"
            type="search"
            value="${esc(calculatorRateSearchQuery)}"
            placeholder="Search cruise lines…"
            autocomplete="off"
            oninput="updateCalculatorSearchFilter(this.value)"
          >
        </div>
        <div class="admin-field calc-rate-filter">
          <label for="calcRateActiveFilter">Status</label>
          <select id="calcRateActiveFilter" onchange="setCalculatorRateActiveFilter(this.value)">
            <option value="active" ${calculatorRateActiveFilter === "active" ? "selected" : ""}>Active</option>
            <option value="inactive" ${calculatorRateActiveFilter === "inactive" ? "selected" : ""}>Inactive</option>
            <option value="all" ${calculatorRateActiveFilter === "all" ? "selected" : ""}>All</option>
          </select>
        </div>
        <div id="calculator-inline-status" class="calc-inline-status ${statusClass}" aria-live="polite">${esc(statusText)}</div>
      </div>

      <div id="calculator-data-message" class="admin-message ${showCalculatorRateForm ? "" : panelMessageClass}">${showCalculatorRateForm ? "" : esc(calculatorRateMessage)}</div>

      <div class="calc-rate-grid-wrap">
        <table class="calc-rate-grid" aria-label="Cruise line calculator rates">
          <thead>
            <tr>
              <th scope="col" class="calc-rate-sticky-col">Cruise Line</th>
              <th scope="col">Currency</th>
              <th scope="col">Beer</th>
              <th scope="col">Wine</th>
              <th scope="col">Cocktails</th>
              <th scope="col">Spirits + Mixer</th>
              <th scope="col">Premium Coffee</th>
              <th scope="col">Soft Drinks</th>
              <th scope="col">Juices</th>
              <th scope="col">Bottled Water</th>
              <th scope="col">Gratuity %</th>
              <th scope="col">Drinks Included</th>
              <th scope="col">Wi-Fi Included</th>
              <th scope="col">Wi-Fi Price</th>
              <th scope="col">Last Verified</th>
              <th scope="col">Active</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length ? filtered.map(renderCalculatorRateRow).join("") : `<tr><td colspan="17" class="calc-rate-empty">No calculator rate records match this view.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="admin-small">Escape cancels unsaved row edits. A dash means not listed; 0 is a real zero price. Use Notes for Wi-Fi label and long-form details.</p>
    </div>

    ${renderCalculatorRateForm()}

    ${renderBeveragePackagesPanel()}
  `;
}

function getFilteredBeveragePackages() {
  const query = String(beveragePackageSearchQuery || "").trim().toLowerCase();
  return beveragePackages
    .filter(pkg => {
      if (beveragePackageActiveFilter === "active" && pkg.active !== true) return false;
      if (beveragePackageActiveFilter === "inactive" && pkg.active === true) return false;
      if (beveragePackageLineFilter !== "all" && String(pkg.cruise_line_id) !== String(beveragePackageLineFilter)) return false;
      if (!query) return true;
      const name = String(pkg.package_name || "").toLowerCase();
      const lineName = String(pkg.cruise_lines?.name || "").toLowerCase();
      return name.includes(query) || lineName.includes(query);
    })
    .slice()
    .sort((a, b) => {
      const lineA = String(a.cruise_lines?.name || "");
      const lineB = String(b.cruise_lines?.name || "");
      const lineCmp = lineA.localeCompare(lineB, undefined, { sensitivity: "base" });
      if (lineCmp) return lineCmp;
      const orderA = Number(a.display_order) || 0;
      const orderB = Number(b.display_order) || 0;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.package_name || "").localeCompare(String(b.package_name || ""), undefined, { sensitivity: "base" });
    });
}

function updateBeveragePackageSearchFilter(value) {
  beveragePackageSearchQuery = value;
  renderAdmin();
}

function setBeveragePackageActiveFilter(value) {
  beveragePackageActiveFilter = value;
  renderAdmin();
}

function setBeveragePackageLineFilter(value) {
  beveragePackageLineFilter = value;
  renderAdmin();
}

async function refreshBeveragePackagesGrid() {
  beveragePackageInlineStatus = "Refreshing…";
  beveragePackageMessageTone = "running";
  renderAdmin();
  const refreshed = await reloadBeveragePackages();
  if (refreshed) {
    beveragePackageInlineStatus = `Loaded ${beveragePackages.length} package${beveragePackages.length === 1 ? "" : "s"}.`;
    beveragePackageMessageTone = "success";
  }
  renderAdmin();
}

function startAddBeveragePackage() {
  showBeveragePackageForm = true;
  showBeveragePackageNotesPanel = false;
  activeBeveragePackageId = null;
  beveragePackageMessage = "";
  beveragePackageMessageTone = "";
  renderAdmin();
}

function cancelBeveragePackageForm() {
  showBeveragePackageForm = false;
  beveragePackageMessage = "";
  beveragePackageMessageTone = "";
  renderAdmin();
}

async function saveBeveragePackage() {
  const cruiseLineId = document.getElementById("beveragePackageCruiseLine")?.value;
  const packageName = String(document.getElementById("beveragePackageName")?.value || "").trim();
  const priceRaw = document.getElementById("beveragePackagePrice")?.value;
  const currency = String(document.getElementById("beveragePackageCurrency")?.value || "USD").trim().toUpperCase();
  const wifiIncluded = document.getElementById("beveragePackageWifi")?.checked === true;
  const gratuitiesIncluded = document.getElementById("beveragePackageGrat")?.checked === true;
  const displayOrder = Number(document.getElementById("beveragePackageOrder")?.value || 0);
  const notes = String(document.getElementById("beveragePackageNotes")?.value || "").trim() || null;
  const lastVerified = String(document.getElementById("beveragePackageVerified")?.value || "").trim() || null;
  const active = document.getElementById("beveragePackageActive")?.checked !== false;

  if (!cruiseLineId) {
    beveragePackageMessage = "Choose a cruise line.";
    beveragePackageMessageTone = "error";
    renderAdmin();
    return;
  }
  if (!packageName) {
    beveragePackageMessage = "Package name is required.";
    beveragePackageMessageTone = "error";
    renderAdmin();
    return;
  }
  if (!currency) {
    beveragePackageMessage = "Currency is required.";
    beveragePackageMessageTone = "error";
    renderAdmin();
    return;
  }

  const parsedPrice = parseCalculatorNonNegativeInput(priceRaw, "Typical daily price");
  if (!parsedPrice.ok) {
    beveragePackageMessage = parsedPrice.error;
    beveragePackageMessageTone = "error";
    renderAdmin();
    return;
  }

  const { data, error } = await supabaseClient
    .from("cruise_line_beverage_packages")
    .insert({
      cruise_line_id: Number(cruiseLineId),
      package_name: packageName,
      typical_daily_price: parsedPrice.value,
      currency,
      wifi_included: wifiIncluded,
      gratuities_included: gratuitiesIncluded,
      display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
      notes,
      last_verified_at: lastVerified,
      active
    })
    .select("*, cruise_lines(id, name)");

  if (error) {
    beveragePackageMessage = error.message || "Unable to add package.";
    beveragePackageMessageTone = "error";
    renderAdmin();
    return;
  }

  showBeveragePackageForm = false;
  beveragePackageMessage = `Added ${packageName}.`;
  beveragePackageMessageTone = "success";
  // Always re-fetch from Supabase so the grid matches the database
  // (never rely on a local append that can go stale or miss nested fields).
  const refreshed = await reloadBeveragePackages();
  if (!refreshed) {
    beveragePackageMessage = `Added ${packageName}, but the package list could not be refreshed. Reload Admin to see all rows.`;
    beveragePackageMessageTone = "error";
  }
  renderAdmin();
}

function collectActiveBeveragePackagePayload() {
  const name = String(document.getElementById("bpName")?.value || "").trim();
  const priceRaw = document.getElementById("bpPrice")?.value;
  const currency = String(document.getElementById("bpCurrency")?.value || "USD").trim().toUpperCase();
  const wifiIncluded = document.getElementById("bpWifi")?.checked === true;
  const gratuitiesIncluded = document.getElementById("bpGrat")?.checked === true;
  const displayOrder = Number(document.getElementById("bpOrder")?.value || 0);
  const lastVerified = String(document.getElementById("bpVerified")?.value || "").trim() || null;
  const active = document.getElementById("bpActive")?.checked === true;
  const notes = showBeveragePackageNotesPanel
    ? (String(document.getElementById("bpNotesEditor")?.value || "").trim() || null)
    : undefined;

  if (!name) return { ok: false, error: "Package name is required." };
  if (!currency) return { ok: false, error: "Currency is required." };
  const parsedPrice = parseCalculatorNonNegativeInput(priceRaw, "Typical daily price");
  if (!parsedPrice.ok) return parsedPrice;

  const payload = {
    package_name: name,
    typical_daily_price: parsedPrice.value,
    currency,
    wifi_included: wifiIncluded,
    gratuities_included: gratuitiesIncluded,
    display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
    last_verified_at: lastVerified,
    active
  };
  if (notes !== undefined) payload.notes = notes;
  return { ok: true, payload };
}

async function saveActiveBeveragePackageRow({ deactivate = false } = {}) {
  if (!activeBeveragePackageId || beveragePackageInlineSaving) return true;
  const collected = collectActiveBeveragePackagePayload();
  if (!collected.ok) {
    beveragePackageInlineStatus = collected.error;
    beveragePackageMessageTone = "error";
    const status = document.getElementById("beverage-package-inline-status");
    if (status) {
      status.textContent = collected.error;
      status.className = "calc-inline-status is-error";
    }
    return false;
  }

  beveragePackageInlineSaving = true;
  beveragePackageInlineStatus = "Saving…";
  beveragePackageMessageTone = "running";
  const statusEl = document.getElementById("beverage-package-inline-status");
  if (statusEl) {
    statusEl.textContent = "Saving…";
    statusEl.className = "calc-inline-status is-running";
  }

  const { data, error } = await supabaseClient
    .from("cruise_line_beverage_packages")
    .update(collected.payload)
    .eq("id", activeBeveragePackageId)
    .select("*, cruise_lines(id, name)");

  beveragePackageInlineSaving = false;

  if (error) {
    beveragePackageInlineStatus = error.message || "Save failed.";
    beveragePackageMessageTone = "error";
    if (statusEl) {
      statusEl.textContent = beveragePackageInlineStatus;
      statusEl.className = "calc-inline-status is-error";
    }
    return false;
  }

  const saved = data && data[0];
  if (saved) {
    beveragePackages = beveragePackages.map(pkg => (pkg.id === saved.id ? saved : pkg));
  }
  beveragePackageInlineStatus = "Saved";
  beveragePackageMessageTone = "success";
  if (statusEl) {
    statusEl.textContent = "Saved";
    statusEl.className = "calc-inline-status is-success";
  }
  if (deactivate) {
    activeBeveragePackageId = null;
    beveragePackageInlineSnapshot = null;
    showBeveragePackageNotesPanel = false;
    renderAdmin();
  }
  return true;
}

async function activateBeveragePackageRow(packageId) {
  if (activeBeveragePackageId && String(activeBeveragePackageId) !== String(packageId)) {
    const saved = await saveActiveBeveragePackageRow({ deactivate: false });
    if (!saved) return;
  }
  activeBeveragePackageId = packageId;
  showBeveragePackageForm = false;
  const pkg = beveragePackages.find(row => String(row.id) === String(packageId));
  beveragePackageInlineSnapshot = pkg ? JSON.stringify(pkg) : null;
  renderAdmin();
}

function openBeveragePackageNotes(packageId) {
  activateBeveragePackageRow(packageId).then(() => {
    showBeveragePackageNotesPanel = true;
    renderAdmin();
  });
}

function renderBeveragePackageNotesPanel() {
  if (!showBeveragePackageNotesPanel || !activeBeveragePackageId) return "";
  const pkg = beveragePackages.find(row => String(row.id) === String(activeBeveragePackageId));
  if (!pkg) return "";
  return `
    <div class="calc-notes-panel">
      <h4>Package notes — ${esc(pkg.package_name)}</h4>
      <div class="admin-field">
        <label for="bpNotesEditor">Notes</label>
        <textarea id="bpNotesEditor" rows="4">${esc(pkg.notes || "")}</textarea>
      </div>
      <div class="admin-actions">
        <button class="admin-button small" onclick="saveActiveBeveragePackageRow({ deactivate: true })">Save notes</button>
        <button class="admin-button secondary small" onclick="showBeveragePackageNotesPanel=false; renderAdmin()">Close</button>
      </div>
    </div>
  `;
}

function renderBeveragePackageForm() {
  if (!showBeveragePackageForm) return "";
  const options = cruiseLines
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }))
    .map(line => `<option value="${esc(line.id)}">${esc(line.name)}</option>`)
    .join("");
  const messageClass = beveragePackageMessageTone === "success" ? "admin-success" : beveragePackageMessageTone === "error" ? "admin-error" : "";
  return `
    <div class="admin-card" style="margin-top:18px">
      <h3>Add Package</h3>
      <div class="admin-grid-2">
        <div class="admin-field"><label for="beveragePackageCruiseLine">Cruise Line</label><select id="beveragePackageCruiseLine"><option value="">Select…</option>${options}</select></div>
        <div class="admin-field"><label for="beveragePackageName">Package Name</label><input id="beveragePackageName" type="text"></div>
        <div class="admin-field"><label for="beveragePackagePrice">Typical Daily Price</label><input id="beveragePackagePrice" type="number" min="0" step="0.01"></div>
        <div class="admin-field"><label for="beveragePackageCurrency">Currency</label><input id="beveragePackageCurrency" type="text" value="USD"></div>
        <div class="admin-field"><label for="beveragePackageOrder">Display Order</label><input id="beveragePackageOrder" type="number" step="1" value="0"></div>
        <div class="admin-field"><label for="beveragePackageVerified">Last Verified</label><input id="beveragePackageVerified" type="date"></div>
      </div>
      <div class="admin-field"><label><input id="beveragePackageWifi" type="checkbox"> Wi-Fi Included</label></div>
      <div class="admin-field"><label><input id="beveragePackageGrat" type="checkbox"> Gratuities Included</label></div>
      <div class="admin-field"><label><input id="beveragePackageActive" type="checkbox" checked> Active</label></div>
      <div class="admin-field"><label for="beveragePackageNotes">Notes</label><textarea id="beveragePackageNotes" rows="3"></textarea></div>
      <div id="beverage-package-form-message" class="admin-message ${messageClass}">${esc(beveragePackageMessage)}</div>
      <div class="admin-actions">
        <button class="admin-button" onclick="saveBeveragePackage()">Save Package</button>
        <button class="admin-button secondary" onclick="cancelBeveragePackageForm()">Cancel</button>
      </div>
    </div>
  `;
}

function renderBeveragePackageRow(pkg) {
  const isActive = String(activeBeveragePackageId) === String(pkg.id);
  const lineName = pkg.cruise_lines?.name || "—";
  if (!isActive) {
    return `
      <tr class="calc-rate-row" onclick="activateBeveragePackageRow('${esc(pkg.id)}')">
        <td class="calc-rate-sticky-col calc-rate-left">${esc(lineName)}</td>
        <td class="calc-rate-left">${esc(pkg.package_name)}</td>
        <td class="calc-rate-center">${pkg.typical_daily_price == null ? '<span class="calc-rate-null">—</span>' : esc(pkg.typical_daily_price)}</td>
        <td class="calc-rate-center">${esc(pkg.currency || "USD")}</td>
        <td class="calc-rate-center">${pkg.wifi_included ? "Yes" : "No"}</td>
        <td class="calc-rate-center">${pkg.gratuities_included ? "Yes" : "No"}</td>
        <td class="calc-rate-center">${pkg.last_verified_at ? esc(pkg.last_verified_at) : '<span class="calc-rate-null">—</span>'}</td>
        <td class="calc-rate-center">${pkg.active ? "Yes" : "No"}</td>
        <td class="calc-rate-center">${esc(pkg.display_order ?? 0)}</td>
        <td class="calc-rate-center"><button type="button" class="admin-button secondary small" onclick="event.stopPropagation(); openBeveragePackageNotes('${esc(pkg.id)}')">Notes</button></td>
      </tr>
    `;
  }

  return `
    <tr class="calc-rate-row is-editing" data-beverage-package-editing="true">
      <td class="calc-rate-sticky-col calc-rate-left">${esc(lineName)}</td>
      <td class="calc-rate-left"><input id="bpName" type="text" value="${esc(pkg.package_name || "")}"></td>
      <td class="calc-rate-center"><input id="bpPrice" type="number" min="0" step="0.01" value="${pkg.typical_daily_price == null ? "" : esc(pkg.typical_daily_price)}"></td>
      <td class="calc-rate-center"><input id="bpCurrency" type="text" value="${esc(pkg.currency || "USD")}"></td>
      <td class="calc-rate-center"><input id="bpWifi" type="checkbox" ${pkg.wifi_included ? "checked" : ""}></td>
      <td class="calc-rate-center"><input id="bpGrat" type="checkbox" ${pkg.gratuities_included ? "checked" : ""}></td>
      <td class="calc-rate-center"><input id="bpVerified" type="date" value="${esc(pkg.last_verified_at || "")}"></td>
      <td class="calc-rate-center"><input id="bpActive" type="checkbox" ${pkg.active ? "checked" : ""}></td>
      <td class="calc-rate-center"><input id="bpOrder" type="number" step="1" value="${esc(pkg.display_order ?? 0)}"></td>
      <td class="calc-rate-center"><button type="button" class="admin-button secondary small" onclick="openBeveragePackageNotes('${esc(pkg.id)}')">Notes</button></td>
    </tr>
  `;
}

function bindBeveragePackageGridInteractions() {
  if (window.__dcBeveragePackageGridBound) return;
  window.__dcBeveragePackageGridBound = true;

  document.addEventListener("pointerdown", event => {
    if (activeTab !== "calculator-data" || !activeBeveragePackageId) return;
    if (event.target.closest("[data-beverage-package-editing='true']")) return;
    if (event.target.closest(".calc-notes-panel")) return;
    if (event.target.closest("#beveragePackageSearch, #beveragePackageLineFilter, #beveragePackageActiveFilter")) return;
    saveActiveBeveragePackageRow({ deactivate: true });
  });

  document.addEventListener("keydown", event => {
    if (activeTab !== "calculator-data" || !activeBeveragePackageId) return;
    if (event.key === "Enter" && event.target.closest("[data-beverage-package-editing='true']")) {
      event.preventDefault();
      saveActiveBeveragePackageRow({ deactivate: true });
    }
    if (event.key === "Escape" && event.target.closest("[data-beverage-package-editing='true']")) {
      activeBeveragePackageId = null;
      showBeveragePackageNotesPanel = false;
      renderAdmin();
    }
  });
}

function renderBeveragePackagesPanel() {
  const filtered = getFilteredBeveragePackages();
  const totalLoaded = beveragePackages.length;
  const panelMessageClass = beveragePackageMessageTone === "success"
    ? "admin-success"
    : beveragePackageMessageTone === "error"
      ? "admin-error"
      : "";
  const lineOptions = cruiseLines
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }))
    .map(line => `<option value="${esc(line.id)}" ${String(beveragePackageLineFilter) === String(line.id) ? "selected" : ""}>${esc(line.name)}</option>`)
    .join("");
  const statusText = beveragePackageInlineStatus || (!showBeveragePackageForm ? beveragePackageMessage : "");
  const statusRunning = /^(Saving|Refreshing)/i.test(String(statusText || "")) || beveragePackageMessageTone === "running";
  const statusClass =
    beveragePackageMessageTone === "success"
      ? "is-success"
      : beveragePackageMessageTone === "error"
        ? "is-error"
        : statusRunning
          ? "is-running"
          : "";
  const countLabel = filtered.length === totalLoaded
    ? `${filtered.length} package${filtered.length === 1 ? "" : "s"}`
    : `Showing ${filtered.length} of ${totalLoaded} packages`;

  queueMicrotask(() => bindBeveragePackageGridInteractions());

  return `
    <div class="admin-card calc-data-shell" style="margin-top:22px">
      <div class="admin-list-top">
        <div>
          <h3>Beverage Packages</h3>
          <p class="admin-muted">One row per package. Click a row to edit. Changes save when you leave the row or press Enter. <span id="beverage-package-count">${esc(countLabel)}</span></p>
        </div>
        <div class="calc-rate-actions">
          <button class="admin-button secondary small" type="button" onclick="refreshBeveragePackagesGrid()">Refresh</button>
          <button class="admin-button small" onclick="startAddBeveragePackage()">Add Package</button>
        </div>
      </div>

      ${renderBeveragePackageNotesPanel()}

      <div class="calc-rate-toolbar">
        <div class="admin-field calc-rate-search">
          <label class="admin-visually-hidden" for="beveragePackageSearch">Search packages</label>
          <input id="beveragePackageSearch" type="search" value="${esc(beveragePackageSearchQuery)}" placeholder="Search packages…" autocomplete="off" oninput="updateBeveragePackageSearchFilter(this.value)">
        </div>
        <div class="admin-field calc-rate-filter">
          <label for="beveragePackageLineFilter">Cruise line</label>
          <select id="beveragePackageLineFilter" onchange="setBeveragePackageLineFilter(this.value)">
            <option value="all" ${beveragePackageLineFilter === "all" ? "selected" : ""}>All</option>
            ${lineOptions}
          </select>
        </div>
        <div class="admin-field calc-rate-filter">
          <label for="beveragePackageActiveFilter">Status</label>
          <select id="beveragePackageActiveFilter" onchange="setBeveragePackageActiveFilter(this.value)">
            <option value="active" ${beveragePackageActiveFilter === "active" ? "selected" : ""}>Active</option>
            <option value="inactive" ${beveragePackageActiveFilter === "inactive" ? "selected" : ""}>Inactive</option>
            <option value="all" ${beveragePackageActiveFilter === "all" ? "selected" : ""}>All</option>
          </select>
        </div>
        <div id="beverage-package-inline-status" class="calc-inline-status ${statusClass}" aria-live="polite">${esc(statusText)}</div>
      </div>

      <div class="admin-message ${showBeveragePackageForm ? "" : panelMessageClass}">${showBeveragePackageForm ? "" : esc(beveragePackageMessage)}</div>

      <div class="calc-rate-grid-wrap calc-package-grid-wrap" data-beverage-package-grid>
        <table class="calc-rate-grid" aria-label="Cruise line beverage packages">
          <thead>
            <tr>
              <th scope="col" class="calc-rate-sticky-col calc-rate-left">Cruise Line</th>
              <th scope="col" class="calc-rate-left">Package Name</th>
              <th scope="col" class="calc-rate-center">Typical Daily Price</th>
              <th scope="col" class="calc-rate-center">Currency</th>
              <th scope="col" class="calc-rate-center">Wi-Fi Included</th>
              <th scope="col" class="calc-rate-center">Gratuities Included</th>
              <th scope="col" class="calc-rate-center">Last Verified</th>
              <th scope="col" class="calc-rate-center">Active</th>
              <th scope="col" class="calc-rate-center">Display Order</th>
              <th scope="col" class="calc-rate-center">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length ? filtered.map(renderBeveragePackageRow).join("") : `<tr><td colspan="10" class="calc-rate-empty">No beverage packages match this view.${totalLoaded > 0 ? " Try Status: All, or clear the cruise-line / search filters." : ""}</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="admin-small">Package prices are labelled as typical in the public calculator. Deactivate a package instead of deleting it when retiring an offer. The grid lists every loaded package that matches the filters — there is no hidden page size.</p>
    </div>

    ${renderBeveragePackageForm()}
  `;
}

function getCruiseUsageContext() {
  return {
    surface: "admin",
    user_id: currentUser?.id || null,
    booking_reference: null,
    metadata: { source: "admin" }
  };
}

if (typeof window !== "undefined") {
  window.getCruiseUsageContext = getCruiseUsageContext;
}

function formatUsageDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return "Yesterday";
  const daysAgo = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  if (daysAgo >= 0 && daysAgo < 7) {
    return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  }
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined
  });
}

function formatUsageTrend(trend) {
  if (trend === "up") return `<span class="usage-trend is-up">↑ Up</span>`;
  if (trend === "down") return `<span class="usage-trend is-down">↓ Down</span>`;
  return `<span class="usage-trend is-flat">→ Flat</span>`;
}

function usageInsightsQuery() {
  const params = new URLSearchParams({ range: usageInsightsRange || "7d" });
  if (usageInsightsRange === "custom") {
    if (usageInsightsCustomFrom) params.set("from", usageInsightsCustomFrom);
    if (usageInsightsCustomTo) params.set("to", usageInsightsCustomTo);
  }
  return params.toString();
}

async function loadUsageInsights() {
  usageInsightsLoading = true;
  usageInsightsMessage = "";
  renderAdmin();

  try {
    const { data } = await supabaseClient.auth.getSession();
    const token = data.session?.access_token || "";
    const response = await fetch(`/.netlify/functions/usage-insights?${usageInsightsQuery()}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.message || "Unable to load usage insights.");
    }
    usageInsightsData = payload;
    if (usageInsightsSelectedCustomerKey) {
      const match = (payload.customers || []).find(
        row => row.key === usageInsightsSelectedCustomerKey || row.booking_reference === usageInsightsSelectedCustomerKey
      );
      usageInsightsPanelCustomer = match || null;
    }
  } catch (error) {
    usageInsightsData = null;
    usageInsightsMessage = error.message || "Unable to load usage insights.";
  } finally {
    usageInsightsLoading = false;
    renderAdmin();
  }
}

function setUsageInsightsRange(range) {
  usageInsightsRange = range;
  if (range !== "custom") {
    loadUsageInsights();
  } else {
    renderAdmin();
  }
}

function applyUsageInsightsCustomRange() {
  usageInsightsCustomFrom = document.getElementById("usageInsightsFrom")?.value || "";
  usageInsightsCustomTo = document.getElementById("usageInsightsTo")?.value || "";
  if (!usageInsightsCustomFrom || !usageInsightsCustomTo) {
    usageInsightsMessage = "Choose both a start and end date.";
    renderAdmin();
    return;
  }
  usageInsightsRange = "custom";
  loadUsageInsights();
}

function setUsageInsightsSearch(value) {
  usageInsightsSearch = value;
  renderAdmin();
}

function openUsageCustomerPanel(key) {
  usageInsightsSelectedCustomerKey = key;
  usageInsightsPanelCustomer =
    (usageInsightsData?.customers || []).find(row => row.key === key || row.booking_reference === key) || null;
  renderAdmin();
}

function closeUsageCustomerPanel() {
  usageInsightsSelectedCustomerKey = "";
  usageInsightsPanelCustomer = null;
  renderAdmin();
}

function renderUsageInsightsPanel() {
  const data = usageInsightsData;
  const summary = data?.summary || {};
  const toolUsage = data?.tool_usage || [];
  const publicTools = data?.public_tools || [];
  const recent = data?.recent_activity || [];
  const search = String(usageInsightsSearch || "").trim().toLowerCase();
  const customers = (data?.customers || []).filter(row => {
    if (!search) return true;
    const haystack = [
      row.customer,
      row.booking_reference,
      row.cruise,
      row.cruise_line,
      ...(row.tools_used || [])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });

  const rangeButtons = [
    ["today", "Today"],
    ["7d", "Last 7 Days"],
    ["30d", "Last 30 Days"],
    ["90d", "Last 90 Days"],
    ["custom", "Custom"]
  ]
    .map(
      ([value, label]) =>
        `<button type="button" class="usage-range-btn ${usageInsightsRange === value ? "active" : ""}" onclick="setUsageInsightsRange('${value}')">${label}</button>`
    )
    .join("");

  return `
    <div class="usage-insights-page ${usageInsightsPanelCustomer ? "has-panel" : ""}">
      <div class="admin-card usage-insights-header">
        <div class="admin-list-top">
          <div>
            <h3>Usage & Insights</h3>
            <p class="admin-muted">Customer engagement across My Cruise and public tools. Engagement only — never tool contents.</p>
          </div>
          <div class="admin-actions-row" style="align-items:center">
            <button class="admin-button secondary small" onclick="loadUsageInsights()" ${usageInsightsLoading ? "disabled" : ""}>${usageInsightsLoading ? "Refreshing…" : "Refresh"}</button>
            ${usageInsightsLoading ? `<span class="admin-running-status" role="status" aria-live="polite">Refreshing…</span>` : ""}
          </div>
        </div>
        <div class="usage-range-row" role="group" aria-label="Date range">
          ${rangeButtons}
        </div>
        ${
          usageInsightsRange === "custom"
            ? `<div class="usage-custom-range">
                <label>From <input type="date" id="usageInsightsFrom" value="${esc(usageInsightsCustomFrom)}"></label>
                <label>To <input type="date" id="usageInsightsTo" value="${esc(usageInsightsCustomTo)}"></label>
                <button type="button" class="admin-button black small" onclick="applyUsageInsightsCustomRange()">Apply</button>
              </div>`
            : ""
        }
        ${usageInsightsMessage ? `<div class="admin-message admin-error">${esc(usageInsightsMessage)}</div>` : ""}
        ${
          data?.reporting?.incomplete
            ? `<div class="usage-incomplete-warning" role="status">This report may be incomplete because the selected date range contains more activity than the current reporting limit. Choose a shorter date range.</div>`
            : ""
        }
      </div>

      <div class="usage-summary-grid">
        ${renderUsageSummaryCard("Active Customers", summary.active_customers ?? "—")}
        ${renderUsageSummaryCard("Total Sessions", summary.total_sessions ?? "—")}
        ${renderUsageSummaryCard("Most Used Tool", summary.most_used_tool || "—")}
        ${renderUsageSummaryCard("Customers Inactive 30+ Days", summary.inactive_30_days ?? "—")}
        ${renderUsageSummaryCard("Public Calculator Uses", summary.public_calculator_uses ?? "—")}
      </div>

      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Tool Usage</h3>
            <p class="admin-muted">Which tools customers are actually using.</p>
          </div>
        </div>
        <div class="usage-table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Unique Customers</th>
                <th>Sessions</th>
                <th>Avg Sessions / Customer</th>
                <th>Last Used</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              ${
                usageInsightsLoading
                  ? `<tr><td colspan="6" class="usage-empty">Loading…</td></tr>`
                  : toolUsage.length
                    ? toolUsage
                        .map(
                          row => `<tr>
                            <td>${esc(row.tool)}</td>
                            <td>${esc(row.unique_customers)}</td>
                            <td>${esc(row.sessions)}</td>
                            <td>${esc(row.avg_sessions_per_customer)}</td>
                            <td>${esc(formatUsageDateTime(row.last_used))}</td>
                            <td>${formatUsageTrend(row.trend)}</td>
                          </tr>`
                        )
                        .join("")
                    : `<tr><td colspan="6" class="usage-empty">No tool usage in this range yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>

      ${renderUsageFeatureAdoptionSection(data, usageInsightsLoading)}
      ${renderUsageEngagementFunnelSection(data, usageInsightsLoading)}
      ${renderUsageCustomerInsightsSection(data, usageInsightsLoading)}

      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Customer Engagement</h3>
            <p class="admin-muted">Search customers and open recent activity. Private tool content is never shown.</p>
          </div>
        </div>
        <div class="admin-field usage-search-field">
          <label for="usageCustomerSearch">Search</label>
          <input id="usageCustomerSearch" type="search" placeholder="Name, booking or cruise" value="${esc(usageInsightsSearch)}" oninput="setUsageInsightsSearch(this.value)">
        </div>
        <div class="usage-table-wrap">
          <table class="usage-table usage-customers-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Booking</th>
                <th>Cruise</th>
                <th>Last Active</th>
                <th>Tools Used</th>
                <th>Visits</th>
              </tr>
            </thead>
            <tbody>
              ${
                usageInsightsLoading
                  ? `<tr><td colspan="6" class="usage-empty">Loading…</td></tr>`
                  : customers.length
                    ? customers
                        .map(row => {
                          const keyArg = JSON.stringify(String(row.key || ""));
                          return `<tr class="usage-customer-row ${usageInsightsSelectedCustomerKey === row.key ? "is-selected" : ""}" onclick='openUsageCustomerPanel(${keyArg})'>
                            <td>${esc(row.customer)}</td>
                            <td>${esc(row.booking_reference || "—")}</td>
                            <td>${esc(row.cruise || row.cruise_line || "—")}</td>
                            <td>${esc(formatUsageDateTime(row.last_active))}</td>
                            <td><span class="usage-tools">${esc((row.tools_used || []).join(", ") || "—")}</span></td>
                            <td>${esc(row.visits)}</td>
                          </tr>`;
                        })
                        .join("")
                    : `<tr><td colspan="6" class="usage-empty">No customer engagement in this range yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Public Tools</h3>
            <p class="admin-muted">Anonymous engagement with calculators and public tools.</p>
          </div>
        </div>
        <div class="usage-table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Page Views</th>
                <th>Starts</th>
                <th>Completed Uses</th>
                <th>Completion Rate</th>
              </tr>
            </thead>
            <tbody>
              ${
                publicTools.length
                  ? publicTools
                      .map(
                        row => `<tr>
                          <td>${esc(row.tool)}</td>
                          <td>${esc(row.page_views)}</td>
                          <td>${esc(row.starts)}</td>
                          <td>${esc(row.completed)}</td>
                          <td>${esc(row.completion_rate)}%</td>
                        </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="5" class="usage-empty">No public tool usage yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Recent Activity</h3>
            <p class="admin-muted">Newest first. Engagement labels only.</p>
          </div>
        </div>
        <ul class="usage-activity-list">
          ${
            recent.length
              ? recent
                  .map(
                    item => `<li>
                      <div>
                        <strong>${esc(item.customer)}</strong>
                        <span>${esc(item.label)}</span>
                      </div>
                      <time>${esc(formatUsageDateTime(item.occurred_at))}</time>
                    </li>`
                  )
                  .join("")
              : `<li class="usage-empty-item">No recent activity in this range.</li>`
          }
        </ul>
      </div>

      ${usageInsightsPanelCustomer ? renderUsageCustomerSidePanel(usageInsightsPanelCustomer) : ""}
    </div>
  `;
}

function renderUsageSummaryCard(label, value) {
  return `
    <div class="admin-card usage-summary-card">
      <p class="usage-summary-label">${esc(label)}</p>
      <p class="usage-summary-value">${esc(value)}</p>
    </div>
  `;
}

function isPublicUsageTool(row) {
  const moduleName = String(row?.module || "").toLowerCase();
  const toolName = String(row?.tool || "").toLowerCase();
  return moduleName.startsWith("public_") || toolName.startsWith("public ");
}

function getUsageLoggedInCustomerCount(data) {
  const summaryCount = Number(data?.summary?.active_customers);
  if (Number.isFinite(summaryCount) && summaryCount >= 0) return summaryCount;
  return Array.isArray(data?.customers) ? data.customers.length : 0;
}

function buildUsageFeatureAdoption(data) {
  const totalCustomers = getUsageLoggedInCustomerCount(data);
  const rows = (data?.tool_usage || [])
    .filter(row => row && !isPublicUsageTool(row))
    .map(row => {
      const customers = Math.max(0, Number(row.unique_customers) || 0);
      const percent =
        totalCustomers > 0 ? Math.min(100, Number(((customers / totalCustomers) * 100).toFixed(1))) : 0;
      return {
        module: row.module || "",
        feature: row.tool || row.module || "Feature",
        customers,
        total_customers: totalCustomers,
        percent
      };
    })
    .sort((a, b) => b.percent - a.percent || b.customers - a.customers || a.feature.localeCompare(b.feature));
  return { totalCustomers, rows };
}

function buildUsageEngagementFunnel(data) {
  const adoption = buildUsageFeatureAdoption(data);
  const totalCustomers = adoption.totalCustomers;
  const stages = [];

  if (totalCustomers > 0) {
    stages.push({
      key: "logged_in",
      label: "Logged into My Cruise",
      customers: totalCustomers,
      percent: 100
    });
  }

  adoption.rows
    .slice()
    .sort((a, b) => b.customers - a.customers || a.feature.localeCompare(b.feature))
    .forEach(row => {
      stages.push({
        key: row.module || row.feature,
        label: row.feature,
        customers: row.customers,
        percent: row.percent
      });
    });

  return { totalCustomers, stages };
}

function buildUsageCustomerInsights(data) {
  const adoption = buildUsageFeatureAdoption(data);
  const insights = [];
  const rows = adoption.rows;
  const total = adoption.totalCustomers;

  if (!rows.length || total <= 0) return insights;

  const top = rows[0];
  insights.push(`${top.feature} is currently the most adopted feature (${top.percent}%).`);

  if (rows.length > 1) {
    const bottom = rows[rows.length - 1];
    if (bottom.feature !== top.feature) {
      insights.push(`${bottom.feature} has the lowest adoption (${bottom.percent}%).`);
    }
  }

  const drinks = rows.find(
    row =>
      String(row.module) === "drinks_calculator" ||
      String(row.feature).toLowerCase() === "drinks calculator"
  );
  if (drinks) {
    insights.push(`${drinks.percent}% of customers have used the Drinks Calculator (${drinks.customers} of ${total}).`);
  } else if (rows.length > 2) {
    const mid = rows[Math.floor(rows.length / 2)];
    insights.push(`${mid.percent}% of customers have opened ${mid.feature} (${mid.customers} of ${total}).`);
  }

  const sequenceInsight = buildUsageSequenceInsight(data?.customers || []);
  if (sequenceInsight) insights.push(sequenceInsight);

  return insights.slice(0, 4);
}

function buildUsageSequenceInsight(customers) {
  const pairs = new Map();

  customers.forEach(customer => {
    const activity = Array.isArray(customer.recent_activity) ? customer.recent_activity : [];
    if (activity.length < 2) return;

    const firstByModule = new Map();
    activity.forEach(item => {
      const moduleName = String(item.module || "").trim();
      if (!moduleName || moduleName.startsWith("public_")) return;
      const occurred = Date.parse(item.occurred_at);
      if (!Number.isFinite(occurred)) return;
      const existing = firstByModule.get(moduleName);
      if (existing == null || occurred < existing) firstByModule.set(moduleName, occurred);
    });

    const modules = Array.from(firstByModule.keys());
    for (let i = 0; i < modules.length; i += 1) {
      for (let j = i + 1; j < modules.length; j += 1) {
        const left = modules[i];
        const right = modules[j];
        const leftTime = firstByModule.get(left);
        const rightTime = firstByModule.get(right);
        const key = left < right ? `${left}::${right}` : `${right}::${left}`;
        const earlier = leftTime <= rightTime ? left : right;
        const later = earlier === left ? right : left;
        let row = pairs.get(key);
        if (!row) {
          row = { left, right, earlierCounts: {}, comparable: 0 };
          pairs.set(key, row);
        }
        row.comparable += 1;
        row.earlierCounts[earlier] = (row.earlierCounts[earlier] || 0) + 1;
      }
    }
  });

  let best = null;
  pairs.forEach(row => {
    if (row.comparable < 5) return;
    const entries = Object.entries(row.earlierCounts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return;
    const [earlierModule, earlierCount] = entries[0];
    const share = earlierCount / row.comparable;
    if (share < 0.6) return;
    const laterModule = earlierModule === row.left ? row.right : row.left;
    if (!best || earlierCount > best.earlierCount || row.comparable > best.comparable) {
      best = { earlierModule, laterModule, earlierCount, comparable: row.comparable, share };
    }
  });

  if (!best) return null;

  const labelFor = moduleName => {
    const match = (usageInsightsData?.tool_usage || []).find(row => row.module === moduleName);
    if (match?.tool) return match.tool;
    return moduleName
      .split("_")
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  };

  const earlierLabel = labelFor(best.earlierModule);
  const laterLabel = labelFor(best.laterModule);
  const pct = Math.round(best.share * 100);
  return `${earlierLabel} activity typically occurs before ${laterLabel} for customers who used both (${pct}% of ${best.comparable} comparable customers).`;
}

function renderUsageFeatureAdoptionSection(data, isLoading) {
  const adoption = buildUsageFeatureAdoption(data);
  const body = isLoading
    ? `<p class="admin-muted">Loading…</p>`
    : adoption.totalCustomers <= 0 || !adoption.rows.length
      ? `<p class="admin-muted">No feature adoption data in this range yet.</p>`
      : `<div class="usage-adoption-list">
          ${adoption.rows
            .map(
              row => `<div class="usage-adoption-row">
                <div class="usage-adoption-copy">
                  <p class="usage-adoption-name">${esc(row.feature)}</p>
                  <div class="usage-adoption-bar" aria-hidden="true">
                    <span class="usage-adoption-bar-fill" style="width:${esc(String(row.percent))}%;"></span>
                  </div>
                </div>
                <div class="usage-adoption-meta">
                  <p class="usage-adoption-percent">${esc(String(row.percent))}%</p>
                  <p class="usage-adoption-count">${esc(row.customers)} of ${esc(row.total_customers)} customers</p>
                </div>
              </div>`
            )
            .join("")}
        </div>`;

  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Feature Adoption</h3>
          <p class="admin-muted">Share of My Cruise customers who have opened each feature.</p>
        </div>
      </div>
      ${body}
    </div>
  `;
}

function renderUsageEngagementFunnelSection(data, isLoading) {
  const funnel = buildUsageEngagementFunnel(data);
  const body = isLoading
    ? `<p class="admin-muted">Loading…</p>`
    : funnel.stages.length < 2
      ? `<p class="admin-muted">Not enough engagement data to build a funnel for this range.</p>`
      : `<ol class="usage-funnel-list">
          ${funnel.stages
            .map((stage, index) => {
              const previous = index > 0 ? funnel.stages[index - 1] : null;
              const drop =
                previous && previous.customers > 0
                  ? Math.max(0, previous.customers - stage.customers)
                  : 0;
              return `<li class="usage-funnel-stage">
                ${index > 0 ? `<div class="usage-funnel-arrow" aria-hidden="true">▼</div>` : ""}
                <div class="usage-funnel-card">
                  <p class="usage-funnel-label">${esc(stage.label)}</p>
                  <p class="usage-funnel-percent">${esc(String(stage.percent))}%</p>
                  <p class="usage-funnel-count">${esc(stage.customers)} customers</p>
                  ${
                    previous
                      ? `<p class="usage-funnel-drop">${esc(drop)} fewer than previous stage</p>`
                      : ""
                  }
                </div>
              </li>`;
            })
            .join("")}
        </ol>`;

  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Customer Engagement Funnel</h3>
          <p class="admin-muted">Where customers stop engaging, starting from My Cruise login.</p>
        </div>
      </div>
      ${body}
    </div>
  `;
}

function renderUsageCustomerInsightsSection(data, isLoading) {
  const insights = isLoading ? [] : buildUsageCustomerInsights(data);
  const body = isLoading
    ? `<p class="admin-muted">Loading…</p>`
    : insights.length
      ? `<ul class="usage-insights-list">
          ${insights.map(item => `<li>${esc(item)}</li>`).join("")}
        </ul>`
      : `<p class="admin-muted">No proven customer insights for this range yet.</p>`;

  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Customer Insights</h3>
          <p class="admin-muted">Factual observations derived only from tracked engagement.</p>
        </div>
      </div>
      ${body}
    </div>
  `;
}

function renderUsageCustomerSidePanel(customer) {
  const activity = customer.recent_activity || [];
  return `
    <aside class="usage-side-panel" role="dialog" aria-label="Customer activity">
      <div class="usage-side-panel-header">
        <div>
          <p class="admin-small" style="margin:0 0 4px;text-transform:uppercase;letter-spacing:0.03em;font-weight:700;color:#888;">Customer</p>
          <h3>${esc(customer.customer)}</h3>
        </div>
        <button type="button" class="document-modal-close usage-panel-close" onclick="closeUsageCustomerPanel()" aria-label="Close">×</button>
      </div>
      <dl class="usage-side-meta">
        <div><dt>Booking</dt><dd>${esc(customer.booking_reference || "—")}</dd></div>
        <div><dt>Cruise</dt><dd>${esc(customer.cruise || customer.cruise_line || "—")}</dd></div>
        <div><dt>Last Active</dt><dd>${esc(formatUsageDateTime(customer.last_active))}</dd></div>
      </dl>
      <h4>Recent Activity</h4>
      <ul class="usage-activity-list usage-side-activity">
        ${
          activity.length
            ? activity
                .map(
                  item => `<li>
                    <div><span>${esc(item.label)}</span></div>
                    <time>${esc(formatUsageDateTime(item.occurred_at))}</time>
                  </li>`
                )
                .join("")
            : `<li class="usage-empty-item">No recent activity.</li>`
        }
      </ul>
      <p class="admin-small">Only engagement events are shown. Packing lists, budgets, notes and document contents are never recorded.</p>
    </aside>
    <div class="usage-side-backdrop" onclick="closeUsageCustomerPanel()"></div>
  `;
}

/* ========== Settings — Admin users ========== */

async function adminSettingsApi(action, payload = {}) {
  const run = async () => {
    const headers = await adminAuthHeaders();
    const response = await fetch("/.netlify/functions/admin-users", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let { response, data } = await run();
  if (response.status === 401) {
    await supabaseClient.auth.refreshSession().catch(() => null);
    ({ response, data } = await run());
  }
  if (!response.ok || data.success === false) {
    const message = data.error || `HTTP ${response.status}`;
    const revoked =
      response.status === 401 &&
      /revoked|session_id claim|sign out and sign in/i.test(String(message));
    if (revoked) {
      await supabaseClient.auth.signOut().catch(() => null);
      currentUser = null;
      currentProfile = null;
      renderLogin("Your admin session was revoked. Please sign in again.");
    }
    throw new Error(message);
  }
  return data;
}

async function loadAdminSettingsUsers({ keepMessage = false } = {}) {
  adminSettingsLoading = true;
  if (!keepMessage) adminSettingsMessage = "";
  renderAdmin();
  try {
    const data = await adminSettingsApi("list", { search: adminSettingsSearch, page: 1, per_page: 100 });
    adminSettingsUsers = Array.isArray(data.users) ? data.users : [];
    if (data.warning && !keepMessage) {
      adminSettingsMessage = data.warning;
      adminSettingsMessageTone = "error";
    }
  } catch (error) {
    adminSettingsUsers = [];
    adminSettingsMessage = error.message || "Could not load users.";
    adminSettingsMessageTone = "error";
  } finally {
    adminSettingsLoading = false;
    renderAdmin();
  }
}

function setAdminSettingsSearch(value) {
  adminSettingsSearch = value;
}

async function searchAdminSettingsUsers() {
  adminSettingsSearch = document.getElementById("adminSettingsSearch")?.value || adminSettingsSearch;
  await loadAdminSettingsUsers();
}

async function grantAdminAccess(userId, email) {
  const key = userId || email;
  adminSettingsBusyKey = key;
  adminSettingsMessage = "Granting admin access…";
  adminSettingsMessageTone = "running";
  renderAdmin();
  try {
    const result = await adminSettingsApi("grant", { user_id: userId || undefined, email: email || undefined });
    adminSettingsMessage = result.message || "Admin access granted.";
    adminSettingsMessageTone = "success";
    await loadAdminSettingsUsers({ keepMessage: true });
  } catch (error) {
    adminSettingsMessage = error.message || "Could not grant admin access.";
    adminSettingsMessageTone = "error";
    renderAdmin();
  } finally {
    adminSettingsBusyKey = "";
    renderAdmin();
  }
}

async function revokeAdminAccess(userId, email) {
  if (!confirm(`Remove admin access for ${email || userId}?`)) return;
  const key = userId || email;
  adminSettingsBusyKey = key;
  adminSettingsMessage = "Revoking admin access…";
  adminSettingsMessageTone = "running";
  renderAdmin();
  try {
    const result = await adminSettingsApi("revoke", { user_id: userId || undefined, email: email || undefined });
    adminSettingsMessage = result.message || "Admin access revoked.";
    adminSettingsMessageTone = "success";
    await loadAdminSettingsUsers({ keepMessage: true });
  } catch (error) {
    adminSettingsMessage = error.message || "Could not revoke admin access.";
    adminSettingsMessageTone = "error";
    renderAdmin();
  } finally {
    adminSettingsBusyKey = "";
    renderAdmin();
  }
}

async function grantAdminAccessByEmail() {
  const email = (document.getElementById("adminSettingsGrantEmail")?.value || adminSettingsGrantEmail || "").trim();
  adminSettingsGrantEmail = email;
  if (!email) {
    adminSettingsMessage = "Enter an email address first.";
    adminSettingsMessageTone = "error";
    renderAdmin();
    return;
  }
  await grantAdminAccess("", email);
  adminSettingsGrantEmail = "";
}

function renderSettingsPanel() {
  const messageClass =
    adminSettingsMessageTone === "error"
      ? "admin-error"
      : adminSettingsMessageTone === "success"
        ? "admin-success"
        : adminSettingsMessageTone === "running"
          ? "admin-running"
          : "";

  const rows = adminSettingsUsers
    .map((user) => {
      const key = user.id || user.email;
      const busy = adminSettingsBusyKey === key;
      const role = user.admin_user?.role || (user.is_admin ? "admin" : "—");
      const status = user.pending_invite
        ? "Invited (not signed in yet)"
        : user.is_admin
          ? "Admin"
          : "User";
      const isSelf = user.id && currentUser?.id && user.id === currentUser.id;
      // Use single-quoted onclick attrs — JSON.stringify emits double quotes.
      const actions = user.is_admin
        ? isSelf
          ? `<span class="admin-muted">You</span>`
          : `<button type="button" class="admin-button secondary small" onclick='revokeAdminAccess(${JSON.stringify(user.id || "")}, ${JSON.stringify(user.email || "")})' ${busy ? "disabled" : ""}>${busy ? "Working…" : "Revoke"}</button>`
        : `<button type="button" class="admin-button black small" onclick='grantAdminAccess(${JSON.stringify(user.id || "")}, ${JSON.stringify(user.email || "")})' ${busy ? "disabled" : ""}>${busy ? "Working…" : "Grant admin"}</button>`;

      return `<tr>
        <td>
          <strong>${esc(user.display_name || user.email || "—")}</strong>
          <div class="admin-small">${esc(user.email || "—")}</div>
        </td>
        <td>${esc(status)}</td>
        <td>${esc(role)}</td>
        <td>${esc(user.last_sign_in_at ? formatAdminDate(String(user.last_sign_in_at).slice(0, 10)) : "—")}</td>
        <td class="admin-settings-actions">${actions}</td>
      </tr>`;
    })
    .join("");

  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Settings</h3>
          <p class="admin-muted">Manage who can sign in to 101cruise Admin. Granting access updates both the profile flag and the admin allow-list.</p>
        </div>
        <button type="button" class="admin-button secondary small" onclick="loadAdminSettingsUsers()" ${adminSettingsLoading ? "disabled" : ""}>
          ${adminSettingsLoading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${adminSettingsMessage ? `<div class="admin-message ${messageClass}">${esc(adminSettingsMessage)}</div>` : ""}

      <div class="admin-settings-grant">
        <div class="admin-field">
          <label for="adminSettingsGrantEmail">Grant admin by email</label>
          <input id="adminSettingsGrantEmail" type="email" value="${esc(adminSettingsGrantEmail)}" placeholder="name@example.com" oninput="adminSettingsGrantEmail=this.value" onkeydown="if(event.key==='Enter')grantAdminAccessByEmail()">
          <p class="admin-helper">The person needs a Supabase Auth account first (they can sign in once on this Admin page). Then grant access here.</p>
        </div>
        <button type="button" class="admin-button black" onclick="grantAdminAccessByEmail()" ${adminSettingsBusyKey ? "disabled" : ""}>Grant admin</button>
      </div>
    </div>

    <div class="admin-card" style="margin-top:16px">
      <div class="featured-cruises-toolbar">
        <div class="admin-field">
          <label for="adminSettingsSearch">Search users</label>
          <input id="adminSettingsSearch" type="search" value="${esc(adminSettingsSearch)}" placeholder="Email or name…" oninput="setAdminSettingsSearch(this.value)" onkeydown="if(event.key==='Enter')searchAdminSettingsUsers()">
        </div>
        <button type="button" class="admin-button secondary" onclick="searchAdminSettingsUsers()" ${adminSettingsLoading ? "disabled" : ""}>Search</button>
      </div>

      <div class="usage-table-wrap">
        <table class="usage-table admin-settings-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Status</th>
              <th>Role</th>
              <th>Last sign-in</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              adminSettingsLoading
                ? `<tr><td colspan="5" class="usage-empty">Loading users…</td></tr>`
                : rows
                  ? rows
                  : `<tr><td colspan="5" class="usage-empty">No users found.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function initAdmin() {
  // Password-recovery links land with a recovery session; show a set-password form.
  const hash = window.location.hash || "";
  if (hash.includes("type=recovery")) {
    renderAdminPasswordUpdate();
    return;
  }

  const { data } = await supabaseClient.auth.getSession();

  if (!data.session) {
    renderLogin();
    return;
  }

  currentUser = data.session.user;
  await loadProfile();

  if (!currentProfile?.is_admin) {
    try {
      const headers = await adminAuthHeaders();
      const claimResponse = await fetch("/.netlify/functions/admin-users", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "claim_invite" })
      });
      const claimData = await claimResponse.json().catch(() => ({}));
      if (claimData?.claimed) await loadProfile();
    } catch (_error) {
      /* ignore */
    }
  }

  const access = await assertAdminAccess();
  if (!access.ok) {
    await supabaseClient.auth.signOut();
    currentUser = null;
    currentProfile = null;
    renderLogin(access.message);
    return;
  }

  await loadAdminData();
  renderAdmin();
}

function renderAdminPasswordUpdate(message = "") {
  app.classList.remove("is-calculator-data");
  app.innerHTML = `
    <div class="admin-card">
      <h2>Set a new password</h2>
      <p class="admin-muted">Choose a new password for your 101cruise Admin account.</p>
      <div class="admin-field">
        <label>New password</label>
        <input type="password" id="adminNewPassword" autocomplete="new-password">
      </div>
      <div class="admin-field">
        <label>Confirm password</label>
        <input type="password" id="adminNewPasswordConfirm" autocomplete="new-password">
      </div>
      <button class="admin-button black" onclick="adminUpdatePassword()">Update password</button>
      <div id="admin-login-message" class="admin-message ${message ? "admin-error" : ""}">${esc(message)}</div>
    </div>
  `;
}

async function adminUpdatePassword() {
  const password = document.getElementById("adminNewPassword")?.value || "";
  const confirm = document.getElementById("adminNewPasswordConfirm")?.value || "";
  if (password.length < 8) {
    renderAdminPasswordUpdate("Password must be at least 8 characters.");
    return;
  }
  if (password !== confirm) {
    renderAdminPasswordUpdate("Passwords do not match.");
    return;
  }
  const { error } = await supabaseClient.auth.updateUser({ password });
  if (error) {
    renderAdminPasswordUpdate(error.message);
    return;
  }
  window.history.replaceState({}, document.title, window.location.pathname);
  currentUser = (await supabaseClient.auth.getUser()).data.user;
  await loadProfile();
  const access = await assertAdminAccess();
  if (!access.ok) {
    await supabaseClient.auth.signOut();
    renderLogin(access.message);
    return;
  }
  await loadAdminData();
  renderAdmin();
}

/* =========================================================
   Cruise Intelligence (ci_cruise_lines / ci_cruise_ships)
   ========================================================= */

function slugifyCi(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function captureCiMasterScroll() {
  const lineList = document.getElementById("ciLineMasterList");
  const shipList = document.getElementById("ciShipMasterList");
  if (lineList) ciLineMasterScrollTop = lineList.scrollTop;
  if (shipList) ciShipMasterScrollTop = shipList.scrollTop;
}

function restoreCiMasterScroll() {
  const apply = () => {
    const lineList = document.getElementById("ciLineMasterList");
    const shipList = document.getElementById("ciShipMasterList");
    if (lineList) lineList.scrollTop = ciLineMasterScrollTop;
    if (shipList) shipList.scrollTop = ciShipMasterScrollTop;
  };
  apply();
  requestAnimationFrame(apply);
}

function renderCiAdmin() {
  captureCiMasterScroll();
  renderAdmin();
  restoreCiMasterScroll();
}

function setCiAutosaveStatus(text, tone) {
  ciAutosaveStatus = text || "";
  const el = document.getElementById("ciAutosaveStatus");
  if (!el) return;
  el.textContent = ciAutosaveStatus;
  el.className = `ci-autosave-status${tone ? ` is-${tone}` : ""}`;
}

async function setCiSubView(view) {
  const next = view === "ships" ? "ships" : "lines";
  if (next === ciSubView) return;
  const ok = await flushCiCurrentForm();
  if (!ok) return;
  ciSubView = next;
  ciLineCreating = false;
  ciShipCreating = false;
  editingCiLineId = null;
  editingCiShipId = null;
  ciAutosaveStatus = "";
  renderCiAdmin();
}

function refreshCiLineMasterList() {
  const list = document.getElementById("ciLineMasterList");
  const count = document.getElementById("ciLineListCount");
  if (!list) {
    renderCiAdmin();
    return;
  }
  const scroll = list.scrollTop;
  const filtered = getFilteredCiLines();
  list.innerHTML = filtered.length
    ? filtered.map(renderCiLineMasterRow).join("")
    : `<p class="admin-small ci-master-empty">No cruise lines match these filters.</p>`;
  list.scrollTop = scroll;
  ciLineMasterScrollTop = scroll;
  if (count) count.textContent = `${filtered.length} of ${ciCruiseLines.length}`;
}

function refreshCiShipMasterList() {
  const list = document.getElementById("ciShipMasterList");
  const count = document.getElementById("ciShipListCount");
  if (!list) {
    renderCiAdmin();
    return;
  }
  const scroll = list.scrollTop;
  const filtered = getFilteredCiShips();
  list.innerHTML = filtered.length
    ? filtered.map(renderCiShipMasterRow).join("")
    : `<p class="admin-small ci-master-empty">No ships match these filters.</p>`;
  list.scrollTop = scroll;
  ciShipMasterScrollTop = scroll;
  if (count) count.textContent = `${filtered.length} of ${ciCruiseShips.length}`;
}

function updateCiLineSearch(value) {
  ciLineSearchQuery = value;
  refreshCiLineMasterList();
}

function updateCiLineFilter(value) {
  ciLineFilter = value;
  refreshCiLineMasterList();
}

function updateCiShipSearch(value) {
  ciShipSearchQuery = value;
  refreshCiShipMasterList();
}

function updateCiShipLineFilter(value) {
  ciShipLineFilter = value;
  refreshCiShipMasterList();
}

function updateCiShipStatusFilter(value) {
  ciShipStatusFilter = value;
  refreshCiShipMasterList();
}

function getFilteredCiLines() {
  const q = String(ciLineSearchQuery || "").trim().toLowerCase();
  return ciCruiseLines
    .filter((line) => {
      if (ciLineFilter === "active" && !line.active) return false;
      if (ciLineFilter === "inactive" && line.active) return false;
      if (ciLineFilter === "sold" && !line.sold_by_101cruise) return false;
      if (ciLineFilter === "review" && !line.needs_review) return false;
      if (!q) return true;
      return [line.name, line.code, line.slug, line.country]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(q));
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
}

function getFilteredCiShips() {
  const q = String(ciShipSearchQuery || "").trim().toLowerCase();
  return ciCruiseShips
    .filter((ship) => {
      if (ciShipLineFilter !== "all" && ship.cruise_line_id !== ciShipLineFilter) return false;
      if (ciShipStatusFilter !== "all") {
        const status = String(ship.status || "").toLowerCase();
        if (status !== ciShipStatusFilter) return false;
      }
      if (!q) return true;
      const lineName = String(ship.ci_cruise_lines?.name || "").toLowerCase();
      return String(ship.name || "").toLowerCase().includes(q) || lineName.includes(q);
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
}

function renderCruiseIntelligencePanel() {
  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Cruise Lines/Ships</h3>
          <p class="admin-muted">Permanent cruise-line and ship catalogue (Supabase). Separate from Drinks Calculator logos. Edits save when you select another item.</p>
        </div>
      </div>
      ${
        ciMessage && ciMessage !== "Saving…"
          ? `<div class="admin-message ${
              ciMessageTone === "error" ? "admin-error" : ciMessageTone === "running" || ciMessage === "Saving…" ? "admin-running" : "admin-success"
            }">${esc(ciMessage)}</div>`
          : ""
      }
      <div class="admin-subtabs packing-subtabs" role="tablist" aria-label="Cruise Lines and Ships sections">
        <button class="admin-subtab ${ciSubView === "lines" ? "active" : ""}" onclick="setCiSubView('lines')">Cruise Lines</button>
        <button class="admin-subtab ${ciSubView === "ships" ? "active" : ""}" onclick="setCiSubView('ships')">Ships</button>
      </div>
      ${ciSubView === "ships" ? renderCiShipsSection() : renderCiLinesSection()}
    </div>
  `;
}

function renderCiLinesSection() {
  const filtered = getFilteredCiLines();
  const selectedLine = ciLineCreating
    ? null
    : (editingCiLineId ? ciCruiseLines.find((l) => l.id === editingCiLineId) : null);
  const showDetail = ciLineCreating || Boolean(selectedLine);

  return `
    <div class="ci-toolbar">
      <div class="ci-toolbar-controls">
        <input type="search" value="${esc(ciLineSearchQuery)}" placeholder="Search lines…" oninput="updateCiLineSearch(this.value)">
        <select onchange="updateCiLineFilter(this.value)">
          <option value="all" ${ciLineFilter === "all" ? "selected" : ""}>All</option>
          <option value="sold" ${ciLineFilter === "sold" ? "selected" : ""}>Sold by 101cruise</option>
          <option value="active" ${ciLineFilter === "active" ? "selected" : ""}>Active</option>
          <option value="inactive" ${ciLineFilter === "inactive" ? "selected" : ""}>Inactive</option>
          <option value="review" ${ciLineFilter === "review" ? "selected" : ""}>Needs review</option>
        </select>
        <button class="admin-button black small" onclick="startCiLineCreate()">Add cruise line</button>
      </div>
      <div class="admin-small"><span id="ciLineListCount">${filtered.length} of ${ciCruiseLines.length}</span> lines</div>
    </div>
    <div class="ci-master-detail">
      <aside class="ci-master" aria-label="Cruise lines">
        <div class="ci-master-header">
          <span>Cruise Lines</span>
        </div>
        <div class="ci-master-list" id="ciLineMasterList">
          ${filtered.length
            ? filtered.map(renderCiLineMasterRow).join("")
            : `<p class="admin-small ci-master-empty">No cruise lines match these filters.</p>`}
        </div>
      </aside>
      <section class="ci-detail" aria-label="Cruise line details">
        ${showDetail
          ? renderCiLineForm(selectedLine)
          : `<div class="ci-detail-empty"><p class="admin-muted" style="margin:0;">Select a cruise line to view and edit details.</p></div>`}
      </section>
    </div>
  `;
}

function renderCiLineMasterRow(line) {
  const selected = !ciLineCreating && editingCiLineId === line.id;
  const shipCount = getCiLineShipStats(line.id).total;
  const shipLabel = shipCount === 1 ? "1 ship" : `${shipCount} ships`;
  const meta = [
    shipLabel,
    line.line_type || null,
    line.country || null,
    line.active ? null : "Inactive"
  ].filter(Boolean).join(" · ");

  return `
    <button type="button" class="ci-master-row ${selected ? "is-selected" : ""}" onclick="selectCiLine('${esc(line.id)}')">
      <span class="ci-master-row-title">${esc(line.name)}</span>
      <span class="ci-master-row-meta">${esc(meta)}</span>
    </button>
  `;
}

function formatCiDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function getCiLineShipStats(lineId) {
  const ships = (ciCruiseShips || []).filter((ship) => ship.cruise_line_id === lineId);
  const publicShips = ships.filter((ship) => ship.active !== false).length;
  const hiddenShips = ships.filter((ship) => ship.active === false).length;
  return {
    total: ships.length,
    publicShips,
    hiddenShips
  };
}

function renderCiLineStatsPanel(line) {
  if (!line || !line.id) {
    return `
      <div class="ci-stats-panel">
        <h4>Statistics</h4>
        <p class="admin-small" style="margin:0;">Ship statistics appear after this cruise line is created.</p>
      </div>
    `;
  }

  const stats = getCiLineShipStats(line.id);
  const active = line.active !== false;
  const sold = Boolean(line.sold_by_101cruise);

  return `
    <div class="ci-stats-panel">
      <h4>Statistics</h4>
      <div class="ci-stats-row">
        <div class="ci-stat">
          <span class="ci-stat-label">Ships</span>
          <span class="ci-stat-value">${esc(stats.total)}</span>
        </div>
        <div class="ci-stat">
          <span class="ci-stat-label">Public ships</span>
          <span class="ci-stat-value">${esc(stats.publicShips)}</span>
        </div>
        <div class="ci-stat">
          <span class="ci-stat-label">Hidden ships</span>
          <span class="ci-stat-value">${esc(stats.hiddenShips)}</span>
        </div>
        <div class="ci-stat">
          <span class="ci-stat-label">Last updated</span>
          <span class="ci-stat-value">${esc(formatCiDate(line.updated_at || line.created_at))}</span>
        </div>
        <div class="ci-stat">
          <span class="ci-stat-label">Status</span>
          <div class="ci-stat-status">
            <span class="ci-stat-flag ${active ? "" : "is-off"}">${active ? "✓" : "–"} Active</span>
            <span class="ci-stat-flag ${sold ? "" : "is-off"}">${sold ? "✓" : "–"} Sold by 101cruise</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function normalizeCiStateroomBreakdown(raw) {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const rows = [];
  if (Array.isArray(raw)) {
    raw.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const label = String(entry.label || entry.name || entry.type || entry.stateroom_type || "").trim();
      const countRaw = entry.count ?? entry.value ?? entry.quantity;
      if (!label) return;
      if (countRaw === null || countRaw === undefined || countRaw === "") {
        rows.push({ label, count: "" });
        return;
      }
      const count = Number(countRaw);
      if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) return;
      rows.push({ label, count });
    });
    return sortStateroomCategoryRows(rows);
  }
  if (typeof raw === "object") {
    Object.entries(raw).forEach(([key, value]) => {
      if (key === "custom" && Array.isArray(value)) {
        value.forEach((entry) => {
          if (!entry || typeof entry !== "object") return;
          const label = String(entry.name || entry.label || "").trim();
          if (!label) return;
          const countRaw = entry.count ?? entry.value;
          if (countRaw === null || countRaw === undefined || countRaw === "") {
            rows.push({ label, count: "" });
            return;
          }
          const count = Number(countRaw);
          if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) return;
          rows.push({ label, count });
        });
        return;
      }
      const label = humaniseCiCabinLabel(key);
      if (value === null || value === undefined || value === "") return;
      const count = Number(value);
      if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) return;
      if (count === 0) return;
      rows.push({ label, count });
    });
  }
  return sortStateroomCategoryRows(rows);
}

function stateroomCategoryRank(label) {
  const n = String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (n === "inside" || n === "interior") return 1;
  if (n === "oceanview" || n === "ocean view") return 2;
  if (n === "balcony" || n === "veranda") return 3;
  if (n === "suite" || n === "suites") return 4;
  return 100;
}

function sortStateroomCategoryRows(rows) {
  return (rows || [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const rankDiff = stateroomCategoryRank(a.row.label) - stateroomCategoryRank(b.row.label);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

function humaniseCiCabinLabel(key) {
  const map = {
    inside: "Inside",
    oceanview: "Oceanview",
    ocean_view: "Oceanview",
    balcony: "Balcony",
    suites: "Suites",
    suite: "Suites",
    owners_suites: "Owners Suites",
    owner_suites: "Owners Suites"
  };
  const lower = String(key || "").toLowerCase();
  if (map[lower]) return map[lower];
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function renderCiStateroomRow(row, index) {
  const countVal = row.count === "" || row.count == null ? "" : String(row.count);
  return `
    <div class="ci-stateroom-row" data-index="${index}">
      <input type="text" class="ci-stateroom-label" value="${esc(row.label || "")}" placeholder="Cabin type" oninput="updateCiStateroomTotals()">
      <input type="number" class="ci-stateroom-count" min="0" step="1" value="${esc(countVal)}" placeholder="Qty" oninput="updateCiStateroomTotals()">
      <div class="ci-stateroom-row-actions">
        <button type="button" class="admin-button secondary small" onclick="moveCiStateroomRow(${index}, -1)" title="Move up">↑</button>
        <button type="button" class="admin-button secondary small" onclick="moveCiStateroomRow(${index}, 1)" title="Move down">↓</button>
        <button type="button" class="admin-button secondary small" onclick="removeCiStateroomRow(${index})">Remove</button>
      </div>
    </div>
  `;
}

function renderCiStateroomEditor(ship) {
  const rows = normalizeCiStateroomBreakdown(ship?.stateroom_breakdown);
  if (!rows.length && ship?.cabin_type_summary) {
    rows.push(...normalizeCiStateroomBreakdown(ship.cabin_type_summary));
  }
  const totalRooms = Number(ship?.stateroom_count);
  const sum = rows.reduce((acc, row) => acc + (Number.isFinite(Number(row.count)) ? Number(row.count) : 0), 0);
  const showWarning = Number.isFinite(totalRooms) && totalRooms > 0 && sum > 0 && Math.abs(sum - totalRooms) > Math.max(5, totalRooms * 0.05);

  return `
    <div class="ci-stateroom-section">
      <h4>Stateroom Breakdown</h4>
      <p class="admin-small">Add any cabin categories used by this ship. Totals are checked against Total Staterooms but never block saving.</p>
      <div id="ciStateroomBreakdown">
        ${rows.length ? rows.map(renderCiStateroomRow).join("") : ""}
      </div>
      <div class="admin-actions-row" style="margin-top:8px;">
        <button type="button" class="admin-button secondary small" onclick="addCiStateroomRow()">Add row</button>
        <span class="admin-small">Category total: <strong id="ciStateroomSum">${esc(sum)}</strong></span>
      </div>
      <p id="ciStateroomWarning" class="ci-stateroom-warning"${showWarning ? "" : " hidden"}>Room category totals do not currently match the ship’s stated total. Please verify when convenient.</p>
    </div>
  `;
}

function readCiStateroomBreakdownFromDom() {
  const root = document.getElementById("ciStateroomBreakdown");
  if (!root) return null;
  const rows = [];
  root.querySelectorAll(".ci-stateroom-row").forEach((row) => {
    const label = String(row.querySelector(".ci-stateroom-label")?.value || "").trim();
    const countRaw = String(row.querySelector(".ci-stateroom-count")?.value || "").trim();
    if (!label && !countRaw) return;
    if (!label) return;
    if (!countRaw) {
      rows.push({ label, count: null });
      return;
    }
    if (!/^\d+$/.test(countRaw)) return;
    const count = Number(countRaw);
    if (!Number.isInteger(count) || count < 0) return;
    rows.push({ label, count });
  });
  return rows;
}

function updateCiStateroomTotals() {
  const rows = readCiStateroomBreakdownFromDom() || [];
  const sum = rows.reduce((acc, row) => acc + (Number.isFinite(Number(row.count)) ? Number(row.count) : 0), 0);
  const sumEl = document.getElementById("ciStateroomSum");
  if (sumEl) sumEl.textContent = String(sum);
  const totalRooms = Number(document.getElementById("ciShipStaterooms")?.value);
  const warning = document.getElementById("ciStateroomWarning");
  if (!warning) return;
  const showWarning = Number.isFinite(totalRooms) && totalRooms > 0 && sum > 0 && Math.abs(sum - totalRooms) > Math.max(5, totalRooms * 0.05);
  warning.hidden = !showWarning;
}

function rebuildCiStateroomDom(rows) {
  const root = document.getElementById("ciStateroomBreakdown");
  if (!root) return;
  root.innerHTML = rows.map(renderCiStateroomRow).join("");
  updateCiStateroomTotals();
}

function addCiStateroomRow() {
  const rows = readCiStateroomBreakdownFromDom() || [];
  rows.push({ label: "", count: "" });
  rebuildCiStateroomDom(rows.map((r) => ({ label: r.label, count: r.count == null ? "" : r.count })));
}

function removeCiStateroomRow(index) {
  const rows = readCiStateroomBreakdownFromDom() || [];
  rows.splice(index, 1);
  rebuildCiStateroomDom(rows.map((r) => ({ label: r.label, count: r.count == null ? "" : r.count })));
}

function moveCiStateroomRow(index, delta) {
  const rows = readCiStateroomBreakdownFromDom() || [];
  const next = index + delta;
  if (next < 0 || next >= rows.length) return;
  const copy = rows.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item);
  rebuildCiStateroomDom(copy.map((r) => ({ label: r.label, count: r.count == null ? "" : r.count })));
}

function renderCiMediaField({ kind, inputId, url, previewClass, title }) {
  const hasUrl = Boolean(url);
  const isLogo = kind === "logo";
  return `
    <div class="ci-media-field" data-media-kind="${esc(kind)}">
      <div class="ci-media-head">
        <h4>${esc(title)}</h4>
      </div>
      <div class="ci-media-preview-wrap">
        ${hasUrl
          ? `<img id="${esc(inputId)}Preview" class="${esc(previewClass)}" src="${esc(url)}" alt="${esc(title)} preview" onerror="this.style.display='none'">`
          : `<div id="${esc(inputId)}PreviewEmpty" class="admin-empty-preview">No ${esc(title.toLowerCase())} yet</div>`}
      </div>
      <input type="hidden" id="${esc(inputId)}" value="${esc(url || "")}">
      <div class="ci-media-url-row" id="${esc(inputId)}UrlRow" hidden>
        <input type="url" id="${esc(inputId)}UrlInput" placeholder="${isLogo ? "https://… logo URL" : "https://… image URL"}" value="${esc(url || "")}">
        <button type="button" class="admin-button small" onclick="applyCiMediaUrl('${esc(inputId)}', '${esc(kind)}')">Apply URL</button>
      </div>
      <div class="admin-actions-row ci-media-actions">
        <label class="admin-button secondary small ci-upload-label">
          ${isLogo ? "Upload Logo" : "Upload Image"}
          <input type="file" accept="${isLogo ? "image/png,image/svg+xml,image/webp,image/jpeg,.png,.svg,.webp,.jpg,.jpeg" : "image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg"}" hidden onchange="uploadCiMediaFile(event, '${esc(inputId)}', '${esc(kind)}')">
        </label>
        <button type="button" class="admin-button secondary small" onclick="toggleCiMediaUrlRow('${esc(inputId)}')">Use URL</button>
        <button type="button" class="admin-button secondary small" onclick="removeCiMedia('${esc(inputId)}', '${esc(kind)}')" ${hasUrl ? "" : "disabled"}>Remove ${isLogo ? "Logo" : "Image"}</button>
      </div>
      <p class="admin-small" id="${esc(inputId)}MediaMsg"></p>
    </div>
  `;
}

function toggleCiMediaUrlRow(inputId) {
  const row = document.getElementById(`${inputId}UrlRow`);
  if (!row) return;
  row.hidden = !row.hidden;
}

function setCiMediaMessage(inputId, text, isError) {
  const el = document.getElementById(`${inputId}MediaMsg`);
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "#b42318" : "#245c4e";
}

function updateCiMediaPreview(inputId, url, previewClass) {
  const wrap = document.querySelector(`#${inputId}`)?.closest(".ci-media-field")?.querySelector(".ci-media-preview-wrap");
  if (!wrap) return;
  if (url) {
    wrap.innerHTML = `<img id="${esc(inputId)}Preview" class="${esc(previewClass || "admin-hero-preview")}" src="${esc(url)}" alt="preview" onerror="this.style.display='none'">`;
  } else {
    wrap.innerHTML = `<div class="admin-empty-preview">No image yet</div>`;
  }
  const removeBtn = wrap.closest(".ci-media-field")?.querySelector(".ci-media-actions button:last-child");
  if (removeBtn) removeBtn.disabled = !url;
}

async function applyCiMediaUrl(inputId, kind) {
  const urlInput = document.getElementById(`${inputId}UrlInput`);
  const url = normalizeUrl(urlInput?.value);
  const hidden = document.getElementById(inputId);
  if (!hidden) return;
  hidden.value = url;
  updateCiMediaPreview(inputId, url, kind === "logo" ? "admin-logo-preview" : "admin-hero-preview");
  setCiMediaMessage(inputId, url ? "URL applied." : "URL cleared.");
  if (!ciLineCreating && !ciShipCreating) {
    await persistCiMediaOnly(kind, url);
  }
}

async function removeCiMedia(inputId, kind) {
  const hidden = document.getElementById(inputId);
  if (hidden) hidden.value = "";
  const urlInput = document.getElementById(`${inputId}UrlInput`);
  if (urlInput) urlInput.value = "";
  updateCiMediaPreview(inputId, "", kind === "logo" ? "admin-logo-preview" : "admin-hero-preview");
  setCiMediaMessage(inputId, "Removed.");
  if (!ciLineCreating && !ciShipCreating) {
    await persistCiMediaOnly(kind, "");
  }
}

async function persistCiMediaOnly(kind, url) {
  captureCiMasterScroll();
  if (kind === "logo") {
    const id = document.getElementById("ciLineId")?.value || editingCiLineId;
    if (!id) return;
    setCiAutosaveStatus("Saving…", "saving");
    const result = await supabaseClient
      .from("ci_cruise_lines")
      .update({ logo_url: url || null })
      .eq("id", id)
      .select()
      .single();
    if (result.error) {
      setCiAutosaveStatus("Save failed", "error");
      setCiMediaMessage("ciLineLogo", result.error.message, true);
      return;
    }
    mergeCiLineRecord(result.data);
    setCiAutosaveStatus("Saved", "saved");
    refreshCiLineMasterList();
    return;
  }
  const id = document.getElementById("ciShipId")?.value || editingCiShipId;
  if (!id) return;
  setCiAutosaveStatus("Saving…", "saving");
  const result = await supabaseClient
    .from("ci_cruise_ships")
    .update({ hero_image_url: url || null })
    .eq("id", id)
    .select("*, ci_cruise_lines(id, name, slug)")
    .single();
  if (result.error) {
    setCiAutosaveStatus("Save failed", "error");
    setCiMediaMessage("ciShipHero", result.error.message, true);
    return;
  }
  mergeCiShipRecord(result.data);
  setCiAutosaveStatus("Saved", "saved");
  refreshCiShipMasterList();
}

async function resizeCiImageFile(file, maxWidth = 1800, quality = 0.85) {
  if (!file || !file.type || file.type === "image/svg+xml") return file;
  if (!file.type.startsWith("image/")) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  if (bitmap.width <= maxWidth) return file;
  const scale = maxWidth / bitmap.width;
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const outType = file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg";
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, quality));
  if (!blob) return file;
  const ext = outType === "image/png" ? ".png" : outType === "image/webp" ? ".webp" : ".jpg";
  const base = String(file.name || "image").replace(/\.[^.]+$/, "");
  return new File([blob], `${base}${ext}`, { type: outType });
}

async function uploadCiMediaFile(event, inputId, kind) {
  const input = event?.target;
  const file = input?.files?.[0];
  if (!file) return;

  const isLogo = kind === "logo";
  const maxBytes = isLogo ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
  const allowed = isLogo
    ? ["image/png", "image/svg+xml", "image/webp", "image/jpeg", "image/jpg"]
    : ["image/png", "image/webp", "image/jpeg", "image/jpg"];
  if (!allowed.includes(file.type)) {
    setCiMediaMessage(inputId, "Unsupported file type.", true);
    input.value = "";
    return;
  }

  setCiMediaMessage(inputId, "Preparing upload…");
  let uploadFile = file;
  if (!isLogo) {
    uploadFile = await resizeCiImageFile(file, 1800, 0.85);
  }
  if (uploadFile.size > maxBytes) {
    setCiMediaMessage(inputId, `File too large after optimisation (max ${isLogo ? "2" : "8"} MB).`, true);
    input.value = "";
    return;
  }

  try {
    const headers = await itineraryAuthHeaders();
    const recordId = isLogo
      ? (document.getElementById("ciLineId")?.value || editingCiLineId || "new")
      : (document.getElementById("ciShipId")?.value || editingCiShipId || "new");
    const prepared = await fetch("/.netlify/functions/ci-media-upload", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "create_upload",
        kind: isLogo ? "logo" : "ship",
        filename: uploadFile.name,
        mime_type: uploadFile.type,
        size_bytes: uploadFile.size,
        record_id: recordId
      })
    }).then((r) => r.json());

    if (!prepared?.success) {
      throw new Error(prepared?.error || "Could not prepare upload");
    }

    const { error: uploadError } = await supabaseClient.storage
      .from(prepared.bucket)
      .uploadToSignedUrl(prepared.storage_path, prepared.token, uploadFile, {
        contentType: uploadFile.type
      });
    if (uploadError) throw uploadError;

    const publicUrl = prepared.public_url;
    const hidden = document.getElementById(inputId);
    if (hidden) hidden.value = publicUrl;
    const urlInput = document.getElementById(`${inputId}UrlInput`);
    if (urlInput) urlInput.value = publicUrl;
    updateCiMediaPreview(inputId, publicUrl, isLogo ? "admin-logo-preview" : "admin-hero-preview");
    setCiMediaMessage(inputId, "Uploaded.");
    if (!ciLineCreating && !ciShipCreating) {
      await persistCiMediaOnly(kind, publicUrl);
    }
  } catch (error) {
    setCiMediaMessage(inputId, error.message || "Upload failed", true);
  } finally {
    input.value = "";
  }
}

function renderCiLineForm(line) {
  const editing = Boolean(line);
  const slugReadonly = editing ? `readonly class="ci-id-readonly" aria-readonly="true"` : `placeholder="auto from name if blank"`;
  const codeReadonly = editing ? `readonly class="ci-id-readonly" aria-readonly="true"` : "";
  const statusClass = ciAutosaveStatus
    ? (ciMessageTone === "error" ? "is-error" : ciAutosaveStatus === "Saving…" ? "is-saving" : "is-saved")
    : "";
  return `
    <div>
      <div class="ci-detail-title-row">
        <h3 class="ci-detail-title">${editing ? esc(line.name) : "New cruise line"}</h3>
        ${editing ? `<span id="ciAutosaveStatus" class="ci-autosave-status ${statusClass}">${esc(ciAutosaveStatus)}</span>` : ""}
      </div>
      <p class="admin-small ci-detail-subtitle">${editing ? "Changes save when you select another cruise line." : "Fill in the details, then create."}</p>
      ${renderCiLineStatsPanel(line)}
      ${renderCiMediaField({
        kind: "logo",
        inputId: "ciLineLogo",
        url: line?.logo_url || "",
        previewClass: "admin-logo-preview",
        title: "Logo"
      })}
      <input type="hidden" id="ciLineId" value="${esc(line?.id || "")}">
      <div class="ci-form-grid">
        <div class="admin-field"><label>Name</label><input id="ciLineName" value="${esc(line?.name || "")}"></div>
        <div class="admin-field"><label>Slug</label><input id="ciLineSlug" value="${esc(line?.slug || "")}" ${slugReadonly}></div>
        <div class="admin-field"><label>Code</label><input id="ciLineCode" value="${esc(line?.code || "")}" ${codeReadonly}></div>
        <div class="admin-field"><label>Country</label><input id="ciLineCountry" value="${esc(line?.country || "")}"></div>
        <div class="admin-field"><label>Line type</label>
          <select id="ciLineType">
            <option value="" ${!line?.line_type ? "selected" : ""}>Not set</option>
            ${["ocean", "river", "expedition", "yacht", "specialty"].map((t) => `<option value="${t}" ${line?.line_type === t ? "selected" : ""}>${t}</option>`).join("")}
          </select>
        </div>
        <div class="admin-field"><label>Website URL</label><input id="ciLineWebsite" value="${esc(line?.website_url || "")}"></div>
        <div class="admin-field"><label>Cruise search URL</label><input id="ciLineCruiseSearch" value="${esc(line?.cruise_search_url || "")}" placeholder="Official find-a-cruise page (optional)"></div>
      </div>
      <div class="ci-checkbox-row">
        <label class="ci-check-control"><input type="checkbox" id="ciLineActive" ${line?.active !== false ? "checked" : ""}> Active</label>
        <label class="ci-check-control"><input type="checkbox" id="ciLineSold" ${line?.sold_by_101cruise ? "checked" : ""}> Sold by 101cruise</label>
      </div>
      <p class="admin-small ci-form-note">Sold lines are automatically public when active. Lines list alphabetically by name.${editing ? " Slug and code stay fixed after creation." : ""}</p>
      <div class="admin-field ci-form-description"><label>Description</label><textarea id="ciLineDescription" rows="4">${esc(line?.description || "")}</textarea></div>
      ${ciLineCreating ? `
        <div class="admin-actions-row">
          <button class="admin-button" onclick="saveCiLine()">Create line</button>
          <button class="admin-button secondary" onclick="cancelCiLineForm()">Cancel</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function flushCiCurrentForm() {
  if (ciSubView === "ships") {
    if (ciShipCreating) return true;
    if (!editingCiShipId || !document.getElementById("ciShipId")) return true;
    return persistCiShip({ quiet: true });
  }
  if (ciLineCreating) return true;
  if (!editingCiLineId || !document.getElementById("ciLineId")) return true;
  return persistCiLine({ quiet: true });
}

async function startCiLineCreate() {
  const ok = await flushCiCurrentForm();
  if (!ok) return;
  editingCiLineId = null;
  ciLineCreating = true;
  ciAutosaveStatus = "";
  renderCiAdmin();
}

async function selectCiLine(id) {
  if (!ciLineCreating && editingCiLineId === id) return;
  captureCiMasterScroll();
  if (!ciLineCreating) {
    const ok = await flushCiCurrentForm();
    if (!ok) {
      restoreCiMasterScroll();
      return;
    }
  }
  editingCiLineId = id;
  ciLineCreating = false;
  ciAutosaveStatus = "";
  ciMessage = "";
  renderCiAdmin();
}

function cancelCiLineForm() {
  editingCiLineId = null;
  ciLineCreating = false;
  ciAutosaveStatus = "";
  renderCiAdmin();
}

function mergeCiLineRecord(saved) {
  if (!saved?.id) return;
  const idx = ciCruiseLines.findIndex((l) => l.id === saved.id);
  if (idx >= 0) ciCruiseLines[idx] = { ...ciCruiseLines[idx], ...saved };
  else ciCruiseLines.push(saved);
}

async function persistCiLine({ quiet = false } = {}) {
  if (ciSaving) return false;
  const id = document.getElementById("ciLineId")?.value || "";
  const name = String(document.getElementById("ciLineName")?.value || "").trim();
  let slug = String(document.getElementById("ciLineSlug")?.value || "").trim();
  if (!name) {
    ciMessage = "Cruise line name is required.";
    ciMessageTone = "error";
    setCiAutosaveStatus("Name required", "error");
    if (!quiet) renderCiAdmin();
    return false;
  }
  if (!slug) slug = slugifyCi(name);
  const existingLine = id ? ciCruiseLines.find((l) => l.id === id) : null;
  const payload = {
    name,
    country: String(document.getElementById("ciLineCountry")?.value || "").trim() || null,
    website_url: normalizeUrl(document.getElementById("ciLineWebsite")?.value) || null,
    cruise_search_url: normalizeUrl(document.getElementById("ciLineCruiseSearch")?.value) || null,
    logo_url: normalizeUrl(document.getElementById("ciLineLogo")?.value) || null,
    line_type: String(document.getElementById("ciLineType")?.value || "").trim() || null,
    active: Boolean(document.getElementById("ciLineActive")?.checked),
    sold_by_101cruise: Boolean(document.getElementById("ciLineSold")?.checked),
    description: String(document.getElementById("ciLineDescription")?.value || "").trim() || null,
    needs_review: !document.getElementById("ciLineSold")?.checked,
    review_notes: null
  };
  if (!existingLine) {
    payload.slug = slug;
    payload.code = String(document.getElementById("ciLineCode")?.value || "").trim() || null;
    payload.source_name = "Admin";
  }

  ciSaving = true;
  if (quiet) setCiAutosaveStatus("Saving…", "saving");
  else {
    ciMessage = "Saving…";
    ciMessageTone = "running";
  }

  let result;
  try {
    if (id) {
      result = await supabaseClient.from("ci_cruise_lines").update(payload).eq("id", id).select().single();
    } else {
      result = await supabaseClient.from("ci_cruise_lines").insert(payload).select().single();
    }
  } finally {
    ciSaving = false;
  }

  if (result.error) {
    ciMessage = result.error.message;
    ciMessageTone = "error";
    setCiAutosaveStatus("Save failed", "error");
    if (!quiet) renderCiAdmin();
    return false;
  }

  mergeCiLineRecord(result.data);
  const savedId = result.data?.id || id;
  if (quiet) {
    setCiAutosaveStatus("Saved", "saved");
    refreshCiLineMasterList();
  } else {
    ciMessage = "Cruise line saved.";
    ciMessageTone = "success";
    ciLineCreating = false;
    editingCiLineId = savedId || null;
    ciAutosaveStatus = "Saved";
    renderCiAdmin();
  }
  return true;
}

async function saveCiLine() {
  captureCiMasterScroll();
  await persistCiLine({ quiet: false });
}

function renderCiShipsSection() {
  const filtered = getFilteredCiShips();
  const lineOptions = ciCruiseLines
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((line) => `<option value="${esc(line.id)}" ${ciShipLineFilter === line.id ? "selected" : ""}>${esc(line.name)}</option>`)
    .join("");
  const selectedShip = ciShipCreating
    ? null
    : (editingCiShipId ? ciCruiseShips.find((s) => s.id === editingCiShipId) : null);
  const showDetail = ciShipCreating || Boolean(selectedShip);

  return `
    <div class="ci-toolbar">
      <div class="ci-toolbar-controls">
        <input type="search" value="${esc(ciShipSearchQuery)}" placeholder="Search ships…" oninput="updateCiShipSearch(this.value)">
        <select onchange="updateCiShipLineFilter(this.value)">
          <option value="all">All cruise lines</option>
          ${lineOptions}
        </select>
        <select onchange="updateCiShipStatusFilter(this.value)">
          <option value="all" ${ciShipStatusFilter === "all" ? "selected" : ""}>All statuses</option>
          <option value="active" ${ciShipStatusFilter === "active" ? "selected" : ""}>active</option>
          <option value="under_construction" ${ciShipStatusFilter === "under_construction" ? "selected" : ""}>under_construction</option>
        </select>
        <button class="admin-button black small" onclick="startCiShipCreate()">Add ship</button>
      </div>
      <div class="admin-small"><span id="ciShipListCount">${filtered.length} of ${ciCruiseShips.length}</span> ships</div>
    </div>
    <div class="ci-master-detail">
      <aside class="ci-master" aria-label="Ships">
        <div class="ci-master-header">
          <span>Ships</span>
        </div>
        <div class="ci-master-list" id="ciShipMasterList">
          ${filtered.length
            ? filtered.map(renderCiShipMasterRow).join("")
            : `<p class="admin-small ci-master-empty">No ships match these filters.</p>`}
        </div>
      </aside>
      <section class="ci-detail" aria-label="Ship details">
        ${showDetail
          ? renderCiShipForm(selectedShip)
          : `<div class="ci-detail-empty"><p class="admin-muted" style="margin:0;">Select a ship to view and edit details.</p></div>`}
      </section>
    </div>
  `;
}

function renderCiShipMasterRow(ship) {
  const selected = !ciShipCreating && editingCiShipId === ship.id;
  const meta = [
    ship.ci_cruise_lines?.name || "Unknown line",
    ship.active ? null : "Inactive",
    ship.status && ship.status !== "active" ? ship.status : null
  ].filter(Boolean).join(" · ");

  return `
    <button type="button" class="ci-master-row ${selected ? "is-selected" : ""}" onclick="selectCiShip('${esc(ship.id)}')">
      <span class="ci-master-row-title">${esc(ship.name)}</span>
      <span class="ci-master-row-meta">${esc(meta)}</span>
    </button>
  `;
}

function readCiFacility(ship, key) {
  const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  return facilities[key];
}

function renderCiShipForm(ship) {
  const editing = Boolean(ship);
  const lineOptions = ciCruiseLines
    .map((line) => `<option value="${esc(line.id)}" ${ship?.cruise_line_id === line.id ? "selected" : ""}>${esc(line.name)}</option>`)
    .join("");
  const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  const slugReadonly = editing ? `readonly class="ci-id-readonly" aria-readonly="true"` : `placeholder="auto from name if blank"`;
  const statusClass = ciAutosaveStatus
    ? (ciMessageTone === "error" ? "is-error" : ciAutosaveStatus === "Saving…" ? "is-saving" : "is-saved")
    : "";

  return `
    <div>
      <div class="ci-detail-title-row">
        <h3 class="ci-detail-title">${editing ? esc(ship.name) : "New ship"}</h3>
        ${editing ? `<span id="ciAutosaveStatus" class="ci-autosave-status ${statusClass}">${esc(ciAutosaveStatus)}</span>` : ""}
      </div>
      <p class="admin-small ci-detail-subtitle">${editing ? "Changes save when you select another ship." : "Fill in the details, then create."}</p>
      ${renderCiMediaField({
        kind: "ship",
        inputId: "ciShipHero",
        url: ship?.hero_image_url || "",
        previewClass: "admin-hero-preview",
        title: "Hero Image"
      })}
      <input type="hidden" id="ciShipId" value="${esc(ship?.id || "")}">
      <div class="ci-form-grid">
        <div class="admin-field"><label>Cruise line</label><select id="ciShipLineId"><option value="">Select…</option>${lineOptions}</select></div>
        <div class="admin-field"><label>Name</label><input id="ciShipName" value="${esc(ship?.name || "")}"></div>
        <div class="admin-field"><label>Slug</label><input id="ciShipSlug" value="${esc(ship?.slug || "")}" ${slugReadonly}></div>
        <div class="admin-field"><label>Status</label>
          <select id="ciShipStatus">
            <option value="active" ${ship?.status === "active" || !ship?.status ? "selected" : ""}>active</option>
            <option value="under_construction" ${ship?.status === "under_construction" ? "selected" : ""}>under_construction</option>
            <option value="retired" ${ship?.status === "retired" ? "selected" : ""}>retired</option>
          </select>
        </div>
        <div class="admin-field"><label>Year built</label><input id="ciShipBuilt" type="number" value="${esc(ship?.year_built ?? "")}"></div>
        <div class="admin-field"><label>Year refurbished</label><input id="ciShipRefurb" type="number" value="${esc(ship?.year_refurbished ?? "")}"></div>
        <div class="admin-field"><label>Passengers</label><input id="ciShipPassengers" type="number" value="${esc(ship?.passenger_capacity ?? "")}"></div>
        <div class="admin-field"><label>Crew</label><input id="ciShipCrew" type="number" value="${esc(ship?.crew_count ?? "")}"></div>
        <div class="admin-field"><label>Decks</label><input id="ciShipDecks" type="number" value="${esc(ship?.deck_count ?? "")}"></div>
        <div class="admin-field"><label>Total Staterooms</label><input id="ciShipStaterooms" type="number" value="${esc(ship?.stateroom_count ?? "")}" oninput="updateCiStateroomTotals()"></div>
        <div class="admin-field"><label>Gross tonnage</label><input id="ciShipTonnage" type="number" value="${esc(ship?.gross_tonnage ?? "")}"></div>
        <div class="admin-field"><label>Length (metres)</label><input id="ciShipLength" type="number" value="${esc(ship?.length_metres ?? "")}"></div>
      </div>
      ${renderCiStateroomEditor(ship)}
      <p class="admin-small ci-form-note">Active ships on a sold cruise line are public automatically.${editing ? " Slug stays fixed after creation." : ""}</p>
      <div class="ci-section-heading">
        <h4>Facilities</h4>
        ${editing ? `<button type="button" class="admin-button secondary small" onclick="toggleCiFacilitiesCopyPanel()">Copy</button>` : ""}
      </div>
      <div id="ciFacilitiesCopyPanel" class="ci-facilities-copy-panel" hidden></div>
      <div class="ci-form-grid">
        <div class="admin-field"><label>Dining Options</label><input id="ciFacRestaurants" type="number" value="${esc(facilities.restaurants ?? "")}"></div>
        <div class="admin-field"><label>Specialty Dining</label><input id="ciFacSpecialtyDining" type="number" value="${esc(facilities.specialty_dining ?? "")}"></div>
        <div class="admin-field"><label>Bars</label><input id="ciFacBars" type="number" value="${esc(facilities.bars ?? "")}"></div>
        <div class="admin-field"><label>Pools</label><input id="ciFacPools" type="number" value="${esc(facilities.pools ?? "")}"></div>
        <div class="admin-field"><label>Hot tubs</label><input id="ciFacHotTubs" type="number" value="${esc(facilities.hot_tubs ?? "")}"></div>
      </div>
      <div class="ci-checkbox-row">
        <label class="ci-check-control"><input type="checkbox" id="ciShipActive" ${ship?.active !== false ? "checked" : ""}> Active</label>
        <label class="ci-check-control"><input type="checkbox" id="ciFacSpa" ${facilities.spa === true ? "checked" : ""}> Spa</label>
        <label class="ci-check-control"><input type="checkbox" id="ciFacGym" ${facilities.gym === true || facilities.fitness === true ? "checked" : ""}> Gym</label>
        <label class="ci-check-control"><input type="checkbox" id="ciFacTheatre" ${facilities.theatre === true || facilities.theater === true ? "checked" : ""}> Theatre</label>
        <label class="ci-check-control"><input type="checkbox" id="ciFacCasino" ${facilities.casino === true ? "checked" : ""}> Casino</label>
        <label class="ci-check-control"><input type="checkbox" id="ciFacKids" ${facilities.kids_club === true ? "checked" : ""}> Kids club</label>
      </div>
      <div class="ci-form-grid" style="margin-top:8px;">
        <div class="admin-field" style="grid-column: span 2;"><label>Specialty features (comma separated)</label><input id="ciFacSpecialty" value="${esc(Array.isArray(facilities.specialty_features) ? facilities.specialty_features.join(", ") : "")}"></div>
        <div class="admin-field" style="grid-column: span 2;"><label>Exclusive areas (comma separated)</label><input id="ciFacExclusive" value="${esc(Array.isArray(facilities.exclusive_areas) ? facilities.exclusive_areas.join(", ") : "")}"></div>
      </div>
      ${ciShipCreating ? `
        <div class="admin-actions-row">
          <button class="admin-button" onclick="saveCiShip()">Create ship</button>
          <button class="admin-button secondary" onclick="cancelCiShipForm()">Cancel</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function startCiShipCreate() {
  const ok = await flushCiCurrentForm();
  if (!ok) return;
  editingCiShipId = null;
  ciShipCreating = true;
  ciAutosaveStatus = "";
  renderCiAdmin();
}

async function selectCiShip(id) {
  if (!ciShipCreating && editingCiShipId === id) return;
  captureCiMasterScroll();
  if (!ciShipCreating) {
    const ok = await flushCiCurrentForm();
    if (!ok) {
      restoreCiMasterScroll();
      return;
    }
  }
  editingCiShipId = id;
  ciShipCreating = false;
  ciAutosaveStatus = "";
  ciMessage = "";
  renderCiAdmin();
}

function cancelCiShipForm() {
  editingCiShipId = null;
  ciShipCreating = false;
  ciAutosaveStatus = "";
  renderCiAdmin();
}

function ciOptionalNumber(id) {
  const raw = String(document.getElementById(id)?.value || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function ciCheckboxBool(id) {
  return Boolean(document.getElementById(id)?.checked);
}

function ciChipList(id) {
  return String(document.getElementById(id)?.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readCiFacilitiesFromDom(existingFacilities) {
  const facilities = {
    ...(existingFacilities && typeof existingFacilities === "object" ? existingFacilities : {})
  };
  const restaurants = ciOptionalNumber("ciFacRestaurants");
  const specialtyDining = ciOptionalNumber("ciFacSpecialtyDining");
  const bars = ciOptionalNumber("ciFacBars");
  const pools = ciOptionalNumber("ciFacPools");
  const hotTubs = ciOptionalNumber("ciFacHotTubs");
  if (restaurants != null) facilities.restaurants = restaurants;
  else delete facilities.restaurants;
  if (specialtyDining != null) facilities.specialty_dining = specialtyDining;
  else delete facilities.specialty_dining;
  if (bars != null) facilities.bars = bars;
  else delete facilities.bars;
  if (pools != null) facilities.pools = pools;
  else delete facilities.pools;
  if (hotTubs != null) facilities.hot_tubs = hotTubs;
  else delete facilities.hot_tubs;
  facilities.spa = ciCheckboxBool("ciFacSpa");
  facilities.gym = ciCheckboxBool("ciFacGym");
  facilities.theatre = ciCheckboxBool("ciFacTheatre");
  facilities.casino = ciCheckboxBool("ciFacCasino");
  facilities.kids_club = ciCheckboxBool("ciFacKids");
  delete facilities.fitness;
  delete facilities.theater;
  const specialty = ciChipList("ciFacSpecialty");
  const exclusive = ciChipList("ciFacExclusive");
  if (specialty.length) facilities.specialty_features = specialty;
  else delete facilities.specialty_features;
  if (exclusive.length) facilities.exclusive_areas = exclusive;
  else delete facilities.exclusive_areas;
  return facilities;
}

function getCiFacilitiesCopyTargets() {
  const currentId = document.getElementById("ciShipId")?.value || editingCiShipId;
  const lineId = document.getElementById("ciShipLineId")?.value
    || ciCruiseShips.find((s) => s.id === currentId)?.cruise_line_id;
  if (!lineId) return [];
  return (ciCruiseShips || [])
    .filter((ship) => ship.cruise_line_id === lineId && ship.id !== currentId)
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
}

function toggleCiFacilitiesCopyPanel() {
  const panel = document.getElementById("ciFacilitiesCopyPanel");
  if (!panel) return;
  if (!panel.hidden) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const targets = getCiFacilitiesCopyTargets();
  if (!targets.length) {
    panel.hidden = false;
    panel.innerHTML = `
      <p class="admin-small">No other ships on this cruise line to copy to.</p>
      <div class="admin-actions-row">
        <button type="button" class="admin-button secondary small" onclick="toggleCiFacilitiesCopyPanel()">Close</button>
      </div>
    `;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `
    <p class="admin-small">Copy this ship's facilities to selected ships on the same cruise line. Current form values are used (including unsaved edits).</p>
    <div class="ci-facilities-copy-toolbar">
      <label class="ci-check-control"><input type="checkbox" id="ciFacCopySelectAll" onchange="toggleCiFacilitiesCopySelectAll(this.checked)"> Select all</label>
      <span class="admin-small" id="ciFacCopyStatus"></span>
    </div>
    <div class="ci-facilities-copy-list">
      ${targets.map((ship) => `
        <label class="ci-check-control ci-facilities-copy-item">
          <input type="checkbox" class="ci-fac-copy-target" value="${esc(ship.id)}">
          <span>${esc(ship.name || "Untitled")}${ship.active === false ? " <span class=\"admin-small\">(inactive)</span>" : ""}</span>
        </label>
      `).join("")}
    </div>
    <div class="admin-actions-row">
      <button type="button" class="admin-button small" id="ciFacCopyApplyBtn" onclick="copyCiFacilitiesToSelectedShips()">Copy facilities</button>
      <button type="button" class="admin-button secondary small" onclick="toggleCiFacilitiesCopyPanel()">Cancel</button>
    </div>
  `;
}

function toggleCiFacilitiesCopySelectAll(checked) {
  document.querySelectorAll(".ci-fac-copy-target").forEach((el) => {
    el.checked = Boolean(checked);
  });
}

async function copyCiFacilitiesToSelectedShips() {
  const selected = [...document.querySelectorAll(".ci-fac-copy-target:checked")]
    .map((el) => el.value)
    .filter(Boolean);
  const statusEl = document.getElementById("ciFacCopyStatus");
  const applyBtn = document.getElementById("ciFacCopyApplyBtn");
  if (!selected.length) {
    if (statusEl) statusEl.textContent = "Select at least one ship.";
    return;
  }

  const currentId = document.getElementById("ciShipId")?.value || editingCiShipId;
  const existing = currentId ? ciCruiseShips.find((s) => s.id === currentId) : null;
  const facilities = readCiFacilitiesFromDom(existing?.facilities);

  if (applyBtn) applyBtn.disabled = true;
  if (statusEl) statusEl.textContent = `Copying to ${selected.length} ship${selected.length === 1 ? "" : "s"}…`;

  // Persist current ship first so source matches what we copy.
  if (currentId && !ciShipCreating) {
    const saved = await persistCiShip({ quiet: true });
    if (!saved) {
      if (statusEl) statusEl.textContent = "Could not save current ship first.";
      if (applyBtn) applyBtn.disabled = false;
      return;
    }
  }

  const results = await Promise.all(selected.map(async (id) => {
    const result = await supabaseClient
      .from("ci_cruise_ships")
      .update({ facilities })
      .eq("id", id)
      .select("id, facilities, name, cruise_line_id, active, slug, status")
      .single();
    return { id, result };
  }));

  const failed = results.filter((r) => r.result.error);
  results.forEach(({ result }) => {
    if (result.data) mergeCiShipRecord(result.data);
  });

  if (failed.length) {
    if (statusEl) {
      statusEl.textContent = `Copied with ${failed.length} error${failed.length === 1 ? "" : "s"}.`;
    }
    setCiAutosaveStatus("Facilities copy partial", "error");
    if (applyBtn) applyBtn.disabled = false;
    return;
  }

  if (statusEl) statusEl.textContent = `Copied to ${selected.length} ship${selected.length === 1 ? "" : "s"}.`;
  setCiAutosaveStatus("Facilities copied", "saved");
  refreshCiShipMasterList();
  if (applyBtn) applyBtn.disabled = false;
  const panel = document.getElementById("ciFacilitiesCopyPanel");
  if (panel) {
    window.setTimeout(() => {
      if (panel && !panel.hidden) toggleCiFacilitiesCopyPanel();
    }, 900);
  }
}

function mergeCiShipRecord(saved) {
  if (!saved?.id) return;
  const idx = ciCruiseShips.findIndex((s) => s.id === saved.id);
  if (idx >= 0) {
    const prev = ciCruiseShips[idx];
    ciCruiseShips[idx] = {
      ...prev,
      ...saved,
      ci_cruise_lines: saved.ci_cruise_lines || prev.ci_cruise_lines
    };
  } else {
    ciCruiseShips.push(saved);
  }
}

async function persistCiShip({ quiet = false } = {}) {
  if (ciSaving) return false;
  const id = document.getElementById("ciShipId")?.value || "";
  const cruiseLineId = String(document.getElementById("ciShipLineId")?.value || "").trim();
  const name = String(document.getElementById("ciShipName")?.value || "").trim();
  let slug = String(document.getElementById("ciShipSlug")?.value || "").trim();

  if (!cruiseLineId || !name) {
    ciMessage = "Cruise line and ship name are required.";
    ciMessageTone = "error";
    setCiAutosaveStatus("Line and name required", "error");
    if (!quiet) renderCiAdmin();
    return false;
  }
  if (!slug) slug = slugifyCi(name);

  const existing = id ? ciCruiseShips.find((s) => s.id === id) : null;
  const facilities = readCiFacilitiesFromDom(existing?.facilities);

  const payload = {
    cruise_line_id: cruiseLineId,
    name,
    status: String(document.getElementById("ciShipStatus")?.value || "active"),
    year_built: ciOptionalNumber("ciShipBuilt"),
    year_refurbished: ciOptionalNumber("ciShipRefurb"),
    passenger_capacity: ciOptionalNumber("ciShipPassengers"),
    crew_count: ciOptionalNumber("ciShipCrew"),
    deck_count: ciOptionalNumber("ciShipDecks"),
    stateroom_count: ciOptionalNumber("ciShipStaterooms"),
    gross_tonnage: ciOptionalNumber("ciShipTonnage"),
    length_metres: ciOptionalNumber("ciShipLength"),
    facilities,
    active: ciCheckboxBool("ciShipActive")
  };
  const breakdown = readCiStateroomBreakdownFromDom();
  if (breakdown) {
    payload.stateroom_breakdown = sortStateroomCategoryRows(
      breakdown
        .filter((row) => row.label && row.count != null)
        .map((row) => ({ label: row.label, count: row.count }))
    );
  }
  if (!existing) {
    payload.slug = slug;
    payload.source_name = "Admin";
  }

  ciSaving = true;
  if (quiet) setCiAutosaveStatus("Saving…", "saving");
  else {
    ciMessage = "Saving…";
    ciMessageTone = "running";
  }

  const selectCols = "*, ci_cruise_lines(id, name, slug)";
  let result;
  try {
    if (id) {
      result = await supabaseClient.from("ci_cruise_ships").update(payload).eq("id", id).select(selectCols).single();
    } else {
      result = await supabaseClient.from("ci_cruise_ships").insert(payload).select(selectCols).single();
    }
  } finally {
    ciSaving = false;
  }

  if (result.error) {
    ciMessage = result.error.message;
    ciMessageTone = "error";
    setCiAutosaveStatus("Save failed", "error");
    if (!quiet) renderCiAdmin();
    return false;
  }

  mergeCiShipRecord(result.data);
  const savedId = result.data?.id || id;
  if (quiet) {
    setCiAutosaveStatus("Saved", "saved");
    refreshCiShipMasterList();
  } else {
    ciMessage = "Ship saved.";
    ciMessageTone = "success";
    ciShipCreating = false;
    editingCiShipId = savedId || null;
    ciAutosaveStatus = "Saved";
    renderCiAdmin();
  }
  return true;
}

async function saveCiShip() {
  captureCiMasterScroll();
  await persistCiShip({ quiet: false });
}

/* =========================================================
   Featured Cruises — Sprint 9 workflow refinement
   No public exposure, newsletters, route maps, or Mailchimp.
   ========================================================= */

/* Publication Status is the single lifecycle control:
   Draft = work in progress; Published = approved for campaign/public outputs;
   Archived = retained historically but removed from the default working list. */

function featuredStatusLabel(status) {
  const value = String(status || "draft");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function featuredSlugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function suggestFeaturedSlug({ headline, shipName, departureDate }) {
  return featuredSlugify([headline, shipName, departureDate].filter(Boolean).join(" "));
}

/** Calendar-date arithmetic without UTC shift. */
function addCalendarDays(dateStr, nights) {
  if (!dateStr || nights == null || !Number.isFinite(Number(nights))) return "";
  const n = Number(nights);
  if (n < 1) return "";
  const parts = String(dateStr).split("-").map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return "";
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildFeaturedDestinationStrip(departurePort, arrivalPort) {
  const dep = String(departurePort || "").trim().toUpperCase();
  const arr = String(arrivalPort || "").trim().toUpperCase();
  if (dep && arr) return `${dep} TO ${arr}`;
  if (dep) return dep;
  if (arr) return arr;
  return null;
}

function formatFeaturedMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 }).format(Math.round(num));
}

function parseOptionalPrice(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    const error = new Error("Prices must be blank or a non-negative number.");
    error.code = "INVALID_PRICE";
    throw error;
  }
  return num;
}

function activeCiLinesForFeatured() {
  return [...ciCruiseLines]
    .filter((line) => line.active !== false)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "en"));
}

function shipsForFeaturedLine(lineId) {
  if (!lineId) return [];
  return [...ciCruiseShips]
    .filter((ship) => ship.cruise_line_id === lineId && ship.active !== false)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "en"));
}

function findFeaturedCruise(id) {
  return featuredCruises.find((row) => row.id === id) || null;
}

function sortFeaturedCruises(rows) {
  return [...rows].sort((a, b) => {
    const aDate = a.newsletter_publication_date || "";
    const bDate = b.newsletter_publication_date || "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    const order = Number(a.display_order || 0) - Number(b.display_order || 0);
    if (order) return order;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
}

function filteredFeaturedCruises() {
  const query = featuredCruiseSearchQuery.trim().toLowerCase();
  return sortFeaturedCruises(featuredCruises).filter((row) => {
    const status = row.publication_status || "draft";
    if (featuredCruiseStatusFilter === "all") {
      if (status === "archived") return false;
    } else if (status !== featuredCruiseStatusFilter) {
      return false;
    }
    if (!query) return true;
    const haystack = [
      row.headline,
      row.destination_strip,
      row.departure_port,
      row.arrival_port,
      row.ci_cruise_lines?.name,
      row.ci_cruise_ships?.name,
      row.public_slug,
      row.newsletter_number != null ? `newsletter ${row.newsletter_number}` : ""
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function displayDestinationStrip(row) {
  if (row.destination_strip) return row.destination_strip;
  return buildFeaturedDestinationStrip(row.departure_port, row.arrival_port) || "";
}

async function ensureFeaturedCruisesLoaded() {
  featuredCruiseLoading = true;
  renderAdmin();
  try {
    if (!ciCruiseLines.length || !ciCruiseShips.length) {
      await loadCruiseIntelligenceData({ quiet: true });
    }
    await loadFeaturedCruises();
    await loadFeaturedRoomTypes();
    try {
      await loadFeaturedNewsletterDefaults();
    } catch (_defaultsError) {
      featuredNewsletterDefaults = { newsletter_number: null, newsletter_publication_date: null };
      // Defaults are only required when creating a new cruise; list view can still open.
    }
  } catch (error) {
    featuredCruiseMessage = error.message || "Could not load newsletter cruises.";
    featuredCruiseMessageTone = "error";
  } finally {
    featuredCruiseLoading = false;
    renderAdmin();
  }
}

async function loadCruiseIntelligenceData({ quiet = false } = {}) {
  const [linesResult, shipsResult] = await Promise.all([
    supabaseClient.from("ci_cruise_lines").select("id,name,active,sold_by_101cruise").order("name", { ascending: true }),
    supabaseClient.from("ci_cruise_ships").select("id,name,cruise_line_id,hero_image_url,active").order("name", { ascending: true })
  ]);
  if (linesResult.error) throw new Error(linesResult.error.message);
  if (shipsResult.error) throw new Error(shipsResult.error.message);
  ciCruiseLines = linesResult.data || [];
  ciCruiseShips = shipsResult.data || [];
  if (!quiet && activeTab === "cruise-intelligence") renderCiAdmin();
}

async function loadFeaturedCruises() {
  const { data, error } = await supabaseClient
    .from("featured_cruises")
    .select("*, ci_cruise_lines(id,name), ci_cruise_ships(id,name,hero_image_url)")
    .order("newsletter_publication_date", { ascending: false, nullsFirst: false })
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  featuredCruises = data || [];
}

async function loadFeaturedRoomTypes() {
  const { data, error } = await supabaseClient
    .from("featured_cruise_room_types")
    .select("id,name,sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) {
    console.warn("Featured room types load skipped", error.message);
    featuredCruiseRoomTypes = [
      { name: "Inside" },
      { name: "Oceanview" },
      { name: "Balcony" },
      { name: "Concierge Class" },
      { name: "Aqua Class" },
      { name: "Suite" }
    ];
    return;
  }
  featuredCruiseRoomTypes = data || [];
}

async function loadFeaturedNewsletterDefaults() {
  const { data, error } = await supabaseClient
    .from("featured_cruise_newsletter_defaults")
    .select("newsletter_number,newsletter_publication_date")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    featuredNewsletterDefaults = { newsletter_number: null, newsletter_publication_date: null };
    const err = new Error(error.message || "Could not load newsletter defaults.");
    err.code = "NEWSLETTER_DEFAULTS";
    throw err;
  }
  featuredNewsletterDefaults = {
    newsletter_number: data?.newsletter_number ?? null,
    newsletter_publication_date: data?.newsletter_publication_date || null
  };
}

function blankFeaturedPricing(displayOrder = 1) {
  return {
    id: null,
    local_id: `price-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    room_label: "",
    category: "",
    brochure_price: "",
    cruise_101_price: "",
    airline_price: "",
    // Pricing display_order controls the order used by newsletters, landing pages and future customer-facing outputs.
    display_order: displayOrder
  };
}

function mapPricingRowFromDb(row, index) {
  return {
    id: row.id || null,
    local_id: row.id || `price-${index}`,
    room_label: row.room_label || "",
    // Category is internal operational information and must never appear in
    // newsletters, public pages, social media graphics or other customer-facing output.
    category: row.category || "",
    brochure_price: row.brochure_price == null ? "" : String(row.brochure_price),
    cruise_101_price: row.cruise_101_price == null ? "" : String(row.cruise_101_price),
    airline_price: row.airline_price == null ? "" : String(row.airline_price),
    // Pricing display_order controls the order used by newsletters, landing pages and future customer-facing outputs.
    display_order: Number(row.display_order) || 0
  };
}

/** Normalise NULL/0/duplicate orders into 1..n without changing visual sequence. */
function normalizeFeaturedPricingOrder(rows) {
  return (rows || []).map((row, index) => ({
    ...row,
    display_order: index + 1
  }));
}

function renumberFeaturedPricingOrders() {
  featuredFormPricing = normalizeFeaturedPricingOrder(featuredFormPricing);
}

function blankFeaturedOfferInclusions() {
  return {
    alcohol_package: false,
    wifi: false,
    gratuities: false,
    all_tours: false,
    all_dining: false,
    laundry: false,
    onboard_credit: ""
  };
}

/** Offer inclusions belong on the Featured Cruise parent, not pricing rows. */
function offerInclusionsFromCruise(existing, pricingRows = []) {
  const parent = {
    alcohol_package: Boolean(existing?.alcohol_package),
    wifi: Boolean(existing?.wifi),
    gratuities: Boolean(existing?.gratuities),
    all_tours: Boolean(existing?.all_tours),
    all_dining: Boolean(existing?.all_dining),
    laundry: Boolean(existing?.laundry),
    onboard_credit: existing?.onboard_credit == null ? "" : String(existing.onboard_credit)
  };
  const parentHas =
    parent.alcohol_package ||
    parent.wifi ||
    parent.gratuities ||
    parent.all_tours ||
    parent.all_dining ||
    parent.laundry ||
    parent.onboard_credit !== "";
  if (parentHas) return parent;

  // One-time display fallback for records saved before offer-level inclusions existed.
  const legacy = (pricingRows || []).find(
    (row) =>
      row.alcohol_package ||
      row.wifi ||
      row.gratuities ||
      row.all_tours ||
      row.all_dining ||
      row.laundry ||
      row.onboard_credit != null
  );
  if (!legacy) return parent;
  return {
    alcohol_package: Boolean(legacy.alcohol_package),
    wifi: Boolean(legacy.wifi),
    gratuities: Boolean(legacy.gratuities),
    all_tours: Boolean(legacy.all_tours),
    all_dining: Boolean(legacy.all_dining),
    laundry: Boolean(legacy.laundry),
    onboard_credit: legacy.onboard_credit == null ? "" : String(legacy.onboard_credit)
  };
}

async function startNewFeaturedCruise() {
  editingFeaturedCruiseId = null;
  showFeaturedCruiseForm = true;
  featuredSlugManuallyEdited = false;
  featuredFormPricing = [blankFeaturedPricing(1)];
  featuredItineraryFallback = "";
  featuredRoomTypePromptIndex = null;
  draggedFeaturedPricingLocalId = null;
  featuredPricingDragFromHandle = false;
  featuredCruiseMessage = "";
  featuredCruiseMessageTone = "";
  try {
    await loadFeaturedNewsletterDefaults();
  } catch (_error) {
    featuredNewsletterDefaults = { newsletter_number: null, newsletter_publication_date: null };
    featuredCruiseMessage = "Newsletter defaults could not be loaded. Enter Newsletter Number and Publication Date manually.";
    featuredCruiseMessageTone = "error";
  }
  featuredFormDraft = {
    newsletter_number: featuredNewsletterDefaults.newsletter_number,
    newsletter_publication_date: featuredNewsletterDefaults.newsletter_publication_date,
    publication_status: "draft",
    public_slug: "",
    create_public_page: false,
    headline: "",
    departure_port: "",
    arrival_port: "",
    cruise_line_id: "",
    cruise_ship_id: "",
    departure_date: "",
    nights: "",
    return_date: "",
    short_editorial: "",
    full_description: "",
    use_ship_hero_image: true,
    hero_image_url: "",
    hero_image_alt: "",
    hero_media_id: null,
    hero_media: null,
    route_map_image_url: "",
    route_map_media_id: null,
    route_map_media: null,
    itinerary_summary: "",
    other_information: "",
    display_order: 0,
    ...blankFeaturedOfferInclusions()
  };
  featuredNewsletterDefaultsBaseline = {
    newsletter_number: featuredFormDraft.newsletter_number,
    newsletter_publication_date: featuredFormDraft.newsletter_publication_date
  };
  renderAdmin();
}

async function fetchMediaLibraryRow(id) {
  if (!id) return null;
  const cached = window.MediaLibraryAdmin?.findById?.(id);
  if (cached) return cached;
  const { data, error } = await supabaseClient
    .from("media_library")
    .select("id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active,tags,file_name,mime_type")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.warn("media_library fetch skipped", error.message);
    return null;
  }
  return data || null;
}

async function editFeaturedCruise(id) {
  featuredCruiseLoading = true;
  featuredCruiseMessage = "";
  featuredCruiseMessageTone = "";
  renderAdmin();
  try {
    // Always re-read the cruise row so hero_media_id / route_map_media_id are current.
    const { data: existing, error: cruiseError } = await supabaseClient
      .from("featured_cruises")
      .select("*, ci_cruise_lines(id,name), ci_cruise_ships(id,name,hero_image_url)")
      .eq("id", id)
      .maybeSingle();
    if (cruiseError) throw new Error(cruiseError.message);
    if (!existing) throw new Error("Featured cruise not found.");

    if (window.MediaLibraryAdmin?.ensureLoaded) {
      await window.MediaLibraryAdmin.ensureLoaded({ quiet: true });
    }

    const { data: pricing, error: pricingError } = await supabaseClient
      .from("featured_cruise_pricing")
      .select("*")
      .eq("featured_cruise_id", id)
      .order("display_order", { ascending: true });
    if (pricingError) throw new Error(pricingError.message);

    featuredCruisePricing = pricing || [];
    featuredFormPricing = normalizeFeaturedPricingOrder((pricing || []).map(mapPricingRowFromDb));
    if (!featuredFormPricing.length) featuredFormPricing = [blankFeaturedPricing(1)];

    // The manually entered itinerary_summary is the approved source for newsletter output.
    // featured_cruise_ports is reserved for future automatically sourced day-by-day itinerary data,
    // including dates and arrival/departure times.
    featuredItineraryFallback = "";
    let itinerarySummary = existing.itinerary_summary || "";
    if (!itinerarySummary) {
      const { data: ports } = await supabaseClient
        .from("featured_cruise_ports")
        .select("port_name,display_order")
        .eq("featured_cruise_id", id)
        .order("display_order", { ascending: true });
      if (ports?.length) {
        featuredItineraryFallback = ports.map((p) => p.port_name).filter(Boolean).join(" | ");
        itinerarySummary = featuredItineraryFallback;
      }
    }

    const [heroMedia, routeMapMedia] = await Promise.all([
      fetchMediaLibraryRow(existing.hero_media_id),
      fetchMediaLibraryRow(existing.route_map_media_id)
    ]);

    const nights = existing.nights != null ? Number(existing.nights) : null;
    const departure = existing.departure_date || "";
    editingFeaturedCruiseId = id;
    showFeaturedCruiseForm = true;
    featuredSlugManuallyEdited = Boolean(existing.public_slug);
    featuredRoomTypePromptIndex = null;
    featuredFormDraft = {
      newsletter_number: existing.newsletter_number,
      newsletter_publication_date: existing.newsletter_publication_date || "",
      publication_status: existing.publication_status || "draft",
      public_slug: existing.public_slug || "",
      create_public_page: Boolean(existing.create_public_page),
      headline: existing.headline || "",
      departure_port: existing.departure_port || "",
      arrival_port: existing.arrival_port || "",
      cruise_line_id: existing.cruise_line_id || "",
      cruise_ship_id: existing.cruise_ship_id || "",
      departure_date: departure,
      nights: nights != null && Number.isFinite(nights) ? String(nights) : "",
      return_date: departure && nights ? addCalendarDays(departure, nights) : existing.return_date || "",
      short_editorial: existing.short_editorial || "",
      full_description: existing.full_description || "",
      use_ship_hero_image: existing.use_ship_hero_image !== false,
      hero_image_url: existing.hero_image_url || "",
      hero_image_alt: existing.hero_image_alt || "",
      hero_media_id: existing.hero_media_id || null,
      hero_media: heroMedia,
      route_map_image_url: existing.route_map_image_url || "",
      route_map_media_id: existing.route_map_media_id || null,
      route_map_media: routeMapMedia,
      itinerary_summary: itinerarySummary,
      other_information: existing.other_information || "",
      display_order: existing.display_order ?? 0,
      ...offerInclusionsFromCruise(existing, pricing || [])
    };
    featuredNewsletterDefaultsBaseline = {
      newsletter_number: featuredFormDraft.newsletter_number,
      newsletter_publication_date: featuredFormDraft.newsletter_publication_date
    };

    // Keep list cache in sync for subsequent opens.
    const listIndex = featuredCruises.findIndex((row) => row.id === id);
    if (listIndex >= 0) featuredCruises[listIndex] = { ...featuredCruises[listIndex], ...existing };
    else featuredCruises.unshift(existing);
  } catch (error) {
    featuredCruiseMessage = error.message || "Could not open this cruise.";
    featuredCruiseMessageTone = "error";
    showFeaturedCruiseForm = false;
  } finally {
    featuredCruiseLoading = false;
    renderAdmin();
  }
}

function cancelFeaturedCruiseForm() {
  showFeaturedCruiseForm = false;
  editingFeaturedCruiseId = null;
  featuredFormPricing = [];
  featuredFormDraft = null;
  featuredSlugManuallyEdited = false;
  featuredRoomTypePromptIndex = null;
  draggedFeaturedPricingLocalId = null;
  featuredPricingDragFromHandle = false;
  showFeaturedNewsletterPreview = false;
  featuredCruiseMessage = "";
  featuredCruiseMessageTone = "";
  renderAdmin();
}

function featuredMediaLibraryItems() {
  return window.MediaLibraryAdmin?.getMediaItems?.() || [];
}

function resolveFeaturedCruiseImages(draft = featuredFormDraft || {}) {
  const ship = ciCruiseShips.find((row) => row.id === draft.cruise_ship_id) || null;
  const mediaLibrary = featuredMediaLibraryItems();
  const heroMedia =
    draft.hero_media ||
    (draft.hero_media_id ? window.MediaLibraryAdmin?.findById?.(draft.hero_media_id) || null : null);
  const routeMapMedia =
    draft.route_map_media ||
    (draft.route_map_media_id
      ? window.MediaLibraryAdmin?.findById?.(draft.route_map_media_id) || null
      : null);
  if (!window.MediaResolver) {
    const heroUrl = heroMedia?.public_url || draft.hero_image_url || ship?.hero_image_url || "";
    return {
      hero: heroUrl
        ? {
            url: heroUrl,
            altText: draft.hero_image_alt || heroMedia?.alt_text || "",
            source: heroMedia
              ? "Featured Cruise Media Library selection"
              : draft.hero_image_url
                ? "Legacy Featured Cruise image URL"
                : "Legacy Cruise Intelligence image"
          }
        : null,
      routeMap: (routeMapMedia?.public_url || draft.route_map_image_url)
        ? {
            url: routeMapMedia?.public_url || draft.route_map_image_url,
            altText: routeMapMedia?.alt_text || "Route map",
            source: routeMapMedia
              ? "Featured Cruise Media Library selection"
              : "Legacy route map URL"
          }
        : null
    };
  }
  return window.MediaResolver.resolveCruiseImages(draft, {
    mediaLibrary,
    ship,
    heroMedia,
    routeMapMedia
  });
}

function resolveFeaturedHeroPreviewUrl(draft) {
  return resolveFeaturedCruiseImages(draft).hero?.url || "";
}

function featuredDestinationHints(draft = featuredFormDraft || {}) {
  const ports = String(draft.itinerary_summary || "")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  return [draft.departure_port, draft.arrival_port, ...ports].filter(Boolean);
}

function buildFeaturedNewsletterPreviewModel() {
  const draft = featuredFormDraft || {};
  const departure = draft.departure_date || "";
  const nightsNum = draft.nights === "" || draft.nights == null ? null : Number(draft.nights);
  const returnDate = addCalendarDays(departure, nightsNum) || draft.return_date || "";
  const destinationStrip =
    buildFeaturedDestinationStrip(draft.departure_port, draft.arrival_port) || draft.destination_strip || "";
  const line = ciCruiseLines.find((row) => row.id === draft.cruise_line_id);
  const ship = ciCruiseShips.find((row) => row.id === draft.cruise_ship_id);
  const publicSlug = String(draft.public_slug || "").trim();
  captureFeaturedPricingFromDom();
  const resolved = resolveFeaturedCruiseImages(draft);
  return window.NewsletterPreview.buildModel({
    destinationStrip,
    headline: draft.headline || "",
    hero: resolved.hero,
    heroImageUrl: resolved.hero?.url || "",
    heroImageAlt: resolved.hero?.altText || draft.hero_image_alt || draft.headline || "Cruise image",
    departureDate: departure,
    returnDate,
    nights: nightsNum,
    cruiseLineName: line?.name || "",
    shipName: ship?.name || "",
    itinerarySummary: draft.itinerary_summary || "",
    short_editorial: draft.short_editorial || "",
    full_description: draft.full_description || "",
    description: draft.short_editorial || "",
    publicSlug,
    routeMap: resolved.routeMap,
    routeMapUrl: resolved.routeMap?.url || "",
    pricingRows: featuredFormPricing,
    alcohol_package: draft.alcohol_package,
    wifi: draft.wifi,
    gratuities: draft.gratuities,
    all_tours: draft.all_tours,
    all_dining: draft.all_dining,
    laundry: draft.laundry,
    onboard_credit: draft.onboard_credit,
    other_information: draft.other_information || "",
    outputMode: featuredNewsletterPreviewMode || "general"
  });
}

function openFeaturedNewsletterPreview() {
  if (!window.NewsletterPreview || !window.NewsletterValidation) {
    featuredCruiseMessage = "Newsletter preview modules failed to load.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }
  captureFeaturedDraftFromDom();
  showFeaturedNewsletterPreview = true;
  renderAdmin();
}

function closeFeaturedNewsletterPreview() {
  showFeaturedNewsletterPreview = false;
  renderAdmin();
}

function setFeaturedNewsletterPreviewMode(value) {
  captureFeaturedDraftFromDom();
  featuredNewsletterPreviewMode = value === "airline_staff" ? "airline_staff" : "general";
  showFeaturedNewsletterPreview = true;
  renderAdmin();
}

function renderFeaturedNewsletterPreviewModal() {
  if (!showFeaturedNewsletterPreview || !window.NewsletterPreview) return "";
  const draft = featuredFormDraft || {};
  const model = buildFeaturedNewsletterPreviewModel();
  const warnings = window.NewsletterValidation.validateNewsletterPreview(model);
  const warningsHtml = window.NewsletterPreview.renderWarnings(warnings, esc);
  const articleHtml = window.NewsletterPreview.renderNewsletterCruise(model, { escapeHtml: esc });
  const isPublished = (draft.publication_status || "draft") === "published";
  const slug = String(draft.public_slug || "").trim();
  const publishHint = !isPublished
    ? `<div class="admin-message admin-error" style="margin:0 0 14px">Explore More will show “not currently available” until this cruise is <strong>Published</strong> and Saved. Current status: ${esc(featuredStatusLabel(draft.publication_status))}.</div>`
    : !slug
      ? `<div class="admin-message admin-error" style="margin:0 0 14px">Set a Public Slug and Save before Explore More can open the public page.</div>`
      : `<div class="admin-message admin-success" style="margin:0 0 14px">Public page: <code>/cruise/${esc(featuredSlugify(slug))}</code> — only works after Save while status is Published.</div>`;
  return `
    <div class="newsletter-preview-overlay" onclick="if (event.target === this) closeFeaturedNewsletterPreview()">
      <div class="newsletter-preview-modal" role="dialog" aria-modal="true" aria-labelledby="featuredNewsletterPreviewTitle">
        <div class="newsletter-preview-modal-header">
          <h3 id="featuredNewsletterPreviewTitle">Newsletter Preview</h3>
          <div class="admin-actions-row">
            <label class="newsletter-preview-mode">
              <span>Output</span>
              <select aria-label="Newsletter pricing output mode" onchange="setFeaturedNewsletterPreviewMode(this.value)">
                <option value="general" ${featuredNewsletterPreviewMode === "general" ? "selected" : ""}>General</option>
                <option value="airline_staff" ${featuredNewsletterPreviewMode === "airline_staff" ? "selected" : ""}>Airline Staff</option>
              </select>
            </label>
            <button type="button" class="admin-button secondary small" onclick="closeFeaturedNewsletterPreview()">Close</button>
          </div>
        </div>
        <div class="newsletter-preview-modal-body">
          ${publishHint}
          ${warningsHtml}
          ${articleHtml}
        </div>
      </div>
    </div>
  `;
}

function captureFeaturedPricingFromDom() {
  const list = document.getElementById("fcPricingList");
  if (list) {
    const blocks = Array.from(list.querySelectorAll(".featured-pricing-block"));
    if (blocks.length) {
      const byLocal = new Map(featuredFormPricing.map((row) => [row.local_id, row]));
      featuredFormPricing = blocks.map((block, index) => {
        const prev = byLocal.get(block.dataset.localId) || {};
        return {
          ...prev,
          local_id: block.dataset.localId || prev.local_id || `price-${index}`,
          room_label: block.querySelector('[data-fc-price="room"]')?.value || "",
          category: block.querySelector('[data-fc-price="category"]')?.value || "",
          brochure_price: block.querySelector('[data-fc-price="brochure"]')?.value || "",
          airline_price: block.querySelector('[data-fc-price="airline"]')?.value || "",
          cruise_101_price: block.querySelector('[data-fc-price="cruise101"]')?.value || "",
          display_order: index + 1
        };
      });
      return;
    }
  }
  featuredFormPricing = featuredFormPricing.map((row, index) => ({
    ...row,
    room_label: document.getElementById(`fcPriceRoom-${index}`)?.value || "",
    category: document.getElementById(`fcPriceCategory-${index}`)?.value || "",
    brochure_price: document.getElementById(`fcPriceBrochure-${index}`)?.value || "",
    cruise_101_price: document.getElementById(`fcPrice101-${index}`)?.value || "",
    airline_price: document.getElementById(`fcPriceAirline-${index}`)?.value || "",
    display_order: index + 1
  }));
}

function captureFeaturedDraftFromDom() {
  if (!featuredFormDraft) featuredFormDraft = {};
  const departure = document.getElementById("fcDepartureDate")?.value || "";
  const nightsRaw = document.getElementById("fcNights")?.value || "";
  const nightsNum = nightsRaw === "" ? null : Number(nightsRaw);
  featuredFormDraft = {
    ...featuredFormDraft,
    newsletter_number: document.getElementById("fcNewsletterNumber")?.value || "",
    newsletter_publication_date: document.getElementById("fcNewsletterDate")?.value || "",
    publication_status: document.getElementById("fcPublicationStatus")?.value || "draft",
    public_slug: document.getElementById("fcPublicSlug")?.value || "",
    create_public_page: Boolean(document.getElementById("fcCreatePublicPage")?.checked),
    headline: document.getElementById("fcHeadline")?.value || "",
    departure_port: document.getElementById("fcDeparturePort")?.value || "",
    arrival_port: document.getElementById("fcArrivalPort")?.value || "",
    cruise_line_id: document.getElementById("fcCruiseLineId")?.value || "",
    cruise_ship_id: document.getElementById("fcCruiseShipId")?.value || "",
    departure_date: departure,
    nights: nightsRaw,
    return_date: addCalendarDays(departure, nightsNum),
    short_editorial: document.getElementById("fcShortEditorial")?.value || "",
    full_description: document.getElementById("fcFullDescription")?.value || "",
    use_ship_hero_image: featuredFormDraft.use_ship_hero_image !== false,
    hero_image_url: featuredFormDraft.hero_image_url || "",
    hero_image_alt: document.getElementById("fcHeroImageAlt")?.value || featuredFormDraft.hero_image_alt || "",
    hero_media_id: featuredFormDraft.hero_media_id || null,
    hero_media: featuredFormDraft.hero_media || null,
    route_map_image_url: featuredFormDraft.route_map_image_url || "",
    route_map_media_id: featuredFormDraft.route_map_media_id || null,
    route_map_media: featuredFormDraft.route_map_media || null,
    itinerary_summary: document.getElementById("fcItinerarySummary")?.value || "",
    other_information: document.getElementById("fcOtherInformation")?.value || "",
    display_order: document.getElementById("fcDisplayOrder")?.value || 0,
    alcohol_package: Boolean(document.getElementById("fcIncAlcohol")?.checked),
    wifi: Boolean(document.getElementById("fcIncWifi")?.checked),
    gratuities: Boolean(document.getElementById("fcIncGrat")?.checked),
    all_tours: Boolean(document.getElementById("fcIncTours")?.checked),
    all_dining: Boolean(document.getElementById("fcIncDining")?.checked),
    laundry: Boolean(document.getElementById("fcIncLaundry")?.checked),
    onboard_credit: document.getElementById("fcOnboardCredit")?.value || ""
  };
  captureFeaturedPricingFromDom();
}

function addFeaturedPricingRow() {
  captureFeaturedDraftFromDom();
  const highest = featuredFormPricing.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0);
  featuredFormPricing.push(blankFeaturedPricing(highest + 1));
  renumberFeaturedPricingOrders();
  renderAdmin();
}

function removeFeaturedPricingRow(index) {
  captureFeaturedDraftFromDom();
  featuredFormPricing.splice(index, 1);
  if (!featuredFormPricing.length) featuredFormPricing = [blankFeaturedPricing(1)];
  renumberFeaturedPricingOrders();
  renderAdmin();
}

function onFeaturedPriceHandlePointerDown(event) {
  featuredPricingDragFromHandle = true;
  event.stopPropagation();
}

function onFeaturedPriceDragStart(event, localId) {
  if (!featuredPricingDragFromHandle) {
    event.preventDefault();
    return;
  }
  featuredPricingDragFromHandle = false;
  draggedFeaturedPricingLocalId = String(localId || "");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedFeaturedPricingLocalId);
  const block = event.currentTarget;
  block.classList.add("is-dragging");
  requestAnimationFrame(() => {
    block.classList.add("is-dragging-active");
  });
}

function onFeaturedPriceDragEnd(event) {
  featuredPricingDragFromHandle = false;
  event.currentTarget?.classList.remove("is-dragging", "is-dragging-active");
  document.querySelectorAll(".featured-pricing-block.is-drop-placeholder").forEach((el) => {
    el.classList.remove("is-drop-placeholder");
  });
  const wasDragging = Boolean(draggedFeaturedPricingLocalId);
  draggedFeaturedPricingLocalId = null;
  if (wasDragging) {
    captureFeaturedPricingFromDom();
    renumberFeaturedPricingOrders();
    renderAdmin();
  }
}

function allowFeaturedPriceDrop(event) {
  if (!draggedFeaturedPricingLocalId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";

  const list = event.currentTarget;
  const dragged = list.querySelector(
    `.featured-pricing-block[data-local-id="${CSS.escape(String(draggedFeaturedPricingLocalId))}"]`
  );
  if (!dragged || dragged.parentElement !== list) return;

  const cards = Array.from(list.querySelectorAll(".featured-pricing-block:not(.is-dragging)"));
  const afterElement = cards.find((card) => {
    const rect = card.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });

  list.querySelectorAll(".featured-pricing-block.is-drop-placeholder").forEach((el) => {
    el.classList.remove("is-drop-placeholder");
  });
  if (afterElement) {
    afterElement.classList.add("is-drop-placeholder");
    if (dragged.nextSibling !== afterElement) list.insertBefore(dragged, afterElement);
  } else if (list.lastElementChild !== dragged) {
    list.appendChild(dragged);
  }

  // Keep in-memory display_order in sync immediately (1..n).
  captureFeaturedPricingFromDom();
}

function dropFeaturedPriceRow(event) {
  if (!draggedFeaturedPricingLocalId) return;
  event.preventDefault();
}

function onFeaturedLineChange() {
  captureFeaturedDraftFromDom();
  const ships = shipsForFeaturedLine(featuredFormDraft.cruise_line_id);
  if (featuredFormDraft.cruise_ship_id && !ships.some((s) => s.id === featuredFormDraft.cruise_ship_id)) {
    featuredFormDraft.cruise_ship_id = "";
  }
  renderAdmin();
  updateFeaturedHeroPreview();
  maybeRefreshFeaturedSlug();
}

function onFeaturedDepartureOrNightsChange() {
  const departure = document.getElementById("fcDepartureDate")?.value || "";
  const nightsRaw = document.getElementById("fcNights")?.value || "";
  const nightsNum = nightsRaw === "" ? null : Number(nightsRaw);
  const ret = document.getElementById("fcReturnDate");
  if (ret) ret.value = addCalendarDays(departure, nightsNum);
  refreshFeaturedPricingCalcs();
  maybeRefreshFeaturedSlug();
}

function onFeaturedPortsChange() {
  const dep = document.getElementById("fcDeparturePort")?.value || "";
  const arr = document.getElementById("fcArrivalPort")?.value || "";
  const strip = buildFeaturedDestinationStrip(dep, arr) || "";
  const preview = document.getElementById("fcDestinationStripPreview");
  if (preview) preview.textContent = strip ? `Destination strip preview: ${strip}` : "Destination strip preview: —";
}

function onFeaturedSlugInput() {
  featuredSlugManuallyEdited = true;
}

function maybeRefreshFeaturedSlug() {
  if (featuredSlugManuallyEdited) return;
  const slugInput = document.getElementById("fcPublicSlug");
  if (!slugInput) return;
  const headline = document.getElementById("fcHeadline")?.value || "";
  const shipId = document.getElementById("fcCruiseShipId")?.value || "";
  const shipName = ciCruiseShips.find((ship) => ship.id === shipId)?.name || "";
  const departureDate = document.getElementById("fcDepartureDate")?.value || "";
  slugInput.value = suggestFeaturedSlug({ headline, shipName, departureDate });
}

function updateFeaturedHeroPreview() {
  captureFeaturedDraftFromDom();
  renderAdmin();
}

function setFeaturedHeroDefaultShip() {
  captureFeaturedDraftFromDom();
  featuredFormDraft.hero_media_id = null;
  featuredFormDraft.hero_media = null;
  featuredFormDraft.hero_image_url = "";
  featuredFormDraft.use_ship_hero_image = true;
  renderAdmin();
}

function setFeaturedHeroLegacyCi() {
  captureFeaturedDraftFromDom();
  const ship = ciCruiseShips.find((row) => row.id === featuredFormDraft.cruise_ship_id);
  const ciUrl = ship?.hero_image_url || "";
  if (!ciUrl) {
    featuredCruiseMessage = "No Cruise Intelligence ship image is available for the selected ship.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }
  featuredFormDraft.hero_media_id = null;
  featuredFormDraft.hero_media = null;
  featuredFormDraft.hero_image_url = ciUrl;
  featuredFormDraft.use_ship_hero_image = false;
  renderAdmin();
}

function removeFeaturedHeroOverride() {
  captureFeaturedDraftFromDom();
  featuredFormDraft.hero_media_id = null;
  featuredFormDraft.hero_media = null;
  featuredFormDraft.hero_image_url = "";
  featuredFormDraft.use_ship_hero_image = true;
  renderAdmin();
}

function applyFeaturedHeroMediaSelection(media) {
  if (!media?.id) return;
  captureFeaturedDraftFromDom();
  featuredFormDraft.hero_media_id = media.id;
  featuredFormDraft.hero_media = media;
  featuredFormDraft.use_ship_hero_image = false;
  if (!featuredFormDraft.hero_image_alt && media.alt_text) {
    featuredFormDraft.hero_image_alt = media.alt_text;
  }
  renderAdmin();
}

function applyFeaturedRouteMapMediaSelection(media) {
  if (!media?.id) return;
  captureFeaturedDraftFromDom();
  featuredFormDraft.route_map_media_id = media.id;
  featuredFormDraft.route_map_media = media;
  renderAdmin();
}

function openFeaturedHeroMediaPicker() {
  captureFeaturedDraftFromDom();
  if (!window.MediaLibraryAdmin) return;
  window.MediaLibraryAdmin.openMediaPicker({
    title: "Choose Hero Image",
    selectedId: featuredFormDraft.hero_media_id || null,
    shipId: featuredFormDraft.cruise_ship_id || "",
    cruiseLineId: featuredFormDraft.cruise_line_id || "",
    destinationHints: featuredDestinationHints(featuredFormDraft),
    featuredCruiseId: editingFeaturedCruiseId || null,
    publicSlug: featuredFormDraft.public_slug || "",
    mediaType: null,
    defaultFilter: "recommended",
    onSelect: applyFeaturedHeroMediaSelection
  });
}

function openFeaturedHeroUpload() {
  captureFeaturedDraftFromDom();
  if (!window.MediaLibraryAdmin) return;
  window.MediaLibraryAdmin.openMediaPicker({
    title: "Upload Hero Image",
    selectedId: null,
    shipId: featuredFormDraft.cruise_ship_id || "",
    cruiseLineId: featuredFormDraft.cruise_line_id || "",
    destinationHints: featuredDestinationHints(featuredFormDraft),
    featuredCruiseId: editingFeaturedCruiseId || null,
    publicSlug: featuredFormDraft.public_slug || "",
    mediaType: featuredFormDraft.cruise_ship_id ? "ship" : "general",
    defaultFilter: "recommended",
    onSelect: applyFeaturedHeroMediaSelection
  });
  window.MediaLibraryAdmin.openPickerUpload();
}

function openFeaturedRouteMapPicker() {
  captureFeaturedDraftFromDom();
  if (!window.MediaLibraryAdmin) return;
  window.MediaLibraryAdmin.openMediaPicker({
    title: "Choose Route Map",
    selectedId: featuredFormDraft.route_map_media_id || null,
    shipId: featuredFormDraft.cruise_ship_id || "",
    cruiseLineId: featuredFormDraft.cruise_line_id || "",
    destinationHints: featuredDestinationHints(featuredFormDraft),
    featuredCruiseId: editingFeaturedCruiseId || null,
    publicSlug: featuredFormDraft.public_slug || "",
    mediaType: "route_map",
    defaultFilter: "recommended",
    onSelect: applyFeaturedRouteMapMediaSelection
  });
}

function openFeaturedRouteMapUpload() {
  openFeaturedRouteMapPicker();
  window.MediaLibraryAdmin?.openPickerUpload();
}

function removeFeaturedRouteMapSelection() {
  captureFeaturedDraftFromDom();
  featuredFormDraft.route_map_media_id = null;
  featuredFormDraft.route_map_media = null;
  featuredFormDraft.route_map_image_url = "";
  renderAdmin();
}

function renderFeaturedHeroImageSection(draft) {
  const resolved = resolveFeaturedCruiseImages(draft);
  const hero = resolved.hero;
  const media =
    draft.hero_media ||
    (draft.hero_media_id ? window.MediaLibraryAdmin?.findById?.(draft.hero_media_id) : null);
  const ship = ciCruiseShips.find((row) => row.id === draft.cruise_ship_id);
  const hasCi = Boolean(ship?.hero_image_url);
  const altWarn = !(draft.hero_image_alt || media?.alt_text || hero?.altText);
  return `
    <section class="featured-form-section">
      <h4>Hero Image</h4>
      <div class="featured-media-source-actions">
        <button type="button" class="admin-button secondary small" onclick="setFeaturedHeroDefaultShip()">Use Default Ship Image</button>
        <button type="button" class="admin-button secondary small" onclick="openFeaturedHeroMediaPicker()">Choose from Media Library</button>
        <button type="button" class="admin-button secondary small" onclick="openFeaturedHeroUpload()">Upload New Image</button>
        ${hasCi ? `<button type="button" class="admin-button secondary small" onclick="setFeaturedHeroLegacyCi()">Use Legacy Cruise Intelligence Image</button>` : ""}
      </div>
      <div class="featured-media-preview-block">
        <div id="fcHeroPreview" class="featured-image-preview-wrap">
          ${
            hero?.url
              ? `<img class="featured-image-preview" src="${esc(hero.url)}" alt="${esc(hero.altText || "Hero preview")}" ${hero.width ? `width="${esc(hero.width)}"` : ""} ${hero.height ? `height="${esc(hero.height)}"` : ""} onerror="this.outerHTML='<div class=&quot;admin-empty-preview&quot;>Image could not load</div>'">`
              : `<div class="admin-empty-preview">No image selected</div>`
          }
        </div>
        <div class="featured-media-meta">
          <p class="featured-media-source">Source: ${esc(hero?.source || "No image selected")}</p>
          ${media ? `<p class="admin-small">${esc(media.title)}</p>` : ""}
          ${
            draft.hero_media_id
              ? `<div class="admin-actions-row">
                  <button type="button" class="admin-button secondary small" onclick="openFeaturedHeroMediaPicker()">Replace Image</button>
                  <button type="button" class="admin-button secondary small" onclick="removeFeaturedHeroOverride()">Remove Override</button>
                </div>`
              : ""
          }
        </div>
      </div>
      <div class="admin-field" style="margin-top:12px">
        <label for="fcHeroImageAlt">Image alt text override</label>
        <input id="fcHeroImageAlt" type="text" value="${esc(draft.hero_image_alt || "")}" placeholder="${esc(media?.alt_text || hero?.altText || "Uses media library alt text when empty")}">
        ${altWarn ? `<div class="admin-helper featured-alt-warn">Alt text is empty — add one for accessibility.</div>` : `<div class="admin-helper">Optional override. Defaults to the media library alt text.</div>`}
      </div>
    </section>
  `;
}

function renderFeaturedRouteMapSection(draft) {
  const resolved = resolveFeaturedCruiseImages(draft).routeMap;
  const media =
    draft.route_map_media ||
    (draft.route_map_media_id
      ? window.MediaLibraryAdmin?.findById?.(draft.route_map_media_id)
      : null);
  const legacyUrl = String(draft.route_map_image_url || "").trim();
  return `
    <section class="featured-form-section">
      <h4>Route Map</h4>
      <div class="featured-media-source-actions">
        <button type="button" class="admin-button secondary small" onclick="openFeaturedRouteMapPicker()">Choose from Media Library</button>
        <button type="button" class="admin-button secondary small" onclick="openFeaturedRouteMapUpload()">Upload New Route Map</button>
        ${legacyUrl && !draft.route_map_media_id ? `<span class="admin-small">Legacy Image URL in use</span>` : ""}
        ${
          draft.route_map_media_id || legacyUrl
            ? `<button type="button" class="admin-button secondary small" onclick="removeFeaturedRouteMapSelection()">Remove Selection</button>`
            : ""
        }
      </div>
      <div class="featured-media-preview-block">
        <div class="featured-image-preview-wrap">
          ${
            resolved?.url
              ? `<img class="featured-image-preview" src="${esc(resolved.url)}" alt="${esc(resolved.altText || "Route map")}" loading="lazy">`
              : `<div class="admin-empty-preview">No route map selected</div>`
          }
        </div>
        <div class="featured-media-meta">
          <p class="featured-media-source">Source: ${esc(resolved?.source || "No image selected")}</p>
          ${media ? `<p class="admin-small">${esc(media.title)}</p>` : ""}
        </div>
      </div>
    </section>
  `;
}

function buildFeaturedPriceCalcText(price, brochure, nights) {
  if (price == null || !Number.isFinite(price) || price < 0) return "";
  const parts = [];
  const nightsNum = nights === "" || nights == null ? null : Number(nights);
  if (nightsNum != null && Number.isFinite(nightsNum) && nightsNum >= 1) {
    parts.push(`$${formatFeaturedMoney(price / nightsNum)}/day`);
  }
  if (brochure != null && Number.isFinite(brochure) && brochure > price) {
    const save = brochure - price;
    const pct = Math.round((save / brochure) * 100);
    parts.push(`Save $${formatFeaturedMoney(save)}`);
    parts.push(`${pct}% off`);
  }
  return parts.join(" · ");
}

function buildFeaturedPriceCalcs(row, nights) {
  const brochure = row.brochure_price === "" || row.brochure_price == null ? null : Number(row.brochure_price);
  const airline = row.airline_price === "" || row.airline_price == null ? null : Number(row.airline_price);
  const price101 = row.cruise_101_price === "" || row.cruise_101_price == null ? null : Number(row.cruise_101_price);
  return {
    airline: buildFeaturedPriceCalcText(airline, brochure, nights),
    cruise101: buildFeaturedPriceCalcText(price101, brochure, nights)
  };
}

function refreshFeaturedPricingCalcs() {
  const nights = document.getElementById("fcNights")?.value || "";
  featuredFormPricing.forEach((row, index) => {
    const live = {
      brochure_price: document.getElementById(`fcPriceBrochure-${index}`)?.value ?? row.brochure_price,
      airline_price: document.getElementById(`fcPriceAirline-${index}`)?.value ?? row.airline_price,
      cruise_101_price: document.getElementById(`fcPrice101-${index}`)?.value ?? row.cruise_101_price
    };
    const calcs = buildFeaturedPriceCalcs(live, nights);
    const airlineEl = document.getElementById(`fcCalcAirline-${index}`);
    const cruiseEl = document.getElementById(`fcCalc101-${index}`);
    if (airlineEl) airlineEl.textContent = calcs.airline;
    if (cruiseEl) cruiseEl.textContent = calcs.cruise101;
  });
}

function roomTypeOptionsHtml(selected) {
  const names = [...featuredCruiseRoomTypes.map((r) => r.name)];
  if (selected && !names.some((n) => n.toLowerCase() === selected.toLowerCase())) names.push(selected);
  return names
    .filter(Boolean)
    .map((name) => `<option value="${esc(name)}"></option>`)
    .join("");
}

function onFeaturedRoomTypeInput(index) {
  const value = String(document.getElementById(`fcPriceRoom-${index}`)?.value || "").trim();
  const known = featuredCruiseRoomTypes.some((r) => r.name.toLowerCase() === value.toLowerCase());
  featuredRoomTypePromptIndex = value && !known ? index : null;
  const prompt = document.getElementById(`fcRoomTypeSave-${index}`);
  if (prompt) {
    prompt.hidden = !(value && !known);
    prompt.querySelector("[data-label]") && (prompt.querySelector("[data-label]").textContent = `Save “${value}” for future use`);
  }
}

async function saveFeaturedRoomTypeFromRow(index) {
  const value = String(document.getElementById(`fcPriceRoom-${index}`)?.value || "").trim();
  if (!value) return;
  const { error } = await supabaseClient.from("featured_cruise_room_types").insert({
    name: value,
    sort_order: (featuredCruiseRoomTypes.length + 1) * 10
  });
  if (error) {
    if (/duplicate|unique/i.test(error.message || "")) {
      await loadFeaturedRoomTypes();
      featuredRoomTypePromptIndex = null;
      renderAdmin();
      return;
    }
    featuredCruiseMessage = error.message || "Could not save room type.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }
  await loadFeaturedRoomTypes();
  featuredRoomTypePromptIndex = null;
  captureFeaturedDraftFromDom();
  renderAdmin();
}

function renderFeaturedCruisesPanel() {
  if (showFeaturedCruiseForm) return renderFeaturedCruiseForm();

  const rows = filteredFeaturedCruises();
  const isRunning = /^(Saving)/i.test(String(featuredCruiseMessage || "")) || featuredCruiseMessageTone === "running";
  const messageClass =
    featuredCruiseMessageTone === "error"
      ? "admin-error"
      : featuredCruiseMessageTone === "success"
        ? "admin-success"
        : isRunning
          ? "admin-running"
          : "";

  return `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h3>Newsletter</h3>
          <p class="admin-muted">Create and manage promoted cruises for newsletters and public cruise pages.</p>
        </div>
        <button class="admin-button black" onclick="startNewFeaturedCruise()">+ New</button>
      </div>

      <div class="featured-cruises-toolbar">
        <div class="admin-field">
          <label for="featuredCruiseSearch">Search</label>
          <input id="featuredCruiseSearch" type="search" value="${esc(featuredCruiseSearchQuery)}" placeholder="Headline, ship, destination…" oninput="featuredCruiseSearchQuery=this.value; renderAdmin()">
        </div>
        <div class="admin-field">
          <label for="featuredCruiseStatusFilter">Status</label>
          <select id="featuredCruiseStatusFilter" onchange="featuredCruiseStatusFilter=this.value; renderAdmin()">
            <option value="all" ${featuredCruiseStatusFilter === "all" ? "selected" : ""}>Draft &amp; Published</option>
            <option value="draft" ${featuredCruiseStatusFilter === "draft" ? "selected" : ""}>Draft</option>
            <option value="published" ${featuredCruiseStatusFilter === "published" ? "selected" : ""}>Published</option>
            <option value="archived" ${featuredCruiseStatusFilter === "archived" ? "selected" : ""}>Archived</option>
          </select>
        </div>
      </div>

      <div class="admin-message ${messageClass}">${esc(featuredCruiseMessage)}</div>
      ${featuredCruiseLoading ? `<p class="admin-muted">Loading newsletter cruises…</p>` : ""}

      ${!featuredCruiseLoading && !rows.length
        ? `<div class="admin-card featured-cruise-empty"><p class="admin-muted">No newsletter cruises have been created yet.</p></div>`
        : `<div class="featured-cruise-list">${rows.map(renderFeaturedCruiseListItem).join("")}</div>`}
    </div>
  `;
}

function onFeaturedCruiseCardKeydown(event, id) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    editFeaturedCruise(id);
  }
}

function renderFeaturedCruiseListItem(row) {
  const lineName = row.ci_cruise_lines?.name || "Cruise line not set";
  const shipName = row.ci_cruise_ships?.name || "Ship not set";
  const strip = displayDestinationStrip(row);
  const newsletterBits = [];
  if (row.newsletter_number != null && row.newsletter_number !== "") newsletterBits.push(`Newsletter ${row.newsletter_number}`);
  if (row.newsletter_publication_date) newsletterBits.push(formatAdminDate(row.newsletter_publication_date));
  const id = esc(row.id);
  return `
    <article
      class="featured-cruise-card admin-object-card"
      role="button"
      tabindex="0"
      aria-label="Open ${esc(row.headline || "newsletter cruise")}"
      onclick="editFeaturedCruise('${id}')"
      onkeydown="onFeaturedCruiseCardKeydown(event, '${id}')"
    >
      <div class="featured-cruise-card-main">
        <div class="featured-cruise-card-heading">
          <h4>${esc(row.headline)}</h4>
          <span class="featured-status-pill status-${esc(row.publication_status || "draft")}">${esc(featuredStatusLabel(row.publication_status))}</span>
        </div>
        ${strip ? `<p class="featured-destination-strip">${esc(strip)}</p>` : ""}
        <p class="admin-muted">${esc(lineName)} · ${esc(shipName)}</p>
        <p class="admin-small">
          Departure ${esc(formatAdminDate(row.departure_date))}
          ${newsletterBits.length ? ` · ${esc(newsletterBits.join(" · "))}` : ""}
          ${row.create_public_page ? " · Public page prepared" : ""}
        </p>
      </div>
    </article>
  `;
}

function renderFeaturedPricingBlock(row, index, nights) {
  const calcs = buildFeaturedPriceCalcs(row, nights);
  const showSaveRoom = featuredRoomTypePromptIndex === index;
  const localId = row.local_id || `price-${index}`;
  return `
    <div
      class="featured-pricing-block"
      data-local-id="${esc(localId)}"
      draggable="true"
      ondragstart="onFeaturedPriceDragStart(event, '${esc(localId)}')"
      ondragend="onFeaturedPriceDragEnd(event)"
    >
      <div class="featured-pricing-main-row">
        <span
          class="featured-price-drag-handle"
          role="button"
          tabindex="0"
          aria-label="Drag to reorder pricing row"
          title="Drag to reorder"
          onpointerdown="onFeaturedPriceHandlePointerDown(event)"
        >☰</span>
        <div class="admin-field featured-room-type-field">
          <label>Room Type</label>
          <input id="fcPriceRoom-${index}" data-fc-price="room" list="fcRoomTypeList-${index}" type="text" value="${esc(row.room_label)}" autocomplete="off" oninput="onFeaturedRoomTypeInput(${index}); refreshFeaturedPricingCalcs()">
          <datalist id="fcRoomTypeList-${index}">${roomTypeOptionsHtml(row.room_label)}</datalist>
          <div id="fcRoomTypeSave-${index}" class="featured-room-type-save" ${showSaveRoom ? "" : "hidden"}>
            <button type="button" class="admin-button secondary small" onclick="saveFeaturedRoomTypeFromRow(${index})"><span data-label>Save “${esc(row.room_label)}” for future use</span></button>
          </div>
        </div>
        <div class="admin-field featured-category-field">
          <label>Category</label>
          <input id="fcPriceCategory-${index}" data-fc-price="category" type="text" value="${esc(row.category)}" placeholder="e.g. V1" maxlength="20">
        </div>
        <div class="admin-field">
          <label>Brochure Price</label>
          <input id="fcPriceBrochure-${index}" data-fc-price="brochure" type="number" min="0" step="1" value="${esc(row.brochure_price)}" oninput="refreshFeaturedPricingCalcs()">
        </div>
        <div class="admin-field featured-price-with-calc">
          <label>Airline Price</label>
          <input id="fcPriceAirline-${index}" data-fc-price="airline" type="number" min="0" step="1" value="${esc(row.airline_price)}" oninput="refreshFeaturedPricingCalcs()">
          <div id="fcCalcAirline-${index}" class="featured-price-calc">${esc(calcs.airline)}</div>
        </div>
        <div class="admin-field featured-price-with-calc">
          <label>101cruise Price</label>
          <input id="fcPrice101-${index}" data-fc-price="cruise101" type="number" min="0" step="1" value="${esc(row.cruise_101_price)}" oninput="refreshFeaturedPricingCalcs()">
          <div id="fcCalc101-${index}" class="featured-price-calc">${esc(calcs.cruise101)}</div>
        </div>
        <button type="button" class="admin-button secondary small featured-price-remove" onclick="removeFeaturedPricingRow(${index})">Remove</button>
      </div>
    </div>
  `;
}

function renderFeaturedCruiseForm() {
  const draft = featuredFormDraft || {};
  const existing = editingFeaturedCruiseId ? findFeaturedCruise(editingFeaturedCruiseId) : null;
  const lines = activeCiLinesForFeatured();
  const selectedLineId = draft.cruise_line_id || "";
  const ships = shipsForFeaturedLine(selectedLineId);
  const isRunning = featuredCruiseSaving || /^(Saving)/i.test(String(featuredCruiseMessage || ""));
  const messageClass =
    featuredCruiseMessageTone === "error"
      ? "admin-error"
      : featuredCruiseMessageTone === "success"
        ? "admin-success"
        : isRunning
          ? "admin-running"
          : "";
  const inlineRunning =
    isRunning && featuredCruiseMessage
      ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(featuredCruiseMessage)}</span>`
      : "";
  const strip = buildFeaturedDestinationStrip(draft.departure_port, draft.arrival_port) || "";
  const returnDate = addCalendarDays(draft.departure_date, draft.nights === "" ? null : Number(draft.nights));
  const pickerModal = window.MediaLibraryAdmin?.renderPickerModal?.() || "";

  return `
    <div class="admin-card featured-cruise-form">
      <div class="admin-list-top">
        <div>
          <h3>${existing ? "Edit Cruise" : "New Cruise"}</h3>
          <p class="admin-muted">Newsletter workspace. Nothing here is public in this phase.</p>
        </div>
        <div class="admin-actions-row">
          <button class="admin-button secondary" onclick="cancelFeaturedCruiseForm()" ${featuredCruiseSaving ? "disabled" : ""}>Cancel</button>
          <button class="admin-button secondary" onclick="openFeaturedNewsletterPreview()" ${featuredCruiseSaving ? "disabled" : ""}>Preview Newsletter</button>
          <button class="admin-button black" onclick="saveFeaturedCruise()" ${featuredCruiseSaving ? "disabled" : ""}>${featuredCruiseSaving ? "Saving…" : "Save"}</button>
          ${inlineRunning}
        </div>
      </div>
      ${!isRunning ? `<div class="admin-message ${messageClass}">${esc(featuredCruiseMessage)}</div>` : ""}

      <section class="featured-form-section featured-newsletter-section">
        <h4>Newsletter and Publication</h4>
        <div class="featured-newsletter-row">
          <div class="admin-field">
            <label for="fcNewsletterNumber">Newsletter Number</label>
            <input id="fcNewsletterNumber" type="number" min="1" step="1" placeholder="76" value="${esc(draft.newsletter_number ?? "")}">
          </div>
          <div class="admin-field">
            <label for="fcNewsletterDate">Newsletter Publication Date</label>
            <input id="fcNewsletterDate" type="date" value="${esc(draft.newsletter_publication_date || "")}">
          </div>
          <div class="admin-field">
            <label for="fcPublicationStatus">Publication Status</label>
            <select id="fcPublicationStatus">
              <option value="draft" ${(draft.publication_status || "draft") === "draft" ? "selected" : ""}>Draft</option>
              <option value="published" ${draft.publication_status === "published" ? "selected" : ""}>Published</option>
              <option value="archived" ${draft.publication_status === "archived" ? "selected" : ""}>Archived</option>
            </select>
          </div>
          <div class="admin-field">
            <label for="fcPublicSlug">Public Slug</label>
            <input id="fcPublicSlug" type="text" value="${esc(draft.public_slug || "")}" oninput="onFeaturedSlugInput()" placeholder="auto-suggested">
          </div>
          <label class="admin-check-chip featured-check featured-create-public">
            <input id="fcCreatePublicPage" type="checkbox" ${draft.create_public_page ? "checked" : ""}>
            <span>Create public page</span>
          </label>
        </div>
        <p class="admin-helper">Public page URL: /cruise/{public-slug}. Only Published cruises are publicly visible. Airline prices are never exposed on the public page.</p>
      </section>

      <section class="featured-form-section">
        <h4>Cruise Details</h4>
        <div class="admin-field featured-span-2" style="margin-bottom:12px">
          <label for="fcHeadline">Headline <span class="admin-required">*</span></label>
          <input id="fcHeadline" type="text" value="${esc(draft.headline || "")}" required oninput="maybeRefreshFeaturedSlug()">
        </div>
        <div class="featured-ports-row">
          <div class="admin-field">
            <label for="fcDeparturePort">Departure Port</label>
            <input id="fcDeparturePort" type="text" value="${esc(draft.departure_port || "")}" oninput="onFeaturedPortsChange()">
          </div>
          <div class="admin-field">
            <label for="fcArrivalPort">Arrival Port</label>
            <input id="fcArrivalPort" type="text" value="${esc(draft.arrival_port || "")}" oninput="onFeaturedPortsChange()">
          </div>
        </div>
        <p class="featured-destination-preview" id="fcDestinationStripPreview">${esc(strip ? `Destination strip preview: ${strip}` : "Destination strip preview: —")}</p>
        <div class="featured-details-row">
          <div class="admin-field">
            <label for="fcCruiseLineId">Cruise Line</label>
            <select id="fcCruiseLineId" onchange="onFeaturedLineChange()">
              <option value="">Select cruise line</option>
              ${lines.map((line) => `<option value="${esc(line.id)}" ${line.id === selectedLineId ? "selected" : ""}>${esc(line.name)}</option>`).join("")}
            </select>
          </div>
          <div class="admin-field">
            <label for="fcCruiseShipId">Ship</label>
            <select id="fcCruiseShipId" onchange="updateFeaturedHeroPreview(); maybeRefreshFeaturedSlug()">
              <option value="">Select ship</option>
              ${ships.map((ship) => `<option value="${esc(ship.id)}" ${ship.id === draft.cruise_ship_id ? "selected" : ""}>${esc(ship.name)}</option>`).join("")}
            </select>
          </div>
          <div class="admin-field">
            <label for="fcDepartureDate">Departure Date</label>
            <input id="fcDepartureDate" type="date" value="${esc(draft.departure_date || "")}" onchange="onFeaturedDepartureOrNightsChange()">
          </div>
          <div class="admin-field">
            <label for="fcNights">Nights</label>
            <input id="fcNights" type="number" min="1" step="1" value="${esc(draft.nights ?? "")}" oninput="onFeaturedDepartureOrNightsChange()">
          </div>
          <div class="admin-field">
            <label for="fcReturnDate">Return Date</label>
            <input id="fcReturnDate" class="featured-readonly-date" type="date" value="${esc(returnDate)}" readonly tabindex="-1">
          </div>
        </div>
        <div class="admin-field" style="margin-top:10px;max-width:160px">
          <label for="fcDisplayOrder">Display order</label>
          <input id="fcDisplayOrder" type="number" step="1" value="${esc(draft.display_order ?? 0)}">
        </div>
      </section>

      <section class="featured-form-section">
        <h4>Editorial</h4>
        <div class="admin-field">
          <label for="fcShortEditorial">Short editorial</label>
          <textarea id="fcShortEditorial" rows="3">${esc(draft.short_editorial || "")}</textarea>
          <div class="admin-helper">Intended for the newsletter.</div>
        </div>
        <div class="admin-field">
          <label for="fcFullDescription">Full description</label>
          <textarea id="fcFullDescription" rows="5">${esc(draft.full_description || "")}</textarea>
        </div>
      </section>

      ${renderFeaturedHeroImageSection(draft)}

      ${renderFeaturedRouteMapSection(draft)}

      <section class="featured-form-section">
        <h4>Itinerary</h4>
        <p class="admin-muted">Enter the ports in sailing order, separated by a vertical bar.</p>
        <div class="admin-field">
          <textarea id="fcItinerarySummary" class="featured-itinerary-textarea" rows="4" placeholder="Barcelona, Spain | Palermo, Sicily, Italy | Syracuse, Sicily | Argostoli, Kephalonia | Gythion, Greece | Paros, Greece | Piraeus (Athens), Greece | Kusadasi (Ephesus), Turkey | Bozcaada, Turkey | Istanbul, Turkey">${esc(draft.itinerary_summary || "")}</textarea>
        </div>
      </section>

      <section class="featured-form-section">
        <h4>Pricing</h4>
        <p class="admin-muted">All prices are USD. Airline prices are confidential and must never appear on a public page.</p>
        <div class="featured-warning">Confirm every figure before saving. Category is for internal reference only.</div>
        <div
          id="fcPricingList"
          class="featured-row-editor featured-pricing-list"
          ondragover="allowFeaturedPriceDrop(event)"
          ondrop="dropFeaturedPriceRow(event)"
        >
          ${featuredFormPricing.map((row, index) => renderFeaturedPricingBlock(row, index, draft.nights)).join("")}
        </div>
        <div class="featured-add-pricing">
          <button type="button" class="admin-button secondary small" onclick="addFeaturedPricingRow()">+ Add Room Price</button>
        </div>

        <div class="featured-offer-inclusions">
          <h4>Offer Inclusions</h4>
          <div class="featured-inclusions-row">
            <label class="featured-inc"><input id="fcIncAlcohol" type="checkbox" ${draft.alcohol_package ? "checked" : ""}> Alcohol Package</label>
            <label class="featured-inc"><input id="fcIncWifi" type="checkbox" ${draft.wifi ? "checked" : ""}> Wi-Fi</label>
            <label class="featured-inc"><input id="fcIncGrat" type="checkbox" ${draft.gratuities ? "checked" : ""}> Gratuities</label>
            <label class="featured-inc"><input id="fcIncTours" type="checkbox" ${draft.all_tours ? "checked" : ""}> All Tours</label>
            <label class="featured-inc"><input id="fcIncDining" type="checkbox" ${draft.all_dining ? "checked" : ""}> All Dining</label>
            <label class="featured-inc"><input id="fcIncLaundry" type="checkbox" ${draft.laundry ? "checked" : ""}> Laundry</label>
            <div class="admin-field featured-obc-field">
              <label for="fcOnboardCredit">On Board Credit ($)</label>
              <input id="fcOnboardCredit" type="number" min="0" step="1" value="${esc(draft.onboard_credit ?? "")}">
            </div>
          </div>
        </div>

        <div class="featured-other-information">
          <h4>Other Information</h4>
          <div class="admin-field">
            <label for="fcOtherInformation">Other information</label>
            <input id="fcOtherInformation" type="text" value="${esc(draft.other_information || "")}" placeholder="e.g. Reduced Deposit, Book by 31 July, Fly Free">
          </div>
        </div>
      </section>

      <div class="admin-actions-row featured-form-actions">
        <button class="admin-button secondary" onclick="cancelFeaturedCruiseForm()" ${featuredCruiseSaving ? "disabled" : ""}>Cancel</button>
        ${existing ? `<button class="admin-button secondary" onclick="deleteFeaturedCruise('${esc(existing.id)}')" ${featuredCruiseSaving ? "disabled" : ""}>Delete</button>` : ""}
        <button class="admin-button secondary" onclick="openFeaturedNewsletterPreview()" ${featuredCruiseSaving ? "disabled" : ""}>Preview Newsletter</button>
        <button class="admin-button black" onclick="saveFeaturedCruise()" ${featuredCruiseSaving ? "disabled" : ""}>${featuredCruiseSaving ? "Saving…" : "Save"}</button>
        ${inlineRunning}
      </div>
    </div>
    ${pickerModal}
    ${renderFeaturedNewsletterPreviewModal()}
  `;
}

async function saveFeaturedCruise() {
  captureFeaturedDraftFromDom();
  const draft = featuredFormDraft || {};

  const headline = String(draft.headline || "").trim();
  if (!headline) {
    featuredCruiseMessage = "Headline is required.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }

  const newsletterRaw = String(draft.newsletter_number ?? "").trim();
  let newsletterNumber = null;
  if (newsletterRaw !== "") {
    newsletterNumber = Number(newsletterRaw);
    if (!Number.isInteger(newsletterNumber) || newsletterNumber < 1) {
      featuredCruiseMessage = "Newsletter Number must be a whole number of at least 1.";
      featuredCruiseMessageTone = "error";
      renderAdmin();
      return;
    }
  }

  const nightsRaw = String(draft.nights ?? "").trim();
  const nights = nightsRaw === "" ? null : Number(nightsRaw);
  if (nights == null || !Number.isInteger(nights) || nights < 1) {
    featuredCruiseMessage = "Nights must be a whole number of at least 1.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }

  const departureDate = draft.departure_date || null;
  if (!departureDate) {
    featuredCruiseMessage = "Departure Date is required.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }

  const returnDate = addCalendarDays(departureDate, nights);
  const destinationStrip = buildFeaturedDestinationStrip(draft.departure_port, draft.arrival_port);
  const itinerarySummary = String(draft.itinerary_summary || "").trim() || null;

  const slugRaw = String(draft.public_slug || "").trim();
  const publicSlug = slugRaw ? featuredSlugify(slugRaw) : null;
  if (slugRaw && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(publicSlug || "")) {
    featuredCruiseMessage = "Public slug must use lowercase letters, numbers and hyphens only.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }

  renumberFeaturedPricingOrders();
  const pricingPayload = [];
  let onboardCredit = null;
  try {
    onboardCredit = parseOptionalPrice(draft.onboard_credit);
    for (let index = 0; index < featuredFormPricing.length; index += 1) {
      const row = featuredFormPricing[index];
      const roomLabel = String(row.room_label || "").trim();
      const category = String(row.category || "").trim() || null;
      const brochure = parseOptionalPrice(row.brochure_price);
      const price101 = parseOptionalPrice(row.cruise_101_price);
      const airline = parseOptionalPrice(row.airline_price);
      if (!roomLabel && brochure == null && price101 == null && airline == null && !category) {
        continue;
      }
      if (!roomLabel) {
        featuredCruiseMessage = `Room Type is required on pricing row ${index + 1}.`;
        featuredCruiseMessageTone = "error";
        renderAdmin();
        return;
      }
      // Do not read/write inclusion columns on featured_cruise_pricing.
      // Pricing display_order controls the order used by newsletters, landing pages and future customer-facing outputs.
      pricingPayload.push({
        id: row.id || undefined,
        room_label: roomLabel,
        category,
        brochure_price: brochure,
        cruise_101_price: price101,
        airline_price: airline,
        currency_code: "USD",
        display_order: Number(row.display_order) || pricingPayload.length + 1
      });
    }
  } catch (error) {
    featuredCruiseMessage = error.message || "Pricing validation failed.";
    featuredCruiseMessageTone = "error";
    renderAdmin();
    return;
  }

  const payload = {
    headline,
    destination_strip: destinationStrip,
    cruise_line_id: draft.cruise_line_id || null,
    cruise_ship_id: draft.cruise_ship_id || null,
    departure_date: departureDate,
    return_date: returnDate || null,
    nights,
    departure_port: String(draft.departure_port || "").trim() || null,
    arrival_port: String(draft.arrival_port || "").trim() || null,
    short_editorial: String(draft.short_editorial || "").trim() || null,
    full_description: String(draft.full_description || "").trim() || null,
    use_ship_hero_image: draft.hero_media_id ? false : draft.use_ship_hero_image !== false,
    hero_media_id: draft.hero_media_id || null,
    // Denormalise library public URL so the public page still renders if media joins fail.
    hero_image_url:
      (draft.hero_media_id && (draft.hero_media?.public_url || draft.hero_media?.url)) ||
      normalizeUrl(draft.hero_image_url) ||
      null,
    hero_image_alt: String(draft.hero_image_alt || "").trim() || null,
    route_map_media_id: draft.route_map_media_id || null,
    route_map_image_url:
      (draft.route_map_media_id && (draft.route_map_media?.public_url || draft.route_map_media?.url)) ||
      normalizeUrl(draft.route_map_image_url) ||
      null,
    itinerary_summary: itinerarySummary,
    alcohol_package: Boolean(draft.alcohol_package),
    wifi: Boolean(draft.wifi),
    gratuities: Boolean(draft.gratuities),
    all_tours: Boolean(draft.all_tours),
    all_dining: Boolean(draft.all_dining),
    laundry: Boolean(draft.laundry),
    onboard_credit: onboardCredit,
    other_information: String(draft.other_information || "").trim() || null,
    newsletter_number: newsletterNumber,
    newsletter_publication_date: draft.newsletter_publication_date || null,
    publication_status: draft.publication_status || "draft",
    display_order: Number(draft.display_order || 0) || 0,
    create_public_page: Boolean(draft.create_public_page),
    public_slug: publicSlug,
    updated_by: currentUser?.id || null
  };

  const newsletterChanged =
    String(featuredNewsletterDefaultsBaseline.newsletter_number ?? "") !== String(newsletterNumber ?? "") ||
    String(featuredNewsletterDefaultsBaseline.newsletter_publication_date || "") !==
      String(draft.newsletter_publication_date || "");

  featuredCruiseSaving = true;
  featuredCruiseMessage = "Saving…";
  featuredCruiseMessageTone = "running";
  renderAdmin();

  try {
    const missingColumnMatch = (message) => {
      const match = String(message || "").match(
        /Could not find the '([^']+)' column of 'featured_cruises'/i
      );
      return match?.[1] || null;
    };

    const saveCruiseRow = async (basePayload) => {
      let working = { ...basePayload };
      const stripped = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const selectCols = ["id"];
        if (working.hero_media_id !== undefined) selectCols.push("hero_media_id");
        if (working.route_map_media_id !== undefined) selectCols.push("route_map_media_id");

        if (editingFeaturedCruiseId) {
          const { data, error } = await supabaseClient
            .from("featured_cruises")
            .update(working)
            .eq("id", editingFeaturedCruiseId)
            .select(selectCols.join(","))
            .single();
          if (!error) return { cruiseId: editingFeaturedCruiseId, savedRow: data, stripped };
          const missing = missingColumnMatch(error.message);
          if (missing && Object.prototype.hasOwnProperty.call(working, missing)) {
            delete working[missing];
            stripped.push(missing);
            continue;
          }
          throw new Error(error.message);
        }

        const insertPayload = { ...working, created_by: currentUser?.id || null };
        const { data, error } = await supabaseClient
          .from("featured_cruises")
          .insert(insertPayload)
          .select(selectCols.join(","))
          .single();
        if (!error) return { cruiseId: data.id, savedRow: data, stripped };
        const missing = missingColumnMatch(error.message);
        if (missing && Object.prototype.hasOwnProperty.call(working, missing)) {
          delete working[missing];
          stripped.push(missing);
          continue;
        }
        throw new Error(error.message);
      }
      throw new Error("Could not save cruise because required database columns are missing.");
    };

    const { cruiseId, savedRow, stripped } = await saveCruiseRow(payload);

    if (payload.hero_media_id && savedRow && "hero_media_id" in savedRow && savedRow.hero_media_id !== payload.hero_media_id) {
      throw new Error(
        "Hero image did not save. Confirm the Media Library migration has been applied (hero_media_id column)."
      );
    }
    if (
      payload.route_map_media_id &&
      savedRow &&
      "route_map_media_id" in savedRow &&
      savedRow.route_map_media_id !== payload.route_map_media_id
    ) {
      throw new Error(
        "Route map did not save. Confirm the Media Library migration has been applied (route_map_media_id column)."
      );
    }
    if (stripped.length) {
      console.warn("featured_cruises save omitted missing columns", stripped);
    }

    // Do not modify featured_cruise_ports in this workflow.

    const { error: deletePricingError } = await supabaseClient
      .from("featured_cruise_pricing")
      .delete()
      .eq("featured_cruise_id", cruiseId);
    if (deletePricingError) throw new Error(`Cruise saved, but pricing could not be updated: ${deletePricingError.message}`);

    if (pricingPayload.length) {
      const rows = pricingPayload.map(({ id, ...rest }) => ({ ...rest, featured_cruise_id: cruiseId }));
      const { error: insertPricingError } = await supabaseClient.from("featured_cruise_pricing").insert(rows);
      if (insertPricingError) throw new Error(`Cruise saved, but pricing could not be saved: ${insertPricingError.message}`);
    }

    if (newsletterChanged) {
      const { error: defaultsError } = await supabaseClient.from("featured_cruise_newsletter_defaults").upsert({
        id: 1,
        newsletter_number: newsletterNumber,
        newsletter_publication_date: draft.newsletter_publication_date || null
      });
      if (defaultsError) console.warn("Newsletter defaults update skipped", defaultsError.message);
      else {
        featuredNewsletterDefaults = {
          newsletter_number: newsletterNumber,
          newsletter_publication_date: draft.newsletter_publication_date || null
        };
      }
    }

    await loadFeaturedCruises();
    showFeaturedCruiseForm = false;
    editingFeaturedCruiseId = null;
    featuredFormPricing = [];
    featuredFormDraft = null;
    featuredSlugManuallyEdited = false;
    featuredCruiseMessage = "Cruise saved.";
    featuredCruiseMessageTone = "success";
  } catch (error) {
    featuredCruiseMessage = error.message || "Could not save cruise.";
    featuredCruiseMessageTone = "error";
  } finally {
    featuredCruiseSaving = false;
    renderAdmin();
  }
}

async function deleteFeaturedCruise(id) {
  if (!window.confirm("Delete this cruise? Its pricing rows will also be deleted.")) return;
  featuredCruiseSaving = true;
  featuredCruiseMessage = "Deleting…";
  featuredCruiseMessageTone = "";
  renderAdmin();
  try {
    const { error } = await supabaseClient.from("featured_cruises").delete().eq("id", id);
    if (error) throw new Error(error.message);
    await loadFeaturedCruises();
    showFeaturedCruiseForm = false;
    editingFeaturedCruiseId = null;
    featuredFormPricing = [];
    featuredFormDraft = null;
    featuredCruiseMessage = "Cruise deleted.";
    featuredCruiseMessageTone = "success";
  } catch (error) {
    featuredCruiseMessage = error.message || "Could not delete cruise.";
    featuredCruiseMessageTone = "error";
  } finally {
    featuredCruiseSaving = false;
    renderAdmin();
  }
}


initAdmin();
