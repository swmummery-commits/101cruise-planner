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
let activeTab = "cruise-lines";
let editingShipId = null;
let editingCruiseLineId = null;
let editingChecklistItemId = null;
let editingChecklistSectionId = null;
let selectedChecklistSectionId = "all";

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
}

function setTab(tab) {
  activeTab = tab;
  editingShipId = null;
  editingCruiseLineId = null;
  editingChecklistItemId = null;
  editingChecklistSectionId = null;
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
        <div>
          <button class="admin-button black" onclick="adminSignOut()">Sign Out</button>
        </div>
      </div>
    </div>

    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === "cruise-lines" ? "active" : ""}" onclick="setTab('cruise-lines')">Cruise Lines</button>
      <button class="admin-tab ${activeTab === "ships" ? "active" : ""}" onclick="setTab('ships')">Ships</button>
      <button class="admin-tab ${activeTab === "checklist" ? "active" : ""}" onclick="setTab('checklist')">Checklist</button>
    </div>

    ${activeTab === "cruise-lines" ? renderCruiseLinesPanel() : ""}
    ${activeTab === "ships" ? renderShipsPanel() : ""}
    ${activeTab === "checklist" ? renderChecklistPanel() : ""}
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
