const SUPABASE_URL = "https://xikbibxyinttllxamgao.supabase.co";
const SUPABASE_KEY = "sb_publishable_MEFg6spz5_Uod7sZGU8whw_UvOQDW60";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("cruise-planner-app");

let currentUser = null;
let currentProfile = null;
let countdownTimer = null;

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


function renderLogin() {
  clearCountdownTimer();

  app.innerHTML = `
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

  const { error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: firstName,
        last_name: lastName
      }
    }
  });

  document.getElementById("signup-message").innerText = error
    ? error.message
    : "Account created. Please check your email to confirm your account before signing in.";
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
  if (safeCruises.length <= 1) return "";

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
  const fallbackImage = getShipImage(shipName);
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
  if (cruise) {
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
  const essentialItem = checklistItems.find(item =>
    getPriorityLabel(item.priority) === "Essential" && !isItemCompleted(progressRows, item.id)
  );
  const nextItem = essentialItem || checklistItems.find(item => !isItemCompleted(progressRows, item.id));

  return {
    checklistItems,
    completedCount,
    totalCount,
    percent: getProgressPercent(completedCount, totalCount),
    nextItem
  };
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

function getTravellerSummary(cruise) {
  const names = getDashboardValue(cruise, ["traveller_names", "travellers", "guest_names", "passenger_names"], "");
  if (names) return names;
  const count = getDashboardValue(cruise, ["traveller_count", "guests", "passengers", "guest_count"], "");
  if (count) return `${count} ${Number(count) === 1 ? "Traveller" : "Travellers"}`;
  return "Not added";
}

function getUserDisplayName() {
  const profileName = currentProfile?.first_name || currentUser?.user_metadata?.first_name || "";
  if (profileName && String(profileName).trim()) return String(profileName).trim();

  const emailName = String(currentUser?.email || "").split("@")[0] || "Cruiser";
  if (emailName.toLowerCase().startsWith("steve")) return "Steve";

  const cleaned = emailName.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim();
  return cleaned ? cleaned.replace(/\w/g, char => char.toUpperCase()) : "Cruiser";
}

function renderStatusValue(value) {
  const safeValue = String(value || "Not added").trim() || "Not added";
  const isMissing = safeValue.toLowerCase() === "not added" || safeValue.toLowerCase() === "required" || safeValue.toLowerCase() === "pending";
  return `<strong class="${isMissing ? "is-alert" : ""}">${escapeHtml(safeValue)}</strong>`;
}

function renderDashboardSnapshot(cruise) {
  const embarkation = getDashboardValue(cruise, ["embarkation_port", "departure_port", "from_port", "departure_city"], "Not added");
  const disembarkation = getDashboardValue(cruise, ["disembarkation_port", "arrival_port", "to_port", "destination"], "Not added");
  const cabin = getDashboardValue(cruise, ["cabin_number", "cabin", "stateroom", "suite"], "Not added");
  const travellers = getTravellerSummary(cruise);
  const insurance = getDashboardValue(cruise, ["insurance_status", "travel_insurance", "insurance", "insurance_purchased"], "Not added");
  const flights = getDashboardValue(cruise, ["flight_status", "flights", "flights_booked", "air_status"], "Not added");

  return `
    <article class="dashboard-summary-card dashboard-snapshot-card">
      <p class="dashboard-card-label">Cruise Snapshot</p>
      <div class="dashboard-snapshot-list">
        <div class="dashboard-snapshot-row"><span>Travellers</span>${renderStatusValue(travellers)}</div>
        <div class="dashboard-snapshot-row"><span>Cabin</span>${renderStatusValue(cabin)}</div>
        <div class="dashboard-snapshot-row"><span>Embarkation</span>${renderStatusValue(embarkation)}</div>
        <div class="dashboard-snapshot-row"><span>Disembarkation</span>${renderStatusValue(disembarkation)}</div>
        <div class="dashboard-snapshot-row"><span>Insurance</span>${renderStatusValue(insurance)}</div>
        <div class="dashboard-snapshot-row"><span>Flights</span>${renderStatusValue(flights)}</div>
      </div>
      <button class="dashboard-outline-action" onclick="alert('Booking details will connect to Base44 in a future release')">Open Booking →</button>
    </article>
  `;
}

async function renderDashboard() {
  clearCountdownTimer();

  const { data: cruises, error } = await supabaseClient
    .from("cruises")
    .select("*")
    .order("departure_date", { ascending: true });

  const firstName = getUserDisplayName();
  const safeCruises = cruises || [];
  const plannerPreference = await loadPlannerPreference();
  const mainCruise = selectActiveCruise(safeCruises, plannerPreference);
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

  app.innerHTML = `
    <div class="dashboard-page">
      ${mainCruise ? `
        <section class="dashboard-hero ${mainShipImage ? "has-image" : ""}" ${mainShipImage ? `style="background-image:url('${escapeHtml(mainShipImage)}')"` : ""}>
          <div class="dashboard-hero-overlay"></div>
          <button class="dashboard-signout" onclick="signOut()">Sign Out</button>

          <div class="dashboard-hero-content">
            <p class="dashboard-hero-kicker">My Cruise Planner</p>
            <h1>${escapeHtml(mainCruise.ship_name || mainCruise.cruise_line || "Your Cruise")}</h1>
            <p class="dashboard-hero-date">Departs ${escapeHtml(formatDateShort(mainCruise.departure_date))}</p>
            <p class="dashboard-hero-route">${escapeHtml(routeLine || routeText || "Your upcoming cruise")}</p>
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
          <p>Welcome back, ${escapeHtml(firstName)}. Add your cruise to activate your personal dashboard.</p>
          <button class="planner-button secondary" onclick="signOut()">Sign Out</button>
        </section>
      `}

      <div class="dashboard-content-wrap">
        <section class="dashboard-welcome-strip">
          <div class="dashboard-welcome-avatar">${escapeHtml(String(firstName).slice(0, 2).toUpperCase())}</div>
          <div>
            <h2>Welcome back, ${escapeHtml(firstName)}! 👋</h2>
            <p>${mainCruise ? `You're currently planning <strong>${escapeHtml(mainCruise.ship_name || mainCruise.cruise_line || "your cruise")}</strong>. Your next priority is <strong>${escapeHtml(nextStepTitle)}</strong>.` : `You're <strong>${checklistData.percent}% cruise ready</strong>. Your next priority is <strong>${escapeHtml(nextStepTitle)}</strong>.`}</p>
          </div>
          ${renderCruiseSwitcher(safeCruises, mainCruise)}
        </section>

        <section class="dashboard-summary-grid dashboard-summary-grid-final">
          <article class="dashboard-summary-card next-task-card">
            <p class="dashboard-card-label">Next Essential Task</p>
            <div class="dashboard-card-icon">✓</div>
            <h2>${escapeHtml(nextStepTitle)}</h2>
            <p class="dashboard-card-copy">${escapeHtml(nextStepDescription)}</p>
            <button class="dashboard-card-action" onclick="renderChecklist()">Start Task →</button>
          </article>

          <article class="dashboard-summary-card cruise-ready-card">
            <p class="dashboard-card-label">Cruise Ready</p>
            <div class="dashboard-ready-stat"><strong>${checklistData.percent}%</strong><span>You're making great progress!</span></div>
            ${renderProgressCircle(checklistData.percent)}
            <button class="dashboard-link-action" onclick="renderChecklist()">View Progress →</button>
          </article>

          ${mainCruise ? renderDashboardSnapshot(mainCruise) : ""}

          <article class="dashboard-summary-card dashboard-planner-card">
            <p class="dashboard-card-label">My Planner</p>
            <button onclick="renderChecklist()"><span>Preparation Checklist</span><strong>→</strong></button>
            <button onclick="alert('Packing Checklist coming soon')"><span>Packing Checklist</span><strong>→</strong></button>
            <button onclick="alert('Documents Checklist coming soon')"><span>Documents Checklist</span><strong>→</strong></button>
            <button onclick="alert('Budget Planner coming soon')"><span>Budget Planner</span><strong>→</strong></button>
            <button class="dashboard-planner-main" onclick="renderChecklist()">Go to Planner →</button>
          </article>
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
    { key: "packing", label: "Packing", action: "alert('Packing List coming soon')" },
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
  const { data } = await supabaseClient.auth.getSession();

  if (data.session) {
    currentUser = data.session.user;
    await ensureProfile();
    await loadProfile();
    renderDashboard();
  } else {
    renderLogin();
  }
}

initPlanner();
