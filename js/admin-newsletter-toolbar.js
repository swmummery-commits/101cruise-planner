/*
 * Newsletter toolbar visual priority and specials-only export guard.
 *
 * Keeps the existing newsletter composer behaviour intact while making
 * "New Newsletter" the obvious primary action and moving the existing
 * newsletter selector behind a compact secondary control.
 *
 * The Tease, Headline, Intro and Airline Intro fields are admin-only for now.
 * They remain saved/editable, but are deliberately excluded from generated
 * newsletter HTML, preview HTML and Mailchimp export code.
 */
(function (global) {
  "use strict";

  const composer = global.NewsletterIssueComposer;
  if (!composer || composer.__compactToolbarApplied) return;

  const originalRender = composer.render.bind(composer);
  let existingPickerOpen = false;

  function stripOpeningCopy(markup) {
    const html = String(markup || "");
    if (!html.includes("cr101-issue-opening")) return html;

    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll(".cr101-issue-opening").forEach((node) => node.remove());
    return template.innerHTML;
  }

  function installSpecialsOnlyExport() {
    const api = global.NewsletterMailchimpExport;
    if (!api?.composeIssueHtml || api.composeIssueHtml.__specialsOnlyExport) return;

    const composeWithLegacyOpeningCopy = api.composeIssueHtml.bind(api);
    const wrapped = function (payloads, options = {}) {
      const result = composeWithLegacyOpeningCopy(payloads, options);
      if (!result) return result;
      return {
        ...result,
        html: stripOpeningCopy(result.html),
        previewHtml: stripOpeningCopy(result.previewHtml)
      };
    };

    // The setup enhancement checks this flag before attempting to install its
    // opening-copy wrapper again. Keep it true so editorial fields stay out.
    wrapped.__newsletterSetupWrapped = true;
    wrapped.__specialsOnlyExport = true;
    api.composeIssueHtml = wrapped;
  }

  function ensureStyles() {
    if (document.getElementById("newsletterCompactToolbarStyles")) return;
    const style = document.createElement("style");
    style.id = "newsletterCompactToolbarStyles";
    style.textContent = `
      #cruise-admin-app .newsletter-primary-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: 8px;
        width: 100%;
        margin: 0 0 14px;
      }

      #cruise-admin-app .newsletter-primary-toolbar .admin-button {
        margin: 0;
      }

      #cruise-admin-app .newsletter-new-primary {
        background: var(--brand-green, #8DD9BF);
        color: #000;
        padding: 11px 16px;
        font-size: 13px;
        box-shadow: 0 2px 0 rgba(0, 0, 0, 0.05);
      }

      #cruise-admin-app .newsletter-new-primary:hover,
      #cruise-admin-app .newsletter-new-primary:focus-visible {
        background: var(--brand-green-hover, #79CDB1);
      }

      #cruise-admin-app .newsletter-open-existing-button {
        padding: 9px 12px;
        font-size: 12px;
        white-space: nowrap;
      }

      #cruise-admin-app .newsletter-existing-picker {
        flex-basis: 100%;
        width: auto;
        max-width: 340px;
        margin-top: 2px;
      }

      #cruise-admin-app .newsletter-existing-picker[hidden] {
        display: none !important;
      }

      #cruise-admin-app .newsletter-existing-picker select {
        width: 100%;
        min-width: 240px;
        padding: 9px 11px;
        border: 1px solid #ccc;
        border-radius: 10px;
        background: #fff;
        color: #111;
        font: inherit;
        font-size: 13px;
        box-sizing: border-box;
      }

      #cruise-admin-app .newsletter-workspace-toolbar {
        align-items: start;
      }

      @media (max-width: 640px) {
        #cruise-admin-app .newsletter-primary-toolbar {
          align-items: stretch;
        }

        #cruise-admin-app .newsletter-new-primary,
        #cruise-admin-app .newsletter-open-existing-button {
          width: auto;
        }

        #cruise-admin-app .newsletter-existing-picker {
          max-width: 100%;
        }

        #cruise-admin-app .newsletter-existing-picker select {
          min-width: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function buildCompactToolbar(root) {
    const workspaceToolbar = root.querySelector(".newsletter-workspace-toolbar");
    if (!workspaceToolbar) return;

    const existingField = workspaceToolbar.querySelector(".newsletter-open-field");
    const existingSelect = existingField?.querySelector("#newsletterOpenSelect");
    const hasExisting = Boolean(existingSelect && existingSelect.options.length > 1);

    const compact = document.createElement("div");
    compact.className = "newsletter-primary-toolbar";

    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "admin-button newsletter-new-primary";
    newButton.textContent = "+ New Newsletter";
    newButton.setAttribute("onclick", "NewsletterIssueComposer.startNewNewsletter()");
    compact.appendChild(newButton);

    if (hasExisting) {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "admin-button secondary newsletter-open-existing-button";
      openButton.textContent = "Open Existing Newsletter";
      openButton.setAttribute("onclick", "NewsletterToolbar.toggleExisting()");
      compact.appendChild(openButton);

      const picker = document.createElement("div");
      picker.className = "newsletter-existing-picker";
      picker.id = "newsletterExistingPicker";
      picker.hidden = !existingPickerOpen;

      const select = existingSelect.cloneNode(true);
      select.removeAttribute("onchange");
      select.setAttribute("onchange", "NewsletterToolbar.openExisting(this.value)");
      select.setAttribute("aria-label", "Open existing newsletter");
      picker.appendChild(select);
      compact.appendChild(picker);
    }

    if (existingField) existingField.replaceWith(compact);
    else workspaceToolbar.prepend(compact);
  }

  function enableNewsletterNumberEditing(root) {
    const numberInput = root.querySelector("#newsletterCreateNumber");
    if (!numberInput) return;

    numberInput.removeAttribute("readonly");
    numberInput.removeAttribute("aria-readonly");
    numberInput.setAttribute("title", "The next newsletter number is suggested automatically, but you can change it.");

    const helper = numberInput.nextElementSibling;
    if (helper?.classList.contains("admin-helper")) {
      helper.textContent = "Next number suggested automatically. Change it if you need to recreate an earlier newsletter.";
    }
  }

  function enhancedRender() {
    installSpecialsOnlyExport();
    ensureStyles();
    const html = originalRender();
    const template = document.createElement("template");
    template.innerHTML = html;
    enableNewsletterNumberEditing(template.content);
    buildCompactToolbar(template.content);
    return template.innerHTML;
  }

  async function openExisting(newsletterId) {
    if (!newsletterId) return;
    existingPickerOpen = false;
    await composer.openNewsletterById(newsletterId);
  }

  function toggleExisting() {
    existingPickerOpen = !existingPickerOpen;
    const picker = document.getElementById("newsletterExistingPicker");
    if (picker) {
      picker.hidden = !existingPickerOpen;
      if (existingPickerOpen) picker.querySelector("select")?.focus();
    }
  }

  installSpecialsOnlyExport();
  composer.render = enhancedRender;
  composer.__compactToolbarApplied = true;

  global.NewsletterToolbar = {
    toggleExisting,
    openExisting
  };
})(window);
