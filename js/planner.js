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
  if (cruise && currentUser?.id && !adminPreviewMode) {
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

  if (adminPreviewMode && adminPreviewCruise) {
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
          ${adminPreviewMode ? `<button class="dashboard-signout" onclick="exitAdminPreview()">Exit Preview</button>` : `<button class="dashboard-signout" onclick="signOut()">Sign Out</button>`}

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
          ${adminPreviewMode ? "" : renderCruiseSwitcher(safeCruises, mainCruise)}
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
              <button class="dashboard-feature-row" onclick="alert('Documents Checklist coming soon')"><span>📄</span><span><strong>Documents Checklist</strong><small>Passports, visas and travel papers</small></span><b>→</b></button>
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
    { key: "documents", label: "Documents", action: "alert('Documents coming soon')" }
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
  if (cruise) {
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
                <button class="add-personal-task-button" onclick="addPersonalChecklistItem(${section.id})">+ Add your own task</button>
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

      <section class="planner-card section-spaced">
        <h3>Documents</h3>
        <p class="planner-muted">Documents will be added in a future release. This will eventually hold cruise confirmations, invoices, insurance certificates and other useful files.</p>
      </section>
    </div>
  `;
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
  if (count >= 3) return "Group";
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
    baggage_limit_kg: Number(document.getElementById("packingBaggageLimit")?.value || 20),
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

function calculatePackingQuantity(item, cruise, travellerType) {
  const nights = Number(cruise?.nights || 7);
  const base = Number(item.base_quantity || 1);
  const perNight = Number(item.quantity_per_night || 0);
  let qty = Math.max(1, Math.ceil(base + (perNight * nights)));
  if (travellerType === "Couple") qty = Math.ceil(qty * Number(item.couple_multiplier || 1));
  if (travellerType === "Family") qty = Math.ceil(qty * Number(item.family_multiplier || 1.5));
  if (travellerType === "Group") qty = Math.ceil(qty * Number(item.group_multiplier || 1));
  return qty;
}

function getPackingItemKey(item) {
  return item.source === "personal" ? `personal:${item.id}` : `system:${item.id}`;
}

function isPackingItemPacked(progressRows, item) {
  if (adminPreviewMode) return adminPreviewPackedKeys.has(getPackingItemKey(item));
  if (item.source === "personal") return item.packed === true;
  return (progressRows || []).some(row => row.packing_item_id === item.id && row.packed === true);
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
  if (value === "required") return "Required";
  if (value === "optional") return "Optional";
  return "Recommended";
}

function renderPackingRow(item, packed, quantity) {
  const typeClass = getPackingTypeClass(item.item_type);
  const typeLabel = getPackingTypeLabel(item.item_type);
  const key = getPackingItemKey(item);
  const weight = Number(item.weight_kg || 0) * Number(quantity || 1);
  return `
    <div class="packing-row ${packed ? "is-packed" : ""}" data-packing-row="${escapeHtml(key)}">
      <div class="packing-main-cell">
        <input class="checklist-checkbox" type="checkbox" ${packed ? "checked" : ""} onchange="togglePackingItem('${escapeHtml(key)}', this.checked)">
        <div>
          <div class="packing-item-title">${escapeHtml(item.name)} ${quantity ? `<span class="packing-qty">(${quantity})</span>` : ""}</div>
          ${item.description ? `<div class="packing-item-description">${escapeHtml(item.description)}</div>` : ""}
          ${item.help_text ? `<div class="packing-item-help">ⓘ ${escapeHtml(item.help_text)}</div>` : ""}
        </div>
      </div>
      <div class="packing-type-cell"><span class="priority-badge ${typeClass}">${typeLabel}</span></div>
      <div class="packing-weight-cell">${weight ? `${weight.toFixed(2)} kg` : "—"}</div>
      ${item.source === "personal" ? `<button class="packing-delete-button" onclick="deletePersonalPackingItem(${item.id})">Delete</button>` : ""}
    </div>
  `;
}

function renderPackingControls(preferences, cruise) {
  const destination = preferences?.destination || getDefaultPackingDestination(cruise);
  const travellerType = preferences?.traveller_type || getDefaultTravellerType(cruise);
  const dressCode = preferences?.dress_code || getDefaultDressCode(cruise);
  const limit = preferences?.baggage_limit_kg || 20;

  return `
    <section class="planner-card packing-settings-card">
      <div>
        <h3>Smart Packing Settings</h3>
        <p class="planner-muted">We have prepared this list using your cruise details. Adjust these settings if needed.</p>
      </div>
      <div class="packing-settings-grid">
        <div class="planner-field">
          <label>Who is travelling?</label>
          <select id="packingTravellerType">
            ${["Solo", "Couple", "Family", "Group"].map(type => `<option value="${type}" ${travellerType === type ? "selected" : ""}>${type}</option>`).join("")}
          </select>
        </div>
        <div class="planner-field">
          <label>Destination</label>
          <select id="packingDestination">
            ${PACKING_DESTINATIONS.map(dest => `<option value="${dest}" ${destination === dest ? "selected" : ""}>${dest}</option>`).join("")}
          </select>
        </div>
        <div class="planner-field">
          <label>Dress code</label>
          <select id="packingDressCode">
            ${["Casual", "Semi Formal", "Formal"].map(code => `<option value="${code}" ${dressCode === code ? "selected" : ""}>${code}</option>`).join("")}
          </select>
        </div>
        <div class="planner-field">
          <label>Baggage limit (kg)</label>
          <input id="packingBaggageLimit" type="number" min="5" step="1" value="${escapeHtml(limit)}">
        </div>
      </div>
      <button class="planner-button" onclick="savePackingPreferencesFromForm()">Update Packing List</button>
    </section>
  `;
}

function getWeightStatus(totalWeight, baggageLimit) {
  const limit = Number(baggageLimit || 20);
  if (!totalWeight) return "Start packing to estimate your luggage weight.";
  if (totalWeight <= limit * 0.75) return "Comfortable for most standard baggage allowances.";
  if (totalWeight <= limit) return "Getting close to your selected baggage limit.";
  return "Likely to exceed your selected baggage limit.";
}

function renderPackingWeightGauge(totalWeight, baggageLimit) {
  const limit = Number(baggageLimit || 20);
  const percent = Math.max(0, Math.min(100, Math.round((totalWeight / limit) * 100)));
  return `
    <div class="packing-weight-gauge">
      <div class="packing-weight-labels"><strong>${totalWeight.toFixed(1)} kg</strong><span>Limit: ${limit} kg</span></div>
      <div class="packing-weight-bar"><span style="width:${percent}%"></span></div>
      <p>${escapeHtml(getWeightStatus(totalWeight, limit))}</p>
      <small>Estimated weight is a guide only. Actual luggage weight may vary depending on item size, brand, fabric and quantity. Always check your airline or cruise line baggage limits.</small>
    </div>
  `;
}

function toggleHidePacked() {
  const page = document.getElementById("packing-page");
  if (!page) return;
  page.classList.toggle("hide-packed");
  const button = document.getElementById("hidePackedButton");
  if (button) button.innerText = page.classList.contains("hide-packed") ? "Show Packed" : "Hide Packed";
}

function filterPackingList() {
  const query = String(document.getElementById("packingSearch")?.value || "").toLowerCase().trim();
  document.querySelectorAll(".packing-row").forEach(row => {
    row.style.display = !query || row.textContent.toLowerCase().includes(query) ? "grid" : "none";
  });
}

function printPackingList() {
  window.print();
}

function savePackingPdf() {
  window.print();
}

async function resetPackingProgress() {
  if (!confirm("Reset all packing progress for this cruise?")) return;
  if (adminPreviewMode) {
    adminPreviewPackedKeys = new Set();
    renderPackingPlanner();
    return;
  }
  const cruise = await loadCurrentCruise();
  if (!cruise) return;
  await supabaseClient.from("user_packing_progress").delete().eq("user_id", currentUser.id).eq("cruise_id", cruise.id);
  await supabaseClient.from("user_packing_items").update({ packed: false, packed_at: null }).eq("user_id", currentUser.id).eq("cruise_id", cruise.id);
  renderPackingPlanner();
}

async function addPersonalPackingItem(categoryId) {
  if (adminPreviewMode) {
    alert("Preview mode does not save personal packing items.");
    return;
  }
  const cruise = await loadCurrentCruise();
  if (!cruise) {
    alert("Please add a cruise before adding packing items.");
    return;
  }
  const name = prompt("Add your own packing item");
  if (!name || !name.trim()) return;
  const { error } = await supabaseClient.from("user_packing_items").insert({
    user_id: currentUser.id,
    cruise_id: cruise.id,
    category_id: categoryId,
    name: name.trim(),
    quantity: 1,
    weight_kg: 0,
    packed: false
  });
  if (error) {
    console.error("Personal packing item save error", error);
    alert("Could not add your item. Please try again.");
    return;
  }
  renderPackingPlanner();
}

async function togglePackingItem(key, packed) {
  const cruise = await loadCurrentCruise();
  if (!cruise) return;
  if (adminPreviewMode) {
    if (packed) adminPreviewPackedKeys.add(key);
    else adminPreviewPackedKeys.delete(key);
    return;
  }
  if (String(key).startsWith("personal:")) {
    const id = Number(String(key).replace("personal:", ""));
    const { error } = await supabaseClient.from("user_packing_items").update({ packed, packed_at: packed ? new Date().toISOString() : null }).eq("id", id).eq("user_id", currentUser.id);
    if (error) alert("Could not save packing item.");
  } else {
    const id = Number(String(key).replace("system:", ""));
    const payload = { user_id: currentUser.id, cruise_id: cruise.id, packing_item_id: id, packed, packed_at: packed ? new Date().toISOString() : null };
    const { error } = await supabaseClient.from("user_packing_progress").upsert(payload, { onConflict: "user_id,cruise_id,packing_item_id" });
    if (error) alert("Could not save packing progress.");
  }
  renderPackingPlanner();
}

async function deletePersonalPackingItem(id) {
  if (!confirm("Delete this packing item?")) return;
  const { error } = await supabaseClient.from("user_packing_items").delete().eq("id", id).eq("user_id", currentUser.id);
  if (error) alert("Could not delete packing item.");
  renderPackingPlanner();
}

async function renderPackingPlanner() {
  clearCountdownTimer();
  const cruise = await loadCurrentCruise();
  if (!cruise) {
    app.innerHTML = `<div class="planner-card"><button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button><h2>Smart Packing Planner</h2><p>Add a cruise before generating your packing list.</p></div>`;
    return;
  }

  const preferences = await loadPackingPreferences(cruise);
  const context = {
    destination: preferences?.destination || getDefaultPackingDestination(cruise),
    travellerType: preferences?.traveller_type || getDefaultTravellerType(cruise),
    dressCode: preferences?.dress_code || getDefaultDressCode(cruise),
    climate: getClimateFromDestination(preferences?.destination || getDefaultPackingDestination(cruise)),
    cruiseLine: cruise.cruise_line || ""
  };

  const [{ data: categories }, { data: items }, progressResult, personalResult] = await Promise.all([
    supabaseClient.from("packing_categories").select("*").eq("active", true).order("display_order", { ascending: true }),
    supabaseClient.from("packing_items").select("*, packing_categories(name)").eq("active", true).order("display_order", { ascending: true }),
    adminPreviewMode ? Promise.resolve({ data: [] }) : supabaseClient.from("user_packing_progress").select("*").eq("user_id", currentUser.id).eq("cruise_id", cruise.id),
    adminPreviewMode ? Promise.resolve({ data: [] }) : supabaseClient.from("user_packing_items").select("*").eq("user_id", currentUser.id).eq("cruise_id", cruise.id).order("created_at", { ascending: true })
  ]);
  const progress = progressResult?.data || [];
  const personal = personalResult?.data || [];

  const systemItems = (items || [])
    .filter(item => packingItemApplies(item, context))
    .map(item => ({ ...item, source: "system", calculated_quantity: calculatePackingQuantity(item, cruise, context.travellerType) }));
  const personalItems = (personal || []).map(item => ({ ...item, source: "personal", calculated_quantity: item.quantity || 1, item_type: "Optional", description: item.note || "Personal packing item" }));
  const allPackingItems = [...systemItems, ...personalItems];
  const packedCount = allPackingItems.filter(item => isPackingItemPacked(progress || [], item)).length;
  const totalCount = allPackingItems.length;
  const percent = getProgressPercent(packedCount, totalCount);
  const totalWeight = allPackingItems.reduce((sum, item) => sum + (Number(item.weight_kg || 0) * Number(item.calculated_quantity || 1)), 0);
  const baggageLimit = preferences?.baggage_limit_kg || 20;
  const grouped = groupPackingItems(allPackingItems);

  app.innerHTML = `
    <div id="packing-page" class="packing-page">
      ${renderPlannerNav("packing")}

      <div class="checklist-toolbar planner-card slim-card packing-toolbar">
        <div>
          <h2>Smart Packing Planner</h2>
          <p class="planner-muted">${escapeHtml(cruise.ship_name || cruise.cruise_line || "Your cruise")} • ${escapeHtml(context.destination)} • ${escapeHtml(context.travellerType)} • ${escapeHtml(context.dressCode)}</p>
          <div class="checklist-top-progress"><span style="width:${percent}%"></span></div>
        </div>
        <div class="checklist-toolbar-actions">
          <button class="planner-button secondary" id="hidePackedButton" onclick="toggleHidePacked()">Hide Packed</button>
          <button class="planner-button secondary" onclick="resetPackingProgress()">Reset</button>
          <button class="planner-button secondary" onclick="printPackingList()">Print</button>
          <button class="planner-button" onclick="savePackingPdf()">Save PDF</button>
        </div>
      </div>

      ${renderPackingControls(preferences, cruise)}

      <section class="planner-card packing-summary-card">
        <div>
          <span>Packing Progress</span>
          <strong>${percent}%</strong>
          <small>${packedCount} of ${totalCount} items packed</small>
        </div>
        ${renderPackingWeightGauge(totalWeight, baggageLimit)}
      </section>

      <section class="planner-card packing-search-card">
        <input id="packingSearch" type="search" placeholder="Search packing list..." oninput="filterPackingList()">
      </section>

      <main class="packing-content">
        ${(categories || []).map(category => {
          const categoryItems = grouped[category.id] || [];
          if (!categoryItems.length && category.name !== "Last Minute Items") return "";
          const catPacked = categoryItems.filter(item => isPackingItemPacked(progress || [], item)).length;
          return `
            <section class="checklist-section-block packing-category-block">
              <div class="checklist-section-header">
                <div>
                  <h3>${escapeHtml(category.icon || "🧳")} ${escapeHtml(category.name)}</h3>
                  ${category.description ? `<p>${escapeHtml(category.description)}</p>` : ""}
                </div>
                <div class="section-progress-pill">${catPacked}/${categoryItems.length} Packed</div>
              </div>
              <div class="packing-table-header"><span>Item</span><span>Type</span><span>Weight</span></div>
              ${categoryItems.map(item => renderPackingRow(item, isPackingItemPacked(progress || [], item), item.calculated_quantity)).join("")}
              <button class="add-personal-task-button" onclick="addPersonalPackingItem(${category.id})">+ Add your own item</button>
            </section>
          `;
        }).join("")}
      </main>
    </div>
  `;
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

  captureInvitationBookingId();

  const { data } = await supabaseClient.auth.getSession();

  if (data.session) {
    currentUser = data.session.user;
    await ensureProfile();
    await loadProfile();
    await syncInvitationBookingForCurrentUser();
    renderDashboard();
  } else {
    renderLogin();
  }
}

initPlanner();
