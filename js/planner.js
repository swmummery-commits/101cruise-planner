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
let customerMode = false;
let customerSessionToken = "";
let customerBooking = null;
let customerCruise = null;
let customerPackingPreferences = null;
let customerLinkedBookingsMeta = { can_switch: false, bookings: [], loaded: false };
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



function canonicalBookingCruiseLine(cruiseLine) {
  const raw = String(cruiseLine || "").trim();
  if (!raw) return "";
  if (raw.toLowerCase().replace(/\s+/g, " ") === "explora cruises") return "Explora Journeys";
  return raw;
}

function createPreviewCruiseFromBase44Booking(booking) {
  const nights = calculateCruiseNights(booking.departing_date, booking.arriving_date);
  const passengerNames = getPassengerNamesFromBase44Booking(booking);
  const passengerCount = getPassengerCountFromBase44Booking(booking);

  return {
    id: `preview-${booking.base44_booking_id || booking.booking_reference || "booking"}`,
    base44_booking_id: booking.base44_booking_id || null,
    booking_reference: booking.booking_reference || null,
    cruise_line: canonicalBookingCruiseLine(booking.cruise_line) || null,
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
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const accessToken = sessionData.session?.access_token || "";
    if (!accessToken) throw new Error("Sign in is required to retrieve your cruise booking.");

    const response = await fetch("/.netlify/functions/claim-invitation-booking", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
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
    cruise_line: canonicalBookingCruiseLine(booking.cruise_line) || null,
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
  customerLinkedBookingsMeta = { can_switch: false, bookings: [], loaded: false };
}

function clearCustomerBookingLocalState() {
  activePackingProfileKey = null;
  packingV2Profiles = [];
  packingV2State = [];
  packingV2CurrentCruiseKey = null;
  customerPackingPreferences = null;
  activeBudget = null;
  customerLinkedBookingsMeta = { can_switch: false, bookings: [], loaded: false };
}

function rememberCustomerPreference() {
  try {
    return Boolean(localStorage.getItem(CUSTOMER_SESSION_STORAGE_KEY));
  } catch {
    return false;
  }
}

async function fetchCustomerLinkedBookings() {
  if (!customerMode || !customerSessionToken) {
    customerLinkedBookingsMeta = { can_switch: false, bookings: [], loaded: true };
    return customerLinkedBookingsMeta;
  }
  try {
    const response = await fetch("/.netlify/functions/customer-linked-bookings", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${customerSessionToken}`,
        "Content-Type": "application/json"
      }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      customerLinkedBookingsMeta = {
        can_switch: false,
        bookings: [],
        loaded: true,
        error: data?.error || "We couldn’t load your other cruises just now. Please try again."
      };
      return customerLinkedBookingsMeta;
    }
    customerLinkedBookingsMeta = {
      can_switch: data.can_switch === true,
      bookings: Array.isArray(data.bookings) ? data.bookings : [],
      empty_message: data.empty_message || null,
      loaded: true,
      error: null
    };
    return customerLinkedBookingsMeta;
  } catch (error) {
    customerLinkedBookingsMeta = {
      can_switch: false,
      bookings: [],
      loaded: true,
      error: "We couldn’t load your other cruises just now. Please try again."
    };
    return customerLinkedBookingsMeta;
  }
}

function activateCustomerSession(session) {
  if (!session?.token || !session?.booking) return false;
  const booking = {
    ...session.booking,
    cruise_line: canonicalBookingCruiseLine(session.booking.cruise_line) || session.booking.cruise_line || null
  };
  customerMode = true;
  customerSessionToken = session.token;
  customerBooking = booking;
  customerCruise = createPreviewCruiseFromBase44Booking(booking);
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
        <p class="planner-muted">Access your personalised cruise planner using your booking number and lead traveller’s surname.</p>
        <div class="planner-field">
          <label for="customerBookingNumber">Booking number</label>
          <input id="customerBookingNumber" type="text" autocomplete="off" autocapitalize="characters" placeholder="CRUISE1012345">
        </div>
        <div class="planner-field">
          <label for="customerSurname">Lead traveller surname</label>
          <input id="customerSurname" type="text" autocomplete="family-name" autocapitalize="characters" placeholder="SMITH" onkeydown="if(event.key === 'Enter') accessMyCruise()">
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
  if (button?.disabled) return;
  if (message) message.textContent = "";

  const run = async () => {
    if (button) { button.disabled = true; button.textContent = "Opening My Cruise…"; }
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
      trackMyCruiseEvent("dashboard", "login");
      await renderDashboard();
    } catch (error) {
      if (message) message.textContent = error.message || "We couldn't find a booking matching those details. Please check the booking number and lead traveller surname.";
      if (button) { button.disabled = false; button.textContent = "Open My Cruise"; }
      throw error;
    }
  };

  if (typeof PortalLoading?.withLoading === "function") {
    try {
      await PortalLoading.withLoading(run, { button, key: "customer-login" });
    } catch {
      /* message already shown */
    }
    return;
  }
  try {
    await run();
  } catch {
    /* message already shown */
  }
}

function changeCustomerBooking() {
  trackMyCruiseEvent("dashboard", "logout");
  clearCustomerSession();
  clearCustomerBookingLocalState();
  if (typeof SwitchBooking?.closeChooser === "function") SwitchBooking.closeChooser();
  renderCustomerAccess();
}

async function openSwitchBookingChooser(options = {}) {
  if (!customerMode || !customerSessionToken) {
    changeCustomerBooking();
    return;
  }
  if (typeof SwitchBooking?.openChooser !== "function") {
    changeCustomerBooking();
    return;
  }

  const meta = options.meta || (await fetchCustomerLinkedBookings());
  if (meta.error && !(meta.bookings || []).length) {
    SwitchBooking.openChooser({
      bookings: [],
      errorMessage: meta.error,
      onRetry: () => openSwitchBookingChooser({ force: true }),
      onSignOut: () => changeCustomerBooking(),
      onClose: () => {}
    });
    return;
  }

  if (!meta.can_switch) {
    SwitchBooking.openChooser({
      bookings: meta.bookings || [],
      emptyMessage: meta.empty_message || "No other linked cruises are available in this account.",
      onSignOut: () => changeCustomerBooking(),
      onClose: () => {}
    });
    return;
  }

  SwitchBooking.openChooser({
    bookings: meta.bookings || [],
    onSignOut: () => changeCustomerBooking(),
    onClose: () => {},
    onSelect: (switchToken) => switchCustomerBooking(switchToken)
  });
}

async function switchCustomerBooking(switchToken) {
  const token = String(switchToken || "").trim();
  if (!token || !customerSessionToken) return;

  const previousSession = {
    token: customerSessionToken,
    booking: customerBooking
  };

  const run = async () => {
    if (typeof SwitchBooking?.closeChooser === "function") SwitchBooking.closeChooser();
    const response = await fetch("/.netlify/functions/customer-switch-booking", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${customerSessionToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ switch_token: token })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success || !data?.token || !data?.booking) {
      throw new Error(data?.error || "We couldn’t switch cruises just now. Please try again.");
    }

    clearCustomerBookingLocalState();
    const session = { token: data.token, booking: data.booking };
    storeCustomerSession(session, rememberCustomerPreference());
    activateCustomerSession(session);
    trackMyCruiseEvent("dashboard", "switch_booking");
    try {
      await customerPackingRequest("load");
    } catch (packingError) {
      console.warn("Packing reload after switch failed", packingError);
    }
    await renderDashboard();
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  };

  try {
    if (typeof PortalLoading?.withLoading === "function") {
      await PortalLoading.withLoading(run, { key: "switch-booking" });
    } else {
      await run();
    }
  } catch (error) {
    // Retain previous authorised booking/session on failure
    if (previousSession.token && previousSession.booking) {
      activateCustomerSession(previousSession);
    }
    if (typeof SwitchBooking?.openChooser === "function") {
      SwitchBooking.openChooser({
        bookings: customerLinkedBookingsMeta.bookings || [],
        errorMessage: error.message || "We couldn’t switch cruises just now. Please try again.",
        onRetry: () => openSwitchBookingChooser({ force: true }),
        onSignOut: () => changeCustomerBooking(),
        onSelect: (nextToken) => switchCustomerBooking(nextToken),
        onClose: () => {}
      });
    } else {
      alert(error.message || "We couldn’t switch cruises just now. Please try again.");
    }
  }
}

function getCruiseUsageContext() {
  const cruise = customerCruise || null;
  const booking = customerBooking || cruise?._preview_booking || null;
  const first = String(booking?.passenger1_first_name || currentProfile?.first_name || "").trim();
  const last = String(booking?.passenger1_last_name || currentProfile?.last_name || "").trim();
  const customerLabel = [first, last].filter(Boolean).join(" ") || null;
  const bookingReference =
    booking?.booking_reference ||
    cruise?.booking_reference ||
    null;
  const metadata = {};
  if (customerLabel) metadata.customer_label = customerLabel;
  if (cruise?.cruise_line) metadata.cruise_line = cruise.cruise_line;
  if (cruise?.cruise_name || cruise?.name) metadata.cruise_name = cruise.cruise_name || cruise.name;
  return {
    surface: "my_cruise",
    booking_reference: bookingReference ? String(bookingReference).trim().toUpperCase() : null,
    user_id: currentUser?.id && !String(currentUser.id).startsWith("customer:") ? currentUser.id : null,
    metadata
  };
}

if (typeof window !== "undefined") {
  window.getCruiseUsageContext = getCruiseUsageContext;
}

function trackMyCruisePage(moduleName) {
  try {
    if (window.CruiseUsage && typeof window.CruiseUsage.trackPageOpen === "function") {
      window.CruiseUsage.trackPageOpen(moduleName);
    }
  } catch (_error) {
    /* never block the planner on analytics */
  }
}

function trackMyCruiseEvent(moduleName, eventType, metadata) {
  try {
    if (window.CruiseUsage && typeof window.CruiseUsage.trackEvent === "function") {
      window.CruiseUsage.trackEvent(moduleName, eventType, metadata);
    }
  } catch (_error) {
    /* ignore */
  }
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

  // Prefer Cruise Lines/Ships (CI) catalogue.
  let { data, error } = await supabaseClient
    .from("ci_cruise_lines")
    .select("name, logo_url")
    .ilike("name", safeCruiseLine)
    .eq("active", true)
    .eq("sold_by_101cruise", true)
    .limit(1)
    .maybeSingle();

  if (!error && !data?.logo_url) {
    const partial = safeCruiseLine.replace(/[%_]/g, "").trim();
    if (partial.length >= 3) {
      const partialResult = await supabaseClient
        .from("ci_cruise_lines")
        .select("name, logo_url")
        .ilike("name", `%${partial}%`)
        .eq("active", true)
        .eq("sold_by_101cruise", true)
        .limit(1)
        .maybeSingle();
      data = partialResult.data || data;
      error = partialResult.error || error;
    }
  }

  if (!error && data?.logo_url) return data.logo_url;

  // Legacy drinks-calculator / planner logos table.
  ({ data, error } = await supabaseClient
    .from("cruise_lines")
    .select("name, logo_url")
    .ilike("name", safeCruiseLine)
    .eq("active", true)
    .limit(1)
    .maybeSingle());

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

/** Terminal Roman ↔ Arabic variants for ship-image lookup (Explora 1 ↔ EXPLORA I). */
function expandTerminalShipNameVariants(shipName) {
  const raw = String(shipName || "").trim();
  if (!raw) return [];
  const soft = raw.toLowerCase().replace(/\s+/g, " ");
  const variants = new Set([raw, soft]);
  const parts = soft.split(" ");
  if (parts.length < 2) return [...variants];
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1).join(" ");
  const romanToArabic = {
    i: "1", ii: "2", iii: "3", iv: "4", v: "5",
    vi: "6", vii: "7", viii: "8", ix: "9", x: "10"
  };
  const arabicToRoman = {
    "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v",
    "6": "vi", "7": "vii", "8": "viii", "9": "ix", "10": "x"
  };
  if (romanToArabic[last]) variants.add(`${head} ${romanToArabic[last]}`);
  if (arabicToRoman[last]) variants.add(`${head} ${arabicToRoman[last]}`);
  return [...variants];
}

async function lookupCatalogueShipHeroUrl(shipName) {
  const variants = expandTerminalShipNameVariants(shipName);
  if (!variants.length) return "";

  for (const variant of variants) {
    const { data, error } = await supabaseClient
      .from("ci_cruise_ships")
      .select("name, hero_image_url")
      .ilike("name", variant)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (!error && data?.hero_image_url) return data.hero_image_url;
  }

  for (const variant of variants) {
    if (String(variant).replace(/[%_]/g, "").trim().length < 4) continue;
    const partial = String(variant).replace(/[%_]/g, "").trim();
    const { data } = await supabaseClient
      .from("ci_cruise_ships")
      .select("name, hero_image_url")
      .ilike("name", `%${partial}%`)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (data?.hero_image_url) return data.hero_image_url;
  }

  for (const variant of variants) {
    const { data, error } = await supabaseClient
      .from("ships")
      .select("name, hero_image_url")
      .ilike("name", variant)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("Ship hero image lookup failed", error);
      break;
    }
    if (data?.hero_image_url) return data.hero_image_url;
  }

  for (const variant of variants) {
    if (String(variant).replace(/[%_]/g, "").trim().length < 4) continue;
    const partial = String(variant).replace(/[%_]/g, "").trim();
    const { data } = await supabaseClient
      .from("ships")
      .select("name, hero_image_url")
      .ilike("name", `%${partial}%`)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (data?.hero_image_url) return data.hero_image_url;
  }

  return "";
}

async function loadShipHeroImage(shipName, cruiseLine = "") {
  const defaultImage = "assets/default-cruise-hero.jpg";
  const fallbackImage = getShipImage(shipName) || defaultImage;
  if (!shipName) return fallbackImage;

  // Prefer the same get-ship resolution as Your Ship (handles Explora 1 → EXPLORA I).
  try {
    const resolved = await fetchShipFromBase44(String(shipName).trim(), String(cruiseLine || "").trim());
    if (resolved.ok) {
      if (resolved.ship?.hero_image_url) return resolved.ship.hero_image_url;
      const fromCanonical = await lookupCatalogueShipHeroUrl(resolved.ship?.name || shipName);
      if (fromCanonical) return fromCanonical;
    }
  } catch (_error) {
    /* fall through to local catalogue lookup */
  }

  const catalogueUrl = await lookupCatalogueShipHeroUrl(shipName);
  return catalogueUrl || fallbackImage;
}

async function loadShipPageImage(shipName) {
  // Ship page only: real image or empty (text-only hero). No generic fallback photo.
  if (!shipName) return "";
  const mapped = getShipImage(shipName);
  const catalogueUrl = await lookupCatalogueShipHeroUrl(shipName);
  return catalogueUrl || mapped || "";
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

function getCountdownPartsForTarget(target) {
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

function getCountdownParts(cruise) {
  return getCountdownPartsForTarget(getDepartureDateTime(cruise));
}

function padNumber(value) {
  if (value === "—") return "—";
  return String(value).padStart(2, "0");
}

let dashboardCountdownConfig = null;

function normalizeCalendarDateString(dateString) {
  const match = String(dateString || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function parseCalendarDate(dateString) {
  const normalized = normalizeCalendarDateString(dateString);
  if (!normalized) return null;
  const dateParts = normalized.split("-").map(Number);
  if (dateParts.length !== 3 || dateParts.some(isNaN)) return null;
  return new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 0, 0, 0, 0);
}

function getEarliestNormalizedBudgetDates(budget, category) {
  return (budget?.items || [])
    .filter(item => item.category === category)
    .map(item => normalizeCalendarDateString(item.date))
    .filter(Boolean)
    .sort();
}

function getLeaveHomeDateTime(dateString) {
  const date = parseCalendarDate(dateString);
  if (!date) return null;
  date.setHours(6, 0, 0, 0);
  return date;
}

function getDaysUntilCalendarDate(dateString) {
  const target = parseCalendarDate(dateString);
  if (!target) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((target.getTime() - today.getTime()) / 86400000);
}

function calculateLeaveHomeDate(cruise, budget) {
  const flightDates = getEarliestNormalizedBudgetDates(budget, "flights");
  if (flightDates.length) return { date: flightDates[0], source: "flight" };

  const accommodationDates = getEarliestNormalizedBudgetDates(budget, "accommodation");
  if (accommodationDates.length) return { date: accommodationDates[0], source: "accommodation" };

  const embarkationDate = normalizeCalendarDateString(cruise?.departure_date);
  if (embarkationDate) return { date: embarkationDate, source: "embarkation" };
  return { date: null, source: null };
}

function getLeaveHomeDashboardState(daysUntilLeaveHome) {
  if (daysUntilLeaveHome === null || daysUntilLeaveHome === undefined) return "normal";
  if (daysUntilLeaveHome > 2) return "normal";
  if (daysUntilLeaveHome === 2 || daysUntilLeaveHome === 1) return "before_leave_home";
  if (daysUntilLeaveHome === 0) return "leave_home_day";
  return "after_leave_home";
}

function buildDashboardCountdownConfig(cruise, leaveHomeInfo, booking = null) {
  const dateApi = typeof CruiseDateState !== "undefined" ? CruiseDateState : null;
  const returnInfo = getCruiseReturnDateInfo(cruise, booking);
  const lifecycle = dateApi?.getCruiseLifecycleState
    ? dateApi.getCruiseLifecycleState({
        departing_date: cruise?.departure_date || booking?.departing_date,
        arriving_date: returnInfo.returnDate,
        cruise_duration: booking?.cruise_duration || cruise?.cruise_duration || cruise?.nights,
        nights: cruise?.nights,
        now: new Date()
      })
    : "before_embarkation";

  const embarkationTarget = getDepartureDateTime(cruise);
  const leaveHomeTarget = leaveHomeInfo?.date ? getLeaveHomeDateTime(leaveHomeInfo.date) : null;
  const daysUntilLeaveHome = leaveHomeInfo?.date ? getDaysUntilCalendarDate(leaveHomeInfo.date) : null;
  const now = new Date();
  const embarkationIsAfterLeaveHome = !leaveHomeTarget || !embarkationTarget || leaveHomeTarget.getTime() <= embarkationTarget.getTime();

  let legacy = {
    panelLabel: "Sailing in",
    dayLabel: "",
    getParts: () => getCountdownParts(cruise)
  };

  if (leaveHomeTarget && embarkationIsAfterLeaveHome && daysUntilLeaveHome !== null && daysUntilLeaveHome >= 0 && now.getTime() < leaveHomeTarget.getTime()) {
    const dayLabel = daysUntilLeaveHome === 1 ? "1 day until you leave home" : `${daysUntilLeaveHome} days until you leave home`;
    legacy = {
      panelLabel: "Leaving home in",
      dayLabel,
      getParts: () => getCountdownPartsForTarget(leaveHomeTarget)
    };
  } else if (embarkationTarget && leaveHomeTarget && now.getTime() >= leaveHomeTarget.getTime()) {
    const embarkDays = getCountdownParts(cruise).totalDays;
    const dayLabel = embarkDays === 1 ? "1 day until embarkation" : embarkDays === null ? "Add your sail date" : `${embarkDays} days until embarkation`;
    legacy = {
      panelLabel: "Embarkation in",
      dayLabel,
      getParts: () => getCountdownParts(cruise)
    };
  } else {
    const cruiseDays = getCountdownParts(cruise).totalDays;
    const dayLabel = cruiseDays === null ? "Add your sail date" : cruiseDays <= 0 ? "Bon Voyage" : cruiseDays === 1 ? "1 day until your cruise" : `${cruiseDays} days until your cruise`;
    legacy = {
      panelLabel: "Sailing in",
      dayLabel,
      getParts: () => getCountdownParts(cruise)
    };
  }

  const presentation = dateApi?.buildCountdownPresentation
    ? dateApi.buildCountdownPresentation(lifecycle, legacy)
    : { mode: "countdown", panelLabel: legacy.panelLabel, showCounters: true };

  return {
    ...legacy,
    lifecycle,
    presentation,
    returnDate: returnInfo.returnDate,
    returnDateDerived: returnInfo.derived,
    getParts: legacy.getParts
  };
}

function clearCountdownTimer() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateLiveCountdown(cruise) {
  const presentation = dashboardCountdownConfig?.presentation;
  const panel = document.getElementById("dashboardCountdownPanel");
  if (panel && presentation?.mode === "hidden") {
    panel.hidden = true;
    return;
  }
  if (panel) panel.hidden = false;

  if (presentation?.mode === "sail_day" || presentation?.mode === "enjoying") {
    return;
  }

  const parts = dashboardCountdownConfig?.getParts?.() || getCountdownParts(cruise);
  const panelLabel = document.getElementById("dashboardCountdownLabel");
  if (panelLabel && dashboardCountdownConfig?.panelLabel) panelLabel.textContent = dashboardCountdownConfig.panelLabel;

  const daysEl = document.getElementById("countdownDays");
  const hoursEl = document.getElementById("countdownHours");
  const minutesEl = document.getElementById("countdownMinutes");
  const secondsEl = document.getElementById("countdownSeconds");
  if (daysEl) daysEl.innerText = parts.days;
  if (hoursEl) hoursEl.innerText = padNumber(parts.hours);
  if (minutesEl) minutesEl.innerText = padNumber(parts.minutes);
  if (secondsEl) secondsEl.innerText = padNumber(parts.seconds);
}

function renderDashboardCountdownPanel(countdownConfig, countdownParts) {
  const presentation = countdownConfig?.presentation || { mode: "countdown", showCounters: true };
  if (presentation.mode === "hidden") return "";

  if (presentation.mode === "sail_day") {
    return `
      <div class="dashboard-countdown-panel dashboard-countdown-message" id="dashboardCountdownPanel">
        <p class="dashboard-countdown-message-title">${escapeHtml(presentation.message?.title || "TODAY IS SAIL DAY")}</p>
        <p class="dashboard-countdown-message-subtitle">${escapeHtml(presentation.message?.subtitle || "BON VOYAGE!")}</p>
      </div>`;
  }

  if (presentation.mode === "enjoying") {
    return `
      <div class="dashboard-countdown-panel dashboard-countdown-message" id="dashboardCountdownPanel">
        <p class="dashboard-countdown-message-title">${escapeHtml(presentation.message || "HOPE YOU ARE ENJOYING YOUR CRUISE")}</p>
      </div>`;
  }

  return `
    <div class="dashboard-countdown-panel" id="dashboardCountdownPanel">
      <p id="dashboardCountdownLabel">${escapeHtml(countdownConfig.panelLabel || "Sailing in")}</p>
      <div class="dashboard-countdown-grid">
        <div><span id="countdownDays">${countdownParts.days}</span><small>Days</small></div>
        <div><span id="countdownHours">${padNumber(countdownParts.hours)}</span><small>Hours</small></div>
        <div><span id="countdownMinutes">${padNumber(countdownParts.minutes)}</span><small>Minutes</small></div>
        <div><span id="countdownSeconds">${padNumber(countdownParts.seconds)}</span><small>Seconds</small></div>
      </div>
    </div>`;
}

function startLiveCountdown(cruise, config = null) {
  dashboardCountdownConfig = config || buildDashboardCountdownConfig(cruise, calculateLeaveHomeDate(cruise, null));
  clearCountdownTimer();
  updateLiveCountdown(cruise);
  countdownTimer = setInterval(() => updateLiveCountdown(cruise), 1000);
}

async function loadDashboardChecklistData(cruise) {
  const [{ data: items, error: itemError }, { data: sections }] = await Promise.all([
    supabaseClient.from("checklist_items").select("*, checklist_sections(id, name)").eq("active", true).order("display_order", { ascending: true }),
    supabaseClient.from("checklist_sections").select("*").eq("active", true).order("display_order", { ascending: true })
  ]);

  let progressRows = [];
  if (cruise && customerMode) {
    try {
      const data = await customerProgressRequest("load_checklist");
      progressRows = data.progress || [];
    } catch (error) {
      console.warn("Customer dashboard checklist load failed", error);
    }
  } else if (cruise && currentUser?.id) {
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
  const sectionNameById = new Map((sections || []).map(section => [String(section.id), section.name]));
  const completedCount = checklistItems.filter(item => isItemCompleted(progressRows, item.id)).length;
  const totalCount = checklistItems.length;
  const daysUntil = cruise ? getCountdownParts(cruise).totalDays : null;
  const nextEssentialStep = resolveNextEssentialStep(checklistItems, progressRows, daysUntil, sectionNameById);
  const lastMinute = resolveLastMinuteChecklistState(checklistItems, progressRows, sections || []);

  return {
    checklistItems,
    completedCount,
    totalCount,
    percent: getProgressPercent(completedCount, totalCount),
    nextEssentialStep,
    lastMinute,
    sectionNameById
  };
}

function isLastMinuteSectionName(name) {
  return String(name || "").trim().toLowerCase().includes("last minute");
}

function isLastMinuteChecklistItem(item, sectionNameById) {
  return isLastMinuteSectionName(sectionNameById.get(String(item.section_id)) || "");
}

function isChecklistItemInActiveWindow(item, daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return true;

  const showFrom = item.show_from_days;
  const showUntil = item.show_until_days;

  if (showFrom !== null && showFrom !== undefined && daysUntil > Number(showFrom)) return false;
  if (showUntil !== null && showUntil !== undefined && daysUntil < Number(showUntil)) return false;
  return true;
}

function isDepartureDayOrImmediateTask(item, daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return false;
  if (!isChecklistItemInActiveWindow(item, daysUntil)) return false;
  const showUntil = Number(item.show_until_days);
  if (Number.isFinite(showUntil) && showUntil <= 1) return true;
  return daysUntil <= 1;
}

function isOverdueChecklistItem(item, daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return false;
  if (item.show_until_days === null || item.show_until_days === undefined) return false;
  return daysUntil < Number(item.show_until_days);
}

function sortChecklistItemsByUrgency(items, daysUntil) {
  return [...items].sort((a, b) => {
    const aUntil = Number.isFinite(Number(a.show_until_days)) ? Number(a.show_until_days) : 9999;
    const bUntil = Number.isFinite(Number(b.show_until_days)) ? Number(b.show_until_days) : 9999;
    if (aUntil !== bUntil) return aUntil - bUntil;
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

function resolveNextEssentialStep(checklistItems, progressRows, daysUntil, sectionNameById) {
  if (!checklistItems.length) {
    return { state: "on_track", title: "You're on track", description: "Your next preparation step will appear here when it becomes relevant.", buttonText: "View Preparation Checklist", buttonAction: "openPreparationChecklist()" };
  }

  const incompleteItems = checklistItems.filter(item => !isItemCompleted(progressRows, item.id));
  if (!incompleteItems.length) {
    return { state: "all_complete", title: "You're Ready", description: "There are no essential preparation tasks remaining.", buttonText: "Review Checklist", buttonAction: "openPreparationChecklist()" };
  }

  const preparationItems = incompleteItems.filter(item => !isLastMinuteChecklistItem(item, sectionNameById));
  const currentlyDueItems = preparationItems.filter(item => isChecklistItemInActiveWindow(item, daysUntil));

  const priorityPools = [
    preparationItems.filter(item => isDepartureDayOrImmediateTask(item, daysUntil)),
    preparationItems.filter(item => isOverdueChecklistItem(item, daysUntil)),
    currentlyDueItems.filter(item => item.show_until_days !== null && item.show_until_days !== undefined),
    currentlyDueItems.filter(item => getPriorityLabel(item.priority) === "Essential"),
    currentlyDueItems.filter(item => getPriorityLabel(item.priority) === "Optional")
  ];

  for (const pool of priorityPools) {
    const nextItem = sortChecklistItemsByUrgency(pool, daysUntil)[0];
    if (nextItem) {
      return {
        state: "task",
        item: nextItem,
        title: nextItem.title,
        description: nextItem.description || nextItem.why_it_matters || "Protect your investment and travel with peace of mind.",
        buttonText: "View Task →",
        buttonAction: `openChecklistTask(${nextItem.id})`
      };
    }
  }

  return { state: "on_track", title: "You're on track", description: "Your next preparation step will appear here when it becomes relevant.", buttonText: "View Preparation Checklist", buttonAction: "openPreparationChecklist()" };
}

function resolveLastMinuteChecklistState(checklistItems, progressRows, sections) {
  const lastMinuteSection = (sections || []).find(section => isLastMinuteSectionName(section.name));
  const sectionItems = (checklistItems || []).filter(item => {
    const sectionName = item.checklist_sections?.name || lastMinuteSection?.name || (sections || []).find(section => String(section.id) === String(item.section_id))?.name;
    return isLastMinuteSectionName(sectionName);
  });
  const sectionId = lastMinuteSection?.id ?? sectionItems[0]?.section_id ?? sectionItems[0]?.checklist_sections?.id ?? null;
  const completedCount = sectionItems.filter(item => isItemCompleted(progressRows, item.id)).length;
  const totalCount = sectionItems.length;
  return {
    sectionId,
    completedCount,
    totalCount,
    allComplete: totalCount > 0 && completedCount === totalCount
  };
}

const CHECKLIST_FOCUS_KEY = "101cruise_checklist_focus";

function openPreparationChecklist() {
  sessionStorage.removeItem(CHECKLIST_FOCUS_KEY);
  renderChecklist();
}

function openChecklistTask(itemId) {
  sessionStorage.setItem(CHECKLIST_FOCUS_KEY, JSON.stringify({ type: "item", id: Number(itemId) }));
  renderChecklist();
}

function openLastMinuteChecklist(sectionId) {
  const payload = { type: "section", name: "last minute" };
  if (sectionId !== undefined && sectionId !== null && String(sectionId).trim() !== "") payload.id = String(sectionId);
  sessionStorage.setItem(CHECKLIST_FOCUS_KEY, JSON.stringify(payload));
  renderChecklist();
}

function focusChecklistTargetFromDashboard(attempt = 0) {
  const raw = sessionStorage.getItem(CHECKLIST_FOCUS_KEY);
  if (!raw) return;
  let focus = null;
  try {
    focus = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(CHECKLIST_FOCUS_KEY);
    return;
  }

  if (focus?.type === "item") {
    const row = document.querySelector(`[data-checklist-row="${focus.id}"]`);
    if (!row) {
      if (attempt < 4) window.setTimeout(() => focusChecklistTargetFromDashboard(attempt + 1), 50);
      return;
    }
    sessionStorage.removeItem(CHECKLIST_FOCUS_KEY);
    row.classList.add("is-dashboard-focus");
    const details = document.getElementById(`checklist-details-${focus.id}`);
    if (details) details.classList.add("open");
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => row.classList.remove("is-dashboard-focus"), 2600);
    return;
  }

  if (focus?.type === "section") {
    let section = focus.id !== undefined && focus.id !== null
      ? document.querySelector(`[data-checklist-section="${CSS.escape(String(focus.id))}"]`)
      : null;
    if (!section) {
      section = [...document.querySelectorAll("[data-checklist-section]")].find(block => {
        const heading = block.querySelector(".checklist-section-header h3");
        return isLastMinuteSectionName(heading?.textContent);
      }) || null;
    }
    if (!section) {
      if (attempt < 4) window.setTimeout(() => focusChecklistTargetFromDashboard(attempt + 1), 50);
      return;
    }
    sessionStorage.removeItem(CHECKLIST_FOCUS_KEY);
    section.classList.add("is-dashboard-focus");
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => section.classList.remove("is-dashboard-focus"), 2600);
  }
}

function scheduleChecklistFocusFromDashboard() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => focusChecklistTargetFromDashboard());
  });
}

function resolveDashboardActionCard(checklistData, leaveHomeInfo) {
  const leaveHomeDate = leaveHomeInfo?.date ? normalizeCalendarDateString(leaveHomeInfo.date) : null;
  const daysUntilLeaveHome = leaveHomeDate ? getDaysUntilCalendarDate(leaveHomeDate) : null;
  const leaveHomeState = getLeaveHomeDashboardState(daysUntilLeaveHome);
  const isLeaveHomeDay = leaveHomeState === "leave_home_day";
  const lastMinute = checklistData.lastMinute || { allComplete: false, sectionId: null };
  const lastMinuteAction = lastMinute.sectionId != null
    ? `openLastMinuteChecklist(${JSON.stringify(String(lastMinute.sectionId))})`
    : "openLastMinuteChecklist()";

  if (leaveHomeState === "before_leave_home" || leaveHomeState === "leave_home_day") {
    if (lastMinute.allComplete) {
      return {
        label: "Last Minute Checklist",
        title: "Ready to Go",
        description: "Your Last Minute Checklist is complete. Have a fantastic holiday!",
        buttonText: "",
        buttonAction: "",
        isPrimary: isLeaveHomeDay,
        mode: "last_minute_complete"
      };
    }
    return {
      label: isLeaveHomeDay ? "LEAVE HOME TODAY" : "Next Essential Step",
      title: isLeaveHomeDay ? "Final check before you leave" : "Before You Leave Home",
      description: isLeaveHomeDay
        ? "Today is your Leave Home Day. Review the last-minute items before you head off."
        : "Review the items that can't be packed until the last minute before you leave home.",
      buttonText: "Open Last Minute Checklist →",
      buttonAction: lastMinuteAction,
      isPrimary: isLeaveHomeDay,
      mode: "last_minute"
    };
  }

  const step = checklistData.nextEssentialStep;
  return {
    label: "Next Essential Step",
    title: step.title,
    description: step.description,
    buttonText: step.buttonText || "",
    buttonAction: step.buttonAction || "openPreparationChecklist()",
    isPrimary: false,
    mode: step.state
  };
}

function renderDashboardActionCard(card) {
  const button = card.buttonText
    ? `<button class="dashboard-outline-action dashboard-card-button" onclick="${card.buttonAction}">${escapeHtml(card.buttonText)}</button>`
    : "";
  const cardClass = [
    "dashboard-summary-card",
    "dashboard-next-step-wide",
    card.isPrimary ? "dashboard-next-step-primary dashboard-next-step-leave-home-day" : ""
  ].filter(Boolean).join(" ");
  return `
    <article class="${cardClass}">
      <div>
        <p class="dashboard-card-label">${escapeHtml(card.label)}</p>
        <h2>${escapeHtml(card.title)}</h2>
        <p class="dashboard-card-copy">${escapeHtml(card.description)}</p>
      </div>
      ${button}
    </article>
  `;
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

function getCruiseReturnDateInfo(cruise, booking = null) {
  const api = typeof CruiseDateState !== "undefined" ? CruiseDateState : null;
  const departing = cruise?.departure_date || booking?.departing_date || null;
  const arriving = cruise?.return_date || cruise?.arrival_date || booking?.arriving_date || null;
  const duration = booking?.cruise_duration || cruise?.cruise_duration || cruise?.nights || null;
  if (!api?.deriveReturnDate) {
    return { returnDate: arriving || null, derived: false };
  }
  return api.deriveReturnDate({
    departing_date: departing,
    arriving_date: arriving,
    cruise_duration: duration,
    nights: cruise?.nights
  });
}

function getCruiseDateRangeText(cruise, booking = null) {
  const depart = cruise?.departure_date ? formatDateShort(cruise.departure_date) : "Departure not added";
  const { returnDate, derived } = getCruiseReturnDateInfo(cruise, booking);
  if (!returnDate) return `${depart} to Return not added`;
  return `${depart} to ${formatDateShort(returnDate)}${derived ? "" : ""}`;
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
  return cruise?._preview_booking || customerBooking || cruise || {};
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

function getBookingFinancials(cruise, bookingOverride = null) {
  const booking = bookingOverride || getDashboardBookingSource(cruise);
  const api = typeof BookingFinancials !== "undefined" ? BookingFinancials : null;
  if (!api?.normaliseBookingFinancials) return null;
  return api.normaliseBookingFinancials(booking);
}

function formatBookingFinancialMoney(amount) {
  const api = typeof BookingFinancials !== "undefined" ? BookingFinancials : null;
  if (api?.formatFinancialUsd) {
    const formatted = api.formatFinancialUsd(amount);
    if (formatted) return formatted;
  }
  return formatCurrencyValue(amount);
}

function formatBookingFinancialDate(dateString) {
  if (!dateString) return "";
  const iso = String(dateString).slice(0, 10);
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateString);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const day = Number(match[3]);
  const month = months[Number(match[2]) - 1];
  if (!month || !Number.isFinite(day)) return String(dateString);
  return `${day} ${month} ${match[1]}`;
}

function getBookingFinancialDisplayRows(cruise, bookingOverride = null) {
  const financials = getBookingFinancials(cruise, bookingOverride);
  const api = typeof BookingFinancials !== "undefined" ? BookingFinancials : null;
  if (!financials || !api?.buildFinancialDisplayRows) return [];
  return api.buildFinancialDisplayRows(financials, {
    formatMoney: formatBookingFinancialMoney,
    formatDate: formatBookingFinancialDate
  });
}

function renderSharedFinancialRows(cruise, bookingOverride = null, rowRenderer) {
  const rows = getBookingFinancialDisplayRows(cruise, bookingOverride);
  return rows
    .map(row => rowRenderer(row.label, row.value))
    .filter(Boolean)
    .join("");
}

function getPaymentSummary(cruise) {
  const financials = getBookingFinancials(cruise);
  if (financials?.overall_payment_status_label) {
    return financials.overall_payment_status_label;
  }
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

function isSnapshotValuePresent(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower !== "not added" && lower !== "none recorded";
}

function getBookingTravellerDisplayNames(booking = {}) {
  return [1, 2].map(index => [booking[`passenger${index}_first_name`], booking[`passenger${index}_last_name`]].filter(Boolean).join(" ").trim()).filter(Boolean);
}

function getSnapshotTravellerNames(cruise, booking = null) {
  const fromBooking = getBookingTravellerDisplayNames(booking || {});
  if (fromBooking.length) return fromBooking;

  const raw = String(getDashboardValue(cruise, ["traveller_names", "travellers", "guest_names", "passenger_names"], "") || "").trim();
  if (raw) {
    return raw.split(/,|\s+&\s+|\s+and\s+/i).map(name => name.trim()).filter(Boolean);
  }

  return [];
}

function renderSnapshotTravellerNames(cruise, booking = null) {
  const names = getSnapshotTravellerNames(cruise, booking);
  if (!names.length) return "";
  return `<div class="dashboard-snapshot-travellers">${names.map(name => `<span class="dashboard-snapshot-traveller-name">${escapeHtml(name)}</span>`).join("")}</div>`;
}

function renderSnapshotRowIfPresent(label, value, formatter = item => item) {
  if (!isSnapshotValuePresent(value)) return "";
  const formatted = formatter(value);
  if (!isSnapshotValuePresent(formatted)) return "";
  return `<div class="dashboard-snapshot-row"><span>${escapeHtml(label)}</span>${renderStatusValue(formatted)}</div>`;
}

function renderDashboardTravellerNames(cruise) {
  const namesHtml = renderSnapshotTravellerNames(cruise, getDashboardBookingSource(cruise));
  if (!namesHtml) return renderStatusValue("Not added");
  return namesHtml;
}

function renderDashboardInclusionTags(cruise) {
  const booking = getDashboardBookingSource(cruise);
  const inclusions = Array.isArray(booking.inclusions) ? booking.inclusions.filter(Boolean) : [];
  if (!inclusions.length) return `<p class="dashboard-snapshot-extras-empty">None recorded</p>`;
  return `<div class="dashboard-snapshot-extras-tags">${inclusions.map(item => `<span class="dashboard-snapshot-extras-tag">${escapeHtml(String(item))}</span>`).join("")}</div>`;
}

function renderDashboardSnapshot(cruise) {
  const booking = getDashboardBookingSource(cruise);
  const embarkationPort = getBookingPayloadValue(booking, cruise, ["departing_port", "embarkation_port", "departure_port", "from_port", "departure_city"]) || "";
  const disembarkationPort = getBookingPayloadValue(booking, cruise, ["arriving_port", "disembarkation_port", "arrival_port", "to_port", "destination"]) || "";
  const departureDate = booking.departing_date || cruise?.departure_date;
  const returnDate = booking.arriving_date || cruise?.return_date || cruise?.arrival_date;
  const embarkation = formatPortDateTime(embarkationPort, departureDate, cruise?.departure_time);
  const disembarkation = formatPortDateTime(disembarkationPort, returnDate, cruise?.arrival_time);
  const cabin = getBookingPayloadValue(booking, cruise, ["room_number", "cabin_number", "cabin", "stateroom", "suite"]);
  const roomType = getBookingPayloadValue(booking, cruise, ["room_type", "cabin_type", "stateroom_type", "suite_type"]);
  const category = getBookingPayloadValue(booking, cruise, ["category_class"]);
  const travellerCount = booking.total_passengers || cruise?.traveller_count;
  const duration = booking.cruise_duration || cruise?.nights;
  const status = booking.booking_status || cruise?.booking_status;
  const passportStatus = getPassportStatusSummary(cruise);
  const travellerNamesHtml = renderSnapshotTravellerNames(cruise, booking);
  const financialRowsHtml = renderSharedFinancialRows(cruise, booking, (label, value) =>
    renderSnapshotRowIfPresent(label, value)
  );
  const snapshotRows = [
    travellerNamesHtml ? `<div class="dashboard-snapshot-row dashboard-snapshot-row-travellers"><span>Travellers</span>${travellerNamesHtml}</div>` : "",
    renderSnapshotRowIfPresent("Traveller count", travellerCount),
    renderSnapshotRowIfPresent("Cabin", cabin),
    renderSnapshotRowIfPresent("Room type", roomType),
    renderSnapshotRowIfPresent("Category", category),
    renderSnapshotRowIfPresent("Duration", duration, value => `${value} nights`),
    renderSnapshotRowIfPresent("Embarkation", embarkation),
    renderSnapshotRowIfPresent("Disembarkation", disembarkation),
    renderSnapshotRowIfPresent("Passport check", passportStatus === "Not added" ? null : passportStatus),
    renderSnapshotRowIfPresent("Booking status", status),
    financialRowsHtml
  ].filter(Boolean).join("");

  return `
    <article class="dashboard-summary-card dashboard-snapshot-card">
      <p class="dashboard-card-label">Cruise Snapshot</p>
      <div class="dashboard-snapshot-list">
        ${snapshotRows || `<p class="dashboard-snapshot-extras-empty">Booking details will appear here once your cruise is linked.</p>`}
      </div>
      <section class="dashboard-snapshot-extras">
        <h3 class="dashboard-snapshot-extras-title">Included extras</h3>
        ${renderDashboardInclusionTags(cruise)}
      </section>
      <footer class="dashboard-snapshot-footer">
        <button class="dashboard-outline-action" onclick="navigateWithLoading('booking', () => renderBookingDetails(), event)">Open Booking →</button>
      </footer>
    </article>
  `;
}


/** Demo fixture only — rendered through the same generic journey path as live itineraries. */
const MILLENNIUM_DEMO_ITINERARY = {
  title: "Tokyo to Seoul",
  voyage_name: "Tokyo to Seoul",
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
};

function isJourneySeaDay(stop) {
  const type = String(stop?.type || stop?.entry_type || "").toLowerCase();
  const name = String(stop?.name || "").toLowerCase();
  return type === "sea_day" || name === "at sea" || name.includes("at sea");
}

function journeyStopHasCoordinates(stop) {
  return Number.isFinite(Number(stop?.lat)) && Number.isFinite(Number(stop?.lng));
}

function buildDashboardJourneyFromItinerary(itinerary, source = "itinerary") {
  if (!itinerary || !Array.isArray(itinerary.stops) || !itinerary.stops.length) {
    return { journey: null, reason: "insufficient_stops" };
  }
  const stops = itinerary.stops.map((stop, index) => ({
    date: stop.date || null,
    name: String(stop.name || `Stop ${index + 1}`).trim(),
    type: isJourneySeaDay(stop) ? "sea_day" : String(stop.entry_type || stop.type || "port").toLowerCase(),
    arrival: stop.arrival || stop.arrival_time || "",
    departure: stop.departure || stop.departure_time || "",
    lat: Number.isFinite(Number(stop.lat ?? stop.latitude)) ? Number(stop.lat ?? stop.latitude) : null,
    lng: Number.isFinite(Number(stop.lng ?? stop.longitude)) ? Number(stop.lng ?? stop.longitude) : null
  }));
  const named = stops.filter((s) => s && !isJourneySeaDay(s) && s.name);
  const title =
    String(itinerary.title || itinerary.voyage_name || "").trim() ||
    (named.length >= 2 ? `${named[0].name} to ${named[named.length - 1].name}` : named[0]?.name || "Your journey");
  const mapped = stops.filter((s) => !isJourneySeaDay(s) && journeyStopHasCoordinates(s));
  const canDrawMap = mapped.length >= 2;
  return {
    journey: {
      title,
      stops,
      can_draw_map: canDrawMap,
      source,
      diagnostic_reason: canDrawMap ? "ok" : "insufficient_coordinates"
    },
    reason: canDrawMap ? "ok" : "insufficient_coordinates"
  };
}

function projectDashboardJourneyMap(journey) {
  // Prefer shared geo helper (aspect-corrected equirectangular + date-line unwrap).
  if (typeof DashboardJourneyMapGeo !== "undefined" && DashboardJourneyMapGeo.projectJourneyMap) {
    return DashboardJourneyMapGeo.projectJourneyMap(journey);
  }
  // Offline fallback — simple equirectangular without land (tests / missing script).
  const width = 620;
  const height = 350;
  const pad = 48;
  const points = (journey?.stops || [])
    .filter((s) => !isJourneySeaDay(s) && journeyStopHasCoordinates(s))
    .filter((s, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1];
      return !(prev.lat === s.lat && prev.lng === s.lng);
    });
  if (points.length < 2) return null;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(maxLat - minLat, 0.35);
  const lngSpan = Math.max(maxLng - minLng, 0.35);
  const project = (lat, lng) => ({
    x: Number((pad + ((lng - minLng) / lngSpan) * (width - pad * 2)).toFixed(1)),
    y: Number((pad + ((maxLat - lat) / latSpan) * (height - pad * 2)).toFixed(1))
  });
  const projected = points.map((p, index) => {
    const { x, y } = project(p.lat, p.lng);
    const label = String(p.name || "").replace(/\s*\([^)]*\)\s*$/, "").trim() || p.name;
    return { ...p, x, y, number: index + 1, label: label.length > 18 ? `${label.slice(0, 16)}…` : label };
  });

  let pathD = `M ${projected[0].x} ${projected[0].y}`;
  if (projected.length === 2) {
    pathD += ` L ${projected[1].x} ${projected[1].y}`;
  } else {
    for (let i = 0; i < projected.length - 1; i += 1) {
      const p0 = projected[Math.max(0, i - 1)];
      const p1 = projected[i];
      const p2 = projected[i + 1];
      const p3 = projected[Math.min(projected.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x} ${p2.y}`;
    }
  }
  return { width, height, pathD, ports: projected };
}

async function loadCustomerApprovedJourney(cruise) {
  if (!customerMode || !customerSessionToken) {
    return { journey: null, reason: "not_customer_session" };
  }
  try {
    const response = await fetch("/.netlify/functions/customer-itinerary", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerSessionToken}`
      }
    });
    const data = await response.json().catch(() => null);
    if (response.status === 401) {
      return { journey: null, reason: "invalid_session" };
    }
    if (!response.ok || !data?.success) {
      return { journey: null, reason: data?.reason || "itinerary_request_failed" };
    }
    if (data.journey) {
      return { journey: data.journey, reason: data.reason || "ok", diagnostic: data.diagnostic || null };
    }
    return { journey: null, reason: data.reason || "no_approved_itinerary", diagnostic: data.diagnostic || null };
  } catch (error) {
    console.warn("Customer itinerary load failed", error);
    return { journey: null, reason: "itinerary_request_failed" };
  }
}

async function resolveDashboardJourney(cruise) {
  const reference = String(
    cruise?.booking_reference || customerBooking?.booking_reference || ""
  )
    .trim()
    .toUpperCase();

  const live = await loadCustomerApprovedJourney(cruise);
  if (live.journey) {
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[dashboard-journey]", {
        source: live.journey.source,
        reason: live.reason,
        diagnostic: live.diagnostic || null
      });
    }
    return live.journey;
  }

  // Regression / demo booking only — same generic builder, not a separate renderer.
  if (reference === "SWM123456") {
    const demo = buildDashboardJourneyFromItinerary(MILLENNIUM_DEMO_ITINERARY, "demo_fixture_swm123456");
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[dashboard-journey]", { source: "demo_fixture_swm123456", reason: demo.reason });
    }
    return demo.journey;
  }

  if (typeof console !== "undefined" && console.debug) {
    console.debug("[dashboard-journey]", {
      source: null,
      reason: live.reason || "no_approved_itinerary",
      diagnostic: live.diagnostic || null,
      booking_reference: reference || null
    });
  }
  return null;
}

/** @deprecated Use resolveDashboardJourney — kept for offline tests of demo fixture path. */
function getDashboardJourney(cruise) {
  const reference = String(cruise?.booking_reference || customerBooking?.booking_reference || "").trim().toUpperCase();
  if (reference !== "SWM123456") return null;
  return buildDashboardJourneyFromItinerary(MILLENNIUM_DEMO_ITINERARY, "demo_fixture_swm123456").journey;
}

function scrollPlannerViewportToTop() {
  const nodes = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    app,
    document.getElementById("cruise-planner-app"),
    document.querySelector(".planner-shell"),
    document.querySelector(".documents-header")?.closest(".planner-shell"),
    document.querySelector(".dashboard-page")
  ].filter(Boolean);

  const seen = new Set();
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    try {
      if (typeof el.scrollTo === "function") el.scrollTo(0, 0);
      if ("scrollTop" in el) el.scrollTop = 0;
    } catch (_error) {
      /* ignore */
    }
  }
  try {
    window.scrollTo(0, 0);
  } catch (_error) {
    /* ignore */
  }
}

function scheduleScrollPlannerToTop() {
  // After SPA module content replaces #cruise-planner-app, reset window + containers once paint settles.
  requestAnimationFrame(() => {
    scrollPlannerViewportToTop();
    requestAnimationFrame(() => scrollPlannerViewportToTop());
  });
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
    if (!currentUser?.id) return { selected: 0, packed: 0, percent: 0 };
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
      <button type="button" onclick="navigateWithLoading('checklist', () => renderChecklist(), event)"><span aria-hidden="true">✓</span><strong>Checklist</strong></button>
      <button type="button" onclick="navigateWithLoading('packing', () => renderPackingPlanner(), event)"><span aria-hidden="true">🧳</span><strong>Pack List</strong></button>
      <button type="button" onclick="navigateWithLoading('budget', () => renderBudgetPlanner(), event)"><span aria-hidden="true">💳</span><strong>Budget</strong></button>
      <button type="button" onclick="navigateWithLoading('ship', () => renderTheShip(), event)"><span aria-hidden="true">🚢</span><strong>Your Ship</strong></button>
      <button type="button" onclick="navigateWithLoading('documents', () => renderDocuments(), event)"><span aria-hidden="true">📄</span><strong>Documents</strong></button>
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

function formatJourneyItineraryTime(timeString) {
  if (!timeString) return "";
  return formatTime(timeString);
}

function formatJourneyItineraryDate(dateString) {
  if (!dateString) return "";
  return String(formatDateShort(dateString) || "").toUpperCase();
}

function titleCasePortName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^at\s+sea$/i.test(text)) return "At sea";
  return text.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function renderJourneyItineraryRows(stops, expanded = false) {
  const list = Array.isArray(stops) ? stops : [];
  if (!list.length) return "";
  const visible = expanded || list.length <= 5 ? list : list.slice(0, 5);
  const rows = visible.map(stop => {
    const dayLabel = `DAY ${stop.day != null ? stop.day : ""}`.trim();
    const dateLabel = formatJourneyItineraryDate(stop.date);
    const portLabel = stop.is_sea_day ? "At sea" : titleCasePortName(stop.port_name) || "Port";
    const arrival = formatJourneyItineraryTime(stop.arrival_time);
    const departure = formatJourneyItineraryTime(stop.departure_time);
    let meta = "";
    if (arrival && departure) meta = `${arrival} – ${departure}`;
    else if (departure && (stop.is_embarkation || !arrival)) meta = `Departs ${departure}`;
    else if (arrival) meta = `Arrives ${arrival}`;
    if (stop.overnight) meta = meta ? `${meta} · Overnight` : "Overnight";
    if (stop.is_embarkation) meta = meta ? `${meta} · Embarkation` : "Embarkation";
    if (stop.is_disembarkation) meta = meta ? `${meta} · Disembarkation` : "Disembarkation";
    return `
      <li class="dashboard-journey-itinerary-item">
        <div class="dashboard-journey-itinerary-date">
          <strong>${escapeHtml(dayLabel)}</strong><br>${escapeHtml(dateLabel)}
        </div>
        <div>
          <p class="dashboard-journey-itinerary-port">${escapeHtml(portLabel)}</p>
          ${meta ? `<p class="dashboard-journey-itinerary-meta">${escapeHtml(meta)}</p>` : ""}
        </div>
      </li>`;
  }).join("");

  const toggle = list.length > 5
    ? `<button type="button" class="dashboard-outline-action dashboard-card-button" id="journeyItineraryToggle" data-expanded="${expanded ? "1" : "0"}">${expanded ? "Show less" : "View full itinerary"}</button>`
    : "";

  return `
    <div class="dashboard-journey-itinerary" id="journeyItineraryBlock" data-stop-count="${list.length}">
      <ul class="dashboard-journey-itinerary-list">${rows}</ul>
      ${toggle}
    </div>`;
}

/**
 * Booking-summary journey card with optional text-only itinerary (map extraction retired).
 */
function renderJourneySummary(cruise, options = {}) {
  const booking = options.booking || customerBooking || cruise?._preview_booking || null;
  const itineraryStops = Array.isArray(options.itineraryStops) ? options.itineraryStops : [];
  const itineraryExpanded = options.itineraryExpanded === true;
  const embarkPort =
    cruise?.embarkation_port || cruise?.departure_port || cruise?.from_port || cruise?.departure_city || "";
  const disembarkPort =
    cruise?.disembarkation_port || cruise?.arrival_port || cruise?.destination || cruise?.to_port || "";
  const embarkDate = cruise?.departure_date || "";
  const returnInfo = getCruiseReturnDateInfo(cruise, booking);
  const disembarkDate = returnInfo.returnDate || "";
  const nights =
    cruise?.nights != null && cruise.nights !== ""
      ? Number(cruise.nights)
      : booking?.cruise_duration
        ? Number(String(booking.cruise_duration).match(/\d+/)?.[0] || NaN)
        : calculateCruiseNights(embarkDate, disembarkDate);

  const routeParts = [embarkPort, disembarkPort].filter(Boolean);
  const routeHeading =
    routeParts.length === 2
      ? `${routeParts[0]} → ${routeParts[1]}`
      : routeParts[0] || "Your cruise journey";

  const detailRows = [];
  if (embarkDate) {
    detailRows.push(`<div class="dashboard-journey-summary-row"><span>Embarkation</span><strong>${escapeHtml(formatDateShort(embarkDate))}</strong></div>`);
  }
  if (disembarkDate) {
    detailRows.push(`<div class="dashboard-journey-summary-row"><span>Disembarkation</span><strong>${escapeHtml(formatDateShort(disembarkDate))}</strong></div>`);
  }
  if (nights != null && Number.isFinite(Number(nights)) && Number(nights) > 0) {
    const n = Number(nights);
    detailRows.push(
      `<div class="dashboard-journey-summary-row"><span>Duration</span><strong>${n} night${n === 1 ? "" : "s"}</strong></div>`
    );
  }

  const hasStops = itineraryStops.length > 0;
  const note = hasStops
    ? ""
    : `<p class="dashboard-card-copy">Your detailed cruise itinerary is available in your Booking Confirmation.</p>`;

  return `
    <article class="dashboard-summary-card dashboard-journey-card dashboard-journey-summary-card">
      <p class="dashboard-card-label">Your Journey</p>
      <h2>${escapeHtml(routeHeading)}</h2>
      ${detailRows.length ? `<div class="dashboard-journey-summary-details">${detailRows.join("")}</div>` : ""}
      ${hasStops ? renderJourneyItineraryRows(itineraryStops, itineraryExpanded) : note}
      <button type="button" class="dashboard-outline-action dashboard-card-button" onclick="openDocumentsWithLoading()">Open Documents →</button>
    </article>
  `;
}

async function loadCustomerTextItinerary() {
  if (!customerMode || !customerSessionToken) return { stops: [], status: null, reason: "no_session" };
  try {
    const response = await fetch("/.netlify/functions/customer-text-itinerary", {
      method: "GET",
      headers: { Authorization: `Bearer ${customerSessionToken}`, Accept: "application/json" }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) return { stops: [], status: null, reason: data?.reason || "request_failed" };
    const stops = Array.isArray(data?.itinerary?.stops) ? data.itinerary.stops : [];
    return { stops, status: data.status || null, reason: data.reason || null };
  } catch (error) {
    console.warn("Text itinerary load failed", error);
    return { stops: [], status: null, reason: "request_failed" };
  }
}

async function loadShipGalleryImages(cruise, heroUrl = "") {
  if (!cruise?.ship_name) return [];
  try {
    const params = new URLSearchParams({
      ship: cruise.ship_name || "",
      cruise_line: cruise.cruise_line || ""
    });
    if (heroUrl) params.set("hero_url", heroUrl);
    const headers = { Accept: "application/json" };
    if (customerSessionToken) headers.Authorization = `Bearer ${customerSessionToken}`;
    const response = await fetch(`/.netlify/functions/ship-gallery?${params.toString()}`, { headers });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) return [];
    const images = Array.isArray(data.images) ? data.images : [];
    return images.slice(0, 5);
  } catch (error) {
    console.warn("Ship gallery load failed", error);
    return [];
  }
}

function renderShipGallerySection(images, heroUrl = "") {
  if (typeof ShipGallerySection !== "undefined" && ShipGallerySection.render) {
    return ShipGallerySection.render(images, { heroUrl });
  }
  // Fallback if the shared helper failed to load — still show 1+ images.
  const list = Array.isArray(images)
    ? images.filter((img) => {
        const url = String(img?.url || "").trim();
        if (!url) return false;
        if (heroUrl && url === String(heroUrl).trim()) return false;
        return true;
      })
    : [];
  if (list.length === 0) return "";
  if (list.length === 1) {
    const img = list[0];
    const label = escapeHtml(img.alt || img.title || "Ship photo");
    return `
    <section class="dashboard-ship-gallery dashboard-ship-gallery--single" aria-label="Explore your ship">
      <div class="dashboard-ship-gallery-head"><h3>Explore your ship</h3></div>
      <button type="button" class="dashboard-ship-gallery-item dashboard-ship-gallery-item--single" data-gallery-index="0" aria-label="${label}">
        <img src="${escapeHtml(img.url)}" alt="${label}" loading="lazy" width="960" height="540">
      </button>
    </section>
    <div class="dashboard-ship-gallery-lightbox" id="shipGalleryLightbox" hidden>
      <button type="button" id="shipGalleryLightboxClose" aria-label="Close image">Close</button>
      <img id="shipGalleryLightboxImage" alt="">
    </div>`;
  }
  const items = list.map((img, index) => `
    <button type="button" class="dashboard-ship-gallery-item" data-gallery-index="${index}" aria-label="${escapeHtml(img.alt || img.title || "Ship photo")}">
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || img.title || "Ship photo")}" loading="lazy" width="960" height="540">
    </button>`).join("");
  return `
    <section class="dashboard-ship-gallery" aria-label="Explore your ship">
      <div class="dashboard-ship-gallery-head"><h3>Explore your ship</h3></div>
      <div class="dashboard-ship-gallery-track">${items}</div>
    </section>
    <div class="dashboard-ship-gallery-lightbox" id="shipGalleryLightbox" hidden>
      <button type="button" id="shipGalleryLightboxClose" aria-label="Close image">Close</button>
      <img id="shipGalleryLightboxImage" alt="">
    </div>`;
}

function bindShipGalleryInteractions(images) {
  const list = Array.isArray(images) ? images : [];
  const lightbox = document.getElementById("shipGalleryLightbox");
  const imageEl = document.getElementById("shipGalleryLightboxImage");
  const closeBtn = document.getElementById("shipGalleryLightboxClose");
  if (!lightbox || !imageEl) return;

  document.querySelectorAll("[data-gallery-index]").forEach(button => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-gallery-index"));
      const img = list[index];
      if (!img?.url) return;
      imageEl.src = img.url;
      imageEl.alt = img.alt || img.title || "Ship photo";
      lightbox.hidden = false;
    });
  });
  closeBtn?.addEventListener("click", () => {
    lightbox.hidden = true;
    imageEl.src = "";
  });
  lightbox.addEventListener("click", event => {
    if (event.target === lightbox) {
      lightbox.hidden = true;
      imageEl.src = "";
    }
  });
}

function bindJourneyItineraryToggle(stops) {
  const button = document.getElementById("journeyItineraryToggle");
  const block = document.getElementById("journeyItineraryBlock");
  if (!button || !block || !Array.isArray(stops) || stops.length <= 5) return;
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("data-expanded") === "1";
    block.outerHTML = renderJourneyItineraryRows(stops, !expanded);
    bindJourneyItineraryToggle(stops);
  });
}

async function openDocumentsWithLoading(event) {
  const button = event?.currentTarget || null;
  const run = () => renderDocuments();
  if (typeof PortalLoading?.withLoading === "function") {
    return PortalLoading.withLoading(run, { button, key: "documents" });
  }
  return run();
}

async function navigateWithLoading(key, action, event) {
  const button = event?.currentTarget || null;
  if (typeof PortalLoading?.withLoading === "function") {
    return PortalLoading.withLoading(action, { button, key });
  }
  return action();
}

/** @deprecated Map extraction retired — kept for offline tests of legacy helpers only. */
function renderJourneyMap(journey) {
  return renderJourneySummary(null);
}

function renderEditorialJourneyMap(journey) {
  const projection = journey.can_draw_map === false ? null : projectDashboardJourneyMap(journey);
  if (!projection) {
    return `
      <div class="dashboard-route-map dashboard-final-map dashboard-map-fallback" aria-label="Itinerary ports">
        <p class="dashboard-card-copy">Your port sequence is listed below. A route map will appear when port locations are available.</p>
      </div>`;
  }

  // Stash for async land layer (same projection as route + ship animation).
  window.__dashboardJourneyProjection = projection;

  const portMarks = projection.ports
    .map((port) => {
      const labelAnchor = port.x > projection.width * 0.72 ? "end" : "start";
      let labelX = labelAnchor === "end" ? port.x - 12 : port.x + 12;
      labelX = Math.min(projection.width - 6, Math.max(6, labelX));
      const labelY = Math.min(projection.height - 6, Math.max(14, port.y - 10));
      return `<g class="dashboard-map-port"><circle cx="${port.x}" cy="${port.y}" r="9"/><text x="${port.x}" y="${(port.y + 3.2).toFixed(1)}" text-anchor="middle" class="dashboard-map-port-number">${port.number}</text><text x="${labelX}" y="${labelY.toFixed(1)}" text-anchor="${labelAnchor}" class="dashboard-map-port-label">${escapeHtml(port.label)}</text></g>`;
    })
    .join("");

  return `
    <div class="dashboard-route-map dashboard-final-map" aria-label="Illustrative cruise route map">
      <svg viewBox="0 0 ${projection.width} ${projection.height}" role="img" aria-labelledby="dashboardMapTitle dashboardMapDesc" overflow="hidden">
        <title id="dashboardMapTitle">${escapeHtml(journey.title)} cruise route</title>
        <desc id="dashboardMapDesc">An illustrative route showing the cruise port sequence over a geographic map.</desc>
        <defs>
          <linearGradient id="dashboardSea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dff1f7"/><stop offset="1" stop-color="#cbe7ef"/></linearGradient>
          <clipPath id="dashboardMapClip"><rect width="${projection.width}" height="${projection.height}" rx="18"/></clipPath>
          <filter id="dashboardShipShadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity=".25"/></filter>
          <path id="dashboardRoutePath" d="${projection.pathD}"/>
        </defs>
        <g clip-path="url(#dashboardMapClip)">
          <rect width="${projection.width}" height="${projection.height}" rx="18" fill="url(#dashboardSea)"/>
          <g id="dashboardMapLand" class="dashboard-map-land" aria-hidden="true"></g>
          <use href="#dashboardRoutePath" class="dashboard-map-route" fill="none" stroke="#0c7664" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8 6"/>
          ${portMarks}
          <g class="dashboard-map-ship" filter="url(#dashboardShipShadow)" transform="translate(-8 -13)">
            <circle r="15" fill="#ffffff" stroke="#0c7664" stroke-width="1.8"/>
            <path d="M-9,2 L9,2 L6,7 L-6,7 Z M-6,-1 L6,-1 L4,2 L-4,2 Z M-2,-7 L3,-7 L3,-1 L-2,-1 Z" fill="#0c7664"/>
            <animateMotion dur="26s" repeatCount="indefinite" rotate="0" calcMode="paced"><mpath href="#dashboardRoutePath"/></animateMotion>
          </g>
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

function initialiseDashboardRouteMap(journey) {
  // Route SVG is synchronous; land fills in from the locally bundled Natural Earth topology.
  const root = document.querySelector(".dashboard-final-map");
  const projection = window.__dashboardJourneyProjection;
  if (!root || !projection || !journey) return;
  if (typeof DashboardJourneyMapGeo === "undefined" || !DashboardJourneyMapGeo.attachLandLayer) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[dashboard-journey-map] geo helper unavailable; route-only map retained");
    }
    return;
  }
  DashboardJourneyMapGeo.attachLandLayer(root, projection);
}

