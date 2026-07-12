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


const DASHBOARD_JOURNEY_PROTOTYPES = {
  "SWM123456": {
    title: "Tokyo to Seoul",
    stops: [
      { date: "2026-09-11", name: "Tokyo (Yokohama)", type: "embarkation", arrival: "", departure: "5:00 pm", lat: 35.4437, lng: 139.6380 },
      { date: "2026-09-12", name: "Mt Fuji (Shimizu)", type: "port", arrival: "7:00 am", departure: "6:00 pm", lat: 35.0159, lng: 138.4897 },
      { date: "2026-09-13", name: "Kyoto (Osaka)", type: "port", arrival: "11:00 am", departure: "", lat: 34.6573, lng: 135.4323 },
      { date: "2026-09-14", name: "Kyoto (Osaka)", type: "port", arrival: "", departure: "6:00 pm", lat: 34.6573, lng: 135.4323 },
      { date: "2026-09-15", name: "Kochi", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 33.5008, lng: 133.5589 },
      { date: "2026-09-16", name: "Hiroshima", type: "port", arrival: "9:00 am", departure: "6:00 pm", lat: 34.3523, lng: 132.4553 },
      { date: "2026-09-17", name: "At Sea", type: "sea_day", arrival: "", departure: "" },
      { date: "2026-09-18", name: "Kagoshima", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 31.5894, lng: 130.5611 },
      { date: "2026-09-19", name: "Nagasaki", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 32.7503, lng: 129.8779 },
      { date: "2026-09-20", name: "Fukuoka", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 33.5904, lng: 130.4017 },
      { date: "2026-09-21", name: "Busan", type: "port", arrival: "7:00 am", departure: "6:00 pm", lat: 35.1028, lng: 129.0403 },
      { date: "2026-09-22", name: "At Sea", type: "sea_day", arrival: "", departure: "" },
      { date: "2026-09-23", name: "Seoul (Incheon)", type: "disembarkation", arrival: "5:00 am", departure: "", lat: 37.4563, lng: 126.7052 }
    ]
  }
};

function getDashboardJourney(cruise) {
  const reference = String(cruise?.booking_reference || customerBooking?.booking_reference || adminPreviewCruise?.booking_reference || "").trim().toUpperCase();
  return DASHBOARD_JOURNEY_PROTOTYPES[reference] || null;
}

async function loadDashboardPackingData(cruise) {
  try {
    if (customerMode) {
      const data = await customerPackingRequest("load");
      const profiles = data.profiles || [];
      const states = data.state || [];
      const profileTypes = new Map(profiles.map(profile => [profile.profile_key, profile.profile_type]));
      let selected = 0;
      let packed = 0;
      states.forEach(row => {
        const isCabin = profileTypes.get(row.profile_key) === "cabin" || row.profile_key === "cabin";
        const isSelected = isCabin ? row.packed === true : Number(row.quantity || 0) > 0;
        if (!isSelected) return;
        selected += 1;
        if (row.packed === true) packed += 1;
      });
      return { selected, packed, percent: selected ? Math.round((packed / selected) * 100) : 0 };
    }
    if (!currentUser?.id || adminPreviewMode) return { selected: 0, packed: 0, percent: 0 };
    const cruiseKey = String(cruise?.id || "");
    const { data, error } = await supabaseClient
      .from("user_packing_v2_state")
      .select("profile_key,quantity,packed")
      .eq("user_id", currentUser.id)
      .eq("cruise_key", cruiseKey);
    if (error) throw error;
    let selected = 0;
    let packed = 0;
    (data || []).forEach(row => {
      const isSelected = row.profile_key === "cabin" ? row.packed === true : Number(row.quantity || 0) > 0;
      if (!isSelected) return;
      selected += 1;
      if (row.packed === true) packed += 1;
    });
    return { selected, packed, percent: selected ? Math.round((packed / selected) * 100) : 0 };
  } catch (error) {
    console.warn("Dashboard packing progress load failed", error);
    return { selected: 0, packed: 0, percent: 0 };
  }
}

function renderDashboardQuickAccess() {
  return `
    <nav class="dashboard-quick-access" aria-label="My Cruise tools">
      <button onclick="renderPackingPlanner()"><span aria-hidden="true">🧳</span><strong>Packing List</strong></button>
      <button onclick="renderChecklist()"><span aria-hidden="true">✓</span><strong>Checklist</strong></button>
      <button onclick="renderDocuments()"><span aria-hidden="true">📄</span><strong>Documents</strong></button>
      <button onclick="renderBudgetPlanner()"><span aria-hidden="true">💳</span><strong>Budget</strong></button>
    </nav>
  `;
}

function renderDashboardProgressCard(label, percent, detail, action) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `
    <article class="dashboard-mini-progress">
      <div class="dashboard-mini-progress-circle" style="--progress:${safePercent * 3.6}deg">
        <div><strong>${safePercent}%</strong><span>${escapeHtml(label)}</span></div>
      </div>
      <p>${escapeHtml(detail)}</p>
      <button class="dashboard-outline-action dashboard-card-button" onclick="${action}">Open ${escapeHtml(label)} →</button>
    </article>
  `;
}

