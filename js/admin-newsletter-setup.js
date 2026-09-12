/*
 * Newsletter setup enhancement.
 *
 * Keeps the existing newsletter composer and specials workflow intact while
 * providing a simple New Newsletter setup screen and persistent issue-level
 * opening copy.
 */
(function (global) {
  "use strict";

  const composer = global.NewsletterIssueComposer;
  if (!composer) return;

  const originals = {
    render: composer.render.bind(composer),
    createNewsletter: composer.createNewsletter.bind(composer),
    startIssue: composer.startIssue?.bind(composer),
    saveNewsletter: composer.saveNewsletter.bind(composer),
    openNewsletterById: composer.openNewsletterById.bind(composer),
    selectIssueNumber: composer.selectIssueNumber.bind(composer),
    startNewNewsletter: composer.startNewNewsletter.bind(composer),
    getSelectedIssue: composer.getSelectedIssue.bind(composer),
    preview: composer.preview.bind(composer),
    exportHtml: composer.exportHtml.bind(composer),
    printRecord: composer.printRecord?.bind(composer)
  };

  const savedEditorial = new Map();
  const editorDrafts = new Map();
  const loadingEditorial = new Map();
  let createDraft = null;
  let pendingCreate = null;
  let localMessage = "";
  let localMessageTone = "";

  const emptyEditorial = () => ({
    tease: "",
    headline: "",
    intro: "",
    airline_intro: ""
  });

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function wordCount(value) {
    const text = String(value || "").trim();
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  }

  function todayLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function nextNewsletterNumber() {
    const nums = [];
    const newsletters = Array.isArray(global.newsletters) ? global.newsletters : [];
    for (const row of newsletters) {
      const n = Number(row?.newsletter_number);
      if (Number.isFinite(n)) nums.push(n);
    }
    const cruises = Array.isArray(global.featuredCruises) ? global.featuredCruises : [];
    for (const row of cruises) {
      const n = Number(row?.newsletter_number);
      if (Number.isFinite(n)) nums.push(n);
    }
    const defaultNumber = Number(global.featuredNewsletterDefaults?.newsletter_number);
    if (Number.isFinite(defaultNumber)) nums.push(defaultNumber);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }

  function normalizeEditorial(row) {
    return {
      tease: String(row?.tease || ""),
      headline: String(row?.headline || ""),
      intro: String(row?.intro || ""),
      airline_intro: String(row?.airline_intro || "")
    };
  }

  function activeNewsletter() {
    return composer.getActiveNewsletter?.() || null;
  }

  function editorialFor(active) {
    if (!active?.id) return emptyEditorial();
    if (editorDrafts.has(active.id)) return editorDrafts.get(active.id);
    if (savedEditorial.has(active.id)) return savedEditorial.get(active.id);
    if (
      pendingCreate &&
      Number(pendingCreate.newsletter_number) === Number(active.newsletter_number)
    ) {
      return normalizeEditorial(pendingCreate);
    }
    return emptyEditorial();
  }

  async function hydrateNewsletter(newsletterId, { rerender = true } = {}) {
    if (!newsletterId) return emptyEditorial();
    if (savedEditorial.has(newsletterId)) return savedEditorial.get(newsletterId);
    if (loadingEditorial.has(newsletterId)) return loadingEditorial.get(newsletterId);

    const promise = (async () => {
      const client = global.supabaseClient;
      if (!client) return emptyEditorial();
      const { data, error } = await client
        .from("newsletters")
        .select("id,tease,headline,intro,airline_intro")
        .eq("id", newsletterId)
        .single();
      if (error) {
        console.warn("Newsletter opening copy load failed", error.message);
        return emptyEditorial();
      }
      const value = normalizeEditorial(data);
      savedEditorial.set(newsletterId, value);
      if (rerender && activeNewsletter()?.id === newsletterId && typeof global.renderAdmin === "function") {
        global.renderAdmin();
      }
      return value;
    })().finally(() => loadingEditorial.delete(newsletterId));

    loadingEditorial.set(newsletterId, promise);
    return promise;
  }

  async function ensureActiveHydrated() {
    const active = activeNewsletter();
    if (!active?.id) return emptyEditorial();
    if (editorDrafts.has(active.id)) return editorDrafts.get(active.id);
    return hydrateNewsletter(active.id, { rerender: false });
  }

  function setLocalMessage(text, tone) {
    localMessage = String(text || "");
    localMessageTone = tone || "";
    const box = document.getElementById("newsletterEditorialMessage") || document.getElementById("newsletterCreateSetupMessage");
    if (box) {
      box.textContent = localMessage;
      box.className = `admin-message newsletter-editorial-message ${tone === "error" ? "admin-error" : tone === "success" ? "admin-success" : ""}`;
      box.hidden = !localMessage;
    }
  }

  function validateEditorial(editorial, { creating = false } = {}) {
    const teaseWords = wordCount(editorial.tease);
    if (teaseWords > 9) return `Tease must be 9 words or fewer. It is currently ${teaseWords} words.`;

    const headlineWords = wordCount(editorial.headline);
    if (creating && !headlineWords) return "Enter a headline before creating the newsletter.";
    if (headlineWords && (headlineWords < 8 || headlineWords > 16)) {
      return `Headline must be between 8 and 16 words. It is currently ${headlineWords} words.`;
    }
    return "";
  }

  function createValues() {
    const base = createDraft || pendingCreate || {
      newsletter_number: nextNewsletterNumber(),
      newsletter_date: todayLocal(),
      ...emptyEditorial()
    };
    return {
      newsletter_number: Number(base.newsletter_number || nextNewsletterNumber()),
      newsletter_date: String(base.newsletter_date || todayLocal()),
      ...normalizeEditorial(base)
    };
  }

  function readCreateForm() {
    return {
      newsletter_number: Number(document.getElementById("newsletterCreateNumber")?.value || nextNewsletterNumber()),
      newsletter_date: String(document.getElementById("newsletterCreateDate")?.value || "").trim(),
      tease: String(document.getElementById("newsletterCreateTease")?.value || "").trim(),
      headline: String(document.getElementById("newsletterCreateHeadline")?.value || "").trim(),
      intro: String(document.getElementById("newsletterCreateIntro")?.value || "").trim(),
      airline_intro: String(document.getElementById("newsletterCreateAirlineIntro")?.value || "").trim()
    };
  }

  function readEditorForm() {
    const active = activeNewsletter();
    const fallback = editorialFor(active);
    return {
      tease: String(document.getElementById("newsletterWorkspaceTease")?.value ?? fallback.tease).trim(),
      headline: String(document.getElementById("newsletterWorkspaceHeadline")?.value ?? fallback.headline).trim(),
      intro: String(document.getElementById("newsletterWorkspaceIntro")?.value ?? fallback.intro).trim(),
      airline_intro: String(document.getElementById("newsletterWorkspaceAirlineIntro")?.value ?? fallback.airline_intro).trim()
    };
  }

  function countClass(count, min, max) {
    if (max != null && count > max) return " newsletter-word-count--error";
    if (min != null && count > 0 && count < min) return " newsletter-word-count--warn";
    return "";
  }

  function createPanelHtml(values) {
    const teaseWords = wordCount(values.tease);
    const headlineWords = wordCount(values.headline);
    return `
      <h4>New Newsletter</h4>
      <p class="admin-muted">Set the opening copy once, then go straight into the newsletter to add specials. The design template can still be changed later.</p>
      <div class="newsletter-setup-grid">
        <div class="admin-field">
          <label for="newsletterCreateNumber">Newsletter Number</label>
          <input id="newsletterCreateNumber" type="number" min="1" step="1" value="${esc(values.newsletter_number)}" readonly aria-readonly="true">
          <span class="admin-helper">Automatically assigned from the latest newsletter. You can change it later if needed.</span>
        </div>
        <div class="admin-field">
          <label for="newsletterCreateDate">Publish Date <span class="admin-required">*</span></label>
          <input id="newsletterCreateDate" type="date" value="${esc(values.newsletter_date)}" oninput="NewsletterSetup.captureCreateDraft()">
        </div>
        <div class="admin-field newsletter-setup-wide">
          <label for="newsletterCreateTease">Tease <span class="admin-helper-inline">up to 9 words</span></label>
          <input id="newsletterCreateTease" type="text" value="${esc(values.tease)}" oninput="NewsletterSetup.captureCreateDraft(); NewsletterSetup.refreshCounts()" autocomplete="off">
          <span id="newsletterCreateTeaseCount" class="newsletter-word-count${countClass(teaseWords, null, 9)}">${teaseWords} / 9 words</span>
        </div>
        <div class="admin-field newsletter-setup-wide">
          <label for="newsletterCreateHeadline">Headline <span class="admin-required">*</span> <span class="admin-helper-inline">8 to 16 words</span></label>
          <input id="newsletterCreateHeadline" type="text" value="${esc(values.headline)}" oninput="NewsletterSetup.captureCreateDraft(); NewsletterSetup.refreshCounts()" autocomplete="off">
          <span id="newsletterCreateHeadlineCount" class="newsletter-word-count${countClass(headlineWords, 8, 16)}">${headlineWords} / 8–16 words</span>
        </div>
        <div class="admin-field newsletter-setup-wide">
          <label for="newsletterCreateIntro">Intro</label>
          <textarea id="newsletterCreateIntro" rows="5" oninput="NewsletterSetup.captureCreateDraft()">${esc(values.intro)}</textarea>
        </div>
        <div class="admin-field newsletter-setup-wide">
          <label for="newsletterCreateAirlineIntro">Airline Intro <span class="admin-helper-inline">optional</span></label>
          <textarea id="newsletterCreateAirlineIntro" rows="5" oninput="NewsletterSetup.captureCreateDraft()">${esc(values.airline_intro)}</textarea>
        </div>
      </div>
      <div id="newsletterCreateSetupMessage" class="admin-message newsletter-editorial-message ${localMessageTone === "error" ? "admin-error" : localMessageTone === "success" ? "admin-success" : ""}" ${localMessage ? "" : "hidden"}>${esc(localMessage)}</div>
      <div class="admin-actions-row newsletter-setup-actions">
        <button type="button" class="admin-button black" onclick="NewsletterIssueComposer.createNewsletter()">Create Newsletter &amp; Add Specials</button>
      </div>
    `;
  }

  function editorHtml(active, editorial, loading) {
    const teaseWords = wordCount(editorial.tease);
    const headlineWords = wordCount(editorial.headline);
    const disabled = loading ? "disabled" : "";
    return `
      <section class="newsletter-editorial-editor" aria-label="Newsletter opening copy">
        <div class="admin-list-top">
          <div>
            <h4>Newsletter Opening Copy</h4>
            <p class="admin-muted">These details appear before the specials and can be changed at any time.</p>
          </div>
          ${loading ? '<span class="admin-muted">Loading…</span>' : ""}
        </div>
        <div class="newsletter-setup-grid">
          <div class="admin-field newsletter-setup-wide">
            <label for="newsletterWorkspaceTease">Tease <span class="admin-helper-inline">up to 9 words</span></label>
            <input id="newsletterWorkspaceTease" type="text" value="${esc(editorial.tease)}" ${disabled} oninput="NewsletterSetup.captureEditorDraft(); NewsletterSetup.refreshCounts()" autocomplete="off">
            <span id="newsletterWorkspaceTeaseCount" class="newsletter-word-count${countClass(teaseWords, null, 9)}">${teaseWords} / 9 words</span>
          </div>
          <div class="admin-field newsletter-setup-wide">
            <label for="newsletterWorkspaceHeadline">Headline <span class="admin-helper-inline">8 to 16 words</span></label>
            <input id="newsletterWorkspaceHeadline" type="text" value="${esc(editorial.headline)}" ${disabled} oninput="NewsletterSetup.captureEditorDraft(); NewsletterSetup.refreshCounts()" autocomplete="off">
            <span id="newsletterWorkspaceHeadlineCount" class="newsletter-word-count${countClass(headlineWords, 8, 16)}">${headlineWords} / 8–16 words</span>
          </div>
          <div class="admin-field newsletter-setup-wide">
            <label for="newsletterWorkspaceIntro">Intro</label>
            <textarea id="newsletterWorkspaceIntro" rows="5" ${disabled} oninput="NewsletterSetup.captureEditorDraft()">${esc(editorial.intro)}</textarea>
          </div>
          <div class="admin-field newsletter-setup-wide">
            <label for="newsletterWorkspaceAirlineIntro">Airline Intro <span class="admin-helper-inline">optional</span></label>
            <textarea id="newsletterWorkspaceAirlineIntro" rows="5" ${disabled} oninput="NewsletterSetup.captureEditorDraft()">${esc(editorial.airline_intro)}</textarea>
          </div>
        </div>
        <div id="newsletterEditorialMessage" class="admin-message newsletter-editorial-message ${localMessageTone === "error" ? "admin-error" : localMessageTone === "success" ? "admin-success" : ""}" ${localMessage ? "" : "hidden"}>${esc(localMessage)}</div>
      </section>
    `;
  }

  function enhanceWording(root) {
    const dateLabel = root.querySelector('label[for="newsletterWorkspaceDate"]');
    if (dateLabel) dateLabel.textContent = "Publish Date";

    for (const button of root.querySelectorAll("button")) {
      const label = button.textContent.trim();
      if (label === "+ Add Cruise") button.textContent = "+ Add Special";
    }
    for (const heading of root.querySelectorAll("h4")) {
      if (heading.textContent.trim() === "Cruises in this newsletter") heading.textContent = "Specials in this newsletter";
      if (heading.textContent.trim() === "Cruises not in a newsletter yet") heading.textContent = "Specials not in a newsletter yet";
    }
    for (const p of root.querySelectorAll("p")) {
      const text = p.textContent.trim();
      if (text === "No cruises in this newsletter yet. Use Add Cruise to create a new cruise for this newsletter.") {
        p.textContent = "No specials in this newsletter yet. Use Add Special to create the first one.";
      }
    }
    for (const message of root.querySelectorAll(".admin-message")) {
      if (message.textContent.includes("created. Add cruises below.")) {
        message.textContent = message.textContent.replace("Add cruises below.", "Add specials below.");
      }
    }
  }

  function enhancedRender() {
    const html = originals.render();
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const root = tpl.content;
    const active = activeNewsletter();

    if (!active) {
      const panel = root.querySelector(".newsletter-workspace-create");
      if (panel) panel.innerHTML = createPanelHtml(createValues());
    } else {
      const baseFields = root.querySelector(".newsletter-workspace-fields");
      if (baseFields && !root.querySelector(".newsletter-editorial-editor")) {
        const loading = !savedEditorial.has(active.id) && !editorDrafts.has(active.id) && !(
          pendingCreate && Number(pendingCreate.newsletter_number) === Number(active.newsletter_number)
        );
        const holder = document.createElement("div");
        holder.innerHTML = editorHtml(active, editorialFor(active), loading);
        baseFields.insertAdjacentElement("afterend", holder.firstElementChild);
        if (loading) hydrateNewsletter(active.id).catch(() => {});
      }
    }

    enhanceWording(root);
    return tpl.innerHTML;
  }

  function captureCreateDraft() {
    createDraft = readCreateForm();
  }

  function captureEditorDraft() {
    const active = activeNewsletter();
    if (!active?.id) return;
    editorDrafts.set(active.id, readEditorForm());
  }

  function refreshCounts() {
    const pairs = [
      ["newsletterCreateTease", "newsletterCreateTeaseCount", null, 9, " / 9 words"],
      ["newsletterCreateHeadline", "newsletterCreateHeadlineCount", 8, 16, " / 8–16 words"],
      ["newsletterWorkspaceTease", "newsletterWorkspaceTeaseCount", null, 9, " / 9 words"],
      ["newsletterWorkspaceHeadline", "newsletterWorkspaceHeadlineCount", 8, 16, " / 8–16 words"]
    ];
    for (const [inputId, countId, min, max, suffix] of pairs) {
      const input = document.getElementById(inputId);
      const output = document.getElementById(countId);
      if (!input || !output) continue;
      const count = wordCount(input.value);
      output.textContent = `${count}${suffix}`;
      output.className = `newsletter-word-count${countClass(count, min, max)}`;
    }
  }

  async function createNewsletter() {
    const values = readCreateForm();
    createDraft = values;
    const error = validateEditorial(values, { creating: true });
    if (error) {
      setLocalMessage(error, "error");
      refreshCounts();
      return;
    }
    if (!values.newsletter_date) {
      setLocalMessage("Choose a publish date before creating the newsletter.", "error");
      return;
    }

    localMessage = "";
    localMessageTone = "";
    pendingCreate = values;
    await originals.createNewsletter();

    const active = activeNewsletter();
    if (!active?.id || Number(active.newsletter_number) !== Number(values.newsletter_number)) {
      pendingCreate = null;
      return;
    }

    const client = global.supabaseClient;
    if (!client) {
      setLocalMessage("The newsletter was created, but the opening copy could not be saved because the database client is unavailable.", "error");
      return;
    }

    const editorial = normalizeEditorial(values);
    const { error: saveError } = await client
      .from("newsletters")
      .update(editorial)
      .eq("id", active.id);

    if (saveError) {
      editorDrafts.set(active.id, editorial);
      setLocalMessage(`Newsletter ${values.newsletter_number} was created, but the opening copy did not save: ${saveError.message}`, "error");
    } else {
      savedEditorial.set(active.id, editorial);
      editorDrafts.delete(active.id);
      setLocalMessage("", "");
    }

    pendingCreate = null;
    createDraft = null;
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  async function saveNewsletter() {
    const active = activeNewsletter();
    if (!active?.id) return originals.saveNewsletter();

    await ensureActiveHydrated();
    const editorial = readEditorForm();
    editorDrafts.set(active.id, editorial);
    const error = validateEditorial(editorial, { creating: false });
    if (error) {
      setLocalMessage(error, "error");
      refreshCounts();
      return;
    }

    const client = global.supabaseClient;
    if (!client) {
      setLocalMessage("Database client is not ready.", "error");
      return;
    }

    const { error: editorialError } = await client
      .from("newsletters")
      .update(editorial)
      .eq("id", active.id);
    if (editorialError) {
      setLocalMessage(editorialError.message || "Could not save the newsletter opening copy.", "error");
      return;
    }

    savedEditorial.set(active.id, editorial);
    editorDrafts.delete(active.id);
    setLocalMessage("", "");
    return originals.saveNewsletter();
  }

  async function openNewsletterById(newsletterId) {
    localMessage = "";
    localMessageTone = "";
    const result = await originals.openNewsletterById(newsletterId);
    const active = activeNewsletter();
    if (active?.id) await hydrateNewsletter(active.id);
    return result;
  }

  async function selectIssueNumber(value) {
    localMessage = "";
    localMessageTone = "";
    const result = await originals.selectIssueNumber(value);
    const active = activeNewsletter();
    if (active?.id) await hydrateNewsletter(active.id);
    return result;
  }

  function startNewNewsletter() {
    createDraft = null;
    pendingCreate = null;
    localMessage = "";
    localMessageTone = "";
    return originals.startNewNewsletter();
  }

  function openingCopyHtml(editorial, outputMode) {
    const tease = String(editorial?.tease || "").trim();
    const headline = String(editorial?.headline || "").trim();
    const intro = String(editorial?.intro || "").trim();
    const airlineIntro = outputMode === "airline_staff" ? String(editorial?.airline_intro || "").trim() : "";
    if (!tease && !headline && !intro && !airlineIntro) return "";

    const paragraphs = (value) =>
      String(value || "")
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map(
          (p) =>
            `<p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#202020;text-align:center;">${esc(p).replace(/\n/g, "<br>")}</p>`
        )
        .join("");

    return `
<table role="presentation" class="cr101-issue-opening" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F7F7" style="width:100%;border-collapse:collapse;background-color:#F7F7F7;">
  <tr>
    <td align="center" bgcolor="#F7F7F7" style="padding:0;background-color:#F7F7F7;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:36px 28px 26px;">
            ${tease ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#245C4E;margin:0 0 14px;">${esc(tease)}</div>` : ""}
            ${headline ? `<div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;line-height:1.2;color:#111111;text-align:center;margin:0 0 20px;">${esc(headline)}</div>` : ""}
            ${intro ? `<div style="margin:0 auto;max-width:540px;">${paragraphs(intro)}</div>` : ""}
            ${airlineIntro ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:20px;border-collapse:separate;border-radius:14px;background-color:#D9F2E8;"><tr><td align="center" style="padding:18px 22px;"><div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#245C4E;margin-bottom:8px;">Airline Staff</div>${paragraphs(airlineIntro)}</td></tr></table>` : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
  }

  function installOpeningCopyExport() {
    const api = global.NewsletterMailchimpExport;
    if (!api?.composeIssueHtml || api.composeIssueHtml.__newsletterSetupWrapped) return;
    const originalCompose = api.composeIssueHtml.bind(api);
    const wrapped = function (payloads, options = {}) {
      const result = originalCompose(payloads, options);
      if (!result?.ok) return result;
      const active = activeNewsletter();
      const editorial = editorialFor(active);
      const opening = openingCopyHtml(editorial, options.outputMode);
      if (!opening) return result;
      const combined = `${opening}${result.html}`;
      const previewHtml = result.previewHtml?.includes(result.html)
        ? result.previewHtml.replace(result.html, combined)
        : `<div class="cr101-admin-preview" style="background:#F7F7F7;padding:16px;overflow:auto;">${combined}</div>`;
      return { ...result, html: combined, previewHtml };
    };
    wrapped.__newsletterSetupWrapped = true;
    api.composeIssueHtml = wrapped;
  }

  async function preview(mode) {
    await ensureActiveHydrated();
    installOpeningCopyExport();
    return originals.preview(mode);
  }

  async function exportHtml(mode, action) {
    await ensureActiveHydrated();
    installOpeningCopyExport();
    return originals.exportHtml(mode, action);
  }

  async function printRecord() {
    await ensureActiveHydrated();
    installOpeningCopyExport();
    return originals.printRecord?.();
  }

  function ensureStyles() {
    if (document.getElementById("newsletterSetupStyles")) return;
    const style = document.createElement("style");
    style.id = "newsletterSetupStyles";
    style.textContent = `
      .newsletter-setup-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:14px}
      .newsletter-setup-wide{grid-column:1/-1}
      .newsletter-setup-actions{margin-top:18px;justify-content:flex-end}
      .newsletter-workspace-create textarea,.newsletter-editorial-editor textarea{width:100%;resize:vertical;min-height:108px}
      .newsletter-editorial-editor{margin:16px 0 20px;padding:18px;border:1px solid #e3e7e5;border-radius:14px;background:#fff}
      .newsletter-editorial-editor .admin-list-top{margin-bottom:4px}
      .admin-helper-inline{font-size:12px;font-weight:400;color:#6b7280;margin-left:5px}
      .newsletter-word-count{display:block;margin-top:6px;font-size:12px;color:#6b7280;text-align:right}
      .newsletter-word-count--warn{color:#9a6700}
      .newsletter-word-count--error{color:#b42318;font-weight:700}
      .newsletter-editorial-message[hidden]{display:none}
      @media (max-width:760px){.newsletter-setup-grid{grid-template-columns:1fr}.newsletter-setup-wide{grid-column:auto}.newsletter-setup-actions{justify-content:stretch}.newsletter-setup-actions .admin-button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  composer.render = enhancedRender;
  composer.createNewsletter = createNewsletter;
  composer.startIssue = createNewsletter;
  composer.saveNewsletter = saveNewsletter;
  composer.openNewsletterById = openNewsletterById;
  composer.selectIssueNumber = selectIssueNumber;
  composer.startNewNewsletter = startNewNewsletter;
  composer.getSelectedIssue = function () {
    const base = originals.getSelectedIssue();
    return { ...base, ...editorialFor(activeNewsletter()) };
  };
  composer.preview = preview;
  composer.exportHtml = exportHtml;
  if (originals.printRecord) composer.printRecord = printRecord;

  global.NewsletterSetup = {
    captureCreateDraft,
    captureEditorDraft,
    refreshCounts,
    hydrateNewsletter,
    nextNewsletterNumber
  };

  ensureStyles();
  installOpeningCopyExport();
})(typeof window !== "undefined" ? window : globalThis);
