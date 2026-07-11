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
let activeTab = "cruise-lines";
let editingShipId = null;
let editingCruiseLineId = null;
let editingChecklistItemId = null;
let editingChecklistSectionId = null;
let selectedChecklistSectionId = "all";
let editingPackingCategoryId = null;
let editingPackingItemId = null;
let selectedPackingCategoryId = "all";
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
let plannerPreviewMessage = "";
let itineraryReview = null;
let itineraryMessage = "";
let itineraryLoading = false;

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


function renderLogin(message = "") {
  app.innerHTML = `
    <div class="admin-card">
      <h2>101cruise Admin</h2>
      <p class="admin-muted">Sign in with your admin account to manage planner content.</p>

      <div class="admin-field">
        <label>Email address</label>
        <input type="email" id="adminEmail" placeholder="you@example.com">
      </div>

      <div class="admin-field">
        <label>Password</label>
        <input type="password" id="adminPassword">
      </div>

      <button class="admin-button black" onclick="adminSignIn()">Sign In</button>

      <div id="admin-login-message" class="admin-message ${message ? "admin-error" : ""}">${esc(message)}</div>
    </div>
  `;
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

  if (!currentProfile || currentProfile.is_admin !== true) {
    await supabaseClient.auth.signOut();
    currentUser = null;
    currentProfile = null;
    renderLogin("This account does not have admin access.");
    return;
  }

  await loadAdminData();
  renderAdmin();
}

async function adminSignOut() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
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
}

function setTab(tab) {
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
  crmSyncMessage = "";
  crmSyncLoading = false;
  plannerPreviewMessage = "";
  renderAdmin();
}

function renderAdmin() {
  app.innerHTML = `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h2>101cruise Admin</h2>
          <p class="admin-muted">Manage the content used throughout My Cruise Planner.</p>
        </div>
        <div class="admin-actions-row">
          <button class="admin-button secondary small" onclick="toggleImportDataPanel()">${showImportDataPanel ? "Close Import" : "Import Data"}</button>
          <button class="admin-button black small" onclick="adminSignOut()">Sign Out</button>
        </div>
      </div>
    </div>

    ${showImportDataPanel ? renderImportDataPanel() : ""}

    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === "cruise-lines" ? "active" : ""}" onclick="setTab('cruise-lines')">Cruise Lines</button>
      <button class="admin-tab ${activeTab === "ships" ? "active" : ""}" onclick="setTab('ships')">Ships</button>
      <button class="admin-tab ${activeTab === "checklist" ? "active" : ""}" onclick="setTab('checklist')">Checklist</button>
      <button class="admin-tab ${activeTab === "packing" ? "active" : ""}" onclick="setTab('packing')">Packing</button>
      <button class="admin-tab ${activeTab === "smart-profiles" ? "active" : ""}" onclick="setTab('smart-profiles')">Smart Profiles</button>
      <button class="admin-tab ${activeTab === "crm-sync" ? "active" : ""}" onclick="setTab('crm-sync')">CRM Sync</button>
      <button class="admin-tab ${activeTab === "planner-preview" ? "active" : ""}" onclick="setTab('planner-preview')">Planner Preview</button>
    </div>

    ${activeTab === "cruise-lines" ? renderCruiseLinesPanel() : ""}
    ${activeTab === "ships" ? renderShipsPanel() : ""}
    ${activeTab === "checklist" ? renderChecklistPanel() : ""}
    ${activeTab === "packing" ? renderPackingPanel() : ""}
    ${activeTab === "smart-profiles" ? renderSmartProfilesPanel() : ""}
    ${activeTab === "crm-sync" ? renderCrmSyncPanel() : ""}
    ${activeTab === "planner-preview" ? renderPlannerPreviewPanel() : ""}
  `;
}

function toggleImportDataPanel() {
  showImportDataPanel = !showImportDataPanel;
  renderAdmin();
}

