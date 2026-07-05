const SUPABASE_URL = "https://xikbibxyinttllxamgao.supabase.co";
const SUPABASE_KEY = "sb_publishable_MEFg6spz5_Uod7sZGU8whw_UvOQDW60";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("cruise-admin-app");

let currentUser = null;
let currentProfile = null;
let cruiseLines = [];
let ships = [];
let activeTab = "cruise-lines";
let editingShipId = null;

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

function renderLogin(message = "") {
  app.innerHTML = `
    <div class="admin-card">
      <h2>101cruise Admin</h2>
      <p class="admin-muted">Sign in with your admin account to manage cruise lines and ships.</p>

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
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  const { data: shipRows, error: shipsError } = await supabaseClient
    .from("ships")
    .select("*, cruise_lines(name)")
    .order("name", { ascending: true });

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
}

function setTab(tab) {
  activeTab = tab;
  editingShipId = null;
  renderAdmin();
}

function renderAdmin() {
  app.innerHTML = `
    <div class="admin-card">
      <div class="admin-list-top">
        <div>
          <h2>101cruise Admin</h2>
          <p class="admin-muted">Manage cruise lines, logos, ships and hero images for My Cruise Planner.</p>
        </div>
        <div>
          <button class="admin-button black" onclick="adminSignOut()">Sign Out</button>
        </div>
      </div>
    </div>

    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === "cruise-lines" ? "active" : ""}" onclick="setTab('cruise-lines')">Cruise Lines</button>
      <button class="admin-tab ${activeTab === "ships" ? "active" : ""}" onclick="setTab('ships')">Ships</button>
    </div>

    ${activeTab === "cruise-lines" ? renderCruiseLinesPanel() : renderShipsPanel()}
  `;
}

function renderCruiseLinesPanel() {
  return `
    <div class="admin-card">
      <h3>Cruise Lines</h3>
      <p class="admin-muted">Paste the Squarespace logo URL beside the correct cruise line, then click <strong>Save Logo</strong>. This updates the existing cruise line rather than creating a new one.</p>
      <div id="line-global-message" class="admin-message"></div>

      ${cruiseLines.length ? cruiseLines.map(line => `
        <div class="admin-list-item" id="line-card-${line.id}">
          <div class="admin-inline-grid">
            <div>
              <h3 style="margin-bottom:4px;">${esc(line.name)}</h3>
              <div class="admin-small">Display order: ${esc(line.display_order || 999)}</div>
              ${line.active ? `<span class="admin-pill">Active</span>` : `<span class="admin-pill">Inactive</span>`}

              <div class="admin-field" style="margin-top:14px;">
                <label>Logo URL</label>
                <textarea id="logo-url-${line.id}" placeholder="Paste the Squarespace logo URL here">${esc(line.logo_url || "")}</textarea>
              </div>

              <div class="admin-field">
                <label>Display order</label>
                <input type="number" id="line-order-${line.id}" value="${esc(line.display_order || 999)}">
              </div>

              <button class="admin-button" onclick="saveLineLogo(${line.id})">Save Logo</button>
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
      `).join("") : `<p>No cruise lines found.</p>`}

      <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">

      <h3>Add New Cruise Line</h3>
      <p class="admin-small">Use this only for a brand-new cruise line that is not already listed above.</p>

      <div class="admin-grid">
        <div class="admin-field">
          <label>Cruise line name</label>
          <input type="text" id="newLineName" placeholder="Example: Azamara">
        </div>
        <div class="admin-field">
          <label>Display order</label>
          <input type="number" id="newLineOrder" value="999">
        </div>
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
                  ${ship.active ? `<span class="admin-pill">Active</span>` : `<span class="admin-pill">Inactive</span>`}<br>
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

async function saveLineLogo(lineId) {
  const logoUrl = normalizeUrl(document.getElementById(`logo-url-${lineId}`).value);
  const displayOrder = Number(document.getElementById(`line-order-${lineId}`).value) || 999;
  const message = document.getElementById(`line-message-${lineId}`);

  message.className = "admin-message";
  message.innerText = "Saving...";

  const { data, error } = await supabaseClient
    .from("cruise_lines")
    .update({
      logo_url: logoUrl || null,
      display_order: displayOrder,
      active: true
    })
    .eq("id", lineId)
    .select("id, name, logo_url, display_order, active");

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
  const displayOrder = Number(document.getElementById("newLineOrder").value) || 999;
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
    .insert({ name, logo_url: logoUrl || null, display_order: displayOrder, active: true })
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
