(function (root) {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function contentOf(editorial) {
    return editorial?.content && typeof editorial.content === "object" && !Array.isArray(editorial.content)
      ? editorial.content
      : {};
  }

  function paragraphsHtml(value) {
    const clean = text(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!clean) return "";
    return clean
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => `<p>${esc(part)}</p>`)
      .join("");
  }

  function listItems(value) {
    const raw = Array.isArray(value)
      ? value
      : text(value)
        ? text(value).split(/\n+/)
        : [];
    return raw
      .map((item) => {
        if (item && typeof item === "object") return text(item.label || item.title || item.name || item.value || "");
        return text(item);
      })
      .map((item) => item.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean);
  }

  function listHtml(value) {
    const items = listItems(value);
    if (!items.length) return "";
    return `<ul class="ship-editorial-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
  }

  function faqItems(value) {
    const raw = Array.isArray(value) ? value : [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const question = text(item.question || item.q || item.title || "");
        const answer = text(item.answer || item.a || item.response || "");
        return question && answer ? { question, answer } : null;
      })
      .filter(Boolean);
  }

  function section(title, body, className) {
    if (!body) return "";
    return `
      <section class="ship-editorial-card ${className || ""}">
        <h3>${esc(title)}</h3>
        <div class="ship-editorial-copy">${body}</div>
      </section>`;
  }

  function proseSection(title, value, className) {
    return section(title, paragraphsHtml(value), className);
  }

  function listSection(title, value, className) {
    return section(title, listHtml(value), className);
  }

  function renderPaulsTip(editorial) {
    const tip = text(editorial?.pauls_tip);
    if (!tip) return "";
    return `
      <aside class="ship-editorial-pauls-tip" aria-label="Paul's Tip">
        <div class="ship-editorial-pauls-tip-label">Paul's Tip</div>
        <div class="ship-editorial-pauls-tip-copy">${paragraphsHtml(tip)}</div>
      </aside>`;
  }

  function renderPortalIntro(editorial) {
    const content = contentOf(editorial);
    const overview = text(content.overview || editorial?.summary);
    const tip = renderPaulsTip(editorial);
    if (!overview && !tip) return "";
    return `
      <div class="ship-editorial-lead ship-reveal-block">
        ${overview ? `
          <section class="ship-editorial-overview">
            <div class="ship-editorial-eyebrow">About your ship</div>
            <div class="ship-editorial-overview-copy">${paragraphsHtml(overview)}</div>
          </section>` : ""}
        ${tip}
      </div>`;
  }

  function renderFaqs(value) {
    const faqs = faqItems(value);
    if (!faqs.length) return "";
    return `
      <section class="ship-editorial-faqs">
        <div class="ship-editorial-section-head">
          <div class="ship-editorial-eyebrow">Good to know</div>
          <h2>Frequently asked questions</h2>
        </div>
        <div class="ship-editorial-faq-list">
          ${faqs.map((item) => `
            <details class="ship-editorial-faq">
              <summary>${esc(item.question)}</summary>
              <div class="ship-editorial-faq-answer">${paragraphsHtml(item.answer)}</div>
            </details>`).join("")}
        </div>
      </section>`;
  }

  function renderPortalDetails(editorial) {
    const c = contentOf(editorial);
    const highlights = listSection("Key highlights", c.key_highlights, "ship-editorial-card--wide");
    const personality = proseSection("The onboard feel", c.personality);
    const dining = proseSection("Dining", c.dining_summary);
    const accommodation = proseSection("Accommodation", c.accommodation_summary);
    const entertainment = proseSection("Entertainment", c.entertainment_summary);
    const wellness = proseSection("Wellness", c.wellness_summary);
    const dress = proseSection("Dress code", c.dress_code_summary);
    const connectivity = proseSection("Connectivity", c.connectivity_summary);
    const accessibility = proseSection("Accessibility", c.accessibility_summary);
    const families = proseSection("Families", c.family_summary);
    const solo = proseSection("Solo travellers", c.solo_traveller_summary);
    const included = listSection("Typically included", c.included_summary);
    const extras = listSection("Often extra cost", c.extra_cost_summary);

    const primary = [highlights, personality, dining, accommodation, entertainment, wellness].filter(Boolean).join("");
    const practical = [dress, connectivity, accessibility, families, solo, included, extras].filter(Boolean).join("");
    const faqs = renderFaqs(c.frequently_asked_questions);
    if (!primary && !practical && !faqs) return "";

    return `
      <div class="ship-editorial-details ship-editorial-details--portal">
        ${primary ? `
          <section class="ship-editorial-group">
            <div class="ship-editorial-section-head">
              <div class="ship-editorial-eyebrow">Know your ship</div>
              <h2>What to expect on board</h2>
            </div>
            <div class="ship-editorial-grid">${primary}</div>
          </section>` : ""}
        ${practical ? `
          <section class="ship-editorial-group">
            <div class="ship-editorial-section-head">
              <div class="ship-editorial-eyebrow">Before you sail</div>
              <h2>Practical ship information</h2>
            </div>
            <div class="ship-editorial-grid">${practical}</div>
          </section>` : ""}
        ${faqs}
      </div>`;
  }

  function renderSpotlightDetails(editorial) {
    const c = contentOf(editorial);
    const personality = proseSection("Personality", c.personality);
    const bestFor = listSection("Best for", c.best_for);
    const goodToKnow = listSection("Good to know before you book", c.not_ideal_for);
    const highlights = listSection("Key highlights", c.key_highlights, "ship-editorial-card--wide");
    const dining = proseSection("Dining", c.dining_summary);
    const accommodation = proseSection("Accommodation", c.accommodation_summary);
    const entertainment = proseSection("Entertainment", c.entertainment_summary);
    const wellness = proseSection("Wellness", c.wellness_summary);
    const families = proseSection("Families", c.family_summary);
    const solo = proseSection("Solo travellers", c.solo_traveller_summary);
    const dress = proseSection("Dress code", c.dress_code_summary);
    const included = listSection("Typically included", c.included_summary);
    const extras = listSection("Often extra cost", c.extra_cost_summary);
    const accessibility = proseSection("Accessibility", c.accessibility_summary);
    const connectivity = proseSection("Connectivity", c.connectivity_summary);

    const fit = [personality, bestFor, goodToKnow, highlights].filter(Boolean).join("");
    const onboard = [dining, accommodation, entertainment, wellness, families, solo].filter(Boolean).join("");
    const practical = [dress, included, extras, accessibility, connectivity].filter(Boolean).join("");
    const faqs = renderFaqs(c.frequently_asked_questions);
    if (!fit && !onboard && !practical && !faqs) return "";

    return `
      <section class="public-extra-section ship-editorial-details ship-editorial-details--spotlight" aria-label="Ship editorial guide">
        ${fit ? `
          <section class="ship-editorial-group">
            <div class="ship-editorial-section-head">
              <div class="ship-editorial-eyebrow">101CRUISE guide</div>
              <h2>Is this the right ship for you?</h2>
            </div>
            <div class="ship-editorial-grid">${fit}</div>
          </section>` : ""}
        ${onboard ? `
          <section class="ship-editorial-group">
            <div class="ship-editorial-section-head">
              <div class="ship-editorial-eyebrow">On board</div>
              <h2>What the experience is like</h2>
            </div>
            <div class="ship-editorial-grid">${onboard}</div>
          </section>` : ""}
        ${practical ? `
          <section class="ship-editorial-group">
            <div class="ship-editorial-section-head">
              <div class="ship-editorial-eyebrow">Before you book</div>
              <h2>Useful things to know</h2>
            </div>
            <div class="ship-editorial-grid">${practical}</div>
          </section>` : ""}
        ${faqs}
      </section>`;
  }

  root.ShipEditorialExperience = {
    paragraphsHtml,
    renderPaulsTip,
    renderPortalIntro,
    renderPortalDetails,
    renderSpotlightDetails
  };
})(window);