function renderCrmSyncPanel() {
  const booking = crmSyncResult && crmSyncResult.booking ? crmSyncResult.booking : null;
  const messageClass = crmSyncMessage && crmSyncMessage.toLowerCase().includes("error") ? "admin-error" : "";

  return `
    <div class="admin-card crm-sync-card">
      <div class="admin-list-top">
        <div>
          <h3>CRM Sync</h3>
          <p class="admin-muted">Test the secure connection between Base44 and 101CRUISE using a booking reference.</p>
        </div>
      </div>

      <div class="crm-sync-form">
        <div class="admin-field crm-sync-input">
          <label>Booking reference</label>
          <input type="text" id="crmBookingReference" placeholder="Example: 4118719" onkeydown="handleCrmSyncKeydown(event)">
        </div>
        <button class="admin-button black" onclick="syncCrmBooking()" ${crmSyncLoading ? "disabled" : ""}>${crmSyncLoading ? "Syncing..." : "Sync Booking"}</button>
      </div>

      <div id="crm-sync-message" class="admin-message ${messageClass}">${esc(crmSyncMessage)}</div>
    </div>

    ${booking ? renderCrmBookingPreview(booking) : `
      <div class="admin-card crm-empty-card">
        <p class="admin-muted">Enter a booking reference above to confirm the Base44 connection and preview the booking data returned to 101CRUISE.</p>
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
        <button class="admin-button black" onclick="openPlannerPreview('${esc(booking.base44_booking_id || booking.booking_reference || '')}')">Preview Planner</button>
        <button class="admin-button secondary" onclick="loadItineraryReview('${esc(booking.base44_booking_id || '')}')">Review Itinerary</button>
        <button class="admin-button secondary" onclick="extractBookingItinerary()" ${itineraryLoading ? "disabled" : ""}>${itineraryLoading ? "Extracting…" : "Extract Booking Confirmation"}</button>
      </div>
      ${renderItineraryReview(booking)}
    </div>
  `;
}


function itineraryAuthHeaders() {
  return supabaseClient.auth.getSession().then(({ data }) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.session?.access_token || ""}`
  }));
}