async function renderDashboard() {
  clearCountdownTimer();
  trackMyCruisePage("dashboard");

  let safeCruises = [];
  let mainCruise = null;
  let error = null;

  if (customerMode && customerCruise) {
    safeCruises = [customerCruise];
    mainCruise = customerCruise;
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
  if (mainCruise) {
    await resolveFullBookingPayload(mainCruise);
  }
  const bookingPayload = customerBooking || mainCruise?._preview_booking || null;
  const mainShipImage = mainCruise
    ? await loadShipHeroImage(mainCruise.ship_name, mainCruise.cruise_line)
    : "";
  const [checklistData, packingData, textItinerary, shipGalleryImages, linkedMeta] = await Promise.all([
    loadDashboardChecklistData(mainCruise),
    loadDashboardPackingData(mainCruise),
    loadCustomerTextItinerary(),
    loadShipGalleryImages(mainCruise, mainShipImage),
    customerMode ? fetchCustomerLinkedBookings() : Promise.resolve({ can_switch: false })
  ]);
  const showSwitchBooking =
    customerMode &&
    (linkedMeta?.can_switch === true ||
      (typeof SwitchBooking?.shouldShowSwitchControl === "function" &&
        SwitchBooking.shouldShowSwitchControl(linkedMeta)));
  const customerHeroAction = customerMode
    ? showSwitchBooking
      ? `<button class="dashboard-signout" type="button" onclick="openSwitchBookingChooser()">Switch Booking</button>`
      : `<button class="dashboard-signout" type="button" onclick="changeCustomerBooking()">Sign Out</button>`
    : `<button class="dashboard-signout" type="button" onclick="signOut()">Sign Out</button>`;
  const dashboardBudget = mainCruise ? await resolveDashboardBudget(mainCruise) : null;
  const leaveHomeInfo = calculateLeaveHomeDate(mainCruise, dashboardBudget);
  const countdownConfig = buildDashboardCountdownConfig(mainCruise, leaveHomeInfo, bookingPayload);
  const dashboardActionCard = resolveDashboardActionCard(checklistData, leaveHomeInfo);
  // Journey map extraction retired — booking summary + optional text itinerary only.
  const routeText = getCruiseRouteText(mainCruise);
  const nightsText = mainCruise?.nights ? `${mainCruise.nights} Nights` : "";
  const cruiseLineText = mainCruise?.cruise_line || "";
  const routeLine = [cruiseLineText, nightsText].filter(Boolean).join(" • ");
  const countdownParts = countdownConfig.presentation?.showCounters === false
    ? { days: "—", hours: "—", minutes: "—", seconds: "—" }
    : countdownConfig.getParts();
  const mainLogo = mainCruise ? await loadCruiseLineLogo(mainCruise.cruise_line) : "";
  const heroTitle = (() => {
    if (!mainCruise) return "My Cruise";
    const line = String(mainCruise.cruise_line || "").trim();
    const ship = String(mainCruise.ship_name || "").trim();
    if (!line) return ship;
    if (!ship) return line;
    return ship.toLowerCase().includes(line.toLowerCase()) ? ship : `${line} ${ship}`;
  })();
  const heroDateRange = mainCruise ? getCruiseDateRangeText(mainCruise, bookingPayload) : "";
  const cabinSummary = mainCruise ? getCabinSummary(mainCruise) : "";
  const dashboardMobilePriorityActive = dashboardActionCard.mode === "last_minute" || dashboardActionCard.mode === "last_minute_complete";

  app.innerHTML = `
    <div class="dashboard-page">
      ${mainCruise ? `
        <section class="dashboard-hero ${mainShipImage ? "has-image" : ""}${mainLogo ? " has-cruise-logo" : ""}" ${mainShipImage ? `style="background-image:url('${escapeHtml(mainShipImage)}')"` : ""}>
          <div class="dashboard-hero-overlay"></div>
          <img class="dashboard-brand-logo" src="assets/101cruise-logo.png" alt="101CRUISE">
          ${customerHeroAction}

          <div class="dashboard-hero-content">
            <p class="dashboard-hero-kicker">${escapeHtml(greetingText)}</p>
            <h1>${escapeHtml(heroTitle || "Your Cruise")}</h1>
            <p class="dashboard-hero-date">${escapeHtml(heroDateRange)}</p>
            <p class="dashboard-hero-route">${escapeHtml(routeText || routeLine || "Your upcoming cruise")}${cabinSummary ? ` · ${escapeHtml(cabinSummary)}` : ""}</p>
          </div>

          ${renderDashboardCountdownPanel(countdownConfig, countdownParts)}

          ${mainLogo ? `<img class="dashboard-cruise-line-logo" src="${escapeHtml(mainLogo)}" alt="${escapeHtml(mainCruise.cruise_line || "Cruise line")} logo">` : ""}
        </section>
      ` : `
        <section class="dashboard-empty-hero">
          <h1>My Cruise Planner</h1>
          <p>Welcome, ${escapeHtml(firstName)}. Add your cruise to activate your personal dashboard.</p>
          <button class="planner-button secondary" onclick="signOut()">Sign Out</button>
        </section>
      `}

      <div class="dashboard-content-wrap${dashboardMobilePriorityActive ? " dashboard-mobile-priority-active" : ""}">
        <section class="dashboard-welcome-strip dashboard-quick-access-strip">
          ${renderDashboardQuickAccess()}
          ${customerMode ? "" : renderCruiseSwitcher(safeCruises, mainCruise)}
        </section>

        <section class="dashboard-v2-grid">
          ${renderJourneySummary(mainCruise, { booking: bookingPayload, itineraryStops: textItinerary.stops || [] })}

          <div class="dashboard-v2-middle">
            ${renderDashboardCombinedProgress(packingData, checklistData)}
            ${renderDashboardActionCard(dashboardActionCard)}
          </div>

          ${mainCruise ? renderDashboardSnapshot(mainCruise) : ""}
        </section>

        ${renderShipGallerySection(shipGalleryImages, mainShipImage)}

        ${!mainCruise ? renderDashboardAddCruiseForm() : ""}
      </div>
    </div>
  `;

  if (mainCruise) {
    startLiveCountdown(mainCruise, countdownConfig);
  }
  bindJourneyItineraryToggle(textItinerary.stops || []);
  bindShipGalleryInteractions(shipGalleryImages);
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
    { key: "dashboard", label: "Dashboard", action: "navigateWithLoading('dashboard', () => renderDashboard(), event)" },
    { key: "booking", label: "Booking", action: "navigateWithLoading('booking', () => renderBookingDetails(), event)" },
    { key: "preparation", label: "Checklist", action: "navigateWithLoading('checklist', () => renderChecklist(), event)" },
    { key: "packing", label: "Pack List", action: "navigateWithLoading('packing', () => renderPackingPlanner(), event)" },
    { key: "budget", label: "Budget", action: "navigateWithLoading('budget', () => renderBudgetPlanner(), event)" },
    { key: "ship", label: "Your Ship", action: "navigateWithLoading('ship', () => renderTheShip(), event)" },
    { key: "documents", label: "Documents", action: "navigateWithLoading('documents', () => renderDocuments(), event)" }
  ];

  return `
    <div class="planner-page-header">
      <div class="planner-page-brand">
        <img class="planner-page-brand-logo" src="assets/101cruise-logo-black.png" alt="101cruise">
      </div>
      <div class="planner-module-nav">
        ${items.map(item => `
          <button class="planner-module-nav-button ${active === item.key ? "active" : ""}" onclick="${item.action}">${item.label}</button>
        `).join("")}
      </div>
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
  trackMyCruisePage("preparation");

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
              <section class="checklist-section-block" data-checklist-section="${section.id}">
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
  scheduleChecklistFocusFromDashboard();
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

function renderBookingFieldIfPresent(label, value, formatter = item => item) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const formatted = formatter(value);
  if (formatted === null || formatted === undefined || String(formatted).trim() === "") return "";
  return renderBookingDetailRow(label, formatted);
}

function getBookingPayloadValue(booking, cruise, keys) {
  for (const key of keys) {
    const bookingValue = booking?.[key];
    if (bookingValue !== null && bookingValue !== undefined && String(bookingValue).trim() !== "") return bookingValue;
    const cruiseValue = cruise?.[key];
    if (cruiseValue !== null && cruiseValue !== undefined && String(cruiseValue).trim() !== "") return cruiseValue;
  }
  return null;
}

async function resolveFullBookingPayload(cruise) {
  if (cruise?._preview_booking) return cruise._preview_booking;
  return getDashboardBookingSource(cruise);
}

function getBookingPassportMessage(cruise) {
  const booking = getDashboardBookingSource(cruise);
  const returnDate = booking.arriving_date || cruise?.return_date || cruise?.arrival_date;
  const threshold = returnDate ? new Date(returnDate) : null;
  if (threshold && !Number.isNaN(threshold.getTime())) threshold.setMonth(threshold.getMonth() + 6);

  const passengers = [1, 2].map(index => ({
    name: toDisplayName([booking[`passenger${index}_first_name`], booking[`passenger${index}_last_name`]].filter(Boolean).join(" ")),
    expiry: booking[`passenger${index}_passport_exp_date`]
  })).filter(passenger => passenger.expiry);

  if (!passengers.length || !threshold) {
    return { tone: "neutral", message: "Passport expiry dates have not yet been recorded." };
  }

  const warnings = passengers.filter(passenger => {
    const expiryDate = new Date(passenger.expiry);
    return Number.isNaN(expiryDate.getTime()) || expiryDate < threshold;
  });

  if (warnings.length) {
    const names = warnings.map(item => item.name || "Traveller").join(", ");
    return { tone: "warning", message: `${names} may need passport review before travel.` };
  }

  return { tone: "positive", message: "Your passports will remain valid for at least six months after your cruise." };
}

function renderBookingPassportStatus(cruise) {
  const status = getBookingPassportMessage(cruise);
  return `<p class="booking-passport-status booking-passport-status-${status.tone}">${escapeHtml(status.message)}</p>`;
}

const OPTIONAL_BOOKING_FIELDS = [
  ["Dining package", ["dining_package", "dining_plan", "dining_time", "dining", "dining_preference"]],
  ["Beverage package", ["beverage_package", "drinks_package", "beverage"]],
  ["WiFi", ["wifi", "wifi_package", "internet_package"]],
  ["Gratuities", ["gratuities", "gratuities_included", "gratuities_package"]],
  ["Shore excursions", ["shore_excursions", "included_shore_excursions", "shore_excursion_package"]],
  ["Deck", ["deck", "deck_number", "deck_name"]]
];

function renderBookingTravellerNames(cruise, booking) {
  const namesHtml = renderSnapshotTravellerNames(cruise, booking);
  if (!namesHtml) return renderStatusValue("Not added");
  return namesHtml;
}

function renderBookingCruiseSection(cruise, booking) {
  const embarkationPort = getBookingPayloadValue(booking, cruise, ["departing_port", "embarkation_port", "departure_port", "from_port", "departure_city"]) || "";
  const disembarkationPort = getBookingPayloadValue(booking, cruise, ["arriving_port", "disembarkation_port", "arrival_port", "to_port", "destination"]) || "";
  const departureDate = booking.departing_date || cruise?.departure_date;
  const returnDate = booking.arriving_date || cruise?.return_date || cruise?.arrival_date;
  const embarkation = formatPortDateTime(embarkationPort, departureDate, cruise?.departure_time);
  const disembarkation = formatPortDateTime(disembarkationPort, returnDate, cruise?.arrival_time);
  const cabin = getBookingPayloadValue(booking, cruise, ["room_number", "cabin_number", "cabin", "stateroom", "suite"]);
  const roomType = getBookingPayloadValue(booking, cruise, ["room_type", "cabin_type", "stateroom_type", "suite_type"]);
  const category = getBookingPayloadValue(booking, cruise, ["category_class"]);
  const travellerCount = booking.total_passengers || cruise?.traveller_count;
  const duration = booking.cruise_duration || cruise?.nights;
  const bookingReference = booking.booking_reference || getCruiseBookingReference(cruise);
  const bookingStatus = booking.booking_status || cruise?.booking_status;
  const financialRowsHtml = renderSharedFinancialRows(cruise, booking, (label, value) =>
    renderBookingDetailRow(label, value)
  );
  const optionalRows = OPTIONAL_BOOKING_FIELDS.map(([label, keys]) => renderBookingFieldIfPresent(label, getBookingPayloadValue(booking, cruise, keys))).join("");

  return `
    <section class="planner-card section-spaced">
      <h3>Cruise Booking</h3>
      <div class="dashboard-snapshot-list">
        ${renderBookingDetailRow("Cruise line", booking.cruise_line || cruise?.cruise_line)}
        ${renderBookingDetailRow("Ship", booking.cruise_ship || cruise?.ship_name)}
        ${renderBookingDetailRow("Booking reference", bookingReference)}
        <div class="dashboard-snapshot-row dashboard-snapshot-row-travellers"><span>Travellers</span>${renderBookingTravellerNames(cruise, booking)}</div>
        ${renderBookingDetailRow("Traveller count", travellerCount || getPassengerCountFromBase44Booking(booking))}
        ${renderBookingDetailRow("Cabin number", cabin)}
        ${renderBookingDetailRow("Room type", roomType)}
        ${renderBookingDetailRow("Category", category)}
        ${renderBookingDetailRow("Duration", duration ? `${duration} nights` : null)}
        ${renderBookingDetailRow("Departure date", departureDate ? formatDate(departureDate) : null)}
        ${renderBookingDetailRow("Return date", returnDate ? formatDate(returnDate) : null)}
        ${renderBookingDetailRow("Embarkation port", embarkation)}
        ${renderBookingDetailRow("Disembarkation port", disembarkation)}
        ${renderBookingDetailRow("Booking status", bookingStatus)}
        ${financialRowsHtml}
        ${optionalRows}
      </div>
      ${renderBookingPassportStatus(cruise)}
      <section class="dashboard-snapshot-extras booking-snapshot-extras">
        <h4 class="dashboard-snapshot-extras-title">Included extras</h4>
        ${renderDashboardInclusionTags(cruise)}
      </section>
    </section>
  `;
}

function renderBookingTravelPlanCategory(category, title, emptyMessage, budget) {
  const items = (budget?.items || []).filter(item => item.category === category);
  const editAction = `<button class="dashboard-outline-action booking-compact-action booking-inline-action" onclick="renderBudgetPlanner()">Edit in Budget →</button>`;
  const blockClass = category === "flights"
    ? "booking-travel-plan-block booking-travel-plan-block-flights"
    : "booking-travel-plan-block";

  if (!items.length) {
    return `
      <div class="${blockClass}">
        <h4>${escapeHtml(title)}</h4>
        <p class="planner-muted">${escapeHtml(emptyMessage)}</p>
        ${editAction}
      </div>
    `;
  }

  return `
    <div class="${blockClass}">
      <h4>${escapeHtml(title)}</h4>
      <div class="booking-travel-plan-list">
        ${items.map(item => {
          const parts = getBudgetItemParts(item);
          return `<div class="booking-travel-plan-item"><strong>${escapeHtml(parts.primary)}</strong>${parts.meta ? `<span>${escapeHtml(parts.meta)}</span>` : ""}</div>`;
        }).join("")}
      </div>
    </div>
  `;
}

function renderBookingTravelPlansSection(budget) {
  return `
    <section class="planner-card section-spaced">
      <div class="booking-travel-plans-header">
        <div class="booking-travel-plans-heading">
          <div class="booking-travel-plans-title-row">
            <h3>Travel Plans</h3>
            <button class="dashboard-outline-action booking-compact-action" onclick="renderBudgetPlanner()">Edit in Budget →</button>
          </div>
          <p class="planner-muted">Your travel plans below are automatically summarised from the information you've entered in Budget. Any changes made in Budget will automatically appear here.</p>
        </div>
      </div>
      <div class="booking-travel-plans-grid">
        ${renderBookingTravelPlanCategory("flights", "Flights", "No flights have been added yet.", budget)}
        ${renderBookingTravelPlanCategory("accommodation", "Accommodation", "No accommodation has been added yet.", budget)}
        ${renderBookingTravelPlanCategory("cars", "Car Hire", "No car hire has been added yet.", budget)}
      </div>
    </section>
  `;
}

function parseInsuranceDetails(raw) {
  const defaults = { provider: "", policy_number: "", emergency_phone: "", emergency_contact: "" };
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        provider: parsed.provider || "",
        policy_number: parsed.policy_number || "",
        emergency_phone: parsed.emergency_phone || "",
        emergency_contact: parsed.emergency_contact || ""
      };
    }
  } catch {
    // Legacy free-text insurance notes.
  }

  return { ...defaults, provider: String(raw) };
}

function serializeInsuranceDetails(details) {
  return JSON.stringify({
    provider: String(details.provider || "").trim(),
    policy_number: String(details.policy_number || "").trim(),
    emergency_phone: String(details.emergency_phone || "").trim(),
    emergency_contact: String(details.emergency_contact || "").trim()
  });
}

function renderBookingInsuranceField(id, label, value, placeholder = "") {
  return `
    <div class="planner-field">
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(id)}" type="text" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}">
    </div>
  `;
}

function renderBookingInsuranceSection(insurance) {
  return `
    <section class="planner-card section-spaced">
      <h3>Travel Insurance</h3>
      <div class="planner-grid booking-insurance-grid">
        ${renderBookingInsuranceField("bookingInsuranceProvider", "Insurance Provider", insurance.provider, "Example: Cover-More")}
        ${renderBookingInsuranceField("bookingInsurancePolicyNumber", "Policy Number", insurance.policy_number, "Example: POL-123456")}
        ${renderBookingInsuranceField("bookingInsuranceEmergencyPhone", "Emergency Assistance Phone", insurance.emergency_phone, "Example: +61 1300 000 000")}
        ${renderBookingInsuranceField("bookingInsuranceEmergencyContact", "Emergency Contact", insurance.emergency_contact, "Example: Partner name and number")}
      </div>
      <p class="planner-muted booking-insurance-reminder">Store your travel insurance policy in your Documents Library so it's easy to access while travelling.</p>
      <div class="booking-insurance-actions">
        <button class="planner-button secondary" onclick="openDocumentUpload('Travel Insurance')">Upload Insurance Policy</button>
        <button class="planner-button secondary" onclick="renderDocuments()">View Documents</button>
        <button class="planner-button" onclick="saveUserBookingDetails()">Save Insurance Details</button>
      </div>
      <div id="booking-details-message" class="planner-message"></div>
    </section>
  `;
}

async function renderBookingDetails() {
  clearCountdownTimer();
  trackMyCruisePage("booking");

  const cruise = await loadCurrentCruise();

  if (!cruise) {
    app.innerHTML = `
      <div class="planner-card">
        <button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button>
        <h2>Booking</h2>
        <p>Add a cruise before viewing your booking summary.</p>
      </div>
    `;
    return;
  }

  await resolveFullBookingPayload(cruise);
  const [bookingDetails, budget] = await Promise.all([
    loadUserBookingDetails(cruise),
    loadBudget(cruise)
  ]);
  const insurance = parseInsuranceDetails(bookingDetails?.insurance_details);

  app.innerHTML = `
    <div class="planner-shell">
      ${renderPlannerNav("booking")}

      <div class="booking-reading-column">
        <div class="planner-card slim-card">
          <button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button>
          <h2>Booking</h2>
          <p class="planner-muted">Your cruise booking, travel plans, insurance and documents in one place.</p>
        </div>

        ${renderBookingCruiseSection(cruise, getDashboardBookingSource(cruise))}
        ${renderBookingTravelPlansSection(budget)}
        ${renderBookingInsuranceSection(insurance)}

        <section class="planner-card section-spaced booking-documents-prompt">
          <div>
            <h3>Documents</h3>
            <p class="planner-muted">Keep your booking confirmation, travel insurance, tickets and other important travel documents together in your secure Documents Library.</p>
          </div>
          <div class="booking-insurance-actions">
            <button class="planner-button secondary" onclick="renderDocuments()">View Documents</button>
          </div>
        </section>
      </div>
    </div>
  `;
}


const CUSTOMER_DOCUMENT_TYPES = [
  "Travel Insurance",
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

const DOCUMENT_TYPE_ORDER = [
  "booking confirmation",
  "invoice",
  "final invoice",
  "travel insurance",
  "insurance policy",
  "flight itinerary",
  "flight confirmation",
  "accommodation",
  "hotel confirmation",
  "transfers",
  "luggage tags",
  "boarding pass",
  "electronic ticket / boarding pass",
  "shore excursions",
  "shore excursion ticket",
  "visa",
  "visa / entry information",
  "entry information"
];

function normaliseDocumentType(value) {
  return String(value || "Other").trim() || "Other";
}

function documentOutlineIcon(kind) {
  const icons = {
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    plane: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13l7-1 3-7 2 1-2 6 6 2-1 2-7-1-3 5H6l2-5-5-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v9H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 20v-6h4v6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    ticket: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l6 2 5-2v16l-5 2-6-2-5 2V6l5-2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 4v16M15 6v16" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    id: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 10h4M14 14h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
  };
  return icons[kind] || icons.file;
}

function getDocumentIcon(document) {
  const type = normaliseDocumentType(document.document_type).toLowerCase();
  if (type.includes("insurance")) return documentOutlineIcon("shield");
  if (type.includes("flight")) return documentOutlineIcon("plane");
  if (type.includes("hotel") || type.includes("accommodation")) return documentOutlineIcon("home");
  if (type.includes("boarding") || type.includes("ticket") || type.includes("luggage")) return documentOutlineIcon("ticket");
  if (type.includes("shore") || type.includes("transfer")) return documentOutlineIcon("map");
  if (type.includes("visa") || type.includes("passport") || type.includes("entry")) return documentOutlineIcon("id");
  return documentOutlineIcon("file");
}

function formatDocumentDate(value) {
  if (!value) return "Date not supplied";
  const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function getDocumentPriority(document) {
  const type = normaliseDocumentType(document.document_type).toLowerCase();
  const exact = DOCUMENT_TYPE_ORDER.indexOf(type);
  if (exact >= 0) return exact;
  for (let i = 0; i < DOCUMENT_TYPE_ORDER.length; i += 1) {
    if (type.includes(DOCUMENT_TYPE_ORDER[i]) || DOCUMENT_TYPE_ORDER[i].includes(type)) return i;
  }
  return DOCUMENT_TYPE_ORDER.length + 1;
}

function sortDocuments(documents) {
  return [...documents].sort((a, b) => {
    const priority = getDocumentPriority(a) - getDocumentPriority(b);
    if (priority) return priority;
    return new Date(b.uploaded_date || b.uploaded_at || 0) - new Date(a.uploaded_date || a.uploaded_at || 0);
  });
}

function isDocumentVisibleToCustomer(document) {
  if (document.document_visible_to_customer === false) return false;
  if (document.visible_to_customer === false || document.visible_to_client === false) return false;
  return true;
}

function customerFacingNote(document) {
  if (document.note_visible_to_customer === false || document.notes_visible_to_customer === false) return "";
  return String(document.note || document.notes || "").trim();
}

function openDocument(url) {
  if (!url) {
    alert("This document file is temporarily unavailable. Please try again later or contact 101cruise.");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function downloadDocument(url, filename) {
  if (!url) {
    alert("This document file is temporarily unavailable. Please try again later or contact 101cruise.");
    return;
  }
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
  if (!url) {
    alert("This document file is temporarily unavailable. Please try again later or contact 101cruise.");
    return;
  }
  const printWindow = window.open(url, "_blank", "noopener,noreferrer");
  if (!printWindow) alert("Your browser blocked the document window. Please use Open and print from the new tab.");
}

function renderDocumentCard(document) {
  const source = document.source === "customer" ? "You" : "101cruise";
  const primary = normaliseDocumentType(document.document_type).toLowerCase() === "booking confirmation";
  const note = customerFacingNote(document);
  const fileUrl = document.file_unavailable ? "" : (document.file_url || "");
  const encodedUrl = encodeURIComponent(fileUrl);
  const encodedFilename = encodeURIComponent(document.filename || "travel-document");
  return `
    <article class="document-card document-row ${primary ? "document-card-primary" : ""}">
      <div class="document-card-icon" aria-hidden="true">${getDocumentIcon(document)}</div>
      <div class="document-card-content">
        <div class="document-card-heading">
          <div>
            ${primary ? '<span class="document-primary-badge">Primary travel document</span>' : ""}
            <h3>${escapeHtml(normaliseDocumentType(document.document_type))}</h3>
            ${note ? `<p class="document-notes">${escapeHtml(note)}</p>` : ""}
          </div>
          <span class="document-source-badge">${escapeHtml(source)}</span>
        </div>
        <p class="document-filename">${escapeHtml(document.filename || "Travel document")}</p>
        <p class="document-meta">Added ${escapeHtml(formatDocumentDate(document.uploaded_date || document.uploaded_at))}</p>
        ${document.file_unavailable || !fileUrl ? `<p class="document-unavailable">This file is temporarily unavailable. Please try again later.</p>` : ""}
        <div class="document-actions">
          <button class="planner-button secondary" onclick="openDocument(decodeURIComponent('${encodedUrl}'))">Open</button>
          <button class="planner-button secondary" onclick="downloadDocument(decodeURIComponent('${encodedUrl}'), decodeURIComponent('${encodedFilename}'))">Download</button>
          <button class="planner-button secondary" onclick="printDocument(decodeURIComponent('${encodedUrl}'))">Print</button>
          ${document.source === "customer" ? `<button class="document-delete-button" onclick="deleteCustomerDocument('${escapeHtml(document.id)}')">Delete</button>` : ""}
        </div>
      </div>
    </article>`;
}

async function listBookingLibraryDocuments() {
  if (!customerMode || !customerSessionToken) return [];
  try {
    const response = await fetch("/.netlify/functions/booking-documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerSessionToken}`
      },
      body: JSON.stringify({ action: "list" })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) return [];
    return (data.documents || []).map((document) => ({
      ...document,
      source: document.source_system === "customer" ? "customer" : "booking",
      notes: document.note || document.notes || ""
    }));
  } catch (_error) {
    return [];
  }
}

