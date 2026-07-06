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

function getShipImage(shipName) {
  return SHIP_IMAGES[shipName] || "";
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

async function renderDashboard() {
  clearCountdownTimer();

  const { data: cruises, error } = await supabaseClient
    .from("cruises")
    .select("*")
    .order("departure_date", { ascending: true });

  const firstName = currentProfile?.first_name || currentUser.email;
  const mainCruise = cruises && cruises.length ? cruises[0] : null;
  const countdownParts = mainCruise ? getCountdownParts(mainCruise) : null;
  const nextStep = mainCruise ? getNextStep(countdownParts.totalDays) : null;
  const mainLogo = mainCruise ? getCruiseLineLogo(mainCruise.cruise_line) : "";
  const mainShipImage = mainCruise ? getShipImage(mainCruise.ship_name) : "";

  app.innerHTML = `
    <div class="planner-card">
      <h2>Welcome back, ${firstName}</h2>
      <p class="planner-muted">Your next adventure awaits.</p>
      <button class="planner-button black" onclick="signOut()">Sign Out</button>

      ${
        mainCruise
          ? `
            <div class="cruise-main-card">
              <div class="cruise-main-inner">
                <div class="cruise-hero-left">
                  ${mainLogo ? `<img class="planner-logo" src="${mainLogo}" alt="${mainCruise.cruise_line} logo">` : ``}
                  <p class="cruise-kicker">Current Cruise</p>
                  <h2>${mainCruise.cruise_line}</h2>
                  <p><strong>${mainCruise.ship_name || "Ship not added"}</strong></p>
                  <p>Departs ${formatDate(mainCruise.departure_date)} at ${formatTime(mainCruise.departure_time)}</p>

                  <div class="simple-days">
                    <span class="simple-days-number" id="simpleDays">${countdownParts.days}</span>
                    <span class="simple-days-label">${countdownParts.days === 1 ? "day to go" : "days to go"}</span>
                  </div>
                </div>

                <div class="cruise-hero-right">
                  ${mainShipImage ? `<div class="hero-image-area" style="background-image:url('${mainShipImage}')"></div>` : `<div class="hero-image-area"></div>`}
                  <div class="hero-content">
                    <p class="live-countdown-title">Your next adventure begins in</p>

                    <div class="live-countdown-grid">
                      <div class="countdown-unit">
                        <span class="countdown-value" id="countdownDays">${countdownParts.days}</span>
                        <span class="countdown-label">Days</span>
                      </div>
                      <div class="countdown-unit">
                        <span class="countdown-value" id="countdownHours">${padNumber(countdownParts.hours)}</span>
                        <span class="countdown-label">Hours</span>
                      </div>
                      <div class="countdown-unit">
                        <span class="countdown-value" id="countdownMinutes">${padNumber(countdownParts.minutes)}</span>
                        <span class="countdown-label">Minutes</span>
                      </div>
                      <div class="countdown-unit">
                        <span class="countdown-value" id="countdownSeconds">${padNumber(countdownParts.seconds)}</span>
                        <span class="countdown-label">Seconds</span>
                      </div>
                    </div>

                    <div class="next-step-card">
                      <div class="next-step-label">Next Step</div>
                      <div class="next-step-title"><span id="nextStepIcon">${nextStep.icon}</span> <span id="nextStepTitle">${nextStep.title}</span></div>
                      <div class="next-step-copy" id="nextStepCopy">${nextStep.copy}</div>
                      <a class="next-step-button" id="nextStepButton" href="${nextStep.buttonUrl || '#'}" style="${nextStep.buttonText && nextStep.buttonUrl ? '' : 'display:none;'}">${nextStep.buttonText || ''}</a>
                    </div>

                    <div class="progress-wrap">
                      <p>Planning progress: 0%</p>
                      <div class="progress-bar">
                        <div class="progress-fill"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `
          : `<p>You have not added a cruise yet. Add your first cruise below.</p>`
      }
    </div>

    <div class="planner-feature-grid">
      <div class="feature-card" onclick="renderChecklist()" style="cursor:pointer;">
  <strong>📋 Cruise Checklist</strong>
  <p>Stay on top of what needs to be done before you sail.</p>
  <span class="coming-soon">Open Checklist</span>
</div>

      <div class="feature-card">
        <strong>🧳 Packing List</strong>
        <p>Keep track of what to pack and what to buy.</p>
        <span class="coming-soon">Coming soon</span>
      </div>

      <div class="feature-card">
        <strong>💰 Budget Planner</strong>
        <p>Plan onboard spending, shore tours and extras.</p>
        <span class="coming-soon">Coming soon</span>
      </div>

      <div class="feature-card">
        <strong>🍹 Drinks Calculator</strong>
        <p>Compare package value against buying drinks as you go.</p>
        <span class="coming-soon">Coming soon</span>
      </div>

      <div class="feature-card">
        <strong>📄 Documents</strong>
        <p>Keep important cruise details in one place.</p>
        <span class="coming-soon">Coming soon</span>
      </div>

      <div class="feature-card">
        <strong>📝 Notes</strong>
        <p>Save your own reminders and planning notes.</p>
        <span class="coming-soon">Coming soon</span>
      </div>
    </div>

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

    <div class="planner-card">
      <h2>Your Cruises</h2>
      ${
        error
          ? `<p>Could not load cruises.</p>`
          : cruises.length
            ? cruises.map(cruise => `
                <div class="cruise-list-item">
                  <div>
                    ${renderLogoMarkup(cruise.cruise_line)}
                    <div class="cruise-list-title">${cruise.cruise_line}</div>
                    <div>${cruise.ship_name || "Ship not added"}</div>
                  </div>
                  <div>
                    <strong>Departs</strong><br>
                    ${formatDate(cruise.departure_date)}<br>
                    ${formatTime(cruise.departure_time)}
                  </div>
                  <div>
                    <strong>Nights</strong><br>
                    ${cruise.nights || "Not added"}
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

  if (mainCruise) {
    startLiveCountdown(mainCruise);
  }
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

  const { error } = await supabaseClient.from("cruises").insert({
    user_id: currentUser.id,
    cruise_line: cruiseLine,
    ship_name: shipName,
    departure_date: departureDate || null,
    departure_time: departureTime || "17:00",
    nights: nights || null
  });

  if (error) {
    document.getElementById("cruise-message").innerText = error.message;
    return;
  }

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
