const SUPABASE_URL = "https://xikbibxyinttllxamgao.supabase.co";
const SUPABASE_KEY = "sb_publishable_MEFg6spz5_Uod7sZGU8whw_UvOQDW60";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("cruise-planner-app");

let currentUser = null;
let currentProfile = null;
let countdownTimer = null;
let pendingInvitationBid = null;
let invitationSyncMessage = "";
let invitationSyncLoading = false;
let adminPreviewMode = false;
let adminPreviewLookup = "";
let adminPreviewCruise = null;
let adminPreviewError = "";
let adminPreviewPackedKeys = new Set();
let customerMode = false;
let customerSessionToken = "";
let customerBooking = null;
let customerCruise = null;
let customerPackingPreferences = null;
const CUSTOMER_SESSION_STORAGE_KEY = "101cruise_customer_session";

const CRUISE_LINES = [
  "Carnival Cruise Line",
  "Celebrity Cruises",
  "Cunard",
  "Disney Cruise Line",
  "Explora Journeys",
  "Holland America Line",
  "MSC Cruises",
  "Norwegian Cruise Line",
  "P&O Cruises",
  "Princess Cruises",
  "Royal Caribbean",
  "Seabourn",
  "Silversea",
  "Viking",
  "Virgin Voyages"
];

const SHIPS_BY_CRUISE_LINE = {
  "Carnival Cruise Line": ["Carnival Luminosa", "Carnival Splendor", "Carnival Spirit", "Carnival Adventure", "Carnival Encounter"],
  "Celebrity Cruises": ["Celebrity Edge", "Celebrity Solstice", "Celebrity Eclipse", "Celebrity Beyond", "Celebrity Xcel"],
  "Cunard": ["Queen Anne", "Queen Elizabeth", "Queen Mary 2", "Queen Victoria"],
  "Disney Cruise Line": ["Disney Magic", "Disney Wonder", "Disney Dream", "Disney Fantasy", "Disney Wish", "Disney Treasure"],
  "Explora Journeys": ["Explora I", "Explora II", "Explora III"],
  "Holland America Line": ["Koningsdam", "Nieuw Amsterdam", "Noordam", "Oosterdam", "Westerdam", "Zaandam"],
  "MSC Cruises": ["MSC Magnifica", "MSC Meraviglia", "MSC Opera", "MSC Seascape", "MSC Virtuosa", "MSC World Europa"],
  "Norwegian Cruise Line": ["Norwegian Aqua", "Norwegian Bliss", "Norwegian Encore", "Norwegian Spirit", "Norwegian Sun", "Pride of America"],
  "P&O Cruises": ["Pacific Adventure", "Pacific Encounter", "Pacific Explorer"],
  "Princess Cruises": ["Crown Princess", "Diamond Princess", "Discovery Princess", "Grand Princess", "Majestic Princess", "Royal Princess", "Ruby Princess", "Sapphire Princess", "Star Princess", "Sun Princess"],
  "Royal Caribbean": ["Anthem of the Seas", "Brilliance of the Seas", "Icon of the Seas", "Ovation of the Seas", "Quantum of the Seas", "Radiance of the Seas", "Spectrum of the Seas", "Voyager of the Seas", "Wonder of the Seas"],
  "Seabourn": ["Seabourn Encore", "Seabourn Odyssey", "Seabourn Ovation", "Seabourn Pursuit", "Seabourn Quest", "Seabourn Venture"],
  "Silversea": ["Silver Dawn", "Silver Endeavour", "Silver Moon", "Silver Muse", "Silver Nova", "Silver Ray", "Silver Shadow", "Silver Spirit", "Silver Whisper"],
  "Viking": ["Viking Orion", "Viking Saturn", "Viking Sky", "Viking Star", "Viking Venus"],
  "Virgin Voyages": ["Brilliant Lady", "Resilient Lady", "Scarlet Lady", "Valiant Lady"]
};

const CRUISE_LINE_LOGOS = {
  "Royal Caribbean": "https://images.squarespace-cdn.com/content/6603b29b5ae2121e71e653f4/f27d4b7b-ea8e-4f24-8670-672a4ed6b93e/Royal+Caribbean+.png?content-type=image%2Fpng"
};

const SHIP_IMAGES = {
  // Add Squarespace ship image URLs here later. Example:
  // "Ovation of the Seas": "https://images.squarespace-cdn.com/.../ovation-of-the-seas.jpg"
};


function getInvitationBookingIdFromUrl() {
  const params = new URLSearchParams(window.location.search || "");
  return String(params.get("bid") || params.get("booking_id") || "").trim();
}

function getStoredInvitationBookingId() {
  return String(localStorage.getItem("101cruise_pending_bid") || "").trim();
}

function setStoredInvitationBookingId(value) {
  const safeValue = String(value || "").trim();
  if (safeValue) {
    localStorage.setItem("101cruise_pending_bid", safeValue);
    pendingInvitationBid = safeValue;
  }
}

function clearStoredInvitationBookingId() {
  localStorage.removeItem("101cruise_pending_bid");
  pendingInvitationBid = null;
}

function captureInvitationBookingId() {
  const bid = getInvitationBookingIdFromUrl();
  if (bid) setStoredInvitationBookingId(bid);
  pendingInvitationBid = getStoredInvitationBookingId();
}

function getAdminPreviewLookupFromUrl() {
  const params = new URLSearchParams(window.location.search || "");
  return String(params.get("preview") || params.get("admin_preview") || "").trim();
}

function isLikelyBase44BookingId(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || "").trim());
}

function createPreviewCruiseFromBase44Booking(booking) {
  const nights = calculateCruiseNights(booking.departing_date, booking.arriving_date);
  const passengerNames = getPassengerNamesFromBase44Booking(booking);
  const passengerCount = getPassengerCountFromBase44Booking(booking);

  return {
    id: `preview-${booking.base44_booking_id || booking.booking_reference || "booking"}`,
    base44_booking_id: booking.base44_booking_id || null,
    booking_reference: booking.booking_reference || null,
    cruise_line: booking.cruise_line || null,
    ship_name: booking.cruise_ship || null,
    departure_date: booking.departing_date || null,
    return_date: booking.arriving_date || null,
    arrival_date: booking.arriving_date || null,
    departure_time: null,
    nights,
    embarkation_port: booking.departing_port || null,
    departure_port: booking.departing_port || null,
    disembarkation_port: booking.arriving_port || null,
    arrival_port: booking.arriving_port || null,
    cabin_number: booking.room_number || null,
    cabin: booking.room_number || null,
    cabin_type: booking.room_type || booking.category_class || null,
    traveller_names: passengerNames || null,
    traveller_count: passengerCount,
    booking_status: booking.booking_status || null,
    _preview_booking: booking
  };
}

function renderAdminPreviewLoading(lookup) {
  clearCountdownTimer();
  app.innerHTML = `
    <div class="planner-preview-loading">
      <div class="planner-card">
        <p class="planner-kicker">Admin preview mode</p>
        <h2>Loading planner preview</h2>
        <p class="planner-muted">Retrieving booking ${escapeHtml(lookup)} from Base44.</p>
      </div>
    </div>
  `;
}

function renderAdminPreviewError(message) {
  clearCountdownTimer();
  app.innerHTML = `
    <div class="planner-preview-loading">
      <div class="planner-card">
        <p class="planner-kicker">Admin preview mode</p>
        <h2>Preview could not be loaded</h2>
        <p class="planner-muted">${escapeHtml(message || "Unable to retrieve this booking.")}</p>
        <button class="planner-button secondary" onclick="window.close()">Close Preview</button>
      </div>
    </div>
  `;
}