function fallbackBookingDocumentsFromPayload() {
  const raw = customerBooking?._preview_booking?.documents
    || customerBooking?.documents
    || [];
  return raw
    .filter(isDocumentVisibleToCustomer)
    .map((document, index) => ({
      ...document,
      id: document.id || `payload-${index}`,
      source: "booking",
      note: customerFacingNote(document),
      notes: customerFacingNote(document)
    }));
}

async function renderDocuments() {
  clearCountdownTimer();
  trackMyCruisePage("documents");
  const cruise = await loadCurrentCruise();
  app.innerHTML = `
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
  scheduleScrollPlannerToTop();

  try {
    let libraryDocuments = await listBookingLibraryDocuments();
    if (!libraryDocuments.length) {
      libraryDocuments = fallbackBookingDocumentsFromPayload();
    } else {
      libraryDocuments = libraryDocuments.filter(isDocumentVisibleToCustomer);
    }

    let customerDocuments = [];
    if (customerMode) {
      const data = await customerDocumentsRequest("list");
      customerDocuments = (data.documents || []).map(document => ({ ...document, source: "customer" }));
    }
    const documents = sortDocuments([...libraryDocuments, ...customerDocuments]);
    const list = document.getElementById("documents-list");
    if (!documents.length) {
      list.innerHTML = `<div class="planner-card documents-empty"><div class="documents-empty-icon" aria-hidden="true">${documentOutlineIcon("file")}</div><h3>No documents are available yet</h3><p class="planner-muted">When your 101cruise consultant shares booking documents with you, they will appear here. You can also upload your own insurance, flight or travel documents.</p></div>`;
      return;
    }
    list.innerHTML = `<div class="documents-count">${documents.length} ${documents.length === 1 ? "document" : "documents"}</div>${documents.map(renderDocumentCard).join("")}`;
  } catch (error) {
    console.error("Documents load error", error);
    const list = document.getElementById("documents-list");
    if (list) list.innerHTML = `<div class="planner-card documents-empty"><h3>Documents could not be loaded</h3><p class="planner-muted">${escapeHtml(error.message || "Please try again.")}</p><button class="planner-button secondary" onclick="renderDocuments()">Try Again</button></div>`;
  }
}

function openDocumentUpload(presetType = "") {
  const selectedType = CUSTOMER_DOCUMENT_TYPES.includes(presetType) ? presetType : CUSTOMER_DOCUMENT_TYPES[0];
  const modal = document.createElement("div");
  modal.className = "document-upload-overlay";
  modal.id = "documentUploadOverlay";
  modal.innerHTML = `
    <section class="document-upload-modal planner-card" role="dialog" aria-modal="true" aria-labelledby="documentUploadTitle">
      <div class="document-upload-heading"><div><p class="planner-kicker">My Documents</p><h2 id="documentUploadTitle">Upload a document</h2></div><button class="document-modal-close" onclick="closeDocumentUpload()" aria-label="Close">×</button></div>
      <div class="planner-field"><label for="customerDocumentType">Document type</label><select id="customerDocumentType">${CUSTOMER_DOCUMENT_TYPES.map(type => `<option${type === selectedType ? " selected" : ""}>${escapeHtml(type)}</option>`).join("")}</select></div>
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
    trackMyCruiseEvent("documents", "document_upload");
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
    if (message) message.innerText = "Please add a cruise before saving insurance details.";
    return;
  }

  if (!currentUser?.id) {
    if (message) message.innerText = "Sign in to save insurance details.";
    return;
  }

  const existing = await loadUserBookingDetails(cruise);
  const insuranceDetails = serializeInsuranceDetails({
    provider: document.getElementById("bookingInsuranceProvider")?.value || "",
    policy_number: document.getElementById("bookingInsurancePolicyNumber")?.value || "",
    emergency_phone: document.getElementById("bookingInsuranceEmergencyPhone")?.value || "",
    emergency_contact: document.getElementById("bookingInsuranceEmergencyContact")?.value || ""
  });

  const payload = {
    user_id: currentUser.id,
    cruise_id: cruise.id,
    flight_details: existing?.flight_details || null,
    hotel_details: existing?.hotel_details || null,
    transfer_details: existing?.transfer_details || null,
    insurance_details: insuranceDetails,
    notes: existing?.notes || null,
    updated_at: new Date().toISOString()
  };

  if (message) message.innerText = "Saving...";

  const { error } = await supabaseClient
    .from("user_booking_details")
    .upsert(payload, { onConflict: "user_id,cruise_id" });

  if (error) {
    console.error("Booking details save error", error);
    if (message) message.innerText = "Could not save insurance details. Please try again.";
    return;
  }

  if (message) message.innerText = "Insurance details saved.";
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
let packingPlannerItemData = null;

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
  if (!currentUser?.id) {
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

function isCabinEssentialsCategory(categoryName) {
  return String(categoryName || "").trim().toLowerCase() === "cabin essentials";
}

function packingCabinEssentialsShowsWeight(categoryName, profile = getActivePackingProfile()) {
  return profile?.profile_type === "cabin" && isCabinEssentialsCategory(categoryName);
}

function getCabinEssentialsUnitWeight(item) {
  const weight = Number(item?.weight_kg);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function getCabinEssentialsEffectiveQuantity(packed, quantity) {
  const qty = Math.max(0, Math.round(Number(quantity ?? 0)));
  if (qty > 0) return qty;
  return packed ? 1 : 0;
}

function getCabinEssentialsSelectedWeight(item, packed, quantity) {
  const unitWeight = getCabinEssentialsUnitWeight(item);
  if (!unitWeight) return 0;
  return unitWeight * getCabinEssentialsEffectiveQuantity(packed, quantity);
}

function calculateTotalCabinEssentialsWeight(items, context, cabinProfile) {
  if (!cabinProfile) return 0;
  let total = 0;
  (items || []).filter(item => packingItemApplies(item, context)).forEach(item => {
    const categoryName = item.packing_categories?.name || "";
    if (!isCabinEssentialsCategory(categoryName)) return;
    const state = getPackingState(`system:${item.id}`, cabinProfile.profile_key);
    total += getCabinEssentialsSelectedWeight(item, state?.packed === true, state?.quantity ?? 0);
  });
  return total;
}

function getTravellerCheckedAllowance(profile) {
  const value = profile?.checked_baggage_allowance_kg;
  if (value === null || value === undefined || value === "") return null;
  const limit = Number(value);
  return Number.isFinite(limit) && limit >= 0 ? limit : null;
}

function getPackingAllowancePercent(used, limit) {
  if (limit === null || limit <= 0) return 0;
  return Math.max(0, Math.round((Number(used || 0) / limit) * 100));
}

function buildTravellerPackingItems(travellerProfile) {
  const data = packingPlannerItemData;
  if (!data || !travellerProfile) return [];
  return [...(data.systemItems || []), ...(data.personalItems || [])].filter(item => {
    const categoryName = item.packing_categories?.name || data.categoryNameById?.get(String(item.category_id)) || "";
    return packingItemBelongsToProfile(item, categoryName, travellerProfile);
  });
}

function calculateTravellerPackingWeightBreakdown(travellerProfile) {
  const summary = { checked: 0, carryOn: 0, wearing: 0 };
  buildTravellerPackingItems(travellerProfile).forEach(item => {
    const categoryName = item.packing_categories?.name || packingPlannerItemData?.categoryNameById?.get(String(item.category_id)) || "";
    const state = getPackingState(getPackingItemKey(item), travellerProfile.profile_key);
    if (!packingCategoryUsesQuantityAndWeight(categoryName, travellerProfile)) return;
    const quantity = Math.max(0, Number(state?.quantity ?? 0));
    if (quantity <= 0) return;
    const weight = Number(item.weight_kg || 0) * quantity;
    const location = state?.packing_location || "checked";
    if (location === "carry-on") summary.carryOn += weight;
    else if (location === "wearing") summary.wearing += weight;
    else summary.checked += weight;
  });
  return summary;
}

function buildCabinBaggageSummaries(cabinEssentialsWeight, travellerProfiles) {
  const travellerCount = travellerProfiles.length;
  const cabinShare = travellerCount ? cabinEssentialsWeight / travellerCount : 0;
  const travellers = travellerProfiles.map(profile => {
    const breakdown = calculateTravellerPackingWeightBreakdown(profile);
    const allowance = getTravellerCheckedAllowance(profile);
    const packingChecked = breakdown.checked;
    const totalChecked = packingChecked + cabinShare;
    const percent = getPackingAllowancePercent(totalChecked, allowance);
    const remaining = allowance === null ? null : allowance - totalChecked;
    const isOver = allowance !== null && totalChecked > allowance;
    return { profile, packingChecked, cabinShare, totalChecked, allowance, percent, remaining, isOver };
  });
  const combinedPacking = travellers.reduce((sum, traveller) => sum + traveller.packingChecked, 0);
  const combinedTotal = combinedPacking + cabinEssentialsWeight;
  const allowances = travellers.map(traveller => traveller.allowance).filter(value => value !== null);
  const combinedAllowance = allowances.length ? allowances.reduce((sum, value) => sum + value, 0) : null;
  const combinedPercent = getPackingAllowancePercent(combinedTotal, combinedAllowance);
  const combinedRemaining = combinedAllowance === null ? null : combinedAllowance - combinedTotal;
  const combinedIsOver = combinedAllowance !== null && combinedTotal > combinedAllowance;
  return {
    cabinShare,
    travellers,
    combined: {
      packingChecked: combinedPacking,
      cabinEssentialsWeight,
      total: combinedTotal,
      allowance: combinedAllowance,
      percent: combinedPercent,
      remaining: combinedRemaining,
      isOver: combinedIsOver
    }
  };
}

function renderPackingAllowanceDonut(id, percent, sublabel, { isOver = false, hasNoAllowance = false, mini = false } = {}) {
  const rawPercent = Math.max(0, Math.round(Number(percent) || 0));
  const ringPercent = Math.min(100, rawPercent);
  return `<div id="${id}" class="packing-weight-donut ${mini ? "packing-weight-donut-mini" : ""} ${isOver ? "is-over" : ""} ${hasNoAllowance ? "has-no-allowance" : ""}" style="--packing-weight-percent:${ringPercent * 3.6}deg">
    <div class="packing-weight-donut-centre">
      <strong data-donut-percent>${hasNoAllowance ? "—" : `${rawPercent}%`}</strong>
      ${sublabel ? `<span data-donut-label>${escapeHtml(hasNoAllowance ? "Enter allowance" : sublabel)}</span>` : ""}
    </div>
  </div>`;
}

function updatePackingAllowanceDonut(id, percent, sublabel, { isOver = false, hasNoAllowance = false } = {}) {
  const donut = document.getElementById(id);
  if (!donut) return;
  const rawPercent = Math.max(0, Math.round(Number(percent) || 0));
  const ringPercent = Math.min(100, rawPercent);
  donut.style.setProperty("--packing-weight-percent", `${ringPercent * 3.6}deg`);
  donut.classList.toggle("is-over", isOver);
  donut.classList.toggle("has-no-allowance", hasNoAllowance);
  const percentNode = donut.querySelector("[data-donut-percent]");
  const labelNode = donut.querySelector("[data-donut-label]");
  if (percentNode) percentNode.textContent = hasNoAllowance ? "—" : `${rawPercent}%`;
  if (labelNode && sublabel) labelNode.textContent = hasNoAllowance ? "Enter allowance" : sublabel;
}

function isCabinEssentialsItemSelected(packed, quantity) {
  return packed === true || Math.max(0, Number(quantity ?? 0)) > 0;
}

function countCabinEssentialsProgress(items, profileKey, categoryNameById) {
  let selected = 0;
  let total = 0;
  (items || []).forEach(item => {
    const categoryName = item.packing_categories?.name || categoryNameById?.get(String(item.category_id)) || "";
    if (!isCabinEssentialsCategory(categoryName)) return;
    total += 1;
    const state = getPackingState(getPackingItemKey(item), profileKey);
    if (isCabinEssentialsItemSelected(state?.packed === true, state?.quantity ?? 0)) selected += 1;
  });
  return { selected, total };
}

function getTravellerSidebarMeta(profile, travellerNames = []) {
  const index = Number(profile?.display_order ?? 0);
  const fullName = travellerNames[index] || profile.profile_name;
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2
    ? `${parts[0][0] || ""}${parts[parts.length - 1][0] || ""}`.toUpperCase()
    : String(profile.profile_name || "TR").slice(0, 2).toUpperCase();
  const firstName = parts[0] || profile.profile_name;
  return { displayName: `${firstName} (${initials})`, initials };
}

function formatPackingWeightRatio(weightKg) {
  const value = Math.max(0, Number(weightKg || 0));
  if (value > 0 && value < 1) return `${Math.round(value * 1000)} g`;
  return `${value.toFixed(1)} kg`;
}

function renderCabinCategoryProgress(selected, total, percent) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="cabin-category-progress">
    <span id="cabinCategorySelectedCount">${selected} of ${total} items selected</span>
    ${renderPackingAllowanceDonut("cabinCategoryDonut", safePercent, "", { mini: true })}
  </div>`;
}

function renderCabinChecklistProgress(percent, selected, total) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<section class="cabin-summary-card cabin-checklist-progress-card">
    <h3 class="cabin-summary-card-title">Cabin checklist progress</h3>
    <p id="cabinChecklistDetail" class="cabin-checklist-detail">${selected} of ${total} items selected</p>
    ${renderPackingAllowanceDonut("cabinChecklistDonut", safePercent, "Complete")}
  </section>`;
}

function updateCabinChecklistProgress(percent, selected, total) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  updatePackingAllowanceDonut("cabinChecklistDonut", safePercent, "Complete");
  const detail = document.getElementById("cabinChecklistDetail");
  if (detail) detail.textContent = `${selected} of ${total} items selected`;
  const categoryCount = document.getElementById("cabinCategorySelectedCount");
  if (categoryCount) categoryCount.textContent = `${selected} of ${total} items selected`;
  updatePackingAllowanceDonut("cabinCategoryDonut", safePercent, "", { isOver: false, hasNoAllowance: false });
}