function renderDashboardCombinedProgress(packingData, checklistData) {
  const items = [
    { label: "Packing", percent: packingData.percent, detail: packingData.selected ? `${packingData.packed} of ${packingData.selected} selected items packed` : "Start building your packing list", action: "renderPackingPlanner()" },
    { label: "Preparation", percent: checklistData.percent, detail: checklistData.totalCount ? `${checklistData.completedCount} of ${checklistData.totalCount} tasks complete` : "Your planning starts here", action: "renderChecklist()" }
  ];
  return `
    <article class="dashboard-summary-card dashboard-combined-progress-card">
      <p class="dashboard-card-label">Your Progress</p>
      <div class="dashboard-combined-progress-grid">
        ${items.map(item => {
          const safePercent = Math.max(0, Math.min(100, Number(item.percent) || 0));
          return `<section class="dashboard-combined-progress-item">
            <h2>${escapeHtml(item.label)}</h2>
            <div class="dashboard-mini-progress-circle" style="--progress:${safePercent * 3.6}deg">
              <div><strong>${safePercent}%</strong><span>Complete</span></div>
            </div>
            <p>${escapeHtml(item.detail)}</p>
            <button class="dashboard-outline-action dashboard-card-button" onclick="${item.action}">Open ${escapeHtml(item.label)} →</button>
          </section>`;
        }).join("")}
      </div>
    </article>`;
}

let dashboardLeafletMap = null;
let dashboardShipAnimationFrame = null;

function renderJourneyMap(journey) {
  if (!journey) {
    return `
      <article class="dashboard-summary-card dashboard-journey-card">
        <p class="dashboard-card-label">Your Journey</p>
        <h2>Journey map coming soon</h2>
        <p class="dashboard-card-copy">Your itinerary will appear here once it has been added.</p>
      </article>
    `;
  }
  const previewStops = journey.stops.slice(0, 3);
  const remainingStops = journey.stops.slice(3);
  return `
    <article class="dashboard-summary-card dashboard-journey-card">
      <div class="dashboard-journey-heading">
        <div><p class="dashboard-card-label">Your Journey</p><h2>${escapeHtml(journey.title)}</h2></div>
      </div>
      ${renderEditorialJourneyMap(journey)}
      <div class="dashboard-itinerary-preview" id="dashboardItineraryPreview">
        ${previewStops.map((stop, index) => renderDashboardItineraryPreviewDay(stop, index)).join("")}
        <div id="dashboardItineraryExtra" class="dashboard-itinerary-extra" hidden>
          ${remainingStops.map((stop, index) => renderDashboardItineraryPreviewDay(stop, index + 3)).join("")}
        </div>
      </div>
      ${remainingStops.length ? `<button id="dashboardItineraryToggle" class="dashboard-outline-action dashboard-card-button dashboard-itinerary-toggle" onclick="toggleDashboardItinerary()">Open Full Itinerary →</button>` : ""}
    </article>
  `;
}