async function loadAdminPreview(lookup) {
  adminPreviewMode = true;
  adminPreviewLookup = lookup;
  adminPreviewCruise = null;
  adminPreviewError = "";
  adminPreviewPackedKeys = new Set();
  currentUser = { id: "admin-preview", email: "admin-preview@101cruise.com.au", user_metadata: { first_name: "Admin" } };
  currentProfile = { first_name: "Admin" };

  renderAdminPreviewLoading(lookup);

  try {
    const payload = isLikelyBase44BookingId(lookup)
      ? { booking_id: lookup }
      : { booking_reference: lookup };

    const response = await fetch("/.netlify/functions/get-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({ success: false, error: "Invalid response from booking service" }));

    if (!response.ok || data.success === false || !data.booking) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    adminPreviewCruise = createPreviewCruiseFromBase44Booking(data.booking);
    currentProfile = { first_name: data.booking.passenger1_first_name || "Admin" };
    await renderDashboard();
  } catch (error) {
    console.error("Admin preview failed", error);
    adminPreviewError = error.message || "Unable to load preview";
    renderAdminPreviewError(adminPreviewError);
  }
}

function exitAdminPreview() {
  window.location.href = window.location.origin;
}

function renderAdminPreviewBanner(cruise) {
  if (!adminPreviewMode) return "";
  const reference = getCruiseBookingReference(cruise) || adminPreviewLookup;
  return `
    <div class="admin-preview-banner">
      <div>
        <strong>Admin Preview Mode</strong>
        <span>Viewing booking ${escapeHtml(reference || "preview")}. Customer login is not required.</span>
      </div>
      <button onclick="exitAdminPreview()">Exit Preview</button>
    </div>
  `;
}

function renderInvitationIntro() {
  const bid = pendingInvitationBid || getStoredInvitationBookingId();
  if (!bid) return "";

  return `
    <div class="planner-card invitation-card">
      <p class="planner-kicker">101CRUISE invitation</p>
      <h2>Welcome to your cruise planner</h2>
      <p class="planner-muted">Create your password or sign in below. Your cruise booking will be retrieved automatically and added to My Cruise.</p>
      ${invitationSyncMessage ? `<div class="planner-message ${invitationSyncMessage.toLowerCase().includes("error") ? "planner-error" : "planner-success"}">${escapeHtml(invitationSyncMessage)}</div>` : ""}
    </div>
  `;
}

function calculateCruiseNights(departingDate, arrivingDate) {
  if (!departingDate || !arrivingDate) return null;
  const start = new Date(`${departingDate}T00:00:00`);
  const end = new Date(`${arrivingDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const diff = Math.round((end - start) / 86400000);
  return diff > 0 ? diff : null;
}

function getPassengerNamesFromBase44Booking(booking) {
  const passenger1 = [booking.passenger1_first_name, booking.passenger1_last_name].filter(Boolean).join(" ").trim();
  const passenger2 = [booking.passenger2_first_name, booking.passenger2_last_name].filter(Boolean).join(" ").trim();
  return [passenger1, passenger2].filter(Boolean).join(", ");
}

function getPassengerCountFromBase44Booking(booking) {
  return [booking.passenger1_first_name, booking.passenger2_first_name].filter(Boolean).length || 1;
}

async function syncInvitationBookingForCurrentUser() {
  if (!currentUser?.id) return null;

  const bookingId = pendingInvitationBid || getStoredInvitationBookingId();
  if (!bookingId) return null;

  invitationSyncLoading = true;
  invitationSyncMessage = "Retrieving your cruise booking...";

  try {
    const response = await fetch("/.netlify/functions/get-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking_id: bookingId })
    });

    const data = await response.json().catch(() => ({ success: false, error: "Invalid response from booking service" }));

    if (!response.ok || data.success === false || !data.booking) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    const cruise = await createOrUpdateCruiseFromBase44Booking(data.booking, data.cache_id || null);
    await savePlannerPreferenceForCruise(cruise);
    clearStoredInvitationBookingId();
    invitationSyncMessage = "Your cruise booking has been added to My Cruise.";
    return cruise;
  } catch (error) {
    console.error("Invitation booking sync failed", error);
    invitationSyncMessage = `Error: ${error.message || "Unable to retrieve your cruise booking"}`;
    return null;
  } finally {
    invitationSyncLoading = false;
  }
}

async function createOrUpdateCruiseFromBase44Booking(booking, cacheId = null) {
  const nights = calculateCruiseNights(booking.departing_date, booking.arriving_date);
  const passengerNames = getPassengerNamesFromBase44Booking(booking);
  const passengerCount = getPassengerCountFromBase44Booking(booking);

  const payload = {
    user_id: currentUser.id,
    base44_booking_id: booking.base44_booking_id || null,
    base44_booking_cache_id: cacheId,
    booking_reference: booking.booking_reference || null,
    cruise_line: booking.cruise_line || null,
    ship_name: booking.cruise_ship || null,
    departure_date: booking.departing_date || null,
    return_date: booking.arriving_date || null,
    arrival_date: booking.arriving_date || null,
    departure_time: null,
    nights,
    embarkation_port: booking.departing_port || null,
    departure_port: booking.departing_port || null,
    disembarkation_port: booking.arriving_port || null,
    arrival_port: booking.arriving_port || null,
    cabin_number: booking.room_number || null,
    cabin: booking.room_number || null,
    cabin_type: booking.room_type || booking.category_class || null,
    traveller_names: passengerNames || null,
    traveller_count: passengerCount,
    booking_status: booking.booking_status || null
  };

  const { data, error } = await supabaseClient
    .from("cruises")
    .upsert(payload, { onConflict: "user_id,base44_booking_id" })
    .select("*")
    .single();

  if (error) {
    console.error("Create/update cruise from Base44 failed", error);
    throw error;
  }

  return data;
}


function getStoredCustomerSession() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOMER_SESSION_STORAGE_KEY) || sessionStorage.getItem(CUSTOMER_SESSION_STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function storeCustomerSession(session, remember) {
  localStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY);
  sessionStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY);
  const storage = remember ? localStorage : sessionStorage;
  storage.setItem(CUSTOMER_SESSION_STORAGE_KEY, JSON.stringify(session));
}

function clearCustomerSession() {
  localStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY);
  sessionStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY);
  customerMode = false;
  customerSessionToken = "";
  customerBooking = null;
  customerCruise = null;
  customerPackingPreferences = null;
}

function activateCustomerSession(session) {
  if (!session?.token || !session?.booking) return false;
  customerMode = true;
  customerSessionToken = session.token;
  customerBooking = session.booking;
  customerCruise = createPreviewCruiseFromBase44Booking(session.booking);
  currentUser = {
    id: `customer:${session.booking.base44_booking_id || session.booking.booking_reference}`,
    email: session.booking.passenger1_email || "",
    user_metadata: { first_name: session.booking.passenger1_first_name || "Guest" }
  };
  currentProfile = {
    first_name: formatPackingDisplayName(session.booking.passenger1_first_name || "Guest"),
    last_name: formatPackingDisplayName(session.booking.passenger1_last_name || "")
  };
  return true;
}

function renderCustomerAccess(message = "", isError = false) {
  clearCountdownTimer();
  app.innerHTML = `
    <main class="customer-access-page">
      <section class="customer-access-card planner-card">
        <img class="customer-access-logo" src="assets/101cruise-logo-black.png" alt="101cruise">
        <p class="planner-kicker">My Cruise</p>
        <h1>Welcome to My Cruise</h1>
        <p class="planner-muted">Access your personalised cruise planner using your booking number and surname.</p>
        <div class="planner-field">
          <label for="customerBookingNumber">Booking number</label>
          <input id="customerBookingNumber" type="text" autocomplete="off" autocapitalize="characters" placeholder="SWM123456">
        </div>
        <div class="planner-field">
          <label for="customerSurname">Lead traveller surname</label>
          <input id="customerSurname" type="text" autocomplete="family-name" autocapitalize="characters" placeholder="MUMMERY" onkeydown="if(event.key === 'Enter') accessMyCruise()">
        </div>
        <label class="customer-remember-row"><input id="rememberCustomerBooking" type="checkbox" checked><span>Remember me on this device</span></label>
        <button id="customerAccessButton" class="planner-button black customer-access-button" onclick="accessMyCruise()">Open My Cruise</button>
        <div id="customer-access-message" class="planner-message ${isError ? "planner-error" : ""}">${escapeHtml(message)}</div>
        <details class="customer-existing-account"><summary>Use an existing planner account</summary><div class="customer-account-login"><input id="signinEmail" type="email" placeholder="Email address"><input id="signinPassword" type="password" placeholder="Password"><button class="planner-button secondary" onclick="signIn()">Sign In</button><div id="signin-message" class="planner-message"></div></div></details>
      </section>
    </main>`;
}

async function accessMyCruise() {
  const bookingReference = String(document.getElementById("customerBookingNumber")?.value || "").trim().toUpperCase();
  const surname = String(document.getElementById("customerSurname")?.value || "").trim().toUpperCase();
  const remember = document.getElementById("rememberCustomerBooking")?.checked === true;
  const button = document.getElementById("customerAccessButton");
  const message = document.getElementById("customer-access-message");
  if (!bookingReference || !surname) {
    if (message) message.textContent = "Enter both the booking number and lead traveller surname.";
    return;
  }
  if (button) { button.disabled = true; button.textContent = "Opening My Cruise…"; }
  if (message) message.textContent = "";
  try {
    const response = await fetch("/.netlify/functions/customer-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking_reference: bookingReference, surname })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || "We couldn't find a booking matching those details. Please check the booking number and lead traveller surname.");
    const session = { token: data.token, booking: data.booking };
    storeCustomerSession(session, remember);
    activateCustomerSession(session);
    await renderDashboard();
  } catch (error) {
    if (message) message.textContent = error.message || "We couldn't find a booking matching those details. Please check the booking number and lead traveller surname.";
    if (button) { button.disabled = false; button.textContent = "Open My Cruise"; }
  }
}

function changeCustomerBooking() {
  clearCustomerSession();
  activePackingProfileKey = null;
  packingV2Profiles = [];
  packingV2State = [];
  renderCustomerAccess();
}

async function customerProgressRequest(action, payload = {}) {
  const response = await fetch("/.netlify/functions/customer-progress", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customerSessionToken}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401) {
    clearCustomerSession();
    renderCustomerAccess("Your booking session has expired. Please access My Cruise again.", true);
    throw new Error("Customer session expired");
  }
  if (!response.ok || !data?.success) throw new Error(data?.error || "Could not save your progress.");
  return data;
}

async function customerPackingRequest(action, payload = {}) {
  const response = await fetch("/.netlify/functions/customer-packing", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customerSessionToken}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401) {
    clearCustomerSession();
    renderCustomerAccess("Your booking session has expired. Please access My Cruise again.", true);
    throw new Error("Customer session expired");
  }
  if (!response.ok || !data?.success) throw new Error(data?.error || "Could not save your packing changes.");
  return data;
}

async function customerDocumentsRequest(action, payload = {}) {
  const response = await fetch("/.netlify/functions/customer-documents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customerSessionToken}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401) {
    clearCustomerSession();
    renderCustomerAccess("Your booking session has expired. Please access My Cruise again.", true);
    throw new Error("Customer session expired");
  }
  if (!response.ok || !data?.success) throw new Error(data?.error || "Could not access your documents.");
  return data;
}

function renderLogin() {
  clearCountdownTimer();

  app.innerHTML = `
    ${renderInvitationIntro()}
    <div class="planner-grid auth-grid">
      <div class="planner-card auth-card">
        <h2>Create Account</h2>
        <p class="planner-muted">Create your free account to start planning your cruise.</p>

        <div class="planner-field">
          <label>First name</label>
          <input type="text" id="signupFirstName" placeholder="Steve">
        </div>

        <div class="planner-field">
          <label>Last name</label>
          <input type="text" id="signupLastName" placeholder="Smith">
        </div>

        <div class="planner-field">
          <label>Email address</label>
          <input type="email" id="signupEmail" placeholder="you@example.com">
        </div>

        <div class="planner-field">
          <label>Password</label>
          <input type="password" id="signupPassword" placeholder="Minimum 6 characters">
        </div>

        <button class="planner-button" onclick="signUp()">Create Account</button>
        <div id="signup-message" class="planner-message"></div>
      </div>

      <div class="planner-card auth-card">
        <h2>Sign In</h2>
        <p class="planner-muted">Already have an account? Sign in to continue planning.</p>

        <div class="planner-field">
          <label>Email address</label>
          <input type="email" id="signinEmail" placeholder="you@example.com">
        </div>

        <div class="planner-field">
          <label>Password</label>
          <input type="password" id="signinPassword">
        </div>

        <button class="planner-button black" onclick="signIn()">Sign In</button>
        <div id="signin-message" class="planner-message"></div>
      </div>
    </div>
  `;
}

async function signUp() {
  const firstName = document.getElementById("signupFirstName").value.trim();
  const lastName = document.getElementById("signupLastName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: firstName,
        last_name: lastName
      }
    }
  });

  if (error) {
    document.getElementById("signup-message").innerText = error.message;
    return;
  }

  if (data.session && data.user) {
    currentUser = data.user;
    await ensureProfile();
    await loadProfile();
    await syncInvitationBookingForCurrentUser();
    renderDashboard();
    return;
  }

  document.getElementById("signup-message").innerText = "Account created. Please check your email to confirm your account, then sign in here to open My Cruise.";
}

async function signIn() {
  const email = document.getElementById("signinEmail").value.trim();
  const password = document.getElementById("signinPassword").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    document.getElementById("signin-message").innerText = error.message;
    return;
  }

  currentUser = data.user;
  await ensureProfile();
  await loadProfile();
  await syncInvitationBookingForCurrentUser();
  renderDashboard();
}

async function signOut() {
  if (customerMode) { changeCustomerBooking(); return; }
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  renderLogin();
}

async function ensureProfile() {
  const firstName = currentUser.user_metadata?.first_name || "";
  const lastName = currentUser.user_metadata?.last_name || "";

  await supabaseClient.from("profiles").upsert({
    id: currentUser.id,
    first_name: firstName,
    last_name: lastName
  });
}

async function loadProfile() {
  const { data } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  currentProfile = data;
}

async function loadPlannerPreference() {
  if (!currentUser?.id) return null;

  const { data, error } = await supabaseClient
    .from("user_planner_preferences")
    .select("*")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.warn("Planner preference load failed", error);
    return null;
  }

  return data || null;
}

async function savePlannerPreferenceForCruise(cruise) {
  if (!currentUser?.id || !cruise) return;

  const bookingReference = getCruiseBookingReference(cruise);

  const { error } = await supabaseClient
    .from("user_planner_preferences")
    .upsert({
      user_id: currentUser.id,
      last_active_cruise_id: cruise.id || null,
      last_active_booking_reference: bookingReference || null,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

  if (error) console.warn("Planner preference save failed", error);
}

function getCruiseBookingReference(cruise) {
  return String(
    cruise?.booking_reference ||
    cruise?.cruise_booking_reference ||
    cruise?.booking_ref ||
    cruise?.reference ||
    ""
  ).trim();
}

function isUpcomingCruise(cruise) {
  if (!cruise?.departure_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const depart = new Date(`${cruise.departure_date}T00:00:00`);
  return !Number.isNaN(depart.getTime()) && depart >= today;
}

function selectActiveCruise(cruises, preference) {
  const safeCruises = cruises || [];
  if (!safeCruises.length) return null;

  if (preference?.last_active_cruise_id) {
    const byId = safeCruises.find(cruise => String(cruise.id) === String(preference.last_active_cruise_id));
    if (byId) return byId;
  }

  if (preference?.last_active_booking_reference) {
    const byReference = safeCruises.find(cruise =>
      getCruiseBookingReference(cruise) &&
      getCruiseBookingReference(cruise) === String(preference.last_active_booking_reference).trim()
    );
    if (byReference) return byReference;
  }

  return safeCruises.find(isUpcomingCruise) || safeCruises[0];
}

function renderCruiseSwitcher(cruises, activeCruise) {
  const safeCruises = cruises || [];
  if (!safeCruises.length) return "";

  return `
    <div class="cruise-switcher">
      <button class="cruise-switcher-button" onclick="toggleCruiseSwitcher()">Switch Cruise ▾</button>
      <div id="cruiseSwitcherMenu" class="cruise-switcher-menu" hidden>
        <div class="cruise-switcher-heading">Your cruises</div>
        ${safeCruises.map(cruise => `
          <button class="cruise-switcher-item ${cruise.id === activeCruise?.id ? "active" : ""}" onclick="switchActiveCruise(${cruise.id})">
            <span>${escapeHtml(cruise.ship_name || cruise.cruise_line || "Cruise")}</span>
            <small>${escapeHtml(formatDateShort(cruise.departure_date))}</small>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function toggleCruiseSwitcher() {
  const menu = document.getElementById("cruiseSwitcherMenu");
  if (!menu) return;
  menu.hidden = !menu.hidden;
}

async function switchActiveCruise(cruiseId) {
  const { data, error } = await supabaseClient
    .from("cruises")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("id", cruiseId)
    .maybeSingle();

  if (error || !data) {
    console.warn("Could not switch cruise", error);
    return;
  }

  await savePlannerPreferenceForCruise(data);
  renderDashboard();
}


function normaliseName(value) {
  return String(value || "").trim().toLowerCase();
}

function renderCruiseLineOptions(selectedValue = "") {
  return `<option value="">Select a cruise line</option>` + CRUISE_LINES.map(line => `
    <option value="${line}" ${line === selectedValue ? "selected" : ""}>${line}</option>
  `).join("");
}

function renderShipOptions(cruiseLine, selectedShip = "") {
  const ships = SHIPS_BY_CRUISE_LINE[cruiseLine] || [];
  const options = ships.map(ship => `
    <option value="${ship}" ${ship === selectedShip ? "selected" : ""}>${ship}</option>
  `).join("");

  return `<option value="">${cruiseLine ? "Select a ship" : "Choose a cruise line first"}</option>` + options;
}

function updateShipDropdown() {
  const cruiseLine = document.getElementById("cruiseLine")?.value || "";
  const shipSelect = document.getElementById("shipName");
  if (!shipSelect) return;
  shipSelect.innerHTML = renderShipOptions(cruiseLine);
}

function getCruiseLineLogo(cruiseLine) {
  return CRUISE_LINE_LOGOS[cruiseLine] || "";
}

async function loadCruiseLineLogo(cruiseLine) {
  const fallbackLogo = getCruiseLineLogo(cruiseLine);
  if (!cruiseLine) return fallbackLogo;

  const safeCruiseLine = String(cruiseLine).trim();
  if (!safeCruiseLine) return fallbackLogo;

  // First try a normal case-insensitive exact match.
  let { data, error } = await supabaseClient
    .from("cruise_lines")
    .select("name, logo_url")
    .ilike("name", safeCruiseLine)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  // If the stored cruise value is shortened, for example "Explora" instead of
  // "Explora Journeys", try a partial match as a fallback.
  if (!error && !data?.logo_url) {
    const partial = safeCruiseLine.replace(/[%_]/g, "").trim();
    if (partial.length >= 3) {
      const partialResult = await supabaseClient
        .from("cruise_lines")
        .select("name, logo_url")
        .ilike("name", `%${partial}%`)
        .eq("active", true)
        .limit(1)
        .maybeSingle();

      data = partialResult.data || data;
      error = partialResult.error || error;
    }
  }

  if (error) {
    console.warn("Cruise line logo lookup failed", error);
    return fallbackLogo;
  }

  return data?.logo_url || fallbackLogo;
}

function getShipImage(shipName) {
  return SHIP_IMAGES[shipName] || "";
}

async function loadShipHeroImage(shipName) {
  const defaultImage = "assets/default-cruise-hero.jpg";
  const fallbackImage = getShipImage(shipName) || defaultImage;
  if (!shipName) return fallbackImage;

  const safeShipName = String(shipName).trim();
  if (!safeShipName) return fallbackImage;

  const { data, error } = await supabaseClient
    .from("ships")
    .select("name, hero_image_url")
    .ilike("name", safeShipName)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Ship hero image lookup failed", error);
    return fallbackImage;
  }

  return data?.hero_image_url || fallbackImage;
}

function renderLogoMarkup(cruiseLine) {
  const logo = getCruiseLineLogo(cruiseLine);
  if (!logo) return "";
  return `<img class="planner-logo" src="${logo}" alt="${cruiseLine} logo">`;
}

function formatDate(dateString) {
  if (!dateString) return "Date not added";

  const date = new Date(dateString + "T00:00:00");

  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatDateShort(dateString) {
  if (!dateString) return "Date not added";

  const date = new Date(dateString + "T00:00:00");

  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatTime(timeString) {
  const safeTime = timeString || "17:00";
  const [hours, minutes] = safeTime.split(":").map(Number);
  const date = new Date();
  date.setHours(hours || 0, minutes || 0, 0, 0);

  return date.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function getDepartureDateTime(cruise) {
  if (!cruise?.departure_date) return null;

  const dateParts = String(cruise.departure_date).split("-").map(Number);
  if (dateParts.length !== 3 || dateParts.some(isNaN)) return null;

  const rawTime = String(cruise.departure_time || "17:00");
  const timeParts = rawTime.split(":").map(Number);

  const year = dateParts[0];
  const monthIndex = dateParts[1] - 1;
  const day = dateParts[2];
  const hours = Number.isFinite(timeParts[0]) ? timeParts[0] : 17;
  const minutes = Number.isFinite(timeParts[1]) ? timeParts[1] : 0;

  return new Date(year, monthIndex, day, hours, minutes, 0, 0);
}

function getCountdownParts(cruise) {
  const target = getDepartureDateTime(cruise);
  if (!target) {
    return { days: "—", hours: "—", minutes: "—", seconds: "—", totalDays: null };
  }

  const now = new Date();
  let diff = target.getTime() - now.getTime();

  if (diff < 0) diff = 0;

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return { days, hours, minutes, seconds, totalDays: days };
}

function padNumber(value) {
  if (value === "—") return "—";
  return String(value).padStart(2, "0");
}

function getNextStep(days) {
  if (days === null) {
    return {
      icon: "🚢",
      title: "Add your departure date to activate your cruise countdown.",
      copy: "Once your departure date is added, this planner will guide you through the right next steps before you sail.",
      buttonText: "",
      buttonUrl: ""
    };
  }

  if (days <= 0) {
    return {
      icon: "🚢",
      title: "Bon Voyage!",
      copy: "Have an amazing cruise from everyone at 101cruise.com.au.",
      buttonText: "",
      buttonUrl: ""
    };
  }

  if (days <= 2) {
    return {
      icon: "🛂",
      title: "Get your passport, tickets and travel money sorted.",
      copy: "Print your cruise and airline tickets, check your passport is packed, and make sure your money or cards are ready for travel.",
      buttonText: "",
      buttonUrl: ""
    };
  }

  if (days <= 7) {
    return {
      icon: "🎒",
      title: "You'd better start packing!",
      copy: "This is the time to lay everything out, check the essentials, and make sure nothing important is missing.",
      buttonText: "Open Packing List",
      buttonUrl: "#"
    };
  }

  if (days <= 14) {
    return {
      icon: "📋",
      title: "Have you completed your online check-in and reviewed your cruise documents?",
      copy: "Check your cruise documents carefully and make sure any online check-in requirements are complete.",
      buttonText: "Open Cruise Checklist",
      buttonUrl: "#"
    };
  }

  if (days <= 30) {
    return {
      icon: "🧳",
      title: "It's time to start thinking about what to pack.",
      copy: "Start planning clothing, medication, travel documents, chargers and cruise essentials before the final week arrives.",
      buttonText: "Open Packing List",
      buttonUrl: "#"
    };
  }

  if (days <= 45) {
    return {
      icon: "🍹",
      title: "Have you organised your drinks package?",
      copy: "Compare the cost of buying drinks as you go against the daily package price before you sail.",
      buttonText: "Compare Drinks Packages",
      buttonUrl: "/drinks-package-calculator"
    };
  }

  if (days <= 60) {
    return {
      icon: "🏨",
      title: "Have you booked your pre-cruise hotel?",
      copy: "If you're travelling to the port the day before, now is a good time to organise accommodation close to the terminal.",
      buttonText: "",
      buttonUrl: ""
    };
  }

  if (days <= 100) {
    return {
      icon: "🛂",
      title: "Check your passport has enough validity after your cruise.",
      copy: "Many cruise itineraries require your passport to remain valid well beyond your return date.",
      buttonText: "",
      buttonUrl: ""
    };
  }

  if (days <= 180) {
    return {
      icon: "✈️",
      title: "It's a good time to think about flights and travel arrangements.",
      copy: "If you need flights, transfers, parking or hotel stays, now is a sensible time to start planning.",
      buttonText: "",
      buttonUrl: ""
    };
  }

  return {
    icon: "🎉",
    title: "Your cruise is booked. Enjoy the anticipation.",
    copy: "Your next adventure is on the horizon. We'll help you stay organised as your sailing gets closer.",
    buttonText: "",
    buttonUrl: ""
  };
}

function clearCountdownTimer() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateLiveCountdown(cruise) {
  const parts = getCountdownParts(cruise);
  const nextStep = getNextStep(parts.totalDays);

  const daysEl = document.getElementById("countdownDays");
  const hoursEl = document.getElementById("countdownHours");
  const minutesEl = document.getElementById("countdownMinutes");
  const secondsEl = document.getElementById("countdownSeconds");
  const simpleDaysEl = document.getElementById("simpleDays");
  const nextStepIconEl = document.getElementById("nextStepIcon");
  const nextStepTitleEl = document.getElementById("nextStepTitle");
  const nextStepCopyEl = document.getElementById("nextStepCopy");
  const nextStepButtonEl = document.getElementById("nextStepButton");
  const heroCountdownTextEl = document.getElementById("heroCountdownText");

  if (heroCountdownTextEl) heroCountdownTextEl.innerText = getDashboardCountdownText(cruise);
  if (daysEl) daysEl.innerText = parts.days;
  if (hoursEl) hoursEl.innerText = padNumber(parts.hours);
  if (minutesEl) minutesEl.innerText = padNumber(parts.minutes);
  if (secondsEl) secondsEl.innerText = padNumber(parts.seconds);
  if (simpleDaysEl) simpleDaysEl.innerText = parts.days;
  if (nextStepIconEl) nextStepIconEl.innerText = nextStep.icon;
  if (nextStepTitleEl) nextStepTitleEl.innerText = nextStep.title;
  if (nextStepCopyEl) nextStepCopyEl.innerText = nextStep.copy;
  if (nextStepButtonEl) {
    if (nextStep.buttonText && nextStep.buttonUrl) {
      nextStepButtonEl.style.display = "inline-block";
      nextStepButtonEl.innerText = nextStep.buttonText;
      nextStepButtonEl.setAttribute("href", nextStep.buttonUrl);
    } else {
      nextStepButtonEl.style.display = "none";
      nextStepButtonEl.innerText = "";
      nextStepButtonEl.setAttribute("href", "#");
    }
  }
}

function startLiveCountdown(cruise) {
  clearCountdownTimer();
  updateLiveCountdown(cruise);
  countdownTimer = setInterval(() => updateLiveCountdown(cruise), 1000);
}

async function loadDashboardChecklistData(cruise) {
  const { data: items, error: itemError } = await supabaseClient
    .from("checklist_items")
    .select("*")
    .eq("active", true)
    .order("display_order", { ascending: true });

  let progressRows = [];
  if (cruise && customerMode) {
    try {
      const data = await customerProgressRequest("load_checklist");
      progressRows = data.progress || [];
    } catch (error) {
      console.warn("Customer dashboard checklist load failed", error);
    }
  } else if (cruise && currentUser?.id && !adminPreviewMode) {
    const { data: progressData } = await supabaseClient
      .from("checklist_progress")
      .select("*")
      .eq("user_id", currentUser.id)
      .eq("cruise_id", cruise.id);

    progressRows = progressData || [];
  }

  if (itemError) {
    console.warn("Dashboard checklist load failed", itemError);
  }

  const checklistItems = items || [];
  const completedCount = checklistItems.filter(item => isItemCompleted(progressRows, item.id)).length;
  const totalCount = checklistItems.length;
  const daysUntil = cruise ? getCountdownParts(cruise).totalDays : null;

  const incompleteItems = checklistItems.filter(item => !isItemCompleted(progressRows, item.id));

  const timedItems = incompleteItems.filter(item =>
    isChecklistItemRelevantToday(item, daysUntil)
  );

  const candidateItems = timedItems.length ? timedItems : incompleteItems;

  const essentialItems = candidateItems.filter(item =>
    getPriorityLabel(item.priority) === "Essential"
  );

  const nextItem = sortChecklistItemsForToday(
    essentialItems.length ? essentialItems : candidateItems,
    daysUntil
  )[0] || null;

  return {
    checklistItems,
    completedCount,
    totalCount,
    percent: getProgressPercent(completedCount, totalCount),
    nextItem
  };
}

function isChecklistItemRelevantToday(item, daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return true;

  const showFrom = item.show_from_days;
  const showUntil = item.show_until_days;

  if (showFrom !== null && showFrom !== undefined && daysUntil > Number(showFrom)) {
    return false;
  }

  if (showUntil !== null && showUntil !== undefined && daysUntil < Number(showUntil)) {
    return false;
  }

  return true;
}

function sortChecklistItemsForToday(items, daysUntil) {
  return [...items].sort((a, b) => {
    const aFrom = Number.isFinite(Number(a.show_from_days)) ? Number(a.show_from_days) : 9999;
    const bFrom = Number.isFinite(Number(b.show_from_days)) ? Number(b.show_from_days) : 9999;

    if (daysUntil !== null && daysUntil !== undefined) {
      const aDistance = Math.abs(daysUntil - aFrom);
      const bDistance = Math.abs(daysUntil - bFrom);

      if (aDistance !== bDistance) return aDistance - bDistance;
    }

    return Number(a.display_order || 999) - Number(b.display_order || 999);
  });
}

function getDashboardCountdownText(cruise) {
  const parts = getCountdownParts(cruise);
  if (parts.totalDays === null) return "Add your sail date";
  if (parts.totalDays <= 0) return "Bon Voyage";
  if (parts.totalDays === 1) return "1 Day Until You Sail";
  return `${parts.totalDays} Days Until You Sail`;
}

function getCruiseRouteText(cruise) {
  if (!cruise) return "";
  const from = cruise.departure_port || cruise.embarkation_port || cruise.from_port || cruise.departure_city || "";
  const to = cruise.arrival_port || cruise.disembarkation_port || cruise.destination || cruise.to_port || "";
  if (from && to) return `${from} → ${to}`;
  if (from) return from;
  if (to) return to;
  return cruise.cruise_line || "";
}

function renderDashboardModuleCard({ title, subtitle, action, buttonText = "Open", disabled = false }) {
  return `
    <button class="dashboard-module-card ${disabled ? "is-disabled" : ""}" onclick="${disabled ? "" : action}">
      <span class="dashboard-module-title">${escapeHtml(title)}</span>
      <span class="dashboard-module-subtitle">${escapeHtml(subtitle || "")}</span>
      <span class="dashboard-module-link">${escapeHtml(buttonText)} →</span>
    </button>
  `;
}

function renderDashboardAddCruiseForm() {
  return `
    <div class="planner-card section-spaced">
      <h2>Add Cruise</h2>

      <div class="planner-grid">
        <div>
          <div class="planner-field">
            <label>Cruise line</label>
            <select id="cruiseLine" onchange="updateShipDropdown()">
              ${renderCruiseLineOptions()}
            </select>
          </div>

          <div class="planner-field">
            <label>Ship name</label>
            <select id="shipName">
              ${renderShipOptions("")}
            </select>
          </div>
        </div>

        <div>
          <div class="planner-field">
            <label>Departure date</label>
            <input type="date" id="departureDate">
          </div>

          <div class="planner-field">
            <label>Sail away time (optional)</label>
            <input type="time" id="departureTime" value="17:00">
          </div>

          <div class="planner-field">
            <label>Number of nights</label>
            <input type="number" id="nights" min="1" placeholder="7">
          </div>
        </div>
      </div>

      <button class="planner-button" onclick="addCruise()">+ Save Cruise</button>
      <div id="cruise-message" class="planner-message"></div>
    </div>
  `;
}

function renderDashboardCruiseList(cruises, error, mainCruise) {
  return `
    <div class="planner-card dashboard-cruises-card">
      <h2>Your Cruises</h2>
      ${
        error
          ? `<p>Could not load cruises.</p>`
          : cruises.length
            ? cruises.map(cruise => `
                <div class="cruise-list-item">
                  <div>
                    ${renderLogoMarkup(cruise.cruise_line)}
                    <div class="cruise-list-title">${escapeHtml(cruise.cruise_line)}</div>
                    <div>${escapeHtml(cruise.ship_name || "Ship not added")}</div>
                  </div>
                  <div>
                    <strong>Departs</strong><br>
                    ${escapeHtml(formatDate(cruise.departure_date))}<br>
                    ${escapeHtml(formatTime(cruise.departure_time))}
                  </div>
                  <div>
                    <strong>Nights</strong><br>
                    ${escapeHtml(cruise.nights || "Not added")}
                  </div>
                  <div>
                    ${cruise.id === mainCruise?.id ? `<span class="cruise-pill">Current Cruise</span>` : ``}
                  </div>
                </div>
              `).join("")
            : `<p>You have not added a cruise yet.</p>`
      }
    </div>
  `;
}


function getDashboardValue(cruise, keys, fallback = "Not added") {
  for (const key of keys) {
    const value = cruise && cruise[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return fallback;
}

function toDisplayName(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  return text
    .toLowerCase()
    .split(/(\s+|-|')/)
    .map(part => {
      if (/^\s+$/.test(part) || part === "-" || part === "'") return part;
      if (!part) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("")
    .replace(/Mc([a-z])/g, (_, letter) => `Mc${letter.toUpperCase()}`);
}

function getGreetingName() {
  return toDisplayName(getUserDisplayName()) || "Cruiser";
}

function getGreetingText(name) {
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${name}`;
  if (hour < 18) return `Good afternoon, ${name}`;
  return `Good evening, ${name}`;
}

function formatPortDateTime(port, dateValue, timeValue = "") {
  const portText = String(port || "").trim();
  const dateText = dateValue ? formatDateShort(dateValue) : "";
  const timeText = timeValue ? formatTime(timeValue) : "";
  const detail = [dateText, timeText].filter(Boolean).join(" · ");
  if (portText && detail) return `${portText} · ${detail}`;
  return portText || detail || "Not added";
}

function getTravellerSummary(cruise) {
  const names = getDashboardValue(cruise, ["traveller_names", "travellers", "guest_names", "passenger_names"], "");
  if (names) return names;
  const count = getDashboardValue(cruise, ["traveller_count", "guests", "passengers", "guest_count"], "");
  if (count) return `${count} ${Number(count) === 1 ? "Traveller" : "Travellers"}`;
  return "Not added";
}

function getCruiseDateRangeText(cruise) {
  const depart = cruise?.departure_date ? formatDateShort(cruise.departure_date) : "Departure not added";
  const ret = cruise?.return_date || cruise?.arrival_date;
  const arrival = ret ? formatDateShort(ret) : "Return not added";
  return `${depart} to ${arrival}`;
}

function getCabinSummary(cruise) {
  const cabin = getDashboardValue(cruise, ["cabin_number", "cabin", "stateroom", "suite"], "Cabin not added");
  const cabinType = getDashboardValue(cruise, ["cabin_type", "room_type", "category_class"], "");
  return cabinType ? `${cabin} · ${cabinType}` : cabin;
}

function getBookingReferenceSummary(cruise) {
  return getCruiseBookingReference(cruise) || "Not added";
}

function renderMyCruiseOverview(cruise) {
  if (!cruise) return "";

  const route = getCruiseRouteText(cruise) || "Route not added";
  const travellers = getTravellerSummary(cruise);
  const cabin = getCabinSummary(cruise);
  const dateRange = getCruiseDateRangeText(cruise);
  const nights = cruise?.nights ? `${cruise.nights} nights` : "Nights not added";
  const bookingReference = getBookingReferenceSummary(cruise);

  return `
    <section class="my-cruise-overview-grid">
      <article class="my-cruise-overview-card primary">
        <span class="overview-icon">🚢</span>
        <p>Cruise</p>
        <strong>${escapeHtml([cruise.cruise_line, cruise.ship_name].filter(Boolean).join(" · ") || "Your cruise")}</strong>
        <small>${escapeHtml(nights)}</small>
      </article>
      <article class="my-cruise-overview-card">
        <span class="overview-icon">📅</span>
        <p>Dates</p>
        <strong>${escapeHtml(dateRange)}</strong>
      </article>
      <article class="my-cruise-overview-card">
        <span class="overview-icon">📍</span>
        <p>Route</p>
        <strong>${escapeHtml(route)}</strong>
      </article>
      <article class="my-cruise-overview-card">
        <span class="overview-icon">🛏️</span>
        <p>Cabin</p>
        <strong>${escapeHtml(cabin)}</strong>
      </article>
      <article class="my-cruise-overview-card wide">
        <span class="overview-icon">👥</span>
        <p>Travellers</p>
        <strong>${escapeHtml(travellers)}</strong>
      </article>
      <article class="my-cruise-overview-card">
        <span class="overview-icon">🔖</span>
        <p>Booking Reference</p>
        <strong>${escapeHtml(bookingReference)}</strong>
      </article>
    </section>
  `;
}

function getUserDisplayName() {
  const profileName = currentProfile?.first_name || currentUser?.user_metadata?.first_name || "";
  if (profileName && String(profileName).trim()) return String(profileName).trim();

  const emailName = String(currentUser?.email || "").split("@")[0] || "Cruiser";
  if (emailName.toLowerCase().startsWith("steve")) return "Steve";

  const cleaned = emailName.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim();
  return cleaned ? cleaned.replace(/\b\w/g, char => char.toUpperCase()) : "Cruiser";
}

function renderStatusValue(value) {
  const safeValue = String(value || "Not added").trim() || "Not added";
  const isMissing = safeValue.toLowerCase() === "not added" || safeValue.toLowerCase() === "required" || safeValue.toLowerCase() === "pending";
  return `<strong class="${isMissing ? "is-alert" : ""}">${escapeHtml(safeValue)}</strong>`;
}


function getDashboardBookingSource(cruise) {
  return cruise?._preview_booking || cruise || {};
}

function formatCurrencyValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not added";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(number);
}

function getPassportStatusSummary(cruise) {
  const booking = getDashboardBookingSource(cruise);
  const returnDate = booking.arriving_date || cruise?.return_date || cruise?.arrival_date;
  const threshold = returnDate ? new Date(returnDate) : null;
  if (threshold && !Number.isNaN(threshold.getTime())) threshold.setMonth(threshold.getMonth() + 6);

  const passengers = [1, 2].map(index => ({
    name: toDisplayName([booking[`passenger${index}_first_name`], booking[`passenger${index}_last_name`]].filter(Boolean).join(" ")),
    expiry: booking[`passenger${index}_passport_exp_date`]
  })).filter(passenger => passenger.name || passenger.expiry);

  if (!passengers.length) return "Not added";

  const warnings = passengers.filter(passenger => {
    if (!passenger.expiry || !threshold) return false;
    const expiryDate = new Date(passenger.expiry);
    return !Number.isNaN(expiryDate.getTime()) && expiryDate < threshold;
  });

  if (warnings.length) {
    return `${warnings.map(item => item.name || "Traveller").join(", ")} needs passport review`;
  }

  const missing = passengers.filter(passenger => !passenger.expiry);
  if (missing.length) return `${missing.length} passport expiry date${missing.length === 1 ? "" : "s"} missing`;
  return "Valid for 6+ months after cruise";
}

function getPaymentSummary(cruise) {
  const booking = getDashboardBookingSource(cruise);
  if (booking.payment_status) {
    const label = String(booking.payment_status).replaceAll("_", " ");
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (booking.balance_owing !== undefined && booking.balance_owing !== null) {
    return `${formatCurrencyValue(booking.balance_owing)} owing`;
  }
  return "Not added";
}

function getInclusionsSummary(cruise) {
  const booking = getDashboardBookingSource(cruise);
  const inclusions = Array.isArray(booking.inclusions) ? booking.inclusions.filter(Boolean) : [];
  return inclusions.length ? inclusions.join(", ") : "None recorded";
}

function renderDashboardSnapshot(cruise) {
  const booking = getDashboardBookingSource(cruise);
  const embarkationPort = getDashboardValue(cruise, ["embarkation_port", "departure_port", "from_port", "departure_city"], "");
  const disembarkationPort = getDashboardValue(cruise, ["disembarkation_port", "arrival_port", "to_port", "destination"], "");
  const embarkation = formatPortDateTime(embarkationPort, cruise?.departure_date, cruise?.departure_time);
  const disembarkation = formatPortDateTime(disembarkationPort, cruise?.return_date || cruise?.arrival_date, cruise?.arrival_time);
  const cabin = getDashboardValue(cruise, ["cabin_number", "cabin", "stateroom", "suite"], "Not added");
  const roomType = booking.room_type || getDashboardValue(cruise, ["cabin_type", "room_type"], "Not added");
  const category = booking.category_class || getDashboardValue(cruise, ["category_class"], "Not added");
  const travellers = getTravellerSummary(cruise);
  const travellerCount = booking.total_passengers || cruise?.traveller_count || "Not added";
  const duration = booking.cruise_duration || cruise?.nights || "Not added";
  const status = getDashboardValue(cruise, ["booking_status"], "Not added");
  const payment = getPaymentSummary(cruise);
  const totalPrice = booking.total_price ?? booking.cruise_price_usd;
  const finalDue = booking.final_payment_due_date || booking.reminder_final_payment_due;
  const passportStatus = getPassportStatusSummary(cruise);
  const inclusions = getInclusionsSummary(cruise);

  return `
    <article class="dashboard-summary-card dashboard-snapshot-card">
      <p class="dashboard-card-label">Cruise Snapshot</p>
      <div class="dashboard-snapshot-list">
        <div class="dashboard-snapshot-row"><span>Travellers</span>${renderStatusValue(travellers)}</div>
        <div class="dashboard-snapshot-row"><span>Traveller count</span>${renderStatusValue(travellerCount)}</div>
        <div class="dashboard-snapshot-row"><span>Cabin</span>${renderStatusValue(cabin)}</div>
        <div class="dashboard-snapshot-row"><span>Room type</span>${renderStatusValue(roomType)}</div>
        <div class="dashboard-snapshot-row"><span>Category</span>${renderStatusValue(category)}</div>
        <div class="dashboard-snapshot-row"><span>Duration</span>${renderStatusValue(duration === "Not added" ? duration : `${duration} nights`)}</div>
        <div class="dashboard-snapshot-row"><span>Embarkation</span>${renderStatusValue(embarkation)}</div>
        <div class="dashboard-snapshot-row"><span>Disembarkation</span>${renderStatusValue(disembarkation)}</div>
        <div class="dashboard-snapshot-row"><span>Passport check</span>${renderStatusValue(passportStatus)}</div>
        <div class="dashboard-snapshot-row"><span>Booking status</span>${renderStatusValue(status)}</div>
        <div class="dashboard-snapshot-row"><span>Payment status</span>${renderStatusValue(payment)}</div>
        ${totalPrice !== undefined && totalPrice !== null ? `<div class="dashboard-snapshot-row"><span>Cruise price</span>${renderStatusValue(formatCurrencyValue(totalPrice))}</div>` : ""}
        ${finalDue ? `<div class="dashboard-snapshot-row"><span>Final payment due</span>${renderStatusValue(formatDateShort(finalDue))}</div>` : ""}
        <div class="dashboard-snapshot-row"><span>Included extras</span>${renderStatusValue(inclusions)}</div>
      </div>
      <button class="dashboard-outline-action" onclick="renderBookingDetails()">Open Booking →</button>
    </article>
  `;
}

async function renderDashboard() {
  clearCountdownTimer();

  let safeCruises = [];
  let mainCruise = null;
  let error = null;

  if (customerMode && customerCruise) {
    safeCruises = [customerCruise];
    mainCruise = customerCruise;
  } else if (adminPreviewMode && adminPreviewCruise) {
    safeCruises = [adminPreviewCruise];
    mainCruise = adminPreviewCruise;
  } else {
    const result = await supabaseClient
      .from("cruises")
      .select("*")
      .order("departure_date", { ascending: true });

    error = result.error;
    safeCruises = result.data || [];
    const plannerPreference = await loadPlannerPreference();
    mainCruise = selectActiveCruise(safeCruises, plannerPreference);
  }

  const firstName = getGreetingName();
  const greetingText = getGreetingText(firstName);
  const mainShipImage = mainCruise ? await loadShipHeroImage(mainCruise.ship_name) : "";
  const checklistData = await loadDashboardChecklistData(mainCruise);
  const nextItem = checklistData.nextItem;
  const nextStepTitle = nextItem?.title || "Open your preparation checklist";
  const nextStepDescription = nextItem?.description || nextItem?.why_it_matters || "Protect your investment and travel with peace of mind.";
  const nextStepType = nextItem ? getPriorityLabel(nextItem.priority) : "Essential";
  const routeText = getCruiseRouteText(mainCruise);
  const nightsText = mainCruise?.nights ? `${mainCruise.nights} Nights` : "";
  const cruiseLineText = mainCruise?.cruise_line || "";
  const routeLine = [cruiseLineText, nightsText].filter(Boolean).join(" • ");
  const countdownParts = getCountdownParts(mainCruise);
  const mainLogo = mainCruise ? await loadCruiseLineLogo(mainCruise.cruise_line) : "";
  const heroTitle = mainCruise ? [mainCruise.cruise_line, mainCruise.ship_name].filter(Boolean).join(" · ") : "My Cruise";
  const heroDateRange = mainCruise ? getCruiseDateRangeText(mainCruise) : "";
  const cabinSummary = mainCruise ? getCabinSummary(mainCruise) : "";

  app.innerHTML = `
    <div class="dashboard-page">
      ${renderAdminPreviewBanner(mainCruise)}
      ${mainCruise ? `
        <section class="dashboard-hero ${mainShipImage ? "has-image" : ""}" ${mainShipImage ? `style="background-image:url('${escapeHtml(mainShipImage)}')"` : ""}>
          <div class="dashboard-hero-overlay"></div>
          <img class="dashboard-brand-logo" src="assets/101cruise-logo.png" alt="101CRUISE">
          ${adminPreviewMode ? `<button class="dashboard-signout" onclick="exitAdminPreview()">Exit Preview</button>` : customerMode ? `<button class="dashboard-signout" onclick="changeCustomerBooking()">Change Booking</button>` : `<button class="dashboard-signout" onclick="signOut()">Sign Out</button>`}

          <div class="dashboard-hero-content">
            <p class="dashboard-hero-kicker">${escapeHtml(greetingText)}</p>
            <h1>${escapeHtml(heroTitle || "Your Cruise")}</h1>
            <p class="dashboard-hero-date">${escapeHtml(heroDateRange)}</p>
            <p class="dashboard-hero-route">${escapeHtml(routeText || routeLine || "Your upcoming cruise")}${cabinSummary ? ` · ${escapeHtml(cabinSummary)}` : ""}</p>
          </div>

          <div class="dashboard-countdown-panel">
            <p>Sailing in</p>
            <div class="dashboard-countdown-grid">
              <div><span id="countdownDays">${countdownParts.days}</span><small>Days</small></div>
              <div><span id="countdownHours">${padNumber(countdownParts.hours)}</span><small>Hours</small></div>
              <div><span id="countdownMinutes">${padNumber(countdownParts.minutes)}</span><small>Minutes</small></div>
              <div><span id="countdownSeconds">${padNumber(countdownParts.seconds)}</span><small>Seconds</small></div>
            </div>
            ${mainLogo ? `<div class="dashboard-countdown-logo"><img src="${escapeHtml(mainLogo)}" alt="${escapeHtml(mainCruise.cruise_line || "Cruise line")} logo"></div>` : ""}
          </div>
        </section>
      ` : `
        <section class="dashboard-empty-hero">
          <h1>My Cruise Planner</h1>
          <p>Welcome, ${escapeHtml(firstName)}. Add your cruise to activate your personal dashboard.</p>
          <button class="planner-button secondary" onclick="signOut()">Sign Out</button>
        </section>
      `}

      <div class="dashboard-content-wrap">
        <section class="dashboard-welcome-strip">
          <div class="dashboard-welcome-avatar">${escapeHtml(String(firstName).slice(0, 2).toUpperCase())}</div>
          <div>
            <h2>My Cruise</h2>
            <p>${mainCruise ? `Everything for ${escapeHtml(heroTitle || "your cruise")} is in one place. Your next priority is ${escapeHtml(nextStepTitle)}.` : `Welcome, ${escapeHtml(firstName)}. Add your cruise to activate your personal dashboard.`}</p>
          </div>
          ${adminPreviewMode || customerMode ? "" : renderCruiseSwitcher(safeCruises, mainCruise)}
        </section>

        <section class="dashboard-home-grid">
          <article class="dashboard-summary-card dashboard-planner-card dashboard-planner-feature-card dashboard-planner-column">
            <div class="dashboard-planner-heading">
              <p class="dashboard-card-label">My Planner</p>
              <h2>${checklistData.percent > 0 ? "Continue planning your cruise" : "Start planning your cruise"}</h2>
              <p>Your essential cruise tools are together in one place.</p>
            </div>
            <div class="dashboard-feature-list">
              <button class="dashboard-feature-row" onclick="renderChecklist()"><span>📋</span><span><strong>Preparation Checklist</strong><small>Tasks, reminders and cruise-ready progress</small></span><b>→</b></button>
              <button class="dashboard-feature-row" onclick="renderPackingPlanner()"><span>🧳</span><span><strong>Smart Packing Planner</strong><small>Personalised packing for this sailing</small></span><b>→</b></button>
              <button class="dashboard-feature-row" onclick="renderDocuments()"><span>📄</span><span><strong>Documents</strong><small>Confirmations, tickets and travel papers</small></span><b>→</b></button>
              <button class="dashboard-feature-row" onclick="alert('Budget Planner coming soon')"><span>💳</span><span><strong>Budget Planner</strong><small>Payments and spending plans</small></span><b>→</b></button>
            </div>
          </article>

          <div class="dashboard-status-stack">
            <article class="dashboard-summary-card cruise-ready-card">
              <p class="dashboard-card-label">Cruise Ready</p>
              <div class="dashboard-ready-stat"><strong>${checklistData.percent}%</strong><span>${checklistData.percent > 0 ? "Your plans are taking shape." : "Your planning starts here."}</span></div>
              ${renderProgressCircle(checklistData.percent)}
              <button class="dashboard-card-action" onclick="renderChecklist()">View Progress →</button>
            </article>

            <article class="dashboard-summary-card next-task-card">
              <p class="dashboard-card-label">Next Essential Task</p>
              <div class="dashboard-card-icon">✓</div>
              <h2>${escapeHtml(nextStepTitle)}</h2>
              <p class="dashboard-card-copy">${escapeHtml(nextStepDescription)}</p>
              <button class="dashboard-card-action" onclick="renderChecklist()">Start Task →</button>
            </article>
          </div>

          ${mainCruise ? renderDashboardSnapshot(mainCruise) : ""}
        </section>

        ${!mainCruise ? renderDashboardAddCruiseForm() : ""}
      </div>
    </div>
  `;

  if (mainCruise) {
    startLiveCountdown(mainCruise);
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getPriorityClass(priority) {
  const normalized = String(priority || "Tip").toLowerCase();
  if (normalized === "essential") return "priority-essential";
  if (normalized === "optional") return "priority-optional";
  return "priority-tip";
}

function getPriorityLabel(priority) {
  const normalized = String(priority || "Tip").toLowerCase();
  if (normalized === "essential") return "Essential";
  if (normalized === "optional") return "Optional";
  return "Tip";
}

function getCurrentCruiseFromList(cruises, preference = null) {
  return selectActiveCruise(cruises || [], preference);
}

async function loadCurrentCruise() {
  if (customerMode && customerCruise) return customerCruise;
  if (adminPreviewMode && adminPreviewCruise) return adminPreviewCruise;
  const { data } = await supabaseClient
    .from("cruises")
    .select("*")
    .order("departure_date", { ascending: true });

  const preference = await loadPlannerPreference();
  return getCurrentCruiseFromList(data || [], preference);
}

function getProgressPercent(completed, total) {
  if (!total) return 0;
  return Math.round((completed / total) * 100);
}

function renderProgressCircle(percent) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `
    <div class="cruise-ready-circle" style="--progress:${safePercent};">
      <div class="cruise-ready-circle-inner">
        <strong>${safePercent}%</strong>
        <span>Cruise Ready</span>
      </div>
    </div>
  `;
}

function renderPlannerNav(active = "preparation") {
  const items = [
    { key: "dashboard", label: "Dashboard", action: "renderDashboard()" },
    { key: "preparation", label: "Preparation", action: "renderChecklist()" },
    { key: "packing", label: "Packing", action: "renderPackingPlanner()" },
    { key: "budget", label: "Budget", action: "alert('Budget Planner coming soon')" },
    { key: "documents", label: "Documents", action: "renderDocuments()" }
  ];

  return `
    <div class="planner-module-nav">
      ${items.map(item => `
        <button class="planner-module-nav-button ${active === item.key ? "active" : ""}" onclick="${item.action}">${item.label}</button>
      `).join("")}
    </div>
  `;
}

function renderCruiseSnapshot(cruise, completed, total) {
  const percent = getProgressPercent(completed, total);
  return `
    <aside class="checklist-sidebar">
      <div class="snapshot-card">
        <h3>Cruise Snapshot</h3>
        <div class="snapshot-row"><span>🚢 Ship</span><strong>${escapeHtml(cruise?.ship_name || "Not added")}</strong></div>
        <div class="snapshot-row"><span>⚓ Line</span><strong>${escapeHtml(cruise?.cruise_line || "Not added")}</strong></div>
        <div class="snapshot-row"><span>📅 Departure</span><strong>${escapeHtml(formatDate(cruise?.departure_date))}</strong></div>
        <div class="snapshot-row"><span>🌙 Nights</span><strong>${escapeHtml(cruise?.nights || "Not added")}</strong></div>
      </div>

      <div class="snapshot-card progress-snapshot-card">
        ${renderProgressCircle(percent)}
        <p><strong>${completed}</strong> of <strong>${total}</strong> tasks complete</p>
      </div>
    </aside>
  `;
}

function groupItemsBySection(items) {
  const grouped = {};
  (items || []).forEach(item => {
    if (!grouped[item.section_id]) grouped[item.section_id] = [];
    grouped[item.section_id].push(item);
  });
  return grouped;
}

function isItemCompleted(progressRows, itemId) {
  return (progressRows || []).some(row => row.checklist_item_id === itemId && row.completed === true);
}

function groupPersonalItemsBySection(items) {
  const grouped = {};
  (items || []).forEach(item => {
    if (!grouped[item.section_id]) grouped[item.section_id] = [];
    grouped[item.section_id].push(item);
  });
  return grouped;
}

function renderPersonalChecklistRow(item) {
  return `
    <div class="checklist-row personal-checklist-row ${item.completed ? "is-complete" : ""}" data-personal-row="${item.id}">
      <div class="checklist-main-cell">
        <input class="checklist-checkbox" type="checkbox" ${item.completed ? "checked" : ""} onchange="togglePersonalChecklistItem(${item.id}, this.checked)">
        <button class="checklist-row-toggle" onclick="togglePersonalChecklistDetails(${item.id})" aria-label="Toggle personal task details">
          <span class="checklist-title">${escapeHtml(item.title)}</span>
          <span class="checklist-description">Your own task</span>
        </button>
      </div>

      <div class="checklist-type-cell">
        <span class="priority-badge priority-personal">Personal</span>
      </div>

      <div class="checklist-action-cell">
        <button class="checklist-action-button secondary" onclick="deletePersonalChecklistItem(${item.id})">Delete</button>
      </div>

      <div class="checklist-details" id="personal-checklist-details-${item.id}">
        <p>This task was added by you and only appears in your own planner.</p>
      </div>
    </div>
  `;
}

function renderChecklistRow(item, completed) {
  const description = item.description || item.why_it_matters || "";
  const priorityLabel = getPriorityLabel(item.priority);
  const priorityClass = getPriorityClass(item.priority);

  return `
    <div class="checklist-row ${completed ? "is-complete" : ""}" data-checklist-row="${item.id}">
      <div class="checklist-main-cell">
        <input class="checklist-checkbox" type="checkbox" ${completed ? "checked" : ""} onchange="toggleChecklistItem(${item.id}, this.checked)">
        <button class="checklist-row-toggle" onclick="toggleChecklistDetails(${item.id})" aria-label="Toggle details">
          <span class="checklist-title">${escapeHtml(item.title)}</span>
          ${description ? `<span class="checklist-description">${escapeHtml(description)}</span>` : ""}
        </button>
      </div>

      <div class="checklist-type-cell">
        <span class="priority-badge ${priorityClass}">${priorityLabel}</span>
      </div>

      <div class="checklist-action-cell">
        ${item.button1_text && item.button1_url ? `<a class="checklist-action-button" href="${escapeHtml(item.button1_url)}" target="_blank" rel="noopener">${escapeHtml(item.button1_text)}</a>` : ""}
        ${item.button2_text && item.button2_url ? `<a class="checklist-action-button secondary" href="${escapeHtml(item.button2_url)}" target="_blank" rel="noopener">${escapeHtml(item.button2_text)}</a>` : ""}
      </div>

      <div class="checklist-details" id="checklist-details-${item.id}">
        ${item.why_it_matters ? `<p><strong>Why it matters:</strong> ${escapeHtml(item.why_it_matters)}</p>` : ""}
      </div>
    </div>
  `;
}

function toggleChecklistDetails(itemId) {
  const details = document.getElementById(`checklist-details-${itemId}`);
  if (details) details.classList.toggle("open");
}

function togglePersonalChecklistDetails(itemId) {
  const details = document.getElementById(`personal-checklist-details-${itemId}`);
  if (details) details.classList.toggle("open");
}

async function addPersonalChecklistItem(sectionId) {
  const cruise = await loadCurrentCruise();

  if (!cruise) {
    alert("Please add a cruise before adding your own checklist items.");
    return;
  }

  const title = prompt("Add your own task");
  if (!title || !title.trim()) return;

  const { error } = await supabaseClient
    .from("user_checklist_items")
    .insert({
      user_id: currentUser.id,
      cruise_id: cruise.id,
      section_id: sectionId,
      title: title.trim(),
      completed: false
    });

  if (error) {
    console.error("Personal checklist item save error", error);
    alert("Could not add your task. Please try again.");
    return;
  }

  renderChecklist();
}

async function togglePersonalChecklistItem(itemId, completed) {
  const { error } = await supabaseClient
    .from("user_checklist_items")
    .update({
      completed,
      completed_at: completed ? new Date().toISOString() : null
    })
    .eq("id", itemId)
    .eq("user_id", currentUser.id);

  if (error) {
    console.error("Personal checklist progress save error", error);
    alert("Could not save your task. Please try again.");
    return;
  }

  renderChecklist();
}

async function deletePersonalChecklistItem(itemId) {
  if (!confirm("Delete this personal task?")) return;

  const { error } = await supabaseClient
    .from("user_checklist_items")
    .delete()
    .eq("id", itemId)
    .eq("user_id", currentUser.id);

  if (error) {
    console.error("Personal checklist item delete error", error);
    alert("Could not delete your task. Please try again.");
    return;
  }

  renderChecklist();
}

async function toggleChecklistItem(itemId, completed) {
  const cruise = await loadCurrentCruise();

  if (!cruise) {
    alert("Please add a cruise before saving checklist progress.");
    renderChecklist();
    return;
  }

  if (customerMode) {
    try {
      await customerProgressRequest("save_checklist", { checklist_item_id: itemId, completed });
      await renderChecklist();
    } catch (error) {
      console.error("Customer checklist progress save error", error);
      alert("Could not save checklist progress. Please try again.");
    }
    return;
  }

  const payload = {
    user_id: currentUser.id,
    cruise_id: cruise.id,
    checklist_item_id: itemId,
    completed,
    completed_at: completed ? new Date().toISOString() : null
  };

  const { error } = await supabaseClient
    .from("checklist_progress")
    .upsert(payload, { onConflict: "user_id,cruise_id,checklist_item_id" });

  if (error) {
    console.error("Checklist progress save error", error);
    alert("Could not save checklist progress. Please try again.");
    return;
  }

  renderChecklist();
}

function toggleHideCompleted() {
  const page = document.getElementById("checklist-page");
  if (!page) return;
  page.classList.toggle("hide-completed");

  const button = document.getElementById("hideCompletedButton");
  if (button) {
    button.innerText = page.classList.contains("hide-completed") ? "Show Checked" : "Hide Checked";
  }
}

function printChecklist() {
  window.print();
}

function saveChecklistPdf() {
  window.print();
}

async function renderChecklist() {
  clearCountdownTimer();

  const cruise = await loadCurrentCruise();

  const { data: sections, error: sectionError } = await supabaseClient
    .from("checklist_sections")
    .select("*")
    .eq("active", true)
    .order("display_order", { ascending: true });

  const { data: items, error: itemError } = await supabaseClient
    .from("checklist_items")
    .select("*")
    .eq("active", true)
    .order("display_order", { ascending: true });

  let progressRows = [];
  let personalItems = [];
  if (cruise && customerMode) {
    try {
      const data = await customerProgressRequest("load_checklist");
      progressRows = data.progress || [];
    } catch (error) {
      console.warn("Customer checklist load failed", error);
    }
  } else if (cruise) {
    const { data: progressData } = await supabaseClient
      .from("checklist_progress")
      .select("*")
      .eq("user_id", currentUser.id)
      .eq("cruise_id", cruise.id);
    progressRows = progressData || [];

    const { data: personalData, error: personalError } = await supabaseClient
      .from("user_checklist_items")
      .select("*")
      .eq("user_id", currentUser.id)
      .eq("cruise_id", cruise.id)
      .order("created_at", { ascending: true });

    if (personalError) {
      console.warn("Personal checklist load failed", personalError);
    } else {
      personalItems = personalData || [];
    }
  }

  if (sectionError || itemError) {
    app.innerHTML = `
      <div class="planner-card">
        <button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button>
        <h2>Preparation</h2>
        <p>Could not load the checklist. Please try again.</p>
      </div>
    `;
    return;
  }

  const allItems = items || [];
  const completedSystemCount = allItems.filter(item => isItemCompleted(progressRows, item.id)).length;
  const completedPersonalCount = personalItems.filter(item => item.completed === true).length;
  const completedCount = completedSystemCount + completedPersonalCount;
  const totalCount = allItems.length + personalItems.length;
  const percent = getProgressPercent(completedCount, totalCount);
  const groupedItems = groupItemsBySection(allItems);
  const groupedPersonalItems = groupPersonalItemsBySection(personalItems);

  app.innerHTML = `
    <div id="checklist-page" class="checklist-page">
      ${renderPlannerNav("preparation")}

      <div class="checklist-toolbar planner-card slim-card">
        <div>
          <h2>Preparation</h2>
          <p class="planner-muted">${completedCount} of ${totalCount} tasks complete</p>
          <div class="checklist-top-progress"><span style="width:${percent}%"></span></div>
        </div>
        <div class="checklist-toolbar-actions">
          <button class="planner-button secondary" id="hideCompletedButton" onclick="toggleHideCompleted()">Hide Checked</button>
          <button class="planner-button secondary" onclick="printChecklist()">Print</button>
          <button class="planner-button" onclick="saveChecklistPdf()">Save PDF</button>
        </div>
      </div>

      <div class="checklist-layout">
        <main class="checklist-content">
          ${(sections || []).map(section => {
            const sectionItems = groupedItems[section.id] || [];
            const sectionPersonalItems = groupedPersonalItems[section.id] || [];
            const sectionCompletedSystem = sectionItems.filter(item => isItemCompleted(progressRows, item.id)).length;
            const sectionCompletedPersonal = sectionPersonalItems.filter(item => item.completed === true).length;
            const sectionCompleted = sectionCompletedSystem + sectionCompletedPersonal;
            const sectionTotal = sectionItems.length + sectionPersonalItems.length;
            const sectionPercent = getProgressPercent(sectionCompleted, sectionTotal);

            return `
              <section class="checklist-section-block">
                <div class="checklist-section-header">
                  <div>
                    <h3>${escapeHtml(section.name)}</h3>
                    ${section.description ? `<p>${escapeHtml(section.description)}</p>` : ""}
                  </div>
                  <div class="section-progress-pill">${sectionCompleted}/${sectionTotal} Complete</div>
                </div>
                <div class="section-progress-bar"><span style="width:${sectionPercent}%"></span></div>
                <div class="checklist-table-header">
                  <span>Task</span>
                  <span>Type</span>
                  <span>Action</span>
                </div>
                ${sectionItems.length ? sectionItems.map(item => renderChecklistRow(item, isItemCompleted(progressRows, item.id))).join("") : ""}
                ${sectionPersonalItems.length ? sectionPersonalItems.map(item => renderPersonalChecklistRow(item)).join("") : ""}
                ${!sectionItems.length && !sectionPersonalItems.length ? `<p class="planner-muted empty-checklist-message">No checklist items added yet.</p>` : ""}
                ${customerMode ? "" : `<button class="add-personal-task-button" onclick="addPersonalChecklistItem(${section.id})">+ Add your own task</button>`}
              </section>
            `;
          }).join("")}
        </main>

        ${renderCruiseSnapshot(cruise, completedCount, totalCount)}
      </div>
    </div>
  `;
}


async function loadUserBookingDetails(cruise) {
  if (!currentUser?.id || !cruise?.id) return null;

  const { data, error } = await supabaseClient
    .from("user_booking_details")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("cruise_id", cruise.id)
    .maybeSingle();

  if (error) {
    console.warn("User booking details load failed", error);
    return null;
  }

  return data || null;
}

function renderBookingDetailRow(label, value) {
  const safeValue = value === null || value === undefined || String(value).trim() === "" ? "Not added" : String(value).trim();
  return `<div class="dashboard-snapshot-row"><span>${escapeHtml(label)}</span>${renderStatusValue(safeValue)}</div>`;
}

function renderBookingTextarea(id, label, value, placeholder) {
  return `
    <div class="planner-field">
      <label>${escapeHtml(label)}</label>
      <textarea id="${escapeHtml(id)}" placeholder="${escapeHtml(placeholder || "")}">${escapeHtml(value || "")}</textarea>
    </div>
  `;
}

async function renderBookingDetails() {
  clearCountdownTimer();

  const cruise = await loadCurrentCruise();

  if (!cruise) {
    app.innerHTML = `
      <div class="planner-card">
        <button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button>
        <h2>Booking Details</h2>
        <p>Add a cruise before viewing booking details.</p>
      </div>
    `;
    return;
  }

  const bookingDetails = await loadUserBookingDetails(cruise);
  const bookingReference = getCruiseBookingReference(cruise) || "Not added";
  const embarkation = getDashboardValue(cruise, ["embarkation_port", "departure_port", "from_port", "departure_city"], "Not added");
  const disembarkation = getDashboardValue(cruise, ["disembarkation_port", "arrival_port", "to_port", "destination"], "Not added");
  const cabin = getDashboardValue(cruise, ["cabin_number", "cabin", "stateroom", "suite"], "Not added");
  const cabinType = getDashboardValue(cruise, ["cabin_type", "stateroom_type", "suite_type"], "Not added");
  const deck = getDashboardValue(cruise, ["deck", "deck_number"], "Not added");
  const dining = getDashboardValue(cruise, ["dining_time", "dining", "dining_preference"], "Not added");
  const travellers = getTravellerSummary(cruise);

  app.innerHTML = `
    <div class="booking-details-page">
      ${renderPlannerNav("dashboard")}

      <div class="planner-card slim-card">
        <button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button>
        <h2>Booking Details</h2>
        <p class="planner-muted">Your cruise booking information and personal travel notes in one place.</p>
      </div>

      <div class="planner-grid booking-details-grid">
        <section class="planner-card">
          <h3>Cruise</h3>
          <div class="dashboard-snapshot-list">
            ${renderBookingDetailRow("Cruise line", cruise.cruise_line)}
            ${renderBookingDetailRow("Ship", cruise.ship_name)}
            ${renderBookingDetailRow("Booking reference", bookingReference)}
            ${renderBookingDetailRow("Departure", formatDate(cruise.departure_date))}
            ${renderBookingDetailRow("Return", formatDate(cruise.return_date))}
            ${renderBookingDetailRow("Nights", cruise.nights ? `${cruise.nights} Nights` : "Not added")}
            ${renderBookingDetailRow("Embarkation", embarkation)}
            ${renderBookingDetailRow("Disembarkation", disembarkation)}
          </div>
        </section>

        <section class="planner-card">
          <h3>Travellers & Cabin</h3>
          <div class="dashboard-snapshot-list">
            ${renderBookingDetailRow("Travellers", travellers)}
            ${renderBookingDetailRow("Cabin", cabin)}
            ${renderBookingDetailRow("Cabin type", cabinType)}
            ${renderBookingDetailRow("Deck", deck)}
            ${renderBookingDetailRow("Dining", dining)}
          </div>
        </section>
      </div>

      <section class="planner-card section-spaced">
        <h3>Your Travel Arrangements</h3>
        <p class="planner-muted">Add your own flights, hotels and transfers here. 101CRUISE manages your cruise booking; these fields are for your personal planning notes.</p>

        <div class="planner-grid">
          <div>
            ${renderBookingTextarea("bookingFlightDetails", "Flights", bookingDetails?.flight_details, "Example: QF123 Sydney to Auckland, 24 July, 9:30am")}
            ${renderBookingTextarea("bookingHotelDetails", "Hotels", bookingDetails?.hotel_details, "Example: 2 nights at the Hilton Auckland before sailing")}
          </div>
          <div>
            ${renderBookingTextarea("bookingTransferDetails", "Transfers", bookingDetails?.transfer_details, "Example: Taxi from airport to hotel, private transfer to cruise terminal")}
            ${renderBookingTextarea("bookingInsuranceDetails", "Insurance", bookingDetails?.insurance_details, "Example: Policy number, insurer and emergency contact number")}
          </div>
        </div>

        ${renderBookingTextarea("bookingExtraNotes", "Other notes", bookingDetails?.notes, "Anything else you want to remember for this cruise")}

        <button class="planner-button" onclick="saveUserBookingDetails()">Save Travel Details</button>
        <div id="booking-details-message" class="planner-message"></div>
      </section>

      <section class="planner-card section-spaced booking-documents-prompt">
        <div>
          <h3>Documents</h3>
          <p class="planner-muted">Open your booking confirmation, tickets and uploaded travel documents in one place.</p>
        </div>
        <button class="planner-button secondary" onclick="renderDocuments()">View Documents</button>
      </section>
    </div>
  `;
}


const CUSTOMER_DOCUMENT_TYPES = [
  "Insurance Policy",
  "Passport Copy",
  "Visa",
  "Vaccination Certificate",
  "Flight Confirmation",
  "Hotel Confirmation",
  "Shore Excursion Ticket",
  "Electronic Ticket / Boarding Pass",
  "Other"
];

function normaliseDocumentType(value) {
  return String(value || "Other").trim() || "Other";
}

function getDocumentIcon(document) {
  const type = normaliseDocumentType(document.document_type).toLowerCase();
  const filename = String(document.filename || "").toLowerCase();
  if (type.includes("booking confirmation")) return "📘";
  if (type.includes("ticket") || type.includes("boarding")) return "🎫";
  if (type.includes("insurance")) return "🛡️";
  if (type.includes("passport") || type.includes("visa")) return "🛂";
  if (type.includes("flight")) return "✈️";
  if (type.includes("hotel")) return "🏨";
  if (type.includes("shore excursion")) return "🗺️";
  if (filename.endsWith(".png") || filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "🖼️";
  return "📄";
}

function formatDocumentDate(value) {
  if (!value) return "Date not supplied";
  const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function getDocumentPriority(document) {
  const type = normaliseDocumentType(document.document_type).toLowerCase();
  if (type === "booking confirmation") return 0;
  if (type.includes("ticket") || type.includes("boarding pass")) return 1;
  return 2;
}

function sortDocuments(documents) {
  return [...documents].sort((a, b) => {
    const priority = getDocumentPriority(a) - getDocumentPriority(b);
    if (priority) return priority;
    return new Date(b.uploaded_date || b.uploaded_at || 0) - new Date(a.uploaded_date || a.uploaded_at || 0);
  });
}

function openDocument(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function downloadDocument(url, filename) {
  if (!url) return;
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "travel-document";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function printDocument(url) {
  if (!url) return;
  const printWindow = window.open(url, "_blank", "noopener,noreferrer");
  if (!printWindow) alert("Your browser blocked the document window. Please use Open and print from the new tab.");
}

function renderDocumentCard(document) {
  const source = document.source === "customer" ? "You" : "101cruise";
  const primary = normaliseDocumentType(document.document_type).toLowerCase() === "booking confirmation";
  const encodedUrl = encodeURIComponent(document.file_url || "");
  const encodedFilename = encodeURIComponent(document.filename || "travel-document");
  return `
    <article class="document-card ${primary ? "document-card-primary" : ""}">
      <div class="document-card-icon" aria-hidden="true">${getDocumentIcon(document)}</div>
      <div class="document-card-content">
        <div class="document-card-heading">
          <div>
            ${primary ? '<span class="document-primary-badge">Primary travel document</span>' : ""}
            <h3>${escapeHtml(normaliseDocumentType(document.document_type))}</h3>
          </div>
          <span class="document-source-badge">${escapeHtml(source)}</span>
        </div>
        <p class="document-filename">${escapeHtml(document.filename || "Travel document")}</p>
        <p class="document-meta">Added ${escapeHtml(formatDocumentDate(document.uploaded_date || document.uploaded_at))}</p>
        ${document.notes ? `<p class="document-notes">${escapeHtml(document.notes)}</p>` : ""}
        <div class="document-actions">
          <button class="planner-button secondary" onclick="openDocument(decodeURIComponent('${encodedUrl}'))">Open</button>
          <button class="planner-button secondary" onclick="downloadDocument(decodeURIComponent('${encodedUrl}'), decodeURIComponent('${encodedFilename}'))">Download</button>
          <button class="planner-button secondary" onclick="printDocument(decodeURIComponent('${encodedUrl}'))">Print</button>
          ${document.source === "customer" ? `<button class="document-delete-button" onclick="deleteCustomerDocument('${escapeHtml(document.id)}')">Delete</button>` : ""}
        </div>
      </div>
    </article>`;
}

async function renderDocuments() {
  clearCountdownTimer();
  const cruise = await loadCurrentCruise();
  app.innerHTML = `
    ${renderAdminPreviewBanner(cruise)}
    <div class="planner-shell">
      ${renderPlannerNav("documents")}
      <section class="documents-header planner-card">
        <div>
          <p class="planner-kicker">My Cruise</p>
          <h2>Documents</h2>
          <p class="planner-muted">Your cruise confirmations, tickets and personal travel documents in one secure library.</p>
        </div>
        ${customerMode ? '<button class="planner-button black" onclick="openDocumentUpload()">+ Upload Document</button>' : ""}
      </section>
      <div id="documents-message" class="planner-message"></div>
      <section id="documents-list" class="documents-list">
        <div class="planner-card"><p class="planner-muted">Loading documents…</p></div>
      </section>
    </div>`;

  try {
    const base44Documents = (customerBooking?._preview_booking?.documents || customerBooking?.documents || cruise?._preview_booking?.documents || []).map((document, index) => ({
      ...document,
      id: `base44-${index}`,
      source: "base44"
    }));
    let customerDocuments = [];
    if (customerMode) {
      const data = await customerDocumentsRequest("list");
      customerDocuments = (data.documents || []).map(document => ({ ...document, source: "customer" }));
    }
    const documents = sortDocuments([...base44Documents, ...customerDocuments]);
    const list = document.getElementById("documents-list");
    if (!documents.length) {
      list.innerHTML = `<div class="planner-card documents-empty"><div class="documents-empty-icon">📄</div><h3>No travel documents have been uploaded yet.</h3><p class="planner-muted">Your 101cruise consultant will add booking documents here as they become available. You can also upload your own insurance, passport, visa, flight, hotel or excursion documents.</p></div>`;
      return;
    }
    list.innerHTML = `<div class="documents-count">${documents.length} ${documents.length === 1 ? "document" : "documents"}</div>${documents.map(renderDocumentCard).join("")}`;
  } catch (error) {
    console.error("Documents load error", error);
    const list = document.getElementById("documents-list");
    if (list) list.innerHTML = `<div class="planner-card documents-empty"><h3>Documents could not be loaded</h3><p class="planner-muted">${escapeHtml(error.message || "Please try again.")}</p><button class="planner-button secondary" onclick="renderDocuments()">Try Again</button></div>`;
  }
}

function openDocumentUpload() {
  const modal = document.createElement("div");
  modal.className = "document-upload-overlay";
  modal.id = "documentUploadOverlay";
  modal.innerHTML = `
    <section class="document-upload-modal planner-card" role="dialog" aria-modal="true" aria-labelledby="documentUploadTitle">
      <div class="document-upload-heading"><div><p class="planner-kicker">My Documents</p><h2 id="documentUploadTitle">Upload a document</h2></div><button class="document-modal-close" onclick="closeDocumentUpload()" aria-label="Close">×</button></div>
      <div class="planner-field"><label for="customerDocumentType">Document type</label><select id="customerDocumentType">${CUSTOMER_DOCUMENT_TYPES.map(type => `<option>${escapeHtml(type)}</option>`).join("")}</select></div>
      <div class="planner-field"><label for="customerDocumentFile">Choose file</label><input id="customerDocumentFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></div>
      <div class="planner-field"><label for="customerDocumentNotes">Notes <span class="planner-muted">(optional)</span></label><textarea id="customerDocumentNotes" rows="3" placeholder="Add a short reminder about this document"></textarea></div>
      <p class="planner-muted document-upload-help">PDF, JPG, PNG, DOC or DOCX. Maximum 10 MB.</p>
      <div id="document-upload-message" class="planner-message"></div>
      <div class="document-upload-actions"><button class="planner-button secondary" onclick="closeDocumentUpload()">Cancel</button><button id="documentUploadButton" class="planner-button black" onclick="uploadCustomerDocument()">Upload Document</button></div>
    </section>`;
  document.body.appendChild(modal);
}

function closeDocumentUpload() {
  document.getElementById("documentUploadOverlay")?.remove();
}

async function uploadCustomerDocument() {
  const file = document.getElementById("customerDocumentFile")?.files?.[0];
  const documentType = document.getElementById("customerDocumentType")?.value || "Other";
  const notes = document.getElementById("customerDocumentNotes")?.value.trim() || "";
  const message = document.getElementById("document-upload-message");
  const button = document.getElementById("documentUploadButton");
  if (!file) { if (message) message.textContent = "Choose a document to upload."; return; }
  if (file.size > 10 * 1024 * 1024) { if (message) message.textContent = "The file must be no larger than 10 MB."; return; }
  try {
    if (button) { button.disabled = true; button.textContent = "Uploading…"; }
    if (message) message.textContent = "Preparing secure upload…";
    const prepared = await customerDocumentsRequest("create_upload", {
      filename: file.name,
      document_type: documentType,
      mime_type: file.type,
      size_bytes: file.size
    });
    const upload = prepared.upload;
    if (!upload.token) throw new Error("The secure upload token was not returned.");
    const { error: storageError } = await supabaseClient.storage
      .from("customer-documents")
      .uploadToSignedUrl(upload.storage_path, upload.token, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false
      });
    if (storageError) throw storageError;
    await customerDocumentsRequest("complete_upload", {
      id: upload.id,
      storage_path: upload.storage_path,
      document_type: documentType,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      notes
    });
    closeDocumentUpload();
    await renderDocuments();
  } catch (error) {
    console.error("Document upload error", error);
    if (message) message.textContent = error.message || "The document could not be uploaded.";
    if (button) { button.disabled = false; button.textContent = "Upload Document"; }
  }
}

async function deleteCustomerDocument(id) {
  if (!window.confirm("Delete this document from My Cruise?")) return;
  try {
    await customerDocumentsRequest("delete", { id });
    await renderDocuments();
  } catch (error) {
    const message = document.getElementById("documents-message");
    if (message) message.textContent = error.message || "The document could not be deleted.";
  }
}

async function saveUserBookingDetails() {
  const cruise = await loadCurrentCruise();
  const message = document.getElementById("booking-details-message");

  if (!cruise) {
    if (message) message.innerText = "Please add a cruise before saving travel details.";
    return;
  }

  const payload = {
    user_id: currentUser.id,
    cruise_id: cruise.id,
    flight_details: document.getElementById("bookingFlightDetails")?.value.trim() || null,
    hotel_details: document.getElementById("bookingHotelDetails")?.value.trim() || null,
    transfer_details: document.getElementById("bookingTransferDetails")?.value.trim() || null,
    insurance_details: document.getElementById("bookingInsuranceDetails")?.value.trim() || null,
    notes: document.getElementById("bookingExtraNotes")?.value.trim() || null,
    updated_at: new Date().toISOString()
  };

  if (message) message.innerText = "Saving...";

  const { error } = await supabaseClient
    .from("user_booking_details")
    .upsert(payload, { onConflict: "user_id,cruise_id" });

  if (error) {
    console.error("Booking details save error", error);
    if (message) message.innerText = "Could not save travel details. Please try again.";
    return;
  }

  if (message) message.innerText = "Travel details saved.";
}


const PACKING_DESTINATIONS = [
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

function getDefaultPackingDestination(cruise) {
  const text = [
    cruise?.destination,
    cruise?.arrival_port,
    cruise?.disembarkation_port,
    cruise?.to_port,
    cruise?.itinerary,
    cruise?.cruise_region
  ].filter(Boolean).join(" ").toLowerCase();

  if (text.includes("alaska")) return "Alaska";
  if (text.includes("norway") || text.includes("northern europe") || text.includes("fjord")) return "Norway / Northern Europe";
  if (text.includes("mediterranean") || text.includes("greek") || text.includes("greece") || text.includes("italy") || text.includes("spain")) return "Mediterranean / Greek Isles";
  if (text.includes("caribbean") || text.includes("bahamas")) return "Caribbean / Bahamas";
  if (text.includes("hawaii")) return "Hawaii";
  if (text.includes("asia") || text.includes("singapore") || text.includes("thailand") || text.includes("vietnam")) return "Asia / Southeast Asia";
  if (text.includes("australia") || text.includes("new zealand")) return "Australia & New Zealand";
  if (text.includes("antarctica")) return "Antarctica";
  return "Mediterranean / Greek Isles";
}

function getDefaultDressCode(cruise) {
  const line = String(cruise?.cruise_line || "").toLowerCase();
  if (line.includes("cunard")) return "Formal";
  if (line.includes("virgin")) return "Casual";
  if (line.includes("explora") || line.includes("regent") || line.includes("silversea") || line.includes("seabourn")) return "Semi Formal";
  return "Semi Formal";
}

function getDefaultTravellerType(cruise) {
  const travellers = String(getTravellerSummary(cruise) || "").toLowerCase();
  if (travellers.includes("family") || travellers.includes("child") || travellers.includes("kid")) return "Family";
  const count = Number(getDashboardValue(cruise, ["traveller_count", "guests", "passengers", "guest_count"], 0));
  if (count === 1) return "Solo";
  if (count >= 3) return "Family";
  return "Couple";
}

async function loadPackingPreferences(cruise) {
  if (adminPreviewMode) return null;
  if (!currentUser?.id || !cruise?.id) return null;
  const { data, error } = await supabaseClient
    .from("user_packing_preferences")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("cruise_id", cruise.id)
    .maybeSingle();
  if (error) {
    console.warn("Packing preferences load failed", error);
    return null;
  }
  return data || null;
}

async function savePackingPreferencesFromForm() {
  const cruise = await loadCurrentCruise();
  if (!cruise) return;
  if (adminPreviewMode) {
    alert("Preview mode does not save packing settings. Customer accounts will save their own settings.");
    return;
  }

  const payload = {
    user_id: currentUser.id,
    cruise_id: cruise.id,
    traveller_type: document.getElementById("packingTravellerType")?.value || getDefaultTravellerType(cruise),
    destination: document.getElementById("packingDestination")?.value || getDefaultPackingDestination(cruise),
    dress_code: document.getElementById("packingDressCode")?.value || getDefaultDressCode(cruise),
    checked_baggage_allowance_kg: parseOptionalPackingNumber("packingCheckedBaggageAllowance"),
    cabin_baggage_allowance_kg: parseOptionalPackingNumber("packingCabinBaggageAllowance"),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseClient
    .from("user_packing_preferences")
    .upsert(payload, { onConflict: "user_id,cruise_id" });

  if (error) {
    console.error("Packing preferences save error", error);
    alert("Could not save packing settings. Please try again.");
    return;
  }

  renderPackingPlanner();
}

function parseOptionalPackingNumber(id) {
  const raw = String(document.getElementById(id)?.value || "").trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function splitRuleTags(value) {
  return String(value || "")
    .split(",")
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
}

function ruleMatches(value, selected) {
  const tags = splitRuleTags(value);
  if (!tags.length) return true;
  const s = String(selected || "").trim().toLowerCase();
  return tags.some(tag => tag === s || s.includes(tag) || tag.includes(s));
}

function packingItemApplies(item, context) {
  return ruleMatches(item.destination_tags, context.destination)
    && ruleMatches(item.climate_tags, context.climate)
    && ruleMatches(item.traveller_types, context.travellerType)
    && ruleMatches(item.dress_codes, context.dressCode)
    && ruleMatches(item.cruise_line_tags, context.cruiseLine);
}

function getClimateFromDestination(destination) {
  const value = String(destination || "").toLowerCase();
  if (value.includes("alaska") || value.includes("norway") || value.includes("antarctica")) return "Cold";
  if (value.includes("caribbean") || value.includes("bahamas") || value.includes("hawaii") || value.includes("asia")) return "Tropical";
  return "Warm";
}

let activePackingProfileKey = null;
let packingV2Profiles = [];
let packingShowSelectedOnly = false;
let packingV2State = [];
let packingV2CurrentCruiseKey = null;
let packingCabinSharePerTraveller = 0;

const PACKING_CABIN_CATEGORIES = new Set([
  "cabin essentials",
  "travel documents",
  "money & payments",
  "last minute"
]);


function normalisePackingProfileKey(value, fallback = "traveller") {
  const cleaned = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function getPackingTravellerNames(cruise) {
  const raw = String(getDashboardValue(cruise, ["traveller_names", "travellers", "guest_names", "passenger_names"], "") || "").trim();
  const names = raw
    ? raw.split(/,|\s+&\s+|\s+and\s+/i).map(name => name.trim()).filter(Boolean)
    : [];
  const count = Math.max(1, Number(getDashboardValue(cruise, ["traveller_count", "guests", "passengers", "guest_count"], names.length || 1)) || 1);
  while (names.length < count) names.push(`Traveller ${names.length + 1}`);
  return names.slice(0, Math.max(count, names.length));
}

function formatPackingDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Traveller";
  if (raw !== raw.toUpperCase()) return raw;
  return raw.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function buildPackingProfiles(cruise, savedProfiles = []) {
  const used = new Set();
  const travellers = getPackingTravellerNames(cruise).map((name, index) => {
    const rawFirstName = String(name || `Traveller ${index + 1}`).trim().split(/\s+/)[0] || `Traveller ${index + 1}`;
    const firstName = formatPackingDisplayName(rawFirstName);
    let key = normalisePackingProfileKey(rawFirstName, `traveller-${index + 1}`);
    if (used.has(key)) key = `${key}-${index + 1}`;
    used.add(key);
    const saved = savedProfiles.find(row => row.profile_key === key);
    return {
      profile_key: key,
      profile_name: firstName,
      profile_type: "traveller",
      display_order: index,
      checked_baggage_allowance_kg: saved?.checked_baggage_allowance_kg ?? null,
      cabin_baggage_allowance_kg: saved?.cabin_baggage_allowance_kg ?? null
    };
  });
  const cabinSaved = savedProfiles.find(row => row.profile_key === "cabin");
  return [...travellers, {
    profile_key: "cabin",
    profile_name: "Cabin",
    profile_type: "cabin",
    display_order: travellers.length,
    checked_baggage_allowance_kg: cabinSaved?.checked_baggage_allowance_kg ?? null,
    cabin_baggage_allowance_kg: cabinSaved?.cabin_baggage_allowance_kg ?? null
  }];
}

async function loadPackingV2Data(cruise) {
  const cruiseKey = String(cruise.id);
  packingV2CurrentCruiseKey = cruiseKey;
  if (adminPreviewMode || !currentUser?.id) {
    packingV2Profiles = buildPackingProfiles(cruise, []);
    packingV2State = [];
    return;
  }
  if (customerMode) {
    const data = await customerPackingRequest("load");
    const savedProfiles = data.profiles || [];
    customerPackingPreferences = data.preferences || null;
    packingV2Profiles = buildPackingProfiles(cruise, savedProfiles);
    packingV2State = data.state || [];
    const missingProfiles = packingV2Profiles.filter(profile => !savedProfiles.some(saved => saved.profile_key === profile.profile_key));
    if (missingProfiles.length) await customerPackingRequest("save_profiles", { profiles: missingProfiles });
    return;
  }
  const [profilesResult, stateResult] = await Promise.all([
    supabaseClient.from("user_packing_v2_profiles").select("*").eq("user_id", currentUser.id).eq("cruise_key", cruiseKey).order("display_order", { ascending: true }),
    supabaseClient.from("user_packing_v2_state").select("*").eq("user_id", currentUser.id).eq("cruise_key", cruiseKey)
  ]);
  if (profilesResult.error) console.warn("Packing v2 profiles load failed", profilesResult.error);
  if (stateResult.error) console.warn("Packing v2 state load failed", stateResult.error);
  const savedProfiles = profilesResult.data || [];
  packingV2Profiles = buildPackingProfiles(cruise, savedProfiles);
  packingV2State = stateResult.data || [];

  const missingProfiles = packingV2Profiles.filter(profile => !savedProfiles.some(saved => saved.profile_key === profile.profile_key));
  if (missingProfiles.length) {
    const payload = missingProfiles.map(profile => ({
      user_id: currentUser.id,
      cruise_key: cruiseKey,
      ...profile,
      updated_at: new Date().toISOString()
    }));
    const { error } = await supabaseClient.from("user_packing_v2_profiles").upsert(payload, { onConflict: "user_id,cruise_key,profile_key" });
    if (error) console.warn("Packing v2 profile setup failed", error);
  }
}

function getActivePackingProfile() {
  return packingV2Profiles.find(profile => profile.profile_key === activePackingProfileKey) || packingV2Profiles[0] || null;
}

function selectPackingProfile(profileKey) {
  activePackingProfileKey = profileKey;
  localStorage.setItem(`101cruise_packing_profile_${packingV2CurrentCruiseKey || "current"}`, profileKey);
  renderPackingPlanner();
}

function getPackingItemKey(item) {
  return item.source === "personal" ? `personal:${item.id}` : `system:${item.id}`;
}

function getPackingState(itemKey, profileKey = activePackingProfileKey) {
  return packingV2State.find(row => row.profile_key === profileKey && row.item_key === itemKey) || null;
}

function isPackingItemPacked(_progressRows, item) {
  if (adminPreviewMode) return adminPreviewPackedKeys.has(`${activePackingProfileKey}:${getPackingItemKey(item)}`);
  return getPackingState(getPackingItemKey(item))?.packed === true;
}

function groupPackingItems(items) {
  const grouped = {};
  (items || []).forEach(item => {
    const key = item.category_id || "personal";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });
  return grouped;
}

function getPackingTypeClass(type) {
  const value = String(type || "Recommended").toLowerCase();
  if (value === "required") return "priority-essential";
  if (value === "optional") return "priority-optional";
  return "priority-tip";
}

function getPackingTypeLabel(type) {
  const value = String(type || "Recommended").toLowerCase();
  if (value === "required") return "Recommended";
  if (value === "optional") return "Optional";
  return "Recommended";
}

const PACKING_NON_WEIGHT_CATEGORIES = new Set([
  "travel documents",
  "money & payments",
  "health & medication",
  "last minute",
  "cabin essentials"
]);

function packingCategoryUsesQuantityAndWeight(categoryName, profile = getActivePackingProfile()) {
  if (profile?.profile_type === "cabin") return false;
  return !PACKING_NON_WEIGHT_CATEGORIES.has(String(categoryName || "").trim().toLowerCase());
}

function packingItemBelongsToProfile(item, categoryName, profile) {
  const isCabinCategory = PACKING_CABIN_CATEGORIES.has(String(categoryName || "").trim().toLowerCase());
  return profile?.profile_type === "cabin" ? isCabinCategory : !isCabinCategory;
}

function formatPackingWeight(weightKg) {
  const value = Math.max(0, Number(weightKg || 0));
  if (value > 0 && value < 1) return `${Math.round(value * 1000)} g`;
  return `${value.toFixed(value >= 10 ? 1 : 2)} kg`;
}

function isCarryOnOnlyPackingItem(item) {
  return /(?:power\s*bank|portable\s+battery\s+(?:pack|bank))/i.test(String(item?.name || ""));
}

function renderPackingLocationSelector(key, location, visible, carryOnOnly = false) {
  if (carryOnOnly) {
    return `<div class="packing-location-selector ${visible ? "" : "is-hidden"}" data-location-selector>
      <span class="packing-location-option is-active is-locked">Carry-on only</span>
    </div>`;
  }
  const options = [
    ["checked", "Checked"],
    ["carry-on", "Carry-on"],
    ["wearing", "Wearing"]
  ];
  return `<div class="packing-location-selector ${visible ? "" : "is-hidden"}" data-location-selector>
    ${options.map(([value, label]) => `<button type="button" class="packing-location-option ${location === value ? "is-active" : ""}" onclick="updatePackingLocation('${escapeHtml(key)}','${value}')">${label}</button>`).join("")}
  </div>`;
}

function renderPackingRow(item, packed, quantity, categoryName = "") {
  const profile = getActivePackingProfile();
  const typeClass = getPackingTypeClass(item.item_type);
  const typeLabel = getPackingTypeLabel(item.item_type);
  const key = getPackingItemKey(item);
  const usesQuantityAndWeight = packingCategoryUsesQuantityAndWeight(categoryName, profile);
  const safeQuantity = usesQuantityAndWeight ? Math.max(0, Number(quantity ?? 0)) : 0;
  const state = getPackingState(key);
  const carryOnOnly = usesQuantityAndWeight && isCarryOnOnlyPackingItem(item);
  const location = usesQuantityAndWeight ? (carryOnOnly ? "carry-on" : (state?.packing_location || "checked")) : "checklist";
  const rawUnitWeight = Math.max(0, Number(item.weight_kg || 0));
  const unitWeight = usesQuantityAndWeight ? rawUnitWeight : 0;
  const cabinWeight = profile?.profile_type === "cabin" && String(categoryName || "").trim().toLowerCase() === "cabin essentials" ? rawUnitWeight : 0;
  const weight = unitWeight * safeQuantity;
  return `
    <div class="packing-row ${safeQuantity > 0 ? "is-selected" : ""} ${packed ? "is-packed" : ""} ${usesQuantityAndWeight ? "" : "packing-row-no-weight"}" data-packing-row="${escapeHtml(key)}" data-unit-weight="${unitWeight}" data-cabin-weight="${cabinWeight}" data-uses-weight="${usesQuantityAndWeight}" data-location="${escapeHtml(location)}">
      <div class="packing-check-cell">
        <input class="checklist-checkbox" type="checkbox" ${packed ? "checked" : ""} onchange="togglePackingItem('${escapeHtml(key)}', this.checked)">
      </div>
      <div class="packing-quantity-cell">
        ${usesQuantityAndWeight ? `
          <label class="sr-only" for="packingQuantity-${escapeHtml(key)}">Quantity for ${escapeHtml(item.name)}</label>
          <input id="packingQuantity-${escapeHtml(key)}" class="packing-quantity-input" type="number" min="0" step="1" inputmode="numeric" value="${safeQuantity}" oninput="updatePackingQuantity('${escapeHtml(key)}', this.value)">
        ` : `<span class="packing-not-applicable" aria-label="Quantity not applicable">—</span>`}
      </div>
      <div class="packing-main-cell">
        <div>
          <div class="packing-item-title">${escapeHtml(item.name)}</div>
          ${item.description ? `<div class="packing-item-description">${escapeHtml(item.description)}</div>` : ""}
          ${item.help_text ? `<div class="packing-item-help">ⓘ ${escapeHtml(item.help_text)}</div>` : ""}
          ${usesQuantityAndWeight ? renderPackingLocationSelector(key, location, safeQuantity > 0, carryOnOnly) : ""}
          ${carryOnOnly ? `<div class="packing-safety-note">Carry-on only. Power banks are not permitted in checked baggage.</div>` : ""}
        </div>
      </div>
      <div class="packing-type-cell"><span class="priority-badge ${typeClass}">${typeLabel}</span></div>
      <div class="packing-weight-cell" data-item-weight>${usesQuantityAndWeight ? formatPackingWeight(weight) : "—"}</div>
      ${item.source === "personal" ? `<button class="packing-delete-button" onclick="deletePersonalPackingItem(${item.id})">Delete</button>` : ""}
    </div>
  `;
}

const packingQuantitySaveTimers = new Map();

function updatePackingQuantity(key, rawValue) {
  const row = document.querySelector(`[data-packing-row="${CSS.escape(key)}"]`);
  if (!row) return;
  const quantity = Math.max(0, Math.round(Number(rawValue) || 0));
  const input = row.querySelector(".packing-quantity-input");
  if (input && String(input.value) !== String(quantity)) input.value = quantity;
  const unitWeight = Number(row.dataset.unitWeight || 0);
  const weightCell = row.querySelector("[data-item-weight]");
  if (weightCell) weightCell.textContent = formatPackingWeight(unitWeight * quantity);
  row.querySelector("[data-location-selector]")?.classList.toggle("is-hidden", quantity <= 0);
  row.classList.toggle("is-selected", quantity > 0);
  applyPackingFilters();
  recalculatePackingSummary();

  if (adminPreviewMode) return;
  clearTimeout(packingQuantitySaveTimers.get(`${activePackingProfileKey}:${key}`));
  const forcedLocation = row.querySelector(".packing-location-option.is-locked") ? "carry-on" : undefined;
  packingQuantitySaveTimers.set(`${activePackingProfileKey}:${key}`, setTimeout(() => savePackingV2State(key, { quantity, ...(forcedLocation ? { packing_location: forcedLocation } : {}) }), 450));
}

async function updatePackingLocation(key, location) {
  const row = document.querySelector(`[data-packing-row="${CSS.escape(key)}"]`);
  if (row) {
    row.dataset.location = location;
    row.querySelectorAll(".packing-location-option").forEach(button => button.classList.toggle("is-active", button.textContent.trim().toLowerCase() === location || (location === "carry-on" && button.textContent.trim() === "Carry-on")));
  }
  recalculatePackingSummary();
  if (!adminPreviewMode) await savePackingV2State(key, { packing_location: location });
}

async function savePackingV2State(itemKey, changes = {}) {
  if (!currentUser?.id || !packingV2CurrentCruiseKey || !activePackingProfileKey) return;
  const existing = getPackingState(itemKey) || {};
  const payload = {
    user_id: currentUser.id,
    cruise_key: packingV2CurrentCruiseKey,
    profile_key: activePackingProfileKey,
    item_key: itemKey,
    quantity: changes.quantity ?? existing.quantity ?? 0,
    packed: changes.packed ?? existing.packed ?? false,
    packing_location: changes.packing_location ?? existing.packing_location ?? "checked",
    packed_at: (changes.packed ?? existing.packed) ? (existing.packed_at || new Date().toISOString()) : null,
    updated_at: new Date().toISOString()
  };
  if (customerMode) {
    const customerPayload = { ...payload };
    delete customerPayload.user_id;
    delete customerPayload.cruise_key;
    const result = await customerPackingRequest("save_state", { state: customerPayload });
    const saved = result.state;
    const index = packingV2State.findIndex(row => row.profile_key === activePackingProfileKey && row.item_key === itemKey);
    if (index >= 0) packingV2State[index] = saved;
    else packingV2State.push(saved);
    return;
  }
  const { data, error } = await supabaseClient.from("user_packing_v2_state").upsert(payload, { onConflict: "user_id,cruise_key,profile_key,item_key" }).select("*").single();
  if (error) {
    console.error("Packing v2 state save error", error);
    return;
  }
  const index = packingV2State.findIndex(row => row.profile_key === activePackingProfileKey && row.item_key === itemKey);
  if (index >= 0) packingV2State[index] = data;
  else packingV2State.push(data);
}

function collectPackingSummaryFromDom() {
  const summary = { selected: 0, packed: 0, checked: 0, carryOn: 0, wearing: 0, checklistTotal: 0, checklistPacked: 0, cabinWeight: 0 };
  document.querySelectorAll(".packing-row").forEach(row => {
    const packed = row.querySelector(".checklist-checkbox")?.checked === true;
    if (row.dataset.usesWeight === "true") {
      const quantity = Math.max(0, Number(row.querySelector(".packing-quantity-input")?.value || 0));
      if (quantity > 0) {
        summary.selected += 1;
        if (packed) summary.packed += 1;
        const weight = Number(row.dataset.unitWeight || 0) * quantity;
        if (row.dataset.location === "carry-on") summary.carryOn += weight;
        else if (row.dataset.location === "wearing") summary.wearing += weight;
        else summary.checked += weight;
      }
    } else {
      summary.checklistTotal += 1;
      if (packed) {
        summary.checklistPacked += 1;
        summary.cabinWeight += Number(row.dataset.cabinWeight || 0);
      }
    }
  });
  return summary;
}

function recalculatePackingSummary() {
  const profile = getActivePackingProfile();
  const summary = collectPackingSummaryFromDom();
  if (profile?.profile_type === "cabin") {
    const percent = getProgressPercent(summary.checklistPacked, summary.checklistTotal);
    const value = document.getElementById("packingProgressPercent");
    const detail = document.getElementById("packingProgressDetail");
    if (value) value.textContent = `${percent}%`;
    if (detail) detail.textContent = `${summary.checklistPacked} of ${summary.checklistTotal} complete`;
    const totalNode = document.getElementById("cabinEssentialsWeightTotal");
    if (totalNode) totalNode.textContent = formatPackingWeight(summary.cabinWeight);
    const travellers = packingV2Profiles.filter(item => item.profile_type === "traveller");
    const share = travellers.length ? summary.cabinWeight / travellers.length : 0;
    travellers.forEach(item => {
      const node = document.querySelector(`[data-cabin-share="${CSS.escape(item.profile_key)}"]`);
      if (node) node.textContent = formatPackingWeight(share);
    });
    return;
  }
  summary.checked += packingCabinSharePerTraveller;
  const percent = getProgressPercent(summary.packed, summary.selected);
  const progressValue = document.getElementById("packingProgressPercent");
  const progressDetail = document.getElementById("packingProgressDetail");
  if (progressValue) progressValue.textContent = `${percent}%`;
  if (progressDetail) progressDetail.textContent = `${summary.packed} of ${summary.selected} selected items packed`;
  updatePackingWeightDisplay(summary);
}

async function savePackingPreferencesFromForm() {
  const cruise = await loadCurrentCruise();
  const profile = getActivePackingProfile();
  if (!cruise || !profile) return;
  if (adminPreviewMode) {
    alert("Preview mode does not save packing settings. Customer accounts will save their own settings.");
    return;
  }

  const globalPayload = {
    user_id: currentUser.id,
    cruise_id: cruise.id,
    traveller_type: document.getElementById("packingTravellerType")?.value || getDefaultTravellerType(cruise),
    destination: document.getElementById("packingDestination")?.value || getDefaultPackingDestination(cruise),
    dress_code: document.getElementById("packingDressCode")?.value || getDefaultDressCode(cruise),
    updated_at: new Date().toISOString()
  };
  const profilePayload = {
    user_id: currentUser.id,
    cruise_key: String(cruise.id),
    profile_key: profile.profile_key,
    profile_name: profile.profile_name,
    profile_type: profile.profile_type,
    display_order: profile.display_order,
    checked_baggage_allowance_kg: profile.profile_type === "traveller" ? parseOptionalPackingNumber("packingCheckedBaggageAllowance") : null,
    cabin_baggage_allowance_kg: profile.profile_type === "traveller" ? parseOptionalPackingNumber("packingCabinBaggageAllowance") : null,
    updated_at: new Date().toISOString()
  };

  if (customerMode) {
    const preferencesPayload = {
      traveller_type: globalPayload.traveller_type,
      destination: globalPayload.destination,
      dress_code: globalPayload.dress_code
    };
    const profileForCustomer = { ...profilePayload };
    delete profileForCustomer.user_id;
    delete profileForCustomer.cruise_key;
    const [, profileResult] = await Promise.all([
      customerPackingRequest("save_preferences", { preferences: preferencesPayload }),
      customerPackingRequest("save_profiles", { profiles: [profileForCustomer] })
    ]);
    customerPackingPreferences = { ...(customerPackingPreferences || {}), ...preferencesPayload };
    const savedProfile = profileResult?.profiles?.[0] || profileForCustomer;
    const index = packingV2Profiles.findIndex(item => item.profile_key === profile.profile_key);
    if (index >= 0) packingV2Profiles[index] = { ...packingV2Profiles[index], ...savedProfile };
    return;
  }
  const [globalResult, profileResult] = await Promise.all([
    supabaseClient.from("user_packing_preferences").upsert(globalPayload, { onConflict: "user_id,cruise_id" }),
    supabaseClient.from("user_packing_v2_profiles").upsert(profilePayload, { onConflict: "user_id,cruise_key,profile_key" })
  ]);
  if (globalResult.error || profileResult.error) {
    console.error("Packing settings save error", globalResult.error || profileResult.error);
    alert("Could not save packing settings. Please try again.");
    return;
  }
  const index = packingV2Profiles.findIndex(item => item.profile_key === profile.profile_key);
  if (index >= 0) packingV2Profiles[index] = { ...packingV2Profiles[index], ...profilePayload };
}

let packingPreferencesAutoSaveTimer = null;
function schedulePackingPreferencesSave(immediate = false) {
  if (adminPreviewMode) return;
  clearTimeout(packingPreferencesAutoSaveTimer);
  packingPreferencesAutoSaveTimer = setTimeout(() => savePackingPreferencesFromForm(), immediate ? 0 : 650);
}

function parseOptionalPackingNumber(id) {
  const raw = String(document.getElementById(id)?.value || "").trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function renderPackingControls(preferences, cruise, profile = getActivePackingProfile()) {
  const travellerType = preferences?.traveller_type === "Group" ? getDefaultTravellerType(cruise) : (preferences?.traveller_type || getDefaultTravellerType(cruise));
  const destination = preferences?.destination || getDefaultPackingDestination(cruise);
  const dressCode = preferences?.dress_code || getDefaultDressCode(cruise);
  const isCabin = profile?.profile_type === "cabin";
  return `
    <section class="planner-card packing-settings-card ${isCabin ? "is-cabin" : ""}">
      <div class="packing-settings-heading">
        <div>
          <h3>${isCabin ? "Cabin checklist" : `${escapeHtml(profile?.profile_name || "Traveller")}'s packing settings`}</h3>
          <p class="planner-muted">${isCabin ? "Shared cabin and departure items are kept simple: check them off once for the booking." : "Allowances are entered for this traveller only and save automatically."}</p>
          ${isCabin ? `<p class="cabin-pooling-warning"><strong>NOTE:</strong> Some airlines enforce per-bag or per-passenger weight limits rather than allowing the total baggage allowance to be pooled across everyone travelling. To avoid exceeding an individual allowance, it is recommended that Cabin Essentials are distributed amongst all travellers when packing.</p>` : ""}
        </div>
      </div>
      <div class="packing-settings-grid ${isCabin ? "packing-settings-grid-cabin" : ""}">
        <label><span>Who is travelling?</span>
          <select id="packingTravellerType" onchange="schedulePackingPreferencesSave(true)">
            ${["Solo", "Couple", "Family"].map(type => `<option value="${type}" ${travellerType === type ? "selected" : ""}>${type}</option>`).join("")}
          </select>
        </label>
        <label><span>Destination</span>
          <select id="packingDestination" onchange="schedulePackingPreferencesSave(true)">
            ${PACKING_DESTINATIONS.map(value => `<option value="${escapeHtml(value)}" ${destination === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
          </select>
        </label>
        <label><span>Dress code</span>
          <select id="packingDressCode" onchange="schedulePackingPreferencesSave(true)">
            ${["Casual", "Smart Casual", "Semi Formal", "Formal"].map(value => `<option value="${value}" ${dressCode === value ? "selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
        ${isCabin ? "" : `
          <label class="packing-baggage-field"><span>Checked baggage</span><div class="packing-allowance-input"><input id="packingCheckedBaggageAllowance" type="number" min="0" step="0.5" inputmode="decimal" value="${escapeHtml(profile?.checked_baggage_allowance_kg ?? "")}" placeholder="0" oninput="recalculatePackingSummary(); schedulePackingPreferencesSave()" onblur="schedulePackingPreferencesSave(true)"><span>kg</span></div></label>
          <label class="packing-baggage-field"><span>Cabin baggage</span><div class="packing-allowance-input"><input id="packingCabinBaggageAllowance" type="number" min="0" step="0.5" inputmode="decimal" value="${escapeHtml(profile?.cabin_baggage_allowance_kg ?? "")}" placeholder="0" oninput="recalculatePackingSummary(); schedulePackingPreferencesSave()" onblur="schedulePackingPreferencesSave(true)"><span>kg</span></div></label>
        `}
      </div>
    </section>
  `;
}

function getWeightStatus(totalWeight, baggageLimit) {
  if (baggageLimit === null || baggageLimit === undefined || baggageLimit === "") return "Enter this traveller's allowance to compare it with the packing plan.";
  const limit = Number(baggageLimit);
  if (!totalWeight) return "Add quantities to build this traveller's packing plan.";
  if (totalWeight <= limit * 0.75) return "There is comfortable room within the entered allowance.";
  if (totalWeight <= limit) return "This traveller is getting close to the entered allowance.";
  return "This traveller's current plan exceeds the entered allowance.";
}

function renderPackingWeightGauge(summary, profile) {
  const checkedLimit = profile?.checked_baggage_allowance_kg === null || profile?.checked_baggage_allowance_kg === undefined ? null : Number(profile.checked_baggage_allowance_kg);
  const cabinLimit = profile?.cabin_baggage_allowance_kg === null || profile?.cabin_baggage_allowance_kg === undefined ? null : Number(profile.cabin_baggage_allowance_kg);
  const rawPercent = checkedLimit && checkedLimit > 0 ? Math.max(0, Math.round((summary.checked / checkedLimit) * 100)) : 0;
  const remaining = checkedLimit === null ? null : checkedLimit - summary.checked;
  const isOver = checkedLimit !== null && summary.checked > checkedLimit;
  return `
    <div class="packing-weight-gauge">
      <div id="packingWeightDonut" class="packing-weight-donut ${isOver ? "is-over" : ""} ${checkedLimit === null ? "has-no-allowance" : ""}" style="--packing-weight-percent:${Math.min(100, rawPercent) * 3.6}deg">
        <div class="packing-weight-donut-centre"><strong id="packingWeightDonutPercent">${checkedLimit === null ? "—" : `${rawPercent}%`}</strong><span id="packingWeightDonutLabel">${checkedLimit === null ? "Enter allowance" : (isOver ? "Over allowance" : "Checked used")}</span></div>
      </div>
      <div class="packing-weight-details">
        <div class="packing-weight-metrics">
          <div><span>Checked</span><strong id="packingEstimatedWeight">${formatPackingWeight(summary.checked)}</strong></div>
          <div><span>Carry-on</span><strong id="packingCarryOnWeight">${formatPackingWeight(summary.carryOn)}</strong></div>
          <div><span>Wearing</span><strong id="packingWearingWeight">${formatPackingWeight(summary.wearing)}</strong></div>
          <div><span>Checked allowance</span><strong id="packingCheckedAllowanceValue">${checkedLimit === null ? "Not entered" : `${checkedLimit.toFixed(1)} kg`}</strong></div>
          <div><span>Cabin allowance</span><strong id="packingCabinAllowanceValue">${cabinLimit === null ? "Not entered" : `${cabinLimit.toFixed(1)} kg`}</strong></div>
          <div><span>Checked remaining</span><strong id="packingRemainingWeight" class="${isOver ? "is-over" : ""}">${remaining === null ? "—" : (remaining >= 0 ? `${remaining.toFixed(1)} kg` : `Over by ${Math.abs(remaining).toFixed(1)} kg`)}</strong></div>
        </div>
        <p id="packingWeightStatus">${escapeHtml(getWeightStatus(summary.checked, checkedLimit))}</p>
      </div>
    </div>`;
}

function updatePackingWeightDisplay(summary) {
  const checkedLimit = parseOptionalPackingNumber("packingCheckedBaggageAllowance");
  const cabinLimit = parseOptionalPackingNumber("packingCabinBaggageAllowance");
  const rawPercent = checkedLimit && checkedLimit > 0 ? Math.max(0, Math.round((summary.checked / checkedLimit) * 100)) : 0;
  const remaining = checkedLimit === null ? null : checkedLimit - summary.checked;
  const isOver = checkedLimit !== null && summary.checked > checkedLimit;
  const setText = (id, text) => { const node = document.getElementById(id); if (node) node.textContent = text; };
  setText("packingEstimatedWeight", formatPackingWeight(summary.checked));
  setText("packingCarryOnWeight", formatPackingWeight(summary.carryOn));
  setText("packingWearingWeight", formatPackingWeight(summary.wearing));
  setText("packingCheckedAllowanceValue", checkedLimit === null ? "Not entered" : `${checkedLimit.toFixed(1)} kg`);
  setText("packingCabinAllowanceValue", cabinLimit === null ? "Not entered" : `${cabinLimit.toFixed(1)} kg`);
  setText("packingRemainingWeight", remaining === null ? "—" : (remaining >= 0 ? `${remaining.toFixed(1)} kg` : `Over by ${Math.abs(remaining).toFixed(1)} kg`));
  setText("packingWeightDonutPercent", checkedLimit === null ? "—" : `${rawPercent}%`);
  setText("packingWeightDonutLabel", checkedLimit === null ? "Enter allowance" : (isOver ? "Over allowance" : "Checked used"));
  setText("packingWeightStatus", getWeightStatus(summary.checked, checkedLimit));
  const donut = document.getElementById("packingWeightDonut");
  if (donut) {
    donut.style.setProperty("--packing-weight-percent", `${Math.min(100, rawPercent) * 3.6}deg`);
    donut.classList.toggle("is-over", isOver);
    donut.classList.toggle("has-no-allowance", checkedLimit === null);
  }
  document.getElementById("packingRemainingWeight")?.classList.toggle("is-over", isOver);
}

function toggleHidePacked() {
  const page = document.getElementById("packing-page");
  if (!page) return;
  page.classList.toggle("hide-packed");
  const button = document.getElementById("hidePackedButton");
  if (button) button.innerText = page.classList.contains("hide-packed") ? "Show Packed" : "Hide Packed";
  applyPackingFilters();
}

function toggleSelectedOnly() {
  packingShowSelectedOnly = !packingShowSelectedOnly;
  localStorage.setItem(`101cruise_selected_only_${packingV2CurrentCruiseKey || "current"}_${activePackingProfileKey || "profile"}`, packingShowSelectedOnly ? "1" : "0");
  const button = document.getElementById("selectedOnlyButton");
  if (button) {
    button.classList.toggle("is-active", packingShowSelectedOnly);
    button.innerText = packingShowSelectedOnly ? "Show All Items" : "Show Selected Only";
  }
  applyPackingFilters();
}

function updatePackingListStatus() {
  const rows = [...document.querySelectorAll(".packing-row")];
  const weightedRows = rows.filter(row => row.dataset.usesWeight === "true");
  const selected = weightedRows.filter(row => row.classList.contains("is-selected")).length;
  const visible = rows.filter(row => !row.classList.contains("is-filtered-out") && getComputedStyle(row).display !== "none").length;
  const status = document.getElementById("packingListStatus");
  if (!status) return;
  const profile = getActivePackingProfile();
  if (profile?.profile_type === "cabin") status.textContent = `${visible} checklist items`;
  else status.textContent = packingShowSelectedOnly ? `Showing ${visible} selected items` : `${selected} selected from ${weightedRows.length} recommendations`;
}

function applyPackingFilters() {
  const query = String(document.getElementById("packingSearch")?.value || "").toLowerCase().trim();
  const hidePacked = document.getElementById("packing-page")?.classList.contains("hide-packed") === true;
  document.querySelectorAll(".packing-row").forEach(row => {
    const matchesSearch = !query || row.textContent.toLowerCase().includes(query);
    const matchesSelected = !packingShowSelectedOnly || row.dataset.usesWeight !== "true" || row.classList.contains("is-selected");
    const matchesPacked = !hidePacked || !row.classList.contains("is-packed");
    row.classList.toggle("is-filtered-out", !(matchesSearch && matchesSelected && matchesPacked));
  });
  document.querySelectorAll(".packing-category-block").forEach(block => {
    const hasVisibleRows = [...block.querySelectorAll(".packing-row")].some(row => !row.classList.contains("is-filtered-out"));
    block.classList.toggle("is-filtered-out", !hasVisibleRows);
  });
  updatePackingListStatus();
}

function filterPackingList() { applyPackingFilters(); }

function printPackingList() { window.print(); }
function savePackingPdf() { window.print(); }

async function resetPackingProgress() {
  const profile = getActivePackingProfile();
  if (!profile || !confirm(`Reset ${profile.profile_name}'s packing progress and quantities?`)) return;
  if (adminPreviewMode) {
    adminPreviewPackedKeys = new Set();
    renderPackingPlanner();
    return;
  }
  if (customerMode) {
    await customerPackingRequest("reset_profile", { profile_key: profile.profile_key });
    renderPackingPlanner();
    return;
  }
  await supabaseClient.from("user_packing_v2_state").delete().eq("user_id", currentUser.id).eq("cruise_key", packingV2CurrentCruiseKey).eq("profile_key", profile.profile_key);
  renderPackingPlanner();
}

async function addPersonalPackingItem(categoryId) {
  if (adminPreviewMode) { alert("Preview mode does not save personal packing items."); return; }
  if (customerMode) { alert("Adding personal items will be enabled in the next customer-access update."); return; }
  const cruise = await loadCurrentCruise();
  if (!cruise) return;
  const name = prompt("Add your own packing item");
  if (!name || !name.trim()) return;
  const { data, error } = await supabaseClient.from("user_packing_items").insert({ user_id: currentUser.id, cruise_id: cruise.id, category_id: categoryId, name: name.trim(), quantity: 0, weight_kg: 0, packed: false }).select("*").single();
  if (error) { alert("Could not add your item. Please try again."); return; }
  await savePackingV2State(`personal:${data.id}`, { quantity: 0, packed: false, packing_location: getActivePackingProfile()?.profile_type === "cabin" ? "checklist" : "checked" });
  renderPackingPlanner();
}

async function togglePackingItem(key, packed) {
  if (adminPreviewMode) {
    const previewKey = `${activePackingProfileKey}:${key}`;
    if (packed) adminPreviewPackedKeys.add(previewKey); else adminPreviewPackedKeys.delete(previewKey);
    recalculatePackingSummary();
    return;
  }
  await savePackingV2State(key, { packed });
  const row = document.querySelector(`[data-packing-row="${CSS.escape(key)}"]`);
  row?.classList.toggle("is-packed", packed);
  recalculatePackingSummary();
}

async function deletePersonalPackingItem(id) {
  if (!confirm("Delete this packing item?")) return;
  const itemKey = `personal:${id}`;
  const { error } = await supabaseClient.from("user_packing_items").delete().eq("id", id).eq("user_id", currentUser.id);
  if (!error) await supabaseClient.from("user_packing_v2_state").delete().eq("user_id", currentUser.id).eq("cruise_key", packingV2CurrentCruiseKey).eq("item_key", itemKey);
  if (error) alert("Could not delete packing item.");
  renderPackingPlanner();
}

function renderPackingProfileTabs(profiles) {
  return `<div class="packing-profile-tabs" role="tablist" aria-label="Packing profiles">
    ${profiles.map(profile => `<button type="button" role="tab" aria-selected="${profile.profile_key === activePackingProfileKey}" class="packing-profile-tab ${profile.profile_key === activePackingProfileKey ? "is-active" : ""}" onclick="selectPackingProfile('${escapeHtml(profile.profile_key)}')">${escapeHtml(profile.profile_name)}</button>`).join("")}
  </div>`;
}

async function renderPackingPlanner() {
  clearCountdownTimer();
  const cruise = await loadCurrentCruise();
  if (!cruise) {
    app.innerHTML = `<div class="planner-card"><button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button><h2>Packing Assistant</h2><p>Add a cruise before generating your packing list.</p></div>`;
    return;
  }
  let preferences = customerMode ? null : await loadPackingPreferences(cruise);
  await loadPackingV2Data(cruise);
  if (customerMode) preferences = customerPackingPreferences;
  const storedProfile = localStorage.getItem(`101cruise_packing_profile_${String(cruise.id)}`);
  if (!activePackingProfileKey || !packingV2Profiles.some(profile => profile.profile_key === activePackingProfileKey)) activePackingProfileKey = storedProfile || packingV2Profiles[0]?.profile_key;
  const profile = getActivePackingProfile();
  packingShowSelectedOnly = localStorage.getItem(`101cruise_selected_only_${String(cruise.id)}_${profile?.profile_key || "profile"}`) === "1";
  const context = {
    destination: preferences?.destination || getDefaultPackingDestination(cruise),
    travellerType: preferences?.traveller_type || getDefaultTravellerType(cruise),
    dressCode: preferences?.dress_code || getDefaultDressCode(cruise),
    climate: getClimateFromDestination(preferences?.destination || getDefaultPackingDestination(cruise)),
    cruiseLine: cruise.cruise_line || ""
  };

  const [{ data: categories }, { data: items }, personalResult] = await Promise.all([
    supabaseClient.from("packing_categories").select("*").eq("active", true).order("display_order", { ascending: true }),
    supabaseClient.from("packing_items").select("*, packing_categories(name)").eq("active", true).order("display_order", { ascending: true }),
    (adminPreviewMode || customerMode) ? Promise.resolve({ data: [] }) : supabaseClient.from("user_packing_items").select("*").eq("user_id", currentUser.id).eq("cruise_id", cruise.id).order("created_at", { ascending: true })
  ]);
  const categoryNameById = new Map((categories || []).map(category => [String(category.id), category.name]));
  const systemItems = (items || []).filter(item => packingItemApplies(item, context)).map(item => ({
    ...item,
    source: "system",
    calculated_quantity: getPackingState(`system:${item.id}`, profile.profile_key)?.quantity ?? 0
  }));
  const personalItems = (personalResult?.data || []).map(item => ({
    ...item,
    source: "personal",
    calculated_quantity: getPackingState(`personal:${item.id}`, profile.profile_key)?.quantity ?? 0,
    item_type: "Optional",
    description: item.note || "Personal packing item",
    packing_categories: { name: categoryNameById.get(String(item.category_id)) || "" }
  }));
  const allPackingItems = [...systemItems, ...personalItems].filter(item => {
    const categoryName = item.packing_categories?.name || categoryNameById.get(String(item.category_id)) || "";
    return packingItemBelongsToProfile(item, categoryName, profile);
  });
  const grouped = groupPackingItems(allPackingItems);
  const summary = { selected: 0, packed: 0, checked: 0, carryOn: 0, wearing: 0, checklistTotal: 0, checklistPacked: 0, cabinWeight: 0 };
  allPackingItems.forEach(item => {
    const categoryName = item.packing_categories?.name || categoryNameById.get(String(item.category_id)) || "";
    const state = getPackingState(getPackingItemKey(item), profile.profile_key);
    if (packingCategoryUsesQuantityAndWeight(categoryName, profile)) {
      const quantity = Math.max(0, Number(state?.quantity ?? 0));
      if (quantity > 0) {
        summary.selected += 1;
        if (state?.packed) summary.packed += 1;
        const weight = Number(item.weight_kg || 0) * quantity;
        if (state?.packing_location === "carry-on") summary.carryOn += weight;
        else if (state?.packing_location === "wearing") summary.wearing += weight;
        else summary.checked += weight;
      }
    } else {
      summary.checklistTotal += 1;
      if (state?.packed) {
        summary.checklistPacked += 1;
        if (profile.profile_type === "cabin" && String(categoryName || "").trim().toLowerCase() === "cabin essentials") summary.cabinWeight += Number(item.weight_kg || 0);
      }
    }
  });
  const travellerProfiles = packingV2Profiles.filter(item => item.profile_type === "traveller");
  const cabinProfile = packingV2Profiles.find(item => item.profile_type === "cabin");
  let totalCabinEssentialsWeight = 0;
  if (cabinProfile) {
    (items || []).filter(item => packingItemApplies(item, context)).forEach(item => {
      const categoryName = item.packing_categories?.name || categoryNameById.get(String(item.category_id)) || "";
      if (String(categoryName).trim().toLowerCase() !== "cabin essentials") return;
      const cabinState = getPackingState(`system:${item.id}`, cabinProfile.profile_key);
      if (cabinState?.packed) totalCabinEssentialsWeight += Number(item.weight_kg || 0);
    });
  }
  const cabinSharePerTraveller = travellerProfiles.length ? totalCabinEssentialsWeight / travellerProfiles.length : 0;
  packingCabinSharePerTraveller = profile.profile_type === "traveller" ? cabinSharePerTraveller : 0;
  if (profile.profile_type === "traveller") summary.checked += cabinSharePerTraveller;
  const percent = profile.profile_type === "cabin" ? getProgressPercent(summary.checklistPacked, summary.checklistTotal) : getProgressPercent(summary.packed, summary.selected);

  app.innerHTML = `
    <div id="packing-page" class="packing-page packing-assistant-v2">
      ${renderPlannerNav("packing")}
      <div class="checklist-toolbar planner-card slim-card packing-toolbar">
        <div><p class="planner-kicker">Packing Assistant</p><h2>${escapeHtml(profile.profile_name)}${profile.profile_type === "traveller" ? "'s Packing" : " Checklist"}</h2><p class="planner-muted">${escapeHtml(cruise.ship_name || cruise.cruise_line || "Your cruise")} • ${escapeHtml(context.destination)} • ${escapeHtml(context.dressCode)}</p></div>
        <div class="checklist-toolbar-actions"><button class="planner-button secondary" id="selectedOnlyButton" onclick="toggleSelectedOnly()">Show Selected Only</button><button class="planner-button secondary" id="hidePackedButton" onclick="toggleHidePacked()">Hide Packed</button><button class="planner-button secondary" onclick="resetPackingProgress()">Reset</button><button class="planner-button secondary" onclick="printPackingList()">Print</button><button class="planner-button" onclick="savePackingPdf()">Save PDF</button></div>
      </div>
      ${renderPackingProfileTabs(packingV2Profiles)}
      ${renderPackingControls(preferences, cruise, profile)}
      <div class="packing-workspace">
        <div class="packing-list-column">
          <section class="planner-card packing-search-card"><input id="packingSearch" type="search" placeholder="Search ${escapeHtml(profile.profile_name)}'s list..." oninput="filterPackingList()"><span id="packingListStatus" class="packing-list-status"></span></section>
          <main class="packing-content">
            ${(categories || []).map(category => {
              const categoryItems = grouped[category.id] || [];
              if (!categoryItems.length) return "";
              const usesWeight = packingCategoryUsesQuantityAndWeight(category.name, profile);
              const catPlanned = usesWeight ? categoryItems.filter(item => Number(getPackingState(getPackingItemKey(item), profile.profile_key)?.quantity || 0) > 0).length : categoryItems.length;
              const catPacked = categoryItems.filter(item => getPackingState(getPackingItemKey(item), profile.profile_key)?.packed === true && (!usesWeight || Number(getPackingState(getPackingItemKey(item), profile.profile_key)?.quantity || 0) > 0)).length;
              return `<section class="checklist-section-block packing-category-block">
                <div class="checklist-section-header"><div><h3>${escapeHtml(category.icon || "🧳")} ${escapeHtml(category.name)}</h3>${category.description ? `<p>${escapeHtml(category.description)}</p>` : ""}</div><div class="section-progress-pill">${profile.profile_type === "cabin" ? `${catPacked}/${catPlanned} Complete` : (catPlanned ? `${catPacked}/${catPlanned} Packed` : "No items selected")}</div></div>
                <div class="packing-table-header ${usesWeight ? "" : "packing-table-header-no-weight"}"><span></span><span>Quantity</span><span>Item</span><span>Type</span><span>Weight</span></div>
                ${categoryItems.map(item => renderPackingRow(item, getPackingState(getPackingItemKey(item), profile.profile_key)?.packed === true, getPackingState(getPackingItemKey(item), profile.profile_key)?.quantity ?? 0, category.name)).join("")}
                <button class="add-personal-task-button" onclick="addPersonalPackingItem(${category.id})">+ Add your own item</button>
              </section>`;
            }).join("")}
          </main>
        </div>
        <aside class="planner-card packing-summary-card packing-summary-sticky" aria-label="Packing progress and baggage summary">
          <div class="packing-profile-summary-name">${escapeHtml(profile.profile_name)}</div>
          <div class="packing-progress-summary"><span>${profile.profile_type === "cabin" ? "Cabin checklist" : "Ready to Cruise"}</span><strong id="packingProgressPercent">${percent}%</strong><small id="packingProgressDetail">${profile.profile_type === "cabin" ? `${summary.checklistPacked} of ${summary.checklistTotal} complete` : `${summary.packed} of ${summary.selected} selected items packed`}</small></div>
          ${profile.profile_type === "cabin" ? `<div class="cabin-summary-note"><strong>Cabin Essentials weight</strong><p>Total selected weight: <b id="cabinEssentialsWeightTotal">${formatPackingWeight(summary.cabinWeight)}</b></p><p>Automatically distributed:</p><div class="cabin-weight-distribution">${travellerProfiles.map(item => `<span>${escapeHtml(item.profile_name)} <b data-cabin-share="${escapeHtml(item.profile_key)}">${formatPackingWeight(cabinSharePerTraveller)}</b></span>`).join("")}</div></div>` : renderPackingWeightGauge(summary, profile)}
        </aside>
      </div>
    </div>`;
  const selectedOnlyButton = document.getElementById("selectedOnlyButton");
  if (selectedOnlyButton) {
    selectedOnlyButton.classList.toggle("is-active", packingShowSelectedOnly);
    selectedOnlyButton.innerText = packingShowSelectedOnly ? "Show All Items" : "Show Selected Only";
  }
  applyPackingFilters();
}

async function addCruise() {
  const cruiseLine = document.getElementById("cruiseLine").value;
  const shipName = document.getElementById("shipName").value;
  const departureDate = document.getElementById("departureDate").value;
  const departureTime = document.getElementById("departureTime").value || "17:00";
  const nights = Number(document.getElementById("nights").value);

  if (!cruiseLine) {
    document.getElementById("cruise-message").innerText = "Please select a cruise line.";
    return;
  }

  const { data, error } = await supabaseClient.from("cruises").insert({
    user_id: currentUser.id,
    cruise_line: cruiseLine,
    ship_name: shipName,
    departure_date: departureDate || null,
    departure_time: departureTime || "17:00",
    nights: nights || null
  }).select("*").single();

  if (error) {
    document.getElementById("cruise-message").innerText = error.message;
    return;
  }

  if (data) await savePlannerPreferenceForCruise(data);
  renderDashboard();
}

async function initPlanner() {
  const previewLookup = getAdminPreviewLookupFromUrl();
  if (previewLookup) {
    await loadAdminPreview(previewLookup);
    return;
  }

  const storedCustomerSession = getStoredCustomerSession();
  if (storedCustomerSession && activateCustomerSession(storedCustomerSession)) {
    try {
      await customerPackingRequest("load");
      await renderDashboard();
      return;
    } catch (error) {
      console.warn("Stored customer session could not be restored", error);
      clearCustomerSession();
    }
  }

  captureInvitationBookingId();

  const { data } = await supabaseClient.auth.getSession();

  if (data.session) {
    currentUser = data.session.user;
    await ensureProfile();
    await loadProfile();
    await syncInvitationBookingForCurrentUser();
    renderDashboard();
  } else {
    renderCustomerAccess();
  }
}

initPlanner();