function renderCabinWeightSummaryCard(cabinEssentialsWeight, travellerCount, cabinShare) {
  return `<section class="cabin-summary-card">
    <h3 class="cabin-summary-card-title">Cabin Essentials weight</h3>
    <dl class="cabin-summary-metrics">
      <div><dt>Total selected weight</dt><dd id="cabinEssentialsWeightTotal">${formatPackingWeight(cabinEssentialsWeight)}</dd></div>
      <div><dt>Travellers</dt><dd id="cabinEssentialsTravellerCount">${travellerCount}</dd></div>
      <div><dt>Allocated per traveller</dt><dd id="cabinEssentialsAllocatedPerTraveller">${formatPackingWeight(cabinShare)}</dd></div>
      <div class="cabin-auto-distributed-row"><dt>Automatically distributed</dt><dd><span class="cabin-auto-distributed-value" id="cabinEssentialsAutoDistributed">${formatPackingWeight(cabinShare)} each</span><span class="cabin-info-icon" title="Cabin Essentials weight is shared equally across all travellers.">ⓘ</span></dd></div>
    </dl>
  </section>`;
}

function renderCabinTravellerWeightCard(travellerSummary, travellerNames = []) {
  const { profile, totalChecked, allowance, percent, isOver } = travellerSummary;
  const hasNoAllowance = allowance === null;
  const meta = getTravellerSidebarMeta(profile, travellerNames);
  const donutId = `cabinTravellerDonut-${profile.profile_key}`;
  const ratioText = hasNoAllowance
    ? `${formatPackingWeightRatio(totalChecked)} / —`
    : `${formatPackingWeightRatio(totalChecked)} / ${allowance.toFixed(1)} kg`;
  return `<article class="cabin-traveller-row" data-traveller-summary="${escapeHtml(profile.profile_key)}">
    <div class="cabin-traveller-identity">
      <span class="cabin-traveller-avatar" aria-hidden="true">${escapeHtml(meta.initials)}</span>
      <div class="cabin-traveller-copy">
        <strong>${escapeHtml(meta.displayName)}</strong>
        <span data-traveller-allowance-label="${escapeHtml(profile.profile_key)}">${hasNoAllowance ? "Checked baggage allowance: Not entered" : `Checked baggage allowance: ${allowance.toFixed(1)} kg`}</span>
      </div>
    </div>
    <div class="cabin-traveller-weight-display">
      <span class="cabin-traveller-ratio" data-traveller-ratio="${escapeHtml(profile.profile_key)}">${ratioText}</span>
      ${renderPackingAllowanceDonut(donutId, percent, "", { isOver, hasNoAllowance, mini: true })}
    </div>
  </article>`;
}

