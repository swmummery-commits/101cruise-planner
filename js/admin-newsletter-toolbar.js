/*
 * Newsletter toolbar visual priority.
 *
 * Keeps the existing newsletter composer behaviour intact while making
 * "New Newsletter" the obvious primary action and moving the existing
 * newsletter selector behind a compact secondary control.
 */
(function (global) {
  "use strict";

  const composer = global.NewsletterIssueComposer;
  if (!composer || composer.__compactToolbarApplied) return;

  const originalRender = composer.render.bind(composer);
  let existingPickerOpen = false;

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

  function enhancedRender() {
    ensureStyles();
    const html = originalRender();
    const template = document.createElement("template");
    template.innerHTML = html;
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

  composer.render = enhancedRender;
  composer.__compactToolbarApplied = true;

  global.NewsletterToolbar = {
    toggleExisting,
    openExisting
  };
})(window);
