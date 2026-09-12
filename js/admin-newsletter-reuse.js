/*
 * Reuse Previous Special
 *
 * Copies a cruise special from another newsletter into the currently open
 * newsletter. The original cruise, its pricing and itinerary remain untouched.
 */
(function (global) {
  "use strict";

  const composer = global.NewsletterIssueComposer;
  if (!composer || composer.__reusePreviousSpecialApplied) return;

  const originalRender = composer.render.bind(composer);
  let pickerOpen = false;
  let searchTerm = "";
  let copyingId = null;
  let message = "";
  let messageTone = "";

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (typeof global.formatAdminDate === "function") return global.formatAdminDate(value);
    return value || "";
  }

  function currentIssue() {
    return composer.getSelectedIssue?.() || {};
  }

  function previousSpecials() {
    const issue = currentIssue();
    const q = searchTerm.trim().toLowerCase();
    const rows = Array.isArray(global.featuredCruises) ? global.featuredCruises : [];

    return rows
      .filter((row) => {
        if (!row?.id || !row.newsletter_id) return false;
        if (issue.id && row.newsletter_id === issue.id) return false;
        if (issue.number != null && Number(row.newsletter_number) === Number(issue.number)) return false;
        if (!q) return true;
        const haystack = [
          row.headline,
          row.destination_strip,
          row.departure_port,
          row.arrival_port,
          row.ci_cruise_lines?.name,
          row.ci_cruise_ships?.name,
          row.newsletter_number != null ? `newsletter ${row.newsletter_number}` : ""
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => {
        const newsletterOrder = Number(b.newsletter_number || 0) - Number(a.newsletter_number || 0);
        if (newsletterOrder) return newsletterOrder;
        const displayOrder = Number(a.display_order || 0) - Number(b.display_order || 0);
        if (displayOrder) return displayOrder;
        return String(a.headline || "").localeCompare(String(b.headline || ""), "en");
      });
  }

  function ensureStyles() {
    if (document.getElementById("newsletterReuseStyles")) return;
    const style = document.createElement("style");
    style.id = "newsletterReuseStyles";
    style.textContent = `
      #cruise-admin-app .newsletter-reuse-button{white-space:nowrap}
      #cruise-admin-app .newsletter-reuse-overlay{position:fixed;inset:0;z-index:1500;background:rgba(17,24,22,.46);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
      #cruise-admin-app .newsletter-reuse-dialog{width:min(760px,100%);max-height:min(760px,88vh);overflow:hidden;background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.22);display:flex;flex-direction:column}
      #cruise-admin-app .newsletter-reuse-head{padding:20px 22px 12px;border-bottom:1px solid #ececec}
      #cruise-admin-app .newsletter-reuse-head .admin-list-top{margin-bottom:12px}
      #cruise-admin-app .newsletter-reuse-search{margin:0}
      #cruise-admin-app .newsletter-reuse-search input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ccc;border-radius:10px;font:inherit}
      #cruise-admin-app .newsletter-reuse-message{padding:0 22px;margin:10px 0 0}
      #cruise-admin-app .newsletter-reuse-list{overflow:auto;padding:12px 22px 22px;display:flex;flex-direction:column;gap:10px}
      #cruise-admin-app .newsletter-reuse-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;border:1px solid #e5e7e6;border-radius:13px;padding:14px;background:#fff}
      #cruise-admin-app .newsletter-reuse-copy{min-width:0}
      #cruise-admin-app .newsletter-reuse-copy strong{display:block;font-size:14px;line-height:1.35;margin-bottom:5px}
      #cruise-admin-app .newsletter-reuse-meta{font-size:12px;color:#666;line-height:1.45}
      #cruise-admin-app .newsletter-reuse-empty{padding:20px 0;color:#666;text-align:center}
      @media(max-width:640px){
        #cruise-admin-app .newsletter-reuse-overlay{padding:10px}
        #cruise-admin-app .newsletter-reuse-row{grid-template-columns:1fr}
        #cruise-admin-app .newsletter-reuse-row .admin-button{width:100%;margin:0}
      }
    `;
    document.head.appendChild(style);
  }

  function pickerHtml() {
    if (!pickerOpen) return "";
    const issue = currentIssue();
    const rows = previousSpecials();
    const toneClass = messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : "";

    return `
      <div class="newsletter-reuse-overlay" onclick="if(event.target===this) NewsletterReuse.close()">
        <section class="newsletter-reuse-dialog" role="dialog" aria-modal="true" aria-label="Reuse Previous Special">
          <div class="newsletter-reuse-head">
            <div class="admin-list-top">
              <div>
                <h3>Reuse Previous Special</h3>
                <p class="admin-muted">Copy a special into Newsletter ${esc(issue.number ?? "")}. The original newsletter and its pricing will not be changed.</p>
              </div>
              <button type="button" class="admin-button secondary small" onclick="NewsletterReuse.close()" ${copyingId ? "disabled" : ""}>Close</button>
            </div>
            <div class="newsletter-reuse-search">
              <input id="newsletterReuseSearch" type="search" value="${esc(searchTerm)}" placeholder="Search cruise, ship, cruise line or newsletter number" oninput="NewsletterReuse.search(this.value)" autocomplete="off">
            </div>
          </div>
          ${message ? `<div class="admin-message newsletter-reuse-message ${toneClass}">${esc(message)}</div>` : ""}
          <div class="newsletter-reuse-list">
            ${rows.length ? rows.map((row) => {
              const line = row.ci_cruise_lines?.name || "Cruise line not set";
              const ship = row.ci_cruise_ships?.name || "Ship not set";
              const date = row.newsletter_publication_date ? ` · ${formatDate(row.newsletter_publication_date)}` : "";
              const busy = copyingId === row.id;
              return `
                <article class="newsletter-reuse-row">
                  <div class="newsletter-reuse-copy">
                    <strong>${esc(row.headline || "Untitled special")}</strong>
                    <div class="newsletter-reuse-meta">Newsletter ${esc(row.newsletter_number ?? "—")}${esc(date)} · ${esc(line)} · ${esc(ship)}</div>
                  </div>
                  <button type="button" class="admin-button black small" onclick="NewsletterReuse.copy('${esc(row.id)}')" ${copyingId ? "disabled" : ""}>${busy ? "Copying…" : "Reuse Special"}</button>
                </article>`;
            }).join("") : `<div class="newsletter-reuse-empty">No previous specials match this search.</div>`}
          </div>
        </section>
      </div>
    `;
  }

  function addButton(root) {
    const issue = currentIssue();
    if (!issue?.id) return;

    const buttons = Array.from(root.querySelectorAll("button"));
    const addSpecial = buttons.find((button) => button.textContent.trim() === "+ Add Special");
    if (!addSpecial || root.querySelector(".newsletter-reuse-button")) return;

    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.className = "admin-button secondary newsletter-reuse-button";
    reuse.textContent = "Reuse Previous Special";
    reuse.setAttribute("onclick", "NewsletterReuse.open()");
    if (addSpecial.disabled) reuse.disabled = true;
    addSpecial.insertAdjacentElement("afterend", reuse);
  }

  function enhancedRender() {
    ensureStyles();
    const html = originalRender();
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;
    addButton(root);

    const composerRoot = root.querySelector(".newsletter-issue-composer");
    if (composerRoot && pickerOpen) composerRoot.insertAdjacentHTML("beforeend", pickerHtml());
    return template.innerHTML;
  }

  function open() {
    const issue = currentIssue();
    if (!issue?.id) return;
    pickerOpen = true;
    searchTerm = "";
    message = "";
    messageTone = "";
    global.renderAdmin?.();
    setTimeout(() => document.getElementById("newsletterReuseSearch")?.focus(), 0);
  }

  function close() {
    if (copyingId) return;
    pickerOpen = false;
    searchTerm = "";
    message = "";
    messageTone = "";
    global.renderAdmin?.();
  }

  function search(value) {
    searchTerm = String(value || "");
    global.renderAdmin?.();
    setTimeout(() => {
      const input = document.getElementById("newsletterReuseSearch");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  }

  async function copy(sourceId) {
    if (copyingId) return;
    const issue = currentIssue();
    if (!issue?.id) {
      message = "Open a newsletter before reusing a special.";
      messageTone = "error";
      global.renderAdmin?.();
      return;
    }
    const client = global.supabaseClient;
    if (!client) {
      message = "Database client is not ready.";
      messageTone = "error";
      global.renderAdmin?.();
      return;
    }

    try {
      copyingId = sourceId;
      message = "Copying the special, pricing and itinerary…";
      messageTone = "";
      global.renderAdmin?.();

      const { data, error } = await client.rpc("reuse_featured_cruise", {
        p_source_cruise_id: sourceId,
        p_target_newsletter_id: issue.id
      });
      if (error) throw new Error(error.message || "Could not reuse the special.");

      const result = Array.isArray(data) ? data[0] : data;
      const newId = result?.new_cruise_id;
      if (!newId) throw new Error("The copy was created but its new record could not be identified.");

      if (typeof global.loadFeaturedCruises === "function") {
        await global.loadFeaturedCruises();
      }

      pickerOpen = false;
      copyingId = null;
      searchTerm = "";
      message = "";
      messageTone = "";

      if (typeof global.editFeaturedCruise === "function") {
        await global.editFeaturedCruise(newId);
      } else {
        global.renderAdmin?.();
      }
    } catch (error) {
      copyingId = null;
      message = error?.message || "Could not reuse the special.";
      messageTone = "error";
      global.renderAdmin?.();
    }
  }

  composer.render = enhancedRender;
  composer.__reusePreviousSpecialApplied = true;

  global.NewsletterReuse = { open, close, search, copy };
})(window);