function renderCabinCombinedWeightSummary(combinedSummary) {
  const { total, allowance, percent, remaining, isOver } = combinedSummary;
  const hasNoAllowance = allowance === null;
  const remainingClass = isOver ? "is-over" : "is-positive";
  return `<section class="cabin-summary-card cabin-combined-summary-card">
    <h3 class="cabin-summary-card-title">Combined weight summary</h3>
    <div class="cabin-combined-layout">
      <dl class="cabin-summary-metrics">
        <div><dt>Combined checked allowance</dt><dd id="cabinCombinedAllowance">${hasNoAllowance ? "Not entered" : `${allowance.toFixed(1)} kg`}</dd></div>
        <div><dt>Combined current weight</dt><dd id="cabinCombinedTotalWeight">${formatPackingWeightRatio(total)}</dd></div>
        <div><dt>Remaining allowance</dt><dd id="cabinCombinedRemaining" class="${remainingClass}">${hasNoAllowance ? "—" : (remaining >= 0 ? `${remaining.toFixed(1)} kg` : `Over by ${Math.abs(remaining).toFixed(1)} kg`)}</dd></div>
      </dl>
      ${renderPackingAllowanceDonut("cabinCombinedDonut", percent, "of allowance used", { isOver, hasNoAllowance })}
    </div>
  </section>`;
}