function renderEditorialJourneyMap(journey) {
  return `
    <div class="dashboard-route-map dashboard-final-map" aria-label="Illustrative cruise route map from Tokyo to Seoul">
      <svg viewBox="0 0 620 350" role="img" aria-labelledby="dashboardMapTitle dashboardMapDesc">
        <title id="dashboardMapTitle">${escapeHtml(journey.title)} cruise route</title>
        <desc id="dashboardMapDesc">An illustrative coastal route showing the cruise sequence between Japan and South Korea.</desc>
        <defs>
          <linearGradient id="dashboardSea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dff1f7"/><stop offset="1" stop-color="#cbe7ef"/></linearGradient>
          <filter id="dashboardShipShadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity=".25"/></filter>
          <path id="dashboardRoutePath" d="M 504.6 138.1 C 520 158 500 184 464.7 154.8 C 446 190 410 224 359.3 169.2 C 344 208 322 236 294.5 213.9 C 280 244 254 248 256.6 180.8 C 232 218 210 272 191.5 287.8 C 177 292 161 268 167.7 243.1 C 170 228 181 216 186.0 210.4 C 167 197 148 173 140.5 151.7 C 110 165 78 145 50 116 C 28 94 34 69 55.8 60.3"/>
        </defs>
        <rect width="620" height="350" rx="18" fill="url(#dashboardSea)"/>
        <g class="dashboard-map-land"><path d="M99.7,0.0L109.9,10.7 L112.5,9.4 L115.8,12.1 L124.5,33.2 L139.8,51.5 L152.6,75.4 L154.2,88.4 L150.6,114.9 L153.3,116.9 L157.0,113.3 L157.9,116.1 L153.1,136.4 L150.0,134.3 L150.3,141.6 L142.1,151.7 L139.5,150.8 L140.9,153.6 L138.8,151.8 L136.6,154.3 L136.4,150.3 L127.2,151.7 L123.6,147.3 L125.2,152.9 L119.1,151.5 L120.6,155.1 L117.4,155.8 L117.6,160.4 L119.7,159.8 L117.9,164.8 L114.7,162.4 L118.1,161.1 L113.9,160.0 L114.8,157.3 L110.1,159.7 L105.0,158.2 L105.3,152.2 L103.6,156.3 L100.7,155.2 L99.0,157.7 L93.7,155.6 L93.5,158.1 L90.4,159.2 L89.6,157.2 L88.7,159.4 L90.9,162.3 L95.6,161.0 L96.6,171.6 L91.6,164.9 L91.1,170.1 L87.9,168.8 L89.4,165.4 L86.7,159.9 L81.2,161.8 L86.4,171.4 L80.4,171.5 L84.0,173.1 L80.6,177.2 L76.2,172.7 L72.8,173.2 L75.7,169.1 L76.7,171.6 L77.6,166.8 L78.7,168.8 L80.8,166.8 L77.2,164.2 L75.1,167.6 L67.4,169.9 L68.2,176.1 L64.9,178.0 L61.5,176.2 L60.9,170.3 L59.7,177.1 L52.5,183.1 L50.1,175.7 L53.1,171.7 L47.8,173.8 L44.1,171.3 L44.6,164.8 L47.2,170.9 L51.1,170.8 L47.8,166.6 L55.9,170.1 L51.6,165.8 L46.9,165.5 L58.0,162.6 L53.9,162.1 L53.4,156.1 L52.2,164.0 L47.1,164.2 L49.6,156.6 L45.0,158.4 L47.8,154.2 L42.7,151.2 L46.4,149.3 L48.9,154.6 L50.8,152.2 L45.7,146.7 L48.1,141.2 L51.3,142.9 L48.4,139.6 L51.1,138.8 L51.1,135.2 L57.9,134.7 L57.3,131.9 L52.0,133.0 L50.2,130.7 L58.0,125.5 L61.4,126.1 L58.0,122.8 L63.2,120.2 L55.5,121.1 L55.6,118.9 L64.3,114.4 L65.2,111.2 L59.4,116.7 L51.4,111.5 L54.8,109.8 L51.1,101.4 L54.1,98.3 L51.5,99.8 L52.1,90.4 L50.5,88.2 L47.1,92.4 L46.9,87.7 L44.4,88.8 L48.9,101.1 L45.9,99.4 L43.8,88.3 L39.8,90.3 L42.1,88.6 L39.7,86.5 L38.5,89.1 L38.2,86.6 L39.9,83.7 L41.2,86.2 L40.6,82.1 L43.8,82.7 L44.8,78.6 L43.6,85.4 L46.6,85.9 L45.4,83.5 L49.3,81.7 L46.8,77.3 L50.0,77.6 L50.5,83.8 L52.0,79.1 L54.0,82.2 L51.6,75.4 L56.1,79.7 L61.5,78.7 L64.0,86.1 L68.4,79.2 L65.7,81.2 L61.6,77.9 L63.9,77.1 L60.1,76.3 L61.8,70.6 L56.8,71.8 L57.7,67.7 L64.1,67.3 L54.8,60.5 L57.2,55.3 L53.0,52.8 L52.4,48.0 L56.8,47.7 L57.0,51.7 L65.5,56.6 L57.7,51.2 L59.5,44.6 L54.2,47.8 L48.0,41.8 L39.9,45.2 L38.8,48.9 L36.2,43.8 L30.9,45.1 L28.2,39.4 L21.6,37.3 L19.3,37.8 L25.4,41.5 L21.6,41.7 L21.3,48.1 L18.1,46.1 L11.9,51.4 L12.3,47.9 L15.4,47.5 L12.4,47.1 L17.5,46.1 L17.7,43.0 L13.0,42.5 L15.6,44.8 L12.3,43.7 L10.3,46.6 L7.9,46.1 L10.5,43.8 L8.2,40.9 L6.0,44.0 L0.0,41.9 L0.0,41.4 L5.3,40.5 L3.9,36.9 L8.4,38.2 L9.0,35.6 L0.0,34.9 L0.0,20.1 L0.4,19.7 L0.0,18.8 L0.0,16.5 L2.5,17.7 L4.2,12.6 L10.7,14.4 L15.0,11.0 L20.8,13.6 L15.4,8.9 L9.6,11.8 L4.3,4.8 L7.5,0.0 L99.7,0.0 Z"/><path d="M378.9,205.7L378.8,205.8 L377.5,210.7 L370.4,216.4 L370.8,214.6 L359.9,211.9 L355.9,207.3 L358.2,205.3 L346.4,199.0 L350.5,193.2 L347.2,191.6 L351.7,188.6 L346.9,182.8 L353.5,179.8 L360.4,171.8 L359.8,167.5 L356.0,166.2 L345.9,170.0 L332.3,163.5 L316.4,165.6 L318.5,167.3 L315.9,170.6 L306.8,171.1 L306.0,172.7 L311.7,172.0 L307.8,176.9 L302.7,177.5 L299.7,172.6 L295.4,176.4 L292.3,174.5 L290.9,177.1 L288.1,176.4 L288.2,180.0 L284.0,177.3 L282.8,180.6 L282.8,178.5 L278.5,179.0 L278.1,181.1 L261.7,185.4 L260.3,191.7 L256.5,190.7 L260.3,185.2 L259.2,180.1 L254.9,179.8 L248.8,184.9 L248.6,194.4 L244.6,196.0 L245.9,201.0 L243.6,196.9 L240.1,197.7 L236.0,193.9 L233.3,195.3 L235.1,193.2 L232.4,191.7 L221.9,195.0 L220.4,191.7 L215.7,197.3 L208.0,192.0 L203.4,197.8 L201.9,190.0 L204.2,186.3 L202.1,183.1 L203.2,180.3 L207.9,179.9 L204.4,179.1 L205.7,177.2 L212.4,179.8 L220.8,177.8 L227.5,168.6 L235.9,166.8 L262.8,144.3 L262.8,138.7 L278.7,131.9 L286.7,133.4 L284.3,135.8 L289.3,137.9 L295.1,134.9 L315.7,134.8 L328.6,129.5 L341.9,130.4 L352.2,125.2 L354.9,129.8 L349.8,134.0 L353.3,132.2 L355.1,137.9 L360.3,132.0 L362.3,136.3 L367.3,134.2 L364.6,136.5 L369.2,136.7 L369.0,133.3 L373.2,134.6 L372.6,130.5 L378.1,131.2 L379.5,125.8 L381.3,129.8 L382.3,125.3 L377.5,117.0 L383.1,106.8 L393.1,100.4 L403.1,87.5 L405.4,77.8 L401.9,71.9 L405.0,63.6 L425.2,57.7 L421.8,65.8 L413.7,70.6 L410.3,68.8 L408.5,74.6 L412.8,75.9 L415.3,73.6 L412.9,82.6 L415.1,86.4 L424.8,87.0 L428.3,80.5 L455.3,71.2 L466.4,63.5 L476.9,45.9 L496.9,33.1 L500.8,17.1 L511.3,4.2 L512.5,0.0 L573.0,0.0 L574.4,5.4 L571.1,3.5 L570.5,12.0 L566.4,12.8 L569.4,14.1 L565.6,17.6 L569.9,18.5 L566.6,21.7 L569.7,23.5 L569.2,28.2 L565.9,23.4 L559.7,22.6 L553.5,24.3 L554.1,27.3 L548.3,31.1 L552.6,58.4 L550.5,78.0 L544.0,82.3 L535.9,105.8 L540.2,119.7 L545.8,126.7 L541.6,124.7 L546.4,128.6 L540.3,128.4 L535.0,131.9 L530.7,137.9 L529.9,148.2 L520.7,151.1 L512.9,159.5 L508.2,157.0 L511.8,155.7 L512.2,146.6 L508.7,143.2 L521.0,133.4 L516.3,128.8 L513.0,131.3 L509.1,129.4 L509.3,135.3 L503.9,137.7 L504.2,144.0 L508.0,145.6 L505.7,150.1 L503.3,150.0 L501.1,143.6 L488.1,145.7 L484.6,153.4 L487.1,159.7 L481.8,168.9 L476.9,171.1 L473.3,167.6 L474.0,156.8 L478.8,153.6 L473.4,150.4 L467.4,151.4 L465.5,156.2 L460.0,159.0 L454.7,168.3 L455.7,171.3 L434.0,168.1 L435.7,163.3 L431.1,165.0 L433.9,168.1 L413.9,171.9 L415.8,168.7 L423.9,168.0 L426.2,164.1 L420.4,162.4 L419.5,164.7 L414.3,164.3 L412.7,157.0 L410.4,164.1 L412.4,167.4 L409.5,166.5 L407.2,159.4 L409.6,151.8 L403.4,153.4 L396.2,169.1 L410.7,177.1 L410.3,179.8 L406.8,180.2 L410.2,180.2 L409.9,183.7 L405.2,184.3 L408.7,183.1 L402.5,183.4 L403.8,181.1 L401.7,181.0 L399.7,184.4 L390.1,186.8 L389.2,191.2 L388.2,189.5 L385.9,191.6 L388.3,195.5 L386.2,194.5 L378.9,205.7 Z"/><path d="M195.3,311.1L199.9,298.1 L196.3,289.6 L192.6,288.2 L195.7,286.6 L198.7,289.1 L199.7,283.9 L194.3,282.6 L189.9,291.7 L191.9,298.8 L195.3,300.7 L192.5,305.1 L188.1,301.4 L179.7,301.5 L175.9,295.1 L183.1,293.9 L183.7,289.0 L178.0,280.4 L180.7,278.8 L178.2,268.1 L183.9,267.5 L195.0,247.6 L187.8,248.0 L194.2,245.1 L191.0,237.0 L186.0,233.1 L184.7,225.1 L183.5,227.8 L178.9,225.4 L176.3,228.3 L180.0,235.1 L175.3,238.8 L183.9,238.9 L184.3,246.0 L178.0,249.3 L176.5,245.5 L179.3,242.9 L175.1,241.4 L170.6,242.3 L163.2,250.1 L167.7,243.2 L165.9,244.3 L159.5,236.3 L161.1,229.6 L166.2,234.0 L165.0,238.5 L172.6,239.3 L169.6,232.1 L164.3,229.4 L164.7,227.6 L160.7,229.4 L159.8,224.6 L156.8,224.9 L159.1,221.2 L157.1,220.4 L161.0,217.8 L167.5,222.4 L165.2,217.2 L167.5,217.3 L164.8,215.8 L167.3,215.6 L167.0,211.6 L173.4,215.8 L179.4,207.3 L181.6,210.7 L185.9,210.0 L187.0,206.6 L184.5,208.3 L182.2,206.5 L187.5,205.2 L190.3,198.7 L195.7,199.6 L195.8,196.9 L201.2,196.4 L197.9,198.9 L203.1,199.0 L206.8,195.8 L205.2,201.1 L210.1,209.2 L219.2,210.9 L218.8,212.8 L224.7,206.7 L229.6,207.3 L232.1,215.1 L227.1,219.8 L223.9,219.3 L224.2,222.6 L237.8,222.9 L234.1,228.6 L241.7,231.0 L236.8,235.0 L244.1,236.0 L240.4,236.3 L239.3,239.7 L241.4,240.2 L237.4,240.9 L236.3,245.2 L230.0,249.5 L231.9,253.1 L229.0,254.2 L230.6,255.7 L228.5,256.0 L224.2,270.3 L222.2,270.1 L224.1,270.5 L222.6,276.3 L220.5,275.3 L223.5,280.7 L218.7,296.9 L209.3,293.2 L206.7,297.2 L211.2,300.4 L195.3,311.1 Z"/><path d="M275.5,234.0L275.5,234.1 L273.8,240.3 L276.3,244.1 L273.4,241.7 L262.8,242.6 L265.9,236.2 L258.8,235.4 L258.0,237.3 L257.4,234.5 L260.2,234.8 L257.7,231.5 L254.1,232.4 L258.5,228.6 L254.7,225.3 L257.9,226.9 L260.4,224.7 L257.6,222.6 L259.1,221.1 L253.9,220.9 L255.7,215.3 L241.7,219.9 L263.6,206.2 L267.5,194.5 L273.5,188.9 L280.1,197.9 L286.6,194.6 L294.3,195.0 L297.9,189.4 L294.7,184.2 L299.3,186.1 L306.4,179.5 L313.0,181.1 L314.9,178.9 L325.0,186.3 L330.3,185.1 L330.9,191.2 L328.3,190.5 L334.3,197.1 L331.7,200.2 L335.8,200.9 L320.8,210.9 L316.1,223.8 L307.1,214.0 L295.4,214.1 L287.7,217.1 L291.3,217.0 L286.5,219.6 L285.6,217.6 L283.3,227.3 L275.5,234.0 Z"/><path d="M40.0,222.0L40.0,221.9 L45.2,215.0 L56.6,211.7 L62.6,211.5 L67.0,215.6 L63.2,221.3 L55.2,224.1 L43.8,225.8 L40.0,222.0 Z"/></g>
        <text x="310" y="46" class="dashboard-map-water-label">Sea of Japan</text>
        <text x="520" y="306" class="dashboard-map-water-label">Pacific Ocean</text>
        <use href="#dashboardRoutePath" fill="none" stroke="#0c7664" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8 6"/>
        <g class="dashboard-map-port"><circle cx="504.6" cy="138.1" r="9"/><text x="504.6" y="141.3" text-anchor="middle" class="dashboard-map-port-number">1</text><text x="516.6" y="128.1" text-anchor="start" class="dashboard-map-port-label">Tokyo</text></g><g class="dashboard-map-port"><circle cx="464.7" cy="154.8" r="9"/><text x="464.7" y="158.0" text-anchor="middle" class="dashboard-map-port-number">2</text><text x="474.7" y="146.8" text-anchor="start" class="dashboard-map-port-label">Mt Fuji</text></g><g class="dashboard-map-port"><circle cx="359.3" cy="169.2" r="9"/><text x="359.3" y="172.4" text-anchor="middle" class="dashboard-map-port-number">3</text><text x="369.3" y="161.2" text-anchor="start" class="dashboard-map-port-label">Kyoto</text></g><g class="dashboard-map-port"><circle cx="294.5" cy="213.9" r="9"/><text x="294.5" y="217.1" text-anchor="middle" class="dashboard-map-port-number">4</text><text x="304.5" y="227.9" text-anchor="start" class="dashboard-map-port-label">Kochi</text></g><g class="dashboard-map-port"><circle cx="256.6" cy="180.8" r="9"/><text x="256.6" y="184.0" text-anchor="middle" class="dashboard-map-port-number">5</text><text x="266.6" y="170.8" text-anchor="start" class="dashboard-map-port-label">Hiroshima</text></g><g class="dashboard-map-port"><circle cx="191.5" cy="287.8" r="9"/><text x="191.5" y="291.0" text-anchor="middle" class="dashboard-map-port-number">6</text><text x="181.5" y="305.8" text-anchor="end" class="dashboard-map-port-label">Kagoshima</text></g><g class="dashboard-map-port"><circle cx="167.7" cy="243.1" r="9"/><text x="167.7" y="246.3" text-anchor="middle" class="dashboard-map-port-number">7</text><text x="155.7" y="258.1" text-anchor="end" class="dashboard-map-port-label">Nagasaki</text></g><g class="dashboard-map-port"><circle cx="186.0" cy="210.4" r="9"/><text x="186.0" y="213.6" text-anchor="middle" class="dashboard-map-port-number">8</text><text x="196.0" y="202.4" text-anchor="start" class="dashboard-map-port-label">Fukuoka</text></g><g class="dashboard-map-port"><circle cx="140.5" cy="151.7" r="9"/><text x="140.5" y="154.9" text-anchor="middle" class="dashboard-map-port-number">9</text><text x="150.5" y="143.7" text-anchor="start" class="dashboard-map-port-label">Busan</text></g><g class="dashboard-map-port"><circle cx="55.8" cy="60.3" r="9"/><text x="55.8" y="63.5" text-anchor="middle" class="dashboard-map-port-number">10</text><text x="67.8" y="50.3" text-anchor="start" class="dashboard-map-port-label">Incheon (Seoul)</text></g>
        <g class="dashboard-map-ship" filter="url(#dashboardShipShadow)" transform="translate(-8 -13)">
          <circle r="15" fill="#ffffff" stroke="#0c7664" stroke-width="1.8"/>
          <path d="M-9,2 L9,2 L6,7 L-6,7 Z M-6,-1 L6,-1 L4,2 L-4,2 Z M-2,-7 L3,-7 L3,-1 L-2,-1 Z" fill="#0c7664"/>
          <animateMotion dur="26s" repeatCount="indefinite" rotate="0" calcMode="paced"><mpath href="#dashboardRoutePath"/></animateMotion>
        </g>
      </svg>
      <div class="dashboard-map-note">Illustrative route only. The line shows port sequence, not the ship’s exact navigational track.</div>
    </div>`;
}