function renderItineraryReview(booking) {
  const messageClass = itineraryMessage.toLowerCase().includes("error") ? "admin-error" : "";
  const data = itineraryReview?.itinerary_data || null;
  return `
    <section class="itinerary-review-panel">
      <div class="admin-list-top">
        <div>
          <h4>Smart Itinerary Review</h4>
          <p class="admin-muted">Extract the Booking Confirmation, inspect the structured itinerary, correct anything necessary, then approve it. The customer map is not included in this first release.</p>
        </div>
        ${itineraryReview?.status ? `<span class="admin-pill">${esc(itineraryReview.status.replaceAll("_", " "))}</span>` : ""}
      </div>
      <div class="admin-message ${messageClass}">${esc(itineraryMessage)}</div>
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
          <button class="admin-button secondary" onclick="saveItineraryReview(false)">Save Draft</button>
          <button class="admin-button black" onclick="saveItineraryReview(true)">Approve Itinerary</button>
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

function renderPlannerPreviewPanel() {
  const messageClass = plannerPreviewMessage && plannerPreviewMessage.toLowerCase().includes("enter") ? "admin-error" : "";

  return `
    <div class="admin-card planner-preview-card">
      <div class="admin-list-top">
        <div>
          <h3>Planner Preview</h3>
          <p class="admin-muted">Preview a customer planner without signing in as the customer or sending account emails.</p>
        </div>
      </div>

      <div class="crm-sync-form">
        <div class="admin-field crm-sync-input">
          <label>Booking reference or Base44 booking ID</label>
          <input type="text" id="plannerPreviewLookup" placeholder="Example: 4118719 or 6a080226fdbea57912141f3e" onkeydown="handlePlannerPreviewKeydown(event)">
          <div class="admin-helper">Use a booking already in Base44. The preview opens in a new tab and does not require a customer login.</div>
        </div>
        <button class="admin-button black" onclick="openPlannerPreviewFromInput()">Preview Planner</button>
      </div>

      <div class="admin-message ${messageClass}">${esc(plannerPreviewMessage)}</div>
    </div>

    <div class="admin-card crm-empty-card">
      <p class="admin-muted">Use this for testing and demonstrations. Customers will still access their planner through the normal invitation and login flow.</p>
    </div>
  `;
}

function handlePlannerPreviewKeydown(event) {
  if (event.key === "Enter") {
    openPlannerPreviewFromInput();
  }
}

function openPlannerPreviewFromInput() {
  const input = document.getElementById("plannerPreviewLookup");
  const lookup = input ? input.value.trim() : "";
  openPlannerPreview(lookup);
}

function openPlannerPreview(lookup) {
  const safeLookup = String(lookup || "").trim();
  if (!safeLookup) {
    plannerPreviewMessage = "Enter a booking reference or Base44 booking ID first.";
    renderAdmin();
    return;
  }

  const previewUrl = `${window.location.origin}/?preview=${encodeURIComponent(safeLookup)}`;
  window.open(previewUrl, "_blank", "noopener");
  plannerPreviewMessage = "Planner preview opened in a new tab.";
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
  const bookingReference = input ? input.value.trim() : "";

  if (!bookingReference) {
    crmSyncMessage = "Enter a booking reference first.";
    crmSyncResult = null;
    renderAdmin();
    return;
  }

  crmSyncLoading = true;
  itineraryReview = null;
  itineraryMessage = "";
  crmSyncMessage = "Syncing booking from Base44...";
  renderAdmin();

  try {
    const response = await fetch("/.netlify/functions/get-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

crmSyncMessage = "Booking retrieved from Base44 and saved to 101CRUISE.";

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
          <h3>Import Data</h3>
          <p class="admin-muted">Use this global import tool for reusable 101CRUISE data. Today it supports the Smart Packing Planner library; later we can add ships, ports, cruise line links and checklist templates.</p>
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

function renderShipsPanel() {
  const editing = ships.find(ship => ship.id === editingShipId);

  return `
    <div class="admin-grid">
      <div class="admin-card">
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

      <div class="admin-card">
        <h3>Ships</h3>
        <div class="admin-list">
          ${ships.length ? ships.map(ship => `
            <div class="admin-list-item">
              <div class="admin-inline-grid">
                <div>
                  <strong>${esc(ship.name)}</strong>
                  <div class="admin-small">${esc(ship.cruise_lines?.name || "Cruise line not found")}</div>
                  <div class="admin-small">${ship.hero_image_url ? esc(ship.hero_image_url) : "No hero image URL saved"}</div>
                  ${ship.active ? `<span class="admin-pill">Active</span>` : `<span class="admin-pill inactive">Inactive</span>`}<br>
                  <button class="admin-button secondary" onclick="editShip(${ship.id})">Edit</button>
                </div>
                <div>
                  ${ship.hero_image_url
                    ? `<img class="admin-hero-preview" src="${esc(ship.hero_image_url)}" alt="${esc(ship.name)} image" onerror="this.outerHTML='<div class=&quot;admin-empty-preview&quot;>Image could not load</div>'">`
                    : `<div class="admin-empty-preview">No hero image saved yet</div>`
                  }
                </div>
              </div>
            </div>
          `).join("") : `<p>No ships found.</p>`}
        </div>
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

  message.className = "admin-message";
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

  message.className = "admin-message";
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

  message.className = "admin-message";
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

  message.className = "admin-message";
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

  message.className = "admin-message";
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

function renderPackingItemCard(item) {
  const isEditing = String(editingPackingItemId || "") === String(item.id);
  const assignedProfileCount = getPackingProfileIdsForItem(item.id).length;
  const ruleText = isEssentialPackingItem(item)
    ? "Essential item included on every cruise"
    : (assignedProfileCount ? `Smart Profile item (${assignedProfileCount} profile${assignedProfileCount === 1 ? "" : "s"})` : formatPackingRule(item.destination_tags || item.climate_tags || item.traveller_types || item.dress_codes || item.cruise_line_tags, "Profile-specific item"));
  return `
    <div class="admin-list-item admin-clickable-row packing-item-row ${isEditing ? "is-editing" : ""}" onclick="editPackingItem(${item.id})">
      ${isEditing ? `
        <div onclick="event.stopPropagation()">
          ${renderPackingItemForm(item)}
        </div>
      ` : `
        <div class="admin-list-top">
          <div>
            <strong class="checklist-admin-title">${esc(item.name)}</strong>
            <div class="admin-small">Category: ${esc(getPackingCategoryName(item.category_id))}</div>
            <div class="admin-small"><strong>Weight:</strong> ${esc(Number(item.weight_kg || 0).toFixed(2))} kg each</div>
            ${item.description ? `<div class="admin-small">${esc(item.description)}</div>` : ""}
            ${item.help_text ? `<div class="admin-small"><strong>Why:</strong> ${esc(item.help_text)}</div>` : ""}
            <div class="admin-small"><strong>Logic:</strong> ${esc(ruleText)}</div>
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
      ${items.length ? `<div class="admin-packing-item-grid">${items.map(renderPackingItemCard).join("")}</div>` : `<p class="admin-muted">No items in this category.</p>`}
    </div>
  `).join("");

  return html || `<p class="admin-muted">No packing categories found.</p>`;
}

function setPackingCategoryFilter(value) {
  selectedPackingCategoryId = value || "all";
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
            <p class="admin-muted">Items are displayed by category order. Essential items are included on every cruise; other items appear when the visibility rules in “Show this item for” match.</p>
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

async function savePackingItem() {
  const id = document.getElementById("packingItemId").value;
  const payload = {
    category_id: Number(document.getElementById("packingItemCategoryId").value),
    name: document.getElementById("packingItemName").value.trim(),
    description: document.getElementById("packingItemDescription").value.trim() || null,
    item_type: document.getElementById("packingItemType").value,
    weight_kg: Number(document.getElementById("packingItemWeightKg").value || 0),
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
      display_order: index + 1,
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


async function initAdmin() {
  const { data } = await supabaseClient.auth.getSession();

  if (!data.session) {
    renderLogin();
    return;
  }

  currentUser = data.session.user;
  await loadProfile();

  if (!currentProfile || currentProfile.is_admin !== true) {
    renderLogin("This account does not have admin access.");
    return;
  }

  await loadAdminData();
  renderAdmin();
}

initAdmin();