function renderCabinPackingSummary(cabinEssentialsWeight, travellerProfiles, essentialsPercent, essentialsSelected, essentialsTotal, travellerNames = []) {
  const baggageSummaries = buildCabinBaggageSummaries(cabinEssentialsWeight, travellerProfiles);
  return `
    ${renderCabinChecklistProgress(essentialsPercent, essentialsSelected, essentialsTotal)}
    ${renderCabinWeightSummaryCard(cabinEssentialsWeight, travellerProfiles.length, baggageSummaries.cabinShare)}
    <section class="cabin-summary-card">
      <h3 class="cabin-summary-card-title">Individual traveller weight (including cabin share)</h3>
      <div class="cabin-traveller-list">
        ${baggageSummaries.travellers.length ? baggageSummaries.travellers.map(traveller => renderCabinTravellerWeightCard(traveller, travellerNames)).join("") : `<p class="cabin-traveller-empty">Add travellers to see individual baggage summaries.</p>`}
      </div>
    </section>
    ${renderCabinCombinedWeightSummary(baggageSummaries.combined)}
  `;
}

function updateCabinPackingSummaries(cabinEssentialsWeight, essentialsSelected, essentialsTotal) {
  const travellerProfiles = packingV2Profiles.filter(item => item.profile_type === "traveller");
  const essentialsPercent = getProgressPercent(essentialsSelected, essentialsTotal);
  const baggageSummaries = buildCabinBaggageSummaries(cabinEssentialsWeight, travellerProfiles);
  packingCabinSharePerTraveller = baggageSummaries.cabinShare;
  updateCabinChecklistProgress(essentialsPercent, essentialsSelected, essentialsTotal);
  const totalNode = document.getElementById("cabinEssentialsWeightTotal");
  if (totalNode) totalNode.textContent = formatPackingWeight(cabinEssentialsWeight);
  const travellerCountNode = document.getElementById("cabinEssentialsTravellerCount");
  if (travellerCountNode) travellerCountNode.textContent = String(travellerProfiles.length);
  const allocatedNode = document.getElementById("cabinEssentialsAllocatedPerTraveller");
  if (allocatedNode) allocatedNode.textContent = formatPackingWeight(baggageSummaries.cabinShare);
  const autoDistributedNode = document.getElementById("cabinEssentialsAutoDistributed");
  if (autoDistributedNode) autoDistributedNode.textContent = `${formatPackingWeight(baggageSummaries.cabinShare)} each`;
  baggageSummaries.travellers.forEach(traveller => {
    const { profile, totalChecked, allowance, percent, isOver } = traveller;
    const hasNoAllowance = allowance === null;
    updatePackingAllowanceDonut(`cabinTravellerDonut-${profile.profile_key}`, percent, "", { isOver, hasNoAllowance });
    const ratioNode = document.querySelector(`[data-traveller-ratio="${CSS.escape(profile.profile_key)}"]`);
    if (ratioNode) {
      ratioNode.textContent = hasNoAllowance
        ? `${formatPackingWeightRatio(totalChecked)} / —`
        : `${formatPackingWeightRatio(totalChecked)} / ${allowance.toFixed(1)} kg`;
    }
    const allowanceLabel = document.querySelector(`[data-traveller-allowance-label="${CSS.escape(profile.profile_key)}"]`);
    if (allowanceLabel) {
      allowanceLabel.textContent = hasNoAllowance
        ? "Checked baggage allowance: Not entered"
        : `Checked baggage allowance: ${allowance.toFixed(1)} kg`;
    }
  });
  const { combined } = baggageSummaries;
  const combinedHasNoAllowance = combined.allowance === null;
  updatePackingAllowanceDonut("cabinCombinedDonut", combined.percent, "of allowance used", { isOver: combined.isOver, hasNoAllowance: combinedHasNoAllowance });
  const setCombinedText = (id, text) => { const node = document.getElementById(id); if (node) node.textContent = text; };
  setCombinedText("cabinCombinedTotalWeight", formatPackingWeightRatio(combined.total));
  setCombinedText("cabinCombinedAllowance", combinedHasNoAllowance ? "Not entered" : `${combined.allowance.toFixed(1)} kg`);
  const combinedRemainingNode = document.getElementById("cabinCombinedRemaining");
  if (combinedRemainingNode) {
    combinedRemainingNode.textContent = combinedHasNoAllowance ? "—" : (combined.remaining >= 0 ? `${combined.remaining.toFixed(1)} kg` : `Over by ${Math.abs(combined.remaining).toFixed(1)} kg`);
    combinedRemainingNode.classList.toggle("is-over", combined.isOver);
    combinedRemainingNode.classList.toggle("is-positive", !combined.isOver && !combinedHasNoAllowance);
  }
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
  const showsCabinEssentialsWeight = packingCabinEssentialsShowsWeight(categoryName, profile);
  const safeQuantity = Math.max(0, Number(quantity ?? 0));
  const state = getPackingState(key);
  const restriction = usesQuantityAndWeight ? getPackingRestriction(item) : "any";
  const location = usesQuantityAndWeight ? (restriction === "carry-on-only" ? "carry-on" : restriction === "checked-only" ? "checked" : (state?.packing_location || "checked")) : "checklist";
  const cabinUnitWeight = showsCabinEssentialsWeight ? getCabinEssentialsUnitWeight(item) : 0;
  const travellerUnitWeight = Math.max(0, Number(item.weight_kg || 0));
  const unitWeight = usesQuantityAndWeight ? travellerUnitWeight : cabinUnitWeight;
  const weight = unitWeight * (usesQuantityAndWeight ? safeQuantity : (safeQuantity > 0 ? safeQuantity : 1));
  const weightDisplay = usesQuantityAndWeight
    ? formatPackingWeight(unitWeight * safeQuantity)
    : (showsCabinEssentialsWeight && cabinUnitWeight > 0 ? formatPackingWeight(weight) : "—");
  const hasWeightColumn = usesQuantityAndWeight || (showsCabinEssentialsWeight && cabinUnitWeight > 0);
  return `
    <div class="packing-row ${safeQuantity > 0 ? "is-selected" : ""} ${packed ? "is-packed" : ""} ${hasWeightColumn ? "" : "packing-row-no-weight"}" data-packing-row="${escapeHtml(key)}" data-unit-weight="${unitWeight}" ${showsCabinEssentialsWeight ? `data-cabin-unit-weight="${cabinUnitWeight}" data-cabin-quantity="${safeQuantity}"` : ""} data-uses-weight="${usesQuantityAndWeight}" data-location="${escapeHtml(location)}">
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
      <div class="packing-weight-cell" data-item-weight>${weightDisplay}</div>
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
  await savePackingV2State(key, { packing_location: location });
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
  const summary = { selected: 0, packed: 0, checked: 0, carryOn: 0, wearing: 0, checklistTotal: 0, checklistPacked: 0, cabinWeight: 0, cabinEssentialsSelected: 0, cabinEssentialsTotal: 0 };
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
      if (packed) summary.checklistPacked += 1;
      const cabinUnitWeight = Number(row.dataset.cabinUnitWeight || 0);
      const cabinQuantity = Math.max(0, Number(row.dataset.cabinQuantity || 0));
      const isCabinEssentialsRow = row.dataset.cabinUnitWeight !== undefined;
      if (isCabinEssentialsRow) {
        summary.cabinEssentialsTotal += 1;
        if (isCabinEssentialsItemSelected(packed, cabinQuantity)) summary.cabinEssentialsSelected += 1;
      }
      if (cabinUnitWeight > 0) {
        summary.cabinWeight += getCabinEssentialsSelectedWeight({ weight_kg: cabinUnitWeight }, packed, cabinQuantity);
      }
    }
  });
  return summary;
}

function recalculatePackingSummary() {
  const profile = getActivePackingProfile();
  const summary = collectPackingSummaryFromDom();
  if (profile?.profile_type === "cabin") {
    updateCabinPackingSummaries(summary.cabinWeight, summary.cabinEssentialsSelected, summary.cabinEssentialsTotal);
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
          <h3>${isCabin ? "Shared packing settings" : `${escapeHtml(profile?.profile_name || "Traveller")}'s packing settings`}</h3>
          <p class="planner-muted">${isCabin ? "These settings apply to the whole booking and update your packing recommendations." : "Allowances are entered for this traveller only and save automatically."}</p>
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
      </div>
      ${isCabin ? "" : `
        <p class="packing-baggage-instruction">Please add your airline baggage allowance below so the system can determine your capacity as you select what to pack.</p>
        <div class="packing-baggage-fields">
          <label class="packing-baggage-field"><span>Checked baggage</span><div class="packing-allowance-input"><input id="packingCheckedBaggageAllowance" type="number" min="0" step="0.5" inputmode="decimal" value="${escapeHtml(profile?.checked_baggage_allowance_kg ?? "")}" placeholder="0" oninput="recalculatePackingSummary(); schedulePackingPreferencesSave()" onblur="schedulePackingPreferencesSave(true)"><span>kg</span></div></label>
          <label class="packing-baggage-field"><span>Cabin baggage</span><div class="packing-allowance-input"><input id="packingCabinBaggageAllowance" type="number" min="0" step="0.5" inputmode="decimal" value="${escapeHtml(profile?.cabin_baggage_allowance_kg ?? "")}" placeholder="0" oninput="recalculatePackingSummary(); schedulePackingPreferencesSave()" onblur="schedulePackingPreferencesSave(true)"><span>kg</span></div></label>
        </div>
      `}
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
  if (customerMode) {
    await customerPackingRequest("reset_profile", { profile_key: profile.profile_key });
    renderPackingPlanner();
    return;
  }
  await supabaseClient.from("user_packing_v2_state").delete().eq("user_id", currentUser.id).eq("cruise_key", packingV2CurrentCruiseKey).eq("profile_key", profile.profile_key);
  renderPackingPlanner();
}