function renderDashboardItineraryPreviewDay(stop, index) {
  const timing = [stop.arrival && `Arrive ${stop.arrival}`, stop.departure && `Depart ${stop.departure}`].filter(Boolean).join(" · ") || (stop.type === "sea_day" ? "A relaxing day at sea" : formatDateShort(stop.date));
  return `
    <div class="dashboard-itinerary-preview-day ${stop.type === "sea_day" ? "is-sea-day" : ""}">
      <span>Day ${index + 1} · ${escapeHtml(formatDateShort(stop.date))}</span>
      <strong>${escapeHtml(stop.name)}</strong>
      <small>${escapeHtml(timing)}</small>
    </div>
  `;
}

function toggleDashboardItinerary() {
  const extra = document.getElementById("dashboardItineraryExtra");
  const button = document.getElementById("dashboardItineraryToggle");
  if (!extra || !button) return;
  const willOpen = extra.hidden;
  extra.hidden = !willOpen;
  button.textContent = willOpen ? "Show Less ↑" : "Open Full Itinerary →";
}

function initialiseDashboardRouteMap() {
  // The dashboard map is self-contained SVG, so no external map initialisation is required.
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
  const packingData = await loadDashboardPackingData(mainCruise);
  const dashboardJourney = getDashboardJourney(mainCruise);
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
  const heroTitle = (() => {
    if (!mainCruise) return "My Cruise";
    const line = String(mainCruise.cruise_line || "").trim();
    const ship = String(mainCruise.ship_name || "").trim();
    if (!line) return ship;
    if (!ship) return line;
    return ship.toLowerCase().includes(line.toLowerCase()) ? ship : `${line} ${ship}`;
  })();
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
        <section class="dashboard-welcome-strip dashboard-quick-access-strip">
          ${renderDashboardQuickAccess()}
          ${adminPreviewMode || customerMode ? "" : renderCruiseSwitcher(safeCruises, mainCruise)}
        </section>

        <section class="dashboard-v2-grid">
          ${renderJourneyMap(dashboardJourney)}

          <div class="dashboard-v2-side">
            <div class="dashboard-v2-top-row">
              ${renderDashboardCombinedProgress(packingData, checklistData)}
              ${mainCruise ? renderDashboardSnapshot(mainCruise) : ""}
            </div>

            <article class="dashboard-summary-card dashboard-next-step-wide">
              <div>
                <p class="dashboard-card-label">Next Essential Step</p>
                <h2>${escapeHtml(nextStepTitle)}</h2>
                <p class="dashboard-card-copy">${escapeHtml(nextStepDescription)}</p>
              </div>
              <button class="dashboard-outline-action dashboard-card-button" onclick="renderChecklist()">Start Task →</button>
            </article>
          </div>
        </section>

        ${!mainCruise ? renderDashboardAddCruiseForm() : ""}
      </div>
    </div>
  `;

  if (mainCruise) {
    startLiveCountdown(mainCruise);
    initialiseDashboardRouteMap(dashboardJourney);
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
    { key: "budget", label: "Budget", action: "renderBudgetPlanner()" },
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

function getPackingRestriction(item) {
  const explicit = String(item?.packing_restriction || "").trim().toLowerCase();
  if (["carry-on-only", "checked-only", "any"].includes(explicit)) return explicit;
  if (/(?:power\s*bank|portable\s+battery\s+(?:pack|bank))/i.test(String(item?.name || ""))) return "carry-on-only";
  return "any";
}

function renderPackingLocationSelector(key, location, visible, restriction = "any") {
  if (restriction === "carry-on-only") {
    return `<div class="packing-location-selector ${visible ? "" : "is-hidden"}" data-location-selector>
      <span class="packing-location-option is-active is-locked">Carry-on only</span>
    </div>`;
  }
  if (restriction === "checked-only") {
    return `<div class="packing-location-selector ${visible ? "" : "is-hidden"}" data-location-selector>
      <span class="packing-location-option is-active is-locked">Checked luggage only</span>
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
  const restriction = usesQuantityAndWeight ? getPackingRestriction(item) : "any";
  const location = usesQuantityAndWeight ? (restriction === "carry-on-only" ? "carry-on" : restriction === "checked-only" ? "checked" : (state?.packing_location || "checked")) : "checklist";
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
          ${usesQuantityAndWeight ? renderPackingLocationSelector(key, location, safeQuantity > 0, restriction) : ""}
          ${restriction === "carry-on-only" ? `<div class="packing-safety-note">Carry-on only. Airline safety rules require this item to travel in cabin baggage.</div>` : ""}
          ${restriction === "checked-only" ? `<div class="packing-safety-note">Checked luggage only. This item should not be packed in cabin baggage.</div>` : ""}
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


const BUDGET_STORAGE_PREFIX = "101cruise_budget_v1";
let activeBudget = null;

function getBudgetBookingKey(cruise) {
  return String(cruise?.base44_booking_id || cruise?.booking_reference || cruise?.id || "default");
}

function getBudgetStorageKey(cruise) {
  return `${BUDGET_STORAGE_PREFIX}:${getBudgetBookingKey(cruise)}`;
}

function parseMoney(value) {
  const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatAud(value) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2 }).format(parseMoney(value));
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(parseMoney(value));
}