async function addPersonalPackingItem(categoryId) {
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
  trackMyCruisePage("packing");
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
    customerMode ? Promise.resolve({ data: [] }) : supabaseClient.from("user_packing_items").select("*").eq("user_id", currentUser.id).eq("cruise_id", cruise.id).order("created_at", { ascending: true })
  ]);
  const categoryNameById = new Map((categories || []).map(category => [String(category.id), category.name]));
  packingPlannerItemData = {
    context,
    categoryNameById,
    systemItems: (items || []).filter(item => packingItemApplies(item, context)),
    personalItems: personalResult?.data || []
  };
  const systemItems = packingPlannerItemData.systemItems.map(item => ({
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
      if (state?.packed) summary.checklistPacked += 1;
      if (profile.profile_type === "cabin" && isCabinEssentialsCategory(categoryName)) {
        summary.cabinWeight += getCabinEssentialsSelectedWeight(item, state?.packed === true, state?.quantity ?? 0);
      }
    }
  });
  const travellerProfiles = packingV2Profiles.filter(item => item.profile_type === "traveller");
  const cabinProfile = packingV2Profiles.find(item => item.profile_type === "cabin");
  const totalCabinEssentialsWeight = calculateTotalCabinEssentialsWeight(items, context, cabinProfile);
  const cabinSharePerTraveller = travellerProfiles.length ? totalCabinEssentialsWeight / travellerProfiles.length : 0;
  packingCabinSharePerTraveller = profile.profile_type === "traveller" ? cabinSharePerTraveller : 0;
  if (profile.profile_type === "traveller") summary.checked += cabinSharePerTraveller;
  const percent = profile.profile_type === "cabin" ? getProgressPercent(summary.checklistPacked, summary.checklistTotal) : getProgressPercent(summary.packed, summary.selected);
  const travellerNames = getPackingTravellerNames(cruise);
  const cabinEssentialsProgress = countCabinEssentialsProgress(allPackingItems, profile.profile_key, categoryNameById);
  const essentialsPercent = getProgressPercent(cabinEssentialsProgress.selected, cabinEssentialsProgress.total);
  const isCabinProfile = profile.profile_type === "cabin";

  app.innerHTML = `
    <div id="packing-page" class="packing-page packing-assistant-v2 ${isCabinProfile ? "is-cabin-page" : ""}">
      ${renderPlannerNav("packing")}
      <div class="checklist-toolbar planner-card slim-card packing-toolbar">
        <div><p class="planner-kicker">Packing Assistant</p><h2>${isCabinProfile ? "Cabin" : `${escapeHtml(profile.profile_name)}'s Packing`}</h2><p class="planner-muted">${isCabinProfile ? "Shared items for the cabin that are distributed across all travellers." : `${escapeHtml(cruise.ship_name || cruise.cruise_line || "Your cruise")} • ${escapeHtml(context.destination)} • ${escapeHtml(context.dressCode)}`}</p></div>
        <div class="checklist-toolbar-actions"><button class="planner-button secondary" id="selectedOnlyButton" onclick="toggleSelectedOnly()">Show Selected Only</button><button class="planner-button secondary" id="hidePackedButton" onclick="toggleHidePacked()">Hide Packed</button><button class="planner-button secondary" onclick="resetPackingProgress()">Reset</button><button class="planner-button secondary" onclick="printPackingList()">Print</button><button class="planner-button" onclick="savePackingPdf()">Save PDF</button></div>
      </div>
      ${renderPackingProfileTabs(packingV2Profiles)}
      ${renderPackingControls(preferences, cruise, profile)}
      <div class="packing-workspace">
        <div class="packing-list-column">
          <section class="planner-card packing-search-card"><input id="packingSearch" type="search" placeholder="Search ${escapeHtml(profile.profile_name)}'s list..." oninput="filterPackingList()"><span id="packingListStatus" class="packing-list-status"></span></section>
          ${isCabinProfile ? `<div class="cabin-info-banner"><span class="cabin-info-banner-icon" aria-hidden="true">ⓘ</span><p>Cabin Essentials are automatically distributed equally across all travellers and included in everyone's baggage weight.</p></div>` : ""}
          <main class="packing-content">
            ${(categories || []).map(category => {
              const categoryItems = grouped[category.id] || [];
              if (!categoryItems.length) return "";
              const usesWeight = packingCategoryUsesQuantityAndWeight(category.name, profile) || packingCabinEssentialsShowsWeight(category.name, profile);
              const isCabinEssentialsBlock = isCabinProfile && isCabinEssentialsCategory(category.name);
              const catPlanned = usesWeight ? categoryItems.filter(item => Number(getPackingState(getPackingItemKey(item), profile.profile_key)?.quantity || 0) > 0).length : categoryItems.length;
              const catPacked = categoryItems.filter(item => getPackingState(getPackingItemKey(item), profile.profile_key)?.packed === true && (!usesWeight || Number(getPackingState(getPackingItemKey(item), profile.profile_key)?.quantity || 0) > 0)).length;
              const essentialsBlockProgress = isCabinEssentialsBlock
                ? countCabinEssentialsProgress(categoryItems, profile.profile_key, categoryNameById)
                : null;
              const essentialsBlockPercent = essentialsBlockProgress ? getProgressPercent(essentialsBlockProgress.selected, essentialsBlockProgress.total) : 0;
              return `<section class="checklist-section-block packing-category-block">
                <div class="checklist-section-header"><div><h3>${escapeHtml(category.icon || "🧳")} ${escapeHtml(category.name)}</h3>${category.description ? `<p>${escapeHtml(category.description)}</p>` : ""}</div>${isCabinEssentialsBlock ? renderCabinCategoryProgress(essentialsBlockProgress.selected, essentialsBlockProgress.total, essentialsBlockPercent) : `<div class="section-progress-pill">${isCabinProfile ? `${catPacked}/${catPlanned} Complete` : (catPlanned ? `${catPacked}/${catPlanned} Packed` : "No items selected")}</div>`}</div>
                <div class="packing-table-header ${usesWeight ? "" : "packing-table-header-no-weight"}"><span></span><span>Quantity</span><span>Item</span><span>Type</span><span>Weight</span></div>
                ${categoryItems.map(item => renderPackingRow(item, getPackingState(getPackingItemKey(item), profile.profile_key)?.packed === true, getPackingState(getPackingItemKey(item), profile.profile_key)?.quantity ?? 0, category.name)).join("")}
                <button class="add-personal-task-button" onclick="addPersonalPackingItem(${category.id})">+ Add your own item</button>
              </section>`;
            }).join("")}
          </main>
        </div>
        ${isCabinProfile
          ? `<aside class="cabin-summary-column" aria-label="Packing progress and baggage summary">${renderCabinPackingSummary(summary.cabinWeight, travellerProfiles, essentialsPercent, cabinEssentialsProgress.selected, cabinEssentialsProgress.total, travellerNames)}</aside>`
          : `<aside class="planner-card packing-summary-card packing-summary-sticky" aria-label="Packing progress and baggage summary">
          <div class="packing-profile-summary-name">${escapeHtml(profile.profile_name)}</div>
          <div class="packing-progress-summary"><span>Ready to Cruise</span><strong id="packingProgressPercent">${percent}%</strong><small id="packingProgressDetail">${summary.packed} of ${summary.selected} selected items packed</small></div>
          ${renderPackingWeightGauge(summary, profile)}
        </aside>`}
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

/**
 * When My Cruise is embedded in a Squarespace iframe, report content height
 * so the parent can grow/shrink the iframe for natural page scrolling.
 * Origin-restricted messaging lives in js/portal-height.js.
 */
function setupEmbedHeightSync() {
  if (typeof PortalHeight !== "undefined" && PortalHeight.start) {
    PortalHeight.start();
    return;
  }
  if (window.parent === window) return;
  document.documentElement.classList.add("is-embedded");
  document.body.classList.add("is-embedded");
}

async function initPlanner() {
  setupEmbedHeightSync();

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

async function resolveDashboardBudget(cruise) {
  const loaded = await loadBudget(cruise);
  if (!activeBudget) return loaded;

  const currentCruise = await loadCurrentCruise();
  if (!currentCruise || getBudgetBookingKey(cruise) !== getBudgetBookingKey(currentCruise)) return loaded;

  return { ...loaded, ...activeBudget, items: activeBudget.items ?? loaded.items ?? [] };
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
  if (!cruise || !activeBudget) return;
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
  return `<div class="budget-item-list">${items.map(item => {
    const parts = getBudgetItemParts(item);
    return `<div class="budget-item-row"><div class="budget-item-copy"><span class="budget-item-primary">${escapeHtml(parts.primary)}</span>${parts.meta ? `<span class="budget-item-meta">${escapeHtml(parts.meta)}</span>` : ""}</div><div class="budget-item-actions"><span>${formatAud(item.amount)}</span><button onclick="editBudgetItem('${item.id}')">Edit</button><button onclick="deleteBudgetItem('${item.id}')">Delete</button></div></div>`;
  }).join("")}</div>`;
}

function getBudgetItemParts(item) {
  if (item.category === "flights") {
    return {
      primary: item.airline || item.name || "Flight",
      meta: [[item.date ? formatDateShort(item.date) : "", [item.from, item.to].filter(Boolean).join(" to "), item.return_flight ? "Return" : ""].filter(Boolean).join(" · ")].filter(Boolean).join(" · ")
    };
  }
  if (item.category === "accommodation") {
    return {
      primary: item.name || "Accommodation",
      meta: [item.location, item.date ? formatDateShort(item.date) : ""].filter(Boolean).join(" · ")
    };
  }
  if (item.category === "cars") {
    return {
      primary: item.name || "Car hire",
      meta: [item.location, item.date ? formatDateShort(item.date) : ""].filter(Boolean).join(" · ")
    };
  }
  return { primary: item.name || "Other expense", meta: "" };
}

const BUDGET_ICON_SVGS = {
  cruise: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M19.38 17A11.6 11.6 0 0 0 21 14l-7-4-7 4c0 1.5.5 3 1.5 4"/><path d="M12 6v4"/><path d="M9 6h6"/></svg>`,
  flights: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 20 3s-3 .5-4.5 1.5L12 8 3.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>`,
  accommodation: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 4v6"/><path d="M2 18h20"/></svg>`,
  cars: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8 1-4h8l1 4"/><path d="M5 8h14v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8z"/><path d="M7 12h.01"/><path d="M17 12h.01"/></svg>`,
  food_beverage: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  travel_insurance: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>`,
  excursions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V22"/><path d="M12 10c-1.5-3.5-5-4-5-4s1.5 3.5 5 4"/><path d="M12 10c1.5-3.5 5-4 5-4s-1.5 3.5-5 4"/><path d="M3 22c2.5-1.5 6-1.5 9-1.5s6.5 0 9 1.5"/></svg>`,
  other: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-4"/></svg>`
};

function renderBudgetCategoryIcon(key) {
  return `<span class="budget-category-icon" aria-hidden="true">${BUDGET_ICON_SVGS[key] || ""}</span>`;
}

function renderBudgetCategory(category, title, buttonLabel) {
  const totals = getBudgetTotals();
  return `<section class="planner-card budget-category-card"><div class="budget-category-heading"><div class="budget-category-title-block">${renderBudgetCategoryIcon(category)}<div class="budget-category-title-copy"><p class="planner-kicker budget-category-kicker">${escapeHtml(title)}</p><h2>${formatAud(totals[category])}</h2></div></div><button class="planner-button secondary budget-add-button" onclick="openBudgetItemForm('${category}')">+ ${escapeHtml(buttonLabel)}</button></div>${renderBudgetItems(category)}<div id="budget-form-${category}"></div></section>`;
}

function renderBudgetGettingStarted() {
  return `<section class="planner-card budget-getting-started"><h3>Getting Started</h3><p class="planner-muted">Keep track of your holiday expenses by adding your flights, accommodation, car hire, travel insurance, shore excursions and any other significant costs you expect. Update each section as you book so your estimated holiday total always stays current.</p></section>`;
}

function renderBudgetSaveMessage() {
  if (!activeBudget?.updated_at) return "";
  const date = new Date(activeBudget.updated_at);
  if (Number.isNaN(date.getTime())) return "";
  return `Updated ${date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}`;
}

function renderBudgetHeroCard(totals) {
  return `<section class="planner-card budget-hero-card"><p class="budget-hero-label">Estimated Holiday Total</p><h1 class="budget-hero-total">${formatAud(totals.total)}</h1><p class="budget-hero-note">Based on your current budget.</p></section>`;
}

function renderBudgetCruiseCard(totals) {
  return `<section class="planner-card budget-category-card budget-cruise-card"><div class="budget-category-heading"><div class="budget-category-title-block">${renderBudgetCategoryIcon("cruise")}<div class="budget-category-title-copy"><p class="planner-kicker budget-category-kicker">Cruise</p><h2>${formatAud(totals.cruiseAud)}</h2></div></div></div><div class="budget-cruise-details"><p class="planner-muted budget-cruise-booking-price">Booking price ${formatUsd(activeBudget.cruise_price_usd)}</p><label class="budget-rate-field"><span>USD to AUD exchange rate</span><input type="number" min="0" step="0.0001" value="${activeBudget.exchange_rate}" onchange="updateBudgetValue('exchange_rate', this.value)"></label></div></section>`;
}

function renderBudgetSummaryColumn(totals) {
  return `<aside class="budget-summary-column">${renderBudgetHeroCard(totals)}${renderBudgetCruiseCard(totals)}</aside>`;
}

function renderBudgetSimpleCard(title, field, inputLabel) {
  return `<section class="planner-card budget-simple-card"><div class="budget-category-heading"><div class="budget-category-title-block">${renderBudgetCategoryIcon(field)}<div class="budget-category-title-copy"><p class="planner-kicker budget-category-kicker">${escapeHtml(title)}</p><h2>${formatAud(activeBudget[field])}</h2></div></div></div><label><span>${escapeHtml(inputLabel)}</span><input type="number" min="0" step="0.01" value="${activeBudget[field] || ""}" placeholder="0.00" onchange="updateBudgetValue('${field}', this.value)"></label></section>`;
}

function renderBudgetCategoriesGrid() {
  return `<div class="budget-categories-column"><div class="budget-grid">${renderBudgetCategory("flights", "Flights", "Add Flight")}${renderBudgetCategory("accommodation", "Accommodation", "Add Stay")}${renderBudgetCategory("cars", "Car Hire", "Add Car Hire")}${renderBudgetSimpleCard("Food & Beverage", "food_beverage", "Total holiday allowance")}${renderBudgetSimpleCard("Travel Insurance", "travel_insurance", "Total insurance cost")}${renderBudgetSimpleCard("Shore Excursions", "excursions", "Total excursion allowance")}${renderBudgetCategory("other", "Other Expenses", "Add Expense")}</div></div>`;
}

async function renderBudgetPlanner() {
  clearCountdownTimer();
  trackMyCruisePage("budget");
  const cruise = await loadCurrentCruise();
  if (!cruise) { app.innerHTML = `<div class="planner-card"><button class="planner-button secondary" onclick="renderDashboard()">← Back to Dashboard</button><h2>Budget</h2><p>Add a cruise before creating your holiday budget.</p></div>`; return; }
  activeBudget = await loadBudget(cruise);
  activeBudget.cruise_price_usd = getCruisePriceUsd(cruise);
  const totals = getBudgetTotals();
  app.innerHTML = `<div class="budget-page">${renderPlannerNav("budget")}${renderBudgetGettingStarted()}<div class="budget-layout">${renderBudgetSummaryColumn(totals)}${renderBudgetCategoriesGrid()}</div>${renderBudgetSaveMessage() ? `<p id="budget-save-message" class="planner-message budget-save-message">${escapeHtml(renderBudgetSaveMessage())}</p>` : ""}</div>`;
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

/* =========================================================
   The Ship — live Base44 Finder data
   ========================================================= */

const SHIP_ROOM_COLORS = ["#8DD9BF", "#5BBFA3", "#245C4E", "#9AA7A3", "#6FA894", "#3D7A6A"];
const SHIP_NOT_LISTED = "Not listed";

const SHIP_SUMMARY_ICONS = {
  passengers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  staterooms: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 4v6"/><path d="M2 18h20"/></svg>`,
  crew: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4z"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M12 12v3"/><path d="M9.5 16.5h5"/></svg>`,
  built: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>`,
  refurbished: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`
};

const SHIP_GLANCE_ICONS = {
  restaurants: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  bars: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8z"/></svg>`,
  pools: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M2 16c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M12 4v8"/><path d="M8 8h8"/></svg>`,
  hot_tubs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M7 12v4a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-4"/><path d="M9 7c.5-1 1.5-2 3-2s2.5 1 3 2"/><path d="M8 4c.5-1 1.5-2 4-2s3.5 1 4 2"/></svg>`,
  specialty_dining: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  spa: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  gym: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m17.5 6.5 1 1"/><path d="m6.5 6.5-1 1"/><path d="M12 12v9"/><path d="M8 9h8"/><path d="M9 22h6"/><circle cx="12" cy="5" r="2"/></svg>`,
  theatre: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`,
  casino: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><path d="M12 9v6"/></svg>`,
  kids_club: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`,
  shopping: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`
};

function getBookingShipName(cruise = null) {
  const booking = cruise?._preview_booking || customerBooking || {};
  return String(booking.cruise_ship || cruise?.ship_name || "").trim();
}

function getBookingCruiseLine(cruise = null) {
  const booking = cruise?._preview_booking || customerBooking || {};
  return String(booking.cruise_line || cruise?.cruise_line || "").trim();
}

function readFacilityValue(facilities, keys) {
  if (!facilities || typeof facilities !== "object" || Array.isArray(facilities)) return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(facilities, key) && facilities[key] !== undefined) {
      return facilities[key];
    }
  }
  return null;
}

function formatShipNumber(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  const number = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(number)) return SHIP_NOT_LISTED;
  return new Intl.NumberFormat("en-AU").format(Math.round(number));
}

function formatShipYear(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  const number = Number(value);
  if (!Number.isFinite(number)) return SHIP_NOT_LISTED;
  return String(Math.round(number));
}

function formatShipStatValue(value, key) {
  if (value === null || value === undefined || value === "" || value === SHIP_NOT_LISTED) {
    return SHIP_NOT_LISTED;
  }
  if (key === "built" || key === "refurbished") return formatShipYear(value);
  return formatShipNumber(value);
}

function formatShipCountDisplay(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  const number = Number(value);
  if (!Number.isFinite(number)) return SHIP_NOT_LISTED;
  return new Intl.NumberFormat("en-AU").format(Math.round(number));
}

function formatShipYesNoDisplay(value) {
  if (value === null || value === undefined || value === "") return SHIP_NOT_LISTED;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (value === 1) return "Yes";
    if (value === 0) return "No";
  }
  const text = String(value).trim().toLowerCase();
  if (["yes", "true", "y"].includes(text)) return "Yes";
  if (["no", "false", "n"].includes(text)) return "No";
  return SHIP_NOT_LISTED;
}

function humaniseShipRoomLabel(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function buildShipAccommodation(ship) {
  const colors = SHIP_ROOM_COLORS;
  const rooms = [];

  const pushRoom = (label, value) => {
    const text = String(label || "").trim();
    if (!text) return;
    if (value === null || value === undefined || value === "") return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    if (number <= 0) return;
    rooms.push({ label: text, value: number });
  };

  const breakdown = ship?.stateroom_breakdown;
  if (Array.isArray(breakdown)) {
    breakdown.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const label = entry.label || entry.name || entry.type || entry.stateroom_type;
      const value = entry.value ?? entry.count ?? entry.quantity;
      pushRoom(label, value);
    });
  } else if (breakdown && typeof breakdown === "object") {
    Object.entries(breakdown).forEach(([key, value]) => {
      pushRoom(humaniseShipRoomLabel(key), value);
    });
  }

  const typeSource = ship?.stateroom_types || ship?.cabin_type_summary;
  if (!rooms.length && Array.isArray(typeSource)) {
    typeSource.forEach((entry) => {
      if (typeof entry === "string") return;
      if (!entry || typeof entry !== "object") return;
      const label = entry.label || entry.name || entry.type;
      const value = entry.value ?? entry.count ?? entry.quantity;
      pushRoom(label, value);
    });
  } else if (!rooms.length && typeSource && typeof typeSource === "object") {
    // Support Base44 object shape and custom[] entries.
    Object.entries(typeSource).forEach(([key, value]) => {
      if (key === "custom" && Array.isArray(value)) {
        value.forEach((entry) => {
          if (!entry || typeof entry !== "object") return;
          pushRoom(entry.name || entry.label, entry.count ?? entry.value);
        });
        return;
      }
      pushRoom(humaniseShipRoomLabel(key), value);
    });
  }

  return sortShipRoomCategories(rooms).map((room, index) => ({
    ...room,
    color: colors[index % colors.length]
  }));
}

function shipRoomCategoryRank(label) {
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

function sortShipRoomCategories(rooms) {
  return (rooms || [])
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      const rankDiff = shipRoomCategoryRank(a.room.label) - shipRoomCategoryRank(b.room.label);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map(({ room }) => room);
}

function buildShipOnboardGlance(facilities) {
  const numericRows = [
    { label: "Dining Options", icon: "restaurants", keys: ["restaurants", "restaurant_count", "restaurant"] },
    { label: "Bars", icon: "bars", keys: ["bars", "bar_count", "bar"] },
    { label: "Pools", icon: "pools", keys: ["pools", "pool_count", "pool"] },
    { label: "Hot tubs", icon: "hot_tubs", keys: ["hot_tubs", "hotTubs", "hot_tub_count", "jacuzzis"] },
    { label: "Specialty dining", icon: "specialty_dining", keys: ["specialty_dining", "specialtyDining", "specialty_restaurants"] }
  ];

  const yesNoRows = [
    { label: "Spa", icon: "spa", keys: ["spa", "spa_wellness", "has_spa"] },
    { label: "Gym", icon: "gym", keys: ["gym", "fitness", "fitness_centre", "fitness_center", "has_gym"] },
    { label: "Theatre", icon: "theatre", keys: ["theatre", "theater", "has_theatre", "has_theater"] },
    { label: "Casino", icon: "casino", keys: ["casino", "has_casino"] },
    { label: "Kids club", icon: "kids_club", keys: ["kids_club", "kidsClub", "youth_programmes", "youth_programs", "has_kids_club"] },
    { label: "Shopping", icon: "shopping", keys: ["shopping", "shops", "has_shopping"] }
  ];

  return [
    ...numericRows.map((row) => ({
      label: row.label,
      icon: row.icon,
      display: formatShipCountDisplay(readFacilityValue(facilities, row.keys)),
      kind: "count"
    })),
    ...yesNoRows.map((row) => ({
      label: row.label,
      icon: row.icon,
      display: formatShipYesNoDisplay(readFacilityValue(facilities, row.keys)),
      kind: "yesno"
    }))
  ];
}

function buildShipChipList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function buildShipProfileFromBase44(ship, { shipName, cruiseLine } = {}) {
  const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  const passengers = ship?.passenger_capacity;
  const crew = ship?.crew_count;
  const decks = ship?.deck_count;
  const staterooms = ship?.stateroom_count;
  const accommodation = buildShipAccommodation(ship);

  let crewRatio = SHIP_NOT_LISTED;
  const passengerNumber = Number(passengers);
  const crewNumber = Number(crew);
  if (Number.isFinite(passengerNumber) && Number.isFinite(crewNumber) && crewNumber > 0) {
    crewRatio = `1 : ${(passengerNumber / crewNumber).toFixed(1)}`;
  }

  const exclusiveAreas = buildShipChipList(
    readFacilityValue(facilities, ["exclusive_areas", "exclusiveAreas", "exclusive"])
  );
  const specialtyFeatures = buildShipChipList(
    readFacilityValue(facilities, ["specialty_features", "specialtyFeatures", "signature_features"])
  );

  return {
    name: ship?.name || shipName || "Your ship",
    cruiseLine: cruiseLine || "",
    status: ship?.current_status || "Active",
    summary: {
      passengers,
      staterooms,
      crew,
      built: ship?.year_built,
      refurbished: ship?.year_refurbished
    },
    onboardGlance: buildShipOnboardGlance(facilities),
    specifications: [
      { label: "Gross tonnage", value: ship?.gross_tonnage == null || ship?.gross_tonnage === "" ? SHIP_NOT_LISTED : `${formatShipNumber(ship.gross_tonnage)} GT` },
      { label: "Length", value: ship?.length_meters == null || ship?.length_meters === "" ? SHIP_NOT_LISTED : `${formatShipNumber(ship.length_meters)} metres` },
      { label: "Decks", value: decks == null || decks === "" ? SHIP_NOT_LISTED : `${formatShipNumber(decks)} passenger decks` },
      { label: "Staterooms", value: formatShipNumber(staterooms) },
      { label: "Passengers", value: formatShipNumber(passengers) },
      { label: "Crew", value: formatShipNumber(crew) }
    ],
    accommodation,
    scaleFacts: [
      { label: "Passenger decks", value: formatShipNumber(decks) },
      { label: "Max guests", value: formatShipNumber(passengers) },
      { label: "Crew", value: formatShipNumber(crew) },
      { label: "Crew ratio", value: crewRatio }
    ],
    exclusiveAreas,
    specialtyFeatures,
    deckPlanUrl: ship?.deck_plan_url || null
  };
}

async function fetchShipFromBase44(shipName, cruiseLine = "") {
  const params = new URLSearchParams();
  params.set("name", shipName);
  if (cruiseLine) params.set("cruise_line", cruiseLine);

  const response = await fetch(`/.netlify/functions/get-ship?${params.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  const data = await response.json().catch(() => ({ success: false, error: "Invalid response" }));

  if (
    response.status === 404 ||
    response.status === 409 ||
    data.error === "SHIP_NOT_FOUND" ||
    data.error === "SHIP_AMBIGUOUS"
  ) {
    return { ok: false, notFound: true, source: data.source || null };
  }

  if (!response.ok || data.success === false || !data.ship) {
    return { ok: false, notFound: false, source: data.source || null };
  }

  if (data.source === "base44") {
    console.info("Ship lookup used Base44 fallback — missing Supabase Cruise Intelligence record");
  }

  return { ok: true, ship: data.ship, source: data.source || null };
}

function renderShipSummaryCard(ship) {
  const stats = [
    { key: "passengers", label: "Guests", value: ship.summary.passengers },
    { key: "staterooms", label: "Staterooms", value: ship.summary.staterooms },
    { key: "crew", label: "Crew", value: ship.summary.crew },
    { key: "built", label: "Built", value: ship.summary.built },
    { key: "refurbished", label: "Refurbished", value: ship.summary.refurbished }
  ];

  return `
    <section class="ship-summary-card" aria-label="Ship summary">
      <div class="ship-summary-grid">
        ${stats.map(stat => {
          const numeric = Number(stat.value);
          const isNumeric = stat.value !== null && stat.value !== undefined && stat.value !== "" && Number.isFinite(numeric);
          if (!isNumeric) {
            return `
              <div class="ship-summary-stat">
                <span class="ship-summary-icon" aria-hidden="true">${SHIP_SUMMARY_ICONS[stat.key]}</span>
                <div class="ship-summary-copy">
                  <strong class="ship-summary-value is-static">${escapeHtml(SHIP_NOT_LISTED)}</strong>
                  <span class="ship-summary-label">${escapeHtml(stat.label)}</span>
                </div>
              </div>
            `;
          }
          return `
            <div class="ship-summary-stat">
              <span class="ship-summary-icon" aria-hidden="true">${SHIP_SUMMARY_ICONS[stat.key]}</span>
              <div class="ship-summary-copy">
                <strong class="ship-summary-value" data-ship-stat="${stat.key}" data-ship-target="${numeric}">0</strong>
                <span class="ship-summary-label">${escapeHtml(stat.label)}</span>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderShipOnboardGlance(items) {
  const metrics = (items || []).filter(item => item.kind === "count");
  const statuses = (items || []).filter(item => item.kind !== "count");
  const focusIcons = new Set(["restaurants", "bars", "pools"]);

  const renderMetric = (item) => {
    const display = item.display || SHIP_NOT_LISTED;
    const isEmpty = display === SHIP_NOT_LISTED;
    const isFocus = focusIcons.has(item.icon) && !isEmpty;
    return `
      <div class="ship-glance-item is-metric ${isFocus ? "is-focus" : ""} ${isEmpty ? "is-empty" : ""}">
        <span class="ship-glance-icon" aria-hidden="true">${SHIP_GLANCE_ICONS[item.icon] || SHIP_GLANCE_ICONS.shopping}</span>
        ${isEmpty
          ? `<span class="ship-glance-empty">${escapeHtml(SHIP_NOT_LISTED)}</span>`
          : `<strong class="ship-glance-metric">${escapeHtml(display)}</strong>`}
        <span class="ship-glance-label">${escapeHtml(item.label)}</span>
      </div>
    `;
  };

  const renderStatus = (item) => {
    const display = item.display || SHIP_NOT_LISTED;
    const isEmpty = display === SHIP_NOT_LISTED;
    const valueClass = display === "Yes"
      ? "ship-glance-value ship-glance-yes"
      : display === "No"
        ? "ship-glance-value is-no"
        : "ship-glance-empty";

    return `
      <div class="ship-glance-item is-status ${isEmpty ? "is-empty" : ""}">
        <span class="ship-glance-icon" aria-hidden="true">${SHIP_GLANCE_ICONS[item.icon] || SHIP_GLANCE_ICONS.shopping}</span>
        <span class="ship-glance-label">${escapeHtml(item.label)}</span>
        <span class="${valueClass}">${escapeHtml(display)}</span>
      </div>
    `;
  };

  return `
    <div class="ship-glance">
      <div class="ship-glance-grid ship-glance-metrics">
        ${metrics.map(renderMetric).join("")}
      </div>
      <div class="ship-glance-grid ship-glance-status">
        ${statuses.map(renderStatus).join("")}
      </div>
    </div>
  `;
}

function renderShipHero(ship, { cruiseLineLogo = "", shipImage = "" } = {}) {
  const hasImage = Boolean(shipImage);
  return `
    <header class="ship-hero ${hasImage ? "has-image" : ""}">
      <div class="ship-hero-copy">
        ${cruiseLineLogo ? `<img class="ship-hero-line-logo" src="${escapeHtml(cruiseLineLogo)}" alt="${escapeHtml(ship.cruiseLine || "Cruise line")} logo">` : ""}
        <h1 class="ship-identity-name">${escapeHtml(ship.name)}</h1>
        ${ship.cruiseLine ? `<p class="ship-hero-line ship-identity-line">${escapeHtml(ship.cruiseLine)}</p>` : ""}
      </div>
      ${hasImage ? `
        <div class="ship-hero-media" aria-hidden="true">
          <img class="ship-hero-image" src="${escapeHtml(shipImage)}" alt="">
        </div>
      ` : ""}
    </header>
  `;
}

function renderShipSpecifications(specs) {
  return `
    <div class="ship-spec-list">
      ${specs.map(item => `
        <div class="ship-spec-row">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderShipScaleFacts(facts) {
  const ratioFact = (facts || []).find(item => /crew ratio|guest to crew/i.test(String(item.label || "")));
  const otherFacts = (facts || []).filter(item => item !== ratioFact);

  return `
    <div class="ship-scale-list">
      ${otherFacts.map(item => `
        <div class="ship-scale-row">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `).join("")}
      ${ratioFact ? `
        <div class="ship-scale-highlight">
          <span>${escapeHtml(ratioFact.label === "Crew ratio" ? "Guest to Crew Ratio" : ratioFact.label)}</span>
          <strong>${escapeHtml(ratioFact.value)}</strong>
        </div>
      ` : ""}
    </div>
  `;
}

function renderShipChipGroup(items) {
  return `
    <div class="dashboard-snapshot-extras-tags ship-chip-group">
      ${items.map(item => `<span class="dashboard-snapshot-extras-tag">${escapeHtml(item)}</span>`).join("")}
    </div>
  `;
}

function renderShipAccommodationChart(rooms) {
  if (!rooms.length) {
    return `<p class="planner-muted ship-empty-note">Room type details are not listed for this ship yet.</p>`;
  }

  const total = rooms.reduce((sum, room) => sum + Number(room.value || 0), 0) || 1;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const segments = rooms.map(room => {
    const portion = Number(room.value || 0) / total;
    const length = circumference * portion;
    const segment = {
      ...room,
      dasharray: `${length} ${circumference - length}`,
      dashoffset: -offset
    };
    offset += length;
    return segment;
  });

  return `
    <div class="ship-accommodation-layout">
      <div class="ship-donut-wrap" aria-hidden="true">
        <svg class="ship-donut-chart" viewBox="0 0 140 140" role="presentation">
          <circle class="ship-donut-track" cx="70" cy="70" r="${radius}"></circle>
          ${segments.map((segment, index) => `
            <circle
              class="ship-donut-segment"
              cx="70"
              cy="70"
              r="${radius}"
              stroke="${escapeHtml(segment.color)}"
              stroke-dasharray="${segment.dasharray}"
              stroke-dashoffset="${segment.dashoffset}"
              style="--ship-donut-delay:${0.3 + index * 0.55}s"
            ></circle>
          `).join("")}
        </svg>
        <div class="ship-donut-centre">
          <strong>${formatShipStatValue(total)}</strong>
          <span>Staterooms</span>
        </div>
      </div>
      <ul class="ship-room-legend">
        ${rooms.map(room => `
          <li>
            <span class="ship-room-swatch" style="background:${escapeHtml(room.color)}"></span>
            <span class="ship-room-label">${escapeHtml(room.label)}</span>
            <strong>${formatShipStatValue(room.value)}</strong>
          </li>
        `).join("")}
      </ul>
    </div>
  `;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateShipSummaryStats() {
  return new Promise(resolve => {
    const nodes = Array.from(document.querySelectorAll("[data-ship-stat]"));
    if (!nodes.length) {
      resolve();
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      nodes.forEach(node => {
        const target = Number(node.getAttribute("data-ship-target") || 0);
        const key = node.getAttribute("data-ship-stat");
        node.textContent = formatShipStatValue(target, key);
      });
      resolve();
      return;
    }

    const duration = 3000;
    const start = performance.now();
    let remaining = nodes.length;

    nodes.forEach((node, index) => {
      const target = Number(node.getAttribute("data-ship-target") || 0);
      const key = node.getAttribute("data-ship-stat");
      const finishBias = 150 + (index / Math.max(nodes.length - 1, 1)) * 100;
      let lastShown = -1;

      const tick = now => {
        const elapsed = Math.max(0, now - start);
        const progress = Math.min(1, elapsed / (duration + finishBias));
        const value = Math.round(target * easeOutCubic(progress));
        if (value !== lastShown) {
          lastShown = value;
          node.textContent = formatShipStatValue(value, key);
        }
        if (progress < 1) {
          requestAnimationFrame(tick);
          return;
        }
        node.textContent = formatShipStatValue(target, key);
        remaining -= 1;
        if (remaining <= 0) resolve();
      };

      requestAnimationFrame(tick);
    });
  });
}

function animateShipDonutChart() {
  const segments = Array.from(document.querySelectorAll(".ship-donut-segment"));
  if (!segments.length) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  segments.forEach(segment => {
    const finalDasharray = segment.getAttribute("stroke-dasharray") || "";
    const [lengthText, gapText] = finalDasharray.split(/\s+/);
    const length = Number(lengthText || 0);
    const gap = Number(gapText || 0);

    if (reducedMotion) {
      segment.style.opacity = "1";
      return;
    }

    segment.style.strokeDasharray = `0 ${length + gap}`;
    segment.style.opacity = "0";

    requestAnimationFrame(() => {
      const delay = getComputedStyle(segment).getPropertyValue("--ship-donut-delay") || "0.3s";
      segment.style.transition = `stroke-dasharray 15s cubic-bezier(0.22, 0.61, 0.36, 1) ${delay}, opacity 1.4s ease ${delay}`;
      segment.style.strokeDasharray = finalDasharray;
      segment.style.opacity = "1";
    });
  });
}

function setupShipDonutAnimation() {
  const wrap = document.querySelector(".ship-donut-wrap");
  if (!wrap) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) {
    animateShipDonutChart();
    return;
  }

  // Start only when the chart is on-screen, so late scrollers still catch it.
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      animateShipDonutChart();
    },
    { threshold: 0.35, rootMargin: "0px 0px -8% 0px" }
  );
  observer.observe(wrap);
}

function revealShipContentSections() {
  const page = document.querySelector(".ship-page");
  if (!page) return;
  page.classList.add("is-content-ready");
  requestAnimationFrame(() => setupShipDonutAnimation());
}

async function initialiseShipPageMotion() {
  const page = document.querySelector(".ship-page");
  if (!page) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => page.classList.add("is-ready"));

  if (reducedMotion) {
    await animateShipSummaryStats();
    revealShipContentSections();
    return;
  }

  await animateShipSummaryStats();
  revealShipContentSections();
}

async function renderTheShip() {
  clearCountdownTimer();
  trackMyCruisePage("the_ship");

  const cruise = await loadCurrentCruise();
  const shipName = getBookingShipName(cruise);
  const cruiseLine = getBookingCruiseLine(cruise);

  app.innerHTML = `
    <div class="ship-page">
      ${renderPlannerNav("ship")}
      <div class="ship-page-status" role="status" aria-live="polite">
        <p class="planner-kicker">Your ship</p>
        <h1 class="ship-identity-name ship-status-title">${escapeHtml(shipName || "The Ship")}</h1>
        <p class="planner-muted">Loading ship information…</p>
      </div>
    </div>
  `;

  if (!shipName) {
    app.innerHTML = `
      <div class="ship-page">
        ${renderPlannerNav("ship")}
        <div class="ship-page-status">
          <p class="planner-kicker">Your ship</p>
          <h1 class="ship-identity-name ship-status-title">The Ship</h1>
          <p class="planner-muted">Ship information is not available yet.</p>
        </div>
      </div>
    `;
    return;
  }

  let result;
  try {
    result = await fetchShipFromBase44(shipName, cruiseLine);
  } catch (error) {
    console.error("Ship lookup failed", error);
    result = { ok: false, notFound: false };
  }

  if (!result.ok) {
    app.innerHTML = `
      <div class="ship-page">
        ${renderPlannerNav("ship")}
        <div class="ship-page-status">
          <p class="planner-kicker">Your ship</p>
          <h1 class="ship-identity-name ship-status-title">${escapeHtml(shipName)}</h1>
          ${cruiseLine ? `<p class="ship-identity-line">${escapeHtml(cruiseLine)}</p>` : ""}
          <p class="planner-muted">Ship information is not available yet.</p>
        </div>
      </div>
    `;
    return;
  }

  const ship = buildShipProfileFromBase44(result.ship, {
    shipName,
    cruiseLine: result.ship?.cruise_line_name || cruiseLine
  });
  const cruiseLineLogo = await loadCruiseLineLogo(ship.cruiseLine || cruiseLine);
  let shipImage = await loadShipPageImage(ship.name);
  if (!shipImage && shipName && shipName !== ship.name) {
    shipImage = await loadShipPageImage(shipName);
  }

  app.innerHTML = `
    <div class="ship-page">
      ${renderPlannerNav("ship")}

      ${renderShipHero(ship, { cruiseLineLogo, shipImage })}

      ${renderShipSummaryCard(ship)}

      <div class="ship-content-stage">
        <section class="ship-section-card ship-glance-section ship-reveal-block" style="--ship-delay:0ms">
          <h3>Onboard at a Glance</h3>
          <p class="planner-muted ship-section-intro">Everything that makes life on board feel effortless.</p>
          ${renderShipOnboardGlance(ship.onboardGlance)}
        </section>

        <div class="ship-info-grid ship-reveal-block" style="--ship-delay:70ms">
          <section class="ship-section-card ship-info-card">
            <h3>Ship Specifications</h3>
            ${renderShipSpecifications(ship.specifications)}
          </section>

          <section class="ship-section-card ship-info-card">
            <h3>Room Types</h3>
            ${renderShipAccommodationChart(ship.accommodation)}
          </section>

          <section class="ship-section-card ship-info-card">
            <h3>Ship Scale</h3>
            ${renderShipScaleFacts(ship.scaleFacts)}
          </section>
        </div>

        ${ship.exclusiveAreas.length ? `
          <section class="ship-section-card ship-reveal-block" style="--ship-delay:280ms">
            <h3>Exclusive Areas</h3>
            <p class="planner-muted ship-section-intro">Quiet corners and elevated spaces made for your voyage.</p>
            ${renderShipChipGroup(ship.exclusiveAreas)}
          </section>
        ` : ""}

        ${ship.specialtyFeatures.length ? `
          <section class="ship-section-card ship-reveal-block" style="--ship-delay:350ms">
            <h3>Specialty Features</h3>
            <p class="planner-muted ship-section-intro">Signature experiences unique to this ship.</p>
            ${renderShipChipGroup(ship.specialtyFeatures)}
          </section>
        ` : ""}

        <section class="ship-section-card ship-deck-card ship-reveal-block" style="--ship-delay:420ms">
          <div class="ship-deck-copy">
            <h3>Deck Plans</h3>
            ${
              ship.deckPlanUrl
                ? `<a class="planner-button secondary ship-deck-button ship-deck-button--external" href="${escapeHtml(
                    ship.deckPlanUrl
                  )}" target="_blank" rel="noopener noreferrer">
              <span class="ship-deck-button-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 11h18"/></svg>
              </span>
              <span>Explore ${escapeHtml(String(ship.name || "Ship").trim())} Deck Plans</span>
              <span class="ship-deck-external-icon" aria-hidden="true" title="Opens in a new tab">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/></svg>
              </span>
              <span class="sr-only"> (opens in a new tab)</span>
            </a>
            <p class="planner-muted">Explore the official deck plans and get to know every level before you sail.</p>`
                : `<p class="planner-muted">Deck plans are not yet available for this ship.</p>`
            }
          </div>
        </section>
      </div>
    </div>
  `;

  initialiseShipPageMotion();
}

if (typeof window !== "undefined") {
  window.navigateWithLoading = navigateWithLoading;
  window.openDocumentsWithLoading = openDocumentsWithLoading;
  window.renderJourneySummary = renderJourneySummary;
  window.renderDashboardCountdownPanel = renderDashboardCountdownPanel;
}

initPlanner();