function getCruisePriceUsd(cruise) {
  const booking = getDashboardBookingSource(cruise);
  return parseMoney(booking.cruise_price_usd ?? booking.total_price ?? cruise?.cruise_price_usd ?? 0);
}

function createEmptyBudget(cruise) {
  return {
    exchange_rate: 1.55,
    food_beverage: 0,
    travel_insurance: 0,
    excursions: 0,
    items: [],
    cruise_price_usd: getCruisePriceUsd(cruise),
    updated_at: null
  };
}

async function loadBudget(cruise) {
  if (customerMode) {
    try {
      const response = await fetch("/.netlify/functions/customer-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customerSessionToken}` },
        body: JSON.stringify({ action: "load" })
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) throw new Error("Customer session expired");
      if (response.ok && data?.success && data.budget) return { ...createEmptyBudget(cruise), ...data.budget, items: data.budget.items || [] };
    } catch (error) {
      console.warn("Budget server load unavailable; using device storage", error);
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(getBudgetStorageKey(cruise)) || "null");
    return saved ? { ...createEmptyBudget(cruise), ...saved, items: saved.items || [] } : createEmptyBudget(cruise);
  } catch {
    return createEmptyBudget(cruise);
  }
}

async function persistBudget() {
  const cruise = await loadCurrentCruise();
  if (!cruise || !activeBudget || adminPreviewMode) return;
  activeBudget.cruise_price_usd = getCruisePriceUsd(cruise);
  activeBudget.updated_at = new Date().toISOString();
  localStorage.setItem(getBudgetStorageKey(cruise), JSON.stringify(activeBudget));
  if (customerMode) {
    try {
      const response = await fetch("/.netlify/functions/customer-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customerSessionToken}` },
        body: JSON.stringify({ action: "save", budget: activeBudget })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Budget could not be saved");
    } catch (error) {
      console.warn("Budget saved on this device only", error);
    }
  }
}

function budgetCategoryTotal(category) {
  return (activeBudget?.items || []).filter(item => item.category === category).reduce((sum, item) => sum + parseMoney(item.amount), 0);
}

function getBudgetTotals() {
  const cruiseAud = parseMoney(activeBudget?.cruise_price_usd) * parseMoney(activeBudget?.exchange_rate);
  const flights = budgetCategoryTotal("flights");
  const accommodation = budgetCategoryTotal("accommodation");
  const cars = budgetCategoryTotal("cars");
  const other = budgetCategoryTotal("other");
  const total = cruiseAud + flights + accommodation + cars + parseMoney(activeBudget?.food_beverage) + parseMoney(activeBudget?.travel_insurance) + parseMoney(activeBudget?.excursions) + other;
  return { cruiseAud, flights, accommodation, cars, other, total };
}

function budgetItemSummary(item) {
  if (item.category === "flights") return [item.airline, item.date ? formatDateShort(item.date) : "", [item.from, item.to].filter(Boolean).join(" to "), item.return_flight ? "Return" : ""].filter(Boolean).join(" · ") || "Flight";
  if (item.category === "accommodation") return [item.name, item.location, item.date ? formatDateShort(item.date) : ""].filter(Boolean).join(" · ") || "Accommodation";
  if (item.category === "cars") return [item.name, item.location, item.date ? formatDateShort(item.date) : ""].filter(Boolean).join(" · ") || "Car hire";
  return item.name || "Other expense";
}

function renderBudgetItems(category) {
  const items = (activeBudget?.items || []).filter(item => item.category === category);
  if (!items.length) return `<p class="budget-empty">Nothing added yet.</p>`;
  return `<div class="budget-item-list">${items.map(item => `<div class="budget-item-row"><div><strong>${escapeHtml(budgetItemSummary(item))}</strong></div><div class="budget-item-actions"><span>${formatAud(item.amount)}</span><button onclick="editBudgetItem('${item.id}')">Edit</button><button onclick="deleteBudgetItem('${item.id}')">Delete</button></div></div>`).join("")}</div>`;
}

function renderBudgetCategory(category, title, buttonLabel) {
  const totals = getBudgetTotals();
  return `<section class="planner-card budget-category-card"><div class="budget-category-heading"><div><p class="planner-kicker">${escapeHtml(title)}</p><h2>${formatAud(totals[category])}</h2></div><button class="planner-button secondary" onclick="openBudgetItemForm('${category}')">+ ${escapeHtml(buttonLabel)}</button></div>${renderBudgetItems(category)}<div id="budget-form-${category}"></div></section>`;
}

async function renderBudgetPlanner() {
  clearCountdownTimer();
  const cruise = await loadCurrentCruise();
  if (!cruise) { app.innerHTML = `<div class="planner-card"><button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button><h2>Budget</h2><p>Add a cruise before creating your holiday budget.</p></div>`; return; }
  activeBudget = await loadBudget(cruise);
  activeBudget.cruise_price_usd = getCruisePriceUsd(cruise);
  const totals = getBudgetTotals();
  app.innerHTML = `<div class="budget-page">${renderPlannerNav("budget")}<section class="budget-hero"><p>Estimated Holiday Total</p><h1>${formatAud(totals.total)}</h1><span>Based on your current budget.</span></section><section class="planner-card budget-cruise-card"><div><p class="planner-kicker">Cruise</p><h2>${formatAud(totals.cruiseAud)}</h2><p class="planner-muted">Booking price ${formatUsd(activeBudget.cruise_price_usd)}</p></div><label class="budget-rate-field"><span>USD to AUD exchange rate</span><input type="number" min="0" step="0.0001" value="${activeBudget.exchange_rate}" onchange="updateBudgetValue('exchange_rate', this.value)"></label></section><div class="budget-grid">${renderBudgetCategory("flights", "Flights", "Add Flight")}${renderBudgetCategory("accommodation", "Accommodation", "Add Stay")}${renderBudgetCategory("cars", "Car Hire", "Add Car Hire")}<section class="planner-card budget-simple-card"><div><p class="planner-kicker">Food & Beverage Allowance</p><h2>${formatAud(activeBudget.food_beverage)}</h2></div><label><span>Total holiday allowance</span><input type="number" min="0" step="0.01" value="${activeBudget.food_beverage || ""}" placeholder="0.00" onchange="updateBudgetValue('food_beverage', this.value)"></label></section><section class="planner-card budget-simple-card"><div><p class="planner-kicker">Travel Insurance</p><h2>${formatAud(activeBudget.travel_insurance)}</h2></div><label><span>Total insurance cost</span><input type="number" min="0" step="0.01" value="${activeBudget.travel_insurance || ""}" placeholder="0.00" onchange="updateBudgetValue('travel_insurance', this.value)"></label></section><section class="planner-card budget-simple-card"><div><p class="planner-kicker">Shore Excursions</p><h2>${formatAud(activeBudget.excursions)}</h2></div><label><span>Total excursion allowance</span><input type="number" min="0" step="0.01" value="${activeBudget.excursions || ""}" placeholder="0.00" onchange="updateBudgetValue('excursions', this.value)"></label></section>${renderBudgetCategory("other", "Other Expenses", "Add Expense")}</div><p id="budget-save-message" class="planner-message budget-save-message">${adminPreviewMode ? "Preview only. Budget changes are not saved." : activeBudget.updated_at ? `Updated ${escapeHtml(formatDateShort(activeBudget.updated_at))}` : "Changes save automatically."}</p></div>`;
}

async function updateBudgetValue(field, value) {
  if (!activeBudget) return;
  activeBudget[field] = parseMoney(value);
  await persistBudget();
  await renderBudgetPlanner();
}

function openBudgetItemForm(category, itemId = "") {
  const host = document.getElementById(`budget-form-${category}`);
  if (!host) return;
  const item = (activeBudget.items || []).find(row => row.id === itemId) || { id: "", category, amount: "" };
  const optional = category === "flights" ? `<div class="budget-form-grid"><label>Airline<input id="budgetItemName" value="${escapeHtml(item.airline || "")}"></label><label>Date<input id="budgetItemDate" type="date" value="${escapeHtml(item.date || "")}"></label><label>From<input id="budgetItemFrom" value="${escapeHtml(item.from || "")}"></label><label>To<input id="budgetItemTo" value="${escapeHtml(item.to || "")}"></label></div><label class="budget-checkbox"><input id="budgetItemReturn" type="checkbox" ${item.return_flight ? "checked" : ""}> Return flight</label>` : category === "accommodation" ? `<div class="budget-form-grid"><label>Date<input id="budgetItemDate" type="date" value="${escapeHtml(item.date || "")}"></label><label>Name of place<input id="budgetItemName" value="${escapeHtml(item.name || "")}"></label><label>Location<input id="budgetItemLocation" value="${escapeHtml(item.location || "")}"></label></div>` : category === "cars" ? `<div class="budget-form-grid"><label>Date<input id="budgetItemDate" type="date" value="${escapeHtml(item.date || "")}"></label><label>Hire company<input id="budgetItemName" value="${escapeHtml(item.name || "")}"></label><label>Pick-up location<input id="budgetItemLocation" value="${escapeHtml(item.location || "")}"></label></div>` : `<label>Item<input id="budgetItemName" value="${escapeHtml(item.name || "")}"></label>`;
  host.innerHTML = `<div class="budget-entry-form">${optional}<label>Amount (AUD)<input id="budgetItemAmount" type="number" min="0" step="0.01" value="${escapeHtml(item.amount || "")}" required autofocus></label><div class="budget-form-actions"><button class="planner-button" onclick="saveBudgetItem('${category}','${item.id || ""}')">${item.id ? "Save Changes" : "Add"}</button><button class="planner-button secondary" onclick="document.getElementById('budget-form-${category}').innerHTML=''">Cancel</button></div><div id="budget-item-error" class="planner-message planner-error"></div></div>`;
}

function editBudgetItem(id) { const item = activeBudget?.items?.find(row => row.id === id); if (item) openBudgetItemForm(item.category, id); }

async function saveBudgetItem(category, id) {
  const amount = parseMoney(document.getElementById("budgetItemAmount")?.value);
  const error = document.getElementById("budget-item-error");
  if (!(amount > 0)) { if (error) error.textContent = "Enter an amount greater than zero."; return; }
  const existing = activeBudget.items.find(row => row.id === id);
  const item = existing || { id: `budget-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, category };
  item.amount = amount;
  item.name = String(document.getElementById("budgetItemName")?.value || "").trim();
  item.airline = category === "flights" ? item.name : undefined;
  item.date = String(document.getElementById("budgetItemDate")?.value || "");
  item.from = String(document.getElementById("budgetItemFrom")?.value || "").trim();
  item.to = String(document.getElementById("budgetItemTo")?.value || "").trim();
  item.location = String(document.getElementById("budgetItemLocation")?.value || "").trim();
  item.return_flight = document.getElementById("budgetItemReturn")?.checked === true;
  if (!existing) activeBudget.items.push(item);
  await persistBudget();
  await renderBudgetPlanner();
}

async function deleteBudgetItem(id) {
  if (!confirm("Delete this budget item?")) return;
  activeBudget.items = activeBudget.items.filter(item => item.id !== id);
  await persistBudget();
  await renderBudgetPlanner();
}

initPlanner();
