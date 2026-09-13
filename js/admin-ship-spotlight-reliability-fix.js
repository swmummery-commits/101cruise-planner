/* Reliable Ship Spotlight preview + save/publish controls.
 * This patch deliberately bypasses the legacy inline button handlers.
 * Preview is rendered in an isolated iframe so newsletter HTML/CSS cannot
 * interfere with the Admin shell or depend on the old previewOpen state.
 */
(function (global) {
  'use strict';

  const SAVE_ENDPOINT = '/.netlify/functions/admin-ship-spotlight-save';
  const LIVE_BASE = 'https://admirable-tiramisu-d4da8a.netlify.app/ships/';
  const PREVIEW_ID = 'ssReliablePreviewBackdrop';
  const STAT_KEYS = [
    'passenger_capacity','stateroom_count','crew_count','year_built','year_refurbished',
    'gross_tonnage','length_metres','beam_metres','cruising_speed_knots','deck_count'
  ];

  function root() { return document.getElementById('shipSpotlightOverlay'); }
  function field(id) { return root()?.querySelector(`#${id}`) || null; }
  function selectedShipId() { return String(root()?.querySelector('.ss-selector select')?.value || '').trim(); }
  function value(id) { return String(field(id)?.value || '').trim(); }

  async function authHeaders(extra) {
    if (typeof global.adminAuthHeaders === 'function') {
      return global.adminAuthHeaders({ 'Content-Type': 'application/json', ...(extra || {}) });
    }
    const session = await global.supabaseClient?.auth?.getSession?.();
    const token = session?.data?.session?.access_token || '';
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra || {}) };
  }

  function statusNode() {
    const host = root()?.querySelector('.ss-actions');
    if (!host) return null;
    let node = root().querySelector('[data-ship-spotlight-reliability-status]');
    if (!node) {
      node = document.createElement('div');
      node.dataset.shipSpotlightReliabilityStatus = '1';
      node.className = 'admin-small';
      node.style.marginRight = 'auto';
      node.style.flexBasis = '100%';
      host.insertBefore(node, host.firstChild);
    }
    return node;
  }

  function setStatus(message, tone) {
    const node = statusNode();
    if (!node) return;
    node.textContent = message || '';
    node.style.color = tone === 'error' ? '#9a2525' : tone === 'success' ? '#17633f' : '#545454';
  }

  function payload() {
    const checkbox = field('ssPublished');
    return {
      ship_id: selectedShipId(),
      eyebrow: value('ssEyebrow') || 'SHIP SPOTLIGHT',
      newsletter_heading: value('ssHeading'),
      editorial_intro: value('ssIntro'),
      hero_image_url: value('ssHero'),
      public_slug: value('ssSlug'),
      publication_status: checkbox?.checked ? 'published' : 'draft',
      stat_keys: STAT_KEYS,
      supporting_image_urls: []
    };
  }

  async function saveViaServer(options) {
    const api = global.ShipSpotlightAdmin;
    api?.capture?.();
    const body = payload();
    if (!body.ship_id) {
      setStatus('Select a ship first.', 'error');
      return false;
    }
    if (!body.hero_image_url) {
      setStatus('Choose a hero image before saving.', 'error');
      return false;
    }

    setStatus(body.publication_status === 'published' ? 'Publishing…' : 'Saving…', '');
    try {
      const response = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);

      const state = body.publication_status === 'published' ? 'Published' : 'Saved as draft';
      setStatus(`${state} successfully.`, 'success');
      const publicSection = Array.from(root()?.querySelectorAll('section') || [])
        .find((section) => /public ship page/i.test(String(section.querySelector('h3')?.textContent || '')));
      const helper = publicSection?.querySelector('.admin-helper');
      if (helper && data.public_url) helper.textContent = `${LIVE_BASE}${encodeURIComponent(body.public_slug)}`;
      return data.spotlight || true;
    } catch (error) {
      console.error('Ship Spotlight save failed', error);
      setStatus(error.message || 'Could not save Ship Spotlight.', 'error');
      return false;
    }
  }

  function removePreview() {
    document.getElementById(PREVIEW_ID)?.remove();
  }

  function previewDocument(html) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:#f7f7f7;}body{font-family:Helvetica,Arial,sans-serif;}*{box-sizing:border-box;}</style></head><body>${html}</body></html>`;
  }

  function openReliablePreview() {
    const api = global.ShipSpotlightAdmin;
    try {
      api?.capture?.();
      if (!selectedShipId()) {
        setStatus('Select a ship first.', 'error');
        return false;
      }

      const html = typeof api?.emailHtml === 'function' ? String(api.emailHtml() || '') : '';
      if (!html) {
        setStatus('Preview cannot be created until a hero image is selected.', 'error');
        return false;
      }

      removePreview();

      const backdrop = document.createElement('div');
      backdrop.id = PREVIEW_ID;
      Object.assign(backdrop.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        background: 'rgba(17,17,17,.62)',
        overflowY: 'auto',
        padding: '20px'
      });

      const modal = document.createElement('div');
      Object.assign(modal.style, {
        width: 'min(700px, 100%)',
        margin: '0 auto',
        background: '#fff',
        borderRadius: '10px',
        boxShadow: '0 18px 60px rgba(0,0,0,.28)',
        overflow: 'hidden'
      });

      const head = document.createElement('div');
      Object.assign(head.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '14px 16px',
        borderBottom: '1px solid #e8e8e8',
        background: '#fff'
      });
      head.innerHTML = '<div><strong style="font-family:Helvetica,Arial,sans-serif;">Newsletter block preview</strong><div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#545454;margin-top:3px;">Actual 600px email block. Narrow the window to inspect mobile stacking.</div></div>';

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'admin-button secondary small';
      close.textContent = 'Close';
      close.addEventListener('click', removePreview);
      head.appendChild(close);

      const frameWrap = document.createElement('div');
      Object.assign(frameWrap.style, { background: '#f7f7f7', padding: '0', overflow: 'hidden' });
      const iframe = document.createElement('iframe');
      iframe.title = 'Ship Spotlight newsletter preview';
      iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
      Object.assign(iframe.style, {
        display: 'block',
        width: '100%',
        height: '900px',
        border: '0',
        background: '#f7f7f7'
      });
      iframe.srcdoc = previewDocument(html);
      iframe.addEventListener('load', () => {
        try {
          const height = Math.max(700, iframe.contentDocument?.documentElement?.scrollHeight || 0, iframe.contentDocument?.body?.scrollHeight || 0);
          iframe.style.height = `${height + 20}px`;
        } catch (_error) {
          // Fixed fallback height remains usable if the browser blocks measurement.
        }
      });

      frameWrap.appendChild(iframe);
      modal.appendChild(head);
      modal.appendChild(frameWrap);
      backdrop.appendChild(modal);
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) removePreview();
      });
      document.body.appendChild(backdrop);
      setStatus('', '');
      return true;
    } catch (error) {
      console.error('Ship Spotlight preview failed', error);
      setStatus(`Preview failed: ${error?.message || String(error)}`, 'error');
      return false;
    }
  }

  function addPublishHint() {
    const checkbox = field('ssPublished');
    const label = checkbox?.closest('label');
    if (!label || label.dataset.reliablePublishHint === '1') return;
    label.dataset.reliablePublishHint = '1';
    const hint = document.createElement('span');
    hint.className = 'admin-small';
    hint.style.display = 'block';
    hint.style.marginTop = '4px';
    hint.textContent = 'Changing this setting saves immediately.';
    label.appendChild(hint);
  }

  function markButtons() {
    const actions = root()?.querySelector('.ss-actions');
    if (!actions) return;
    Array.from(actions.querySelectorAll('button')).forEach((button) => {
      const text = String(button.textContent || '').trim();
      if (/^Preview Newsletter Block$/i.test(text)) button.dataset.shipSpotlightPreviewTrigger = '1';
      if (/^Save Spotlight$/i.test(text)) button.dataset.shipSpotlightSaveTrigger = '1';
    });
  }

  function installApiOverrides() {
    const api = global.ShipSpotlightAdmin;
    if (!api) return false;
    // Reapply every time. Other presentation patches may replace methods after
    // initial load; these two controls must remain authoritative.
    api.openPreview = openReliablePreview;
    api.closePreview = removePreview;
    api.save = saveViaServer;
    api.__reliablePreviewSaveInstalled = true;
    return true;
  }

  function install() {
    if (!installApiOverrides()) return;
    addPublishHint();
    markButtons();
    statusNode();
  }

  // Capture-phase delegation bypasses the legacy inline onclick completely.
  // This survives every re-render of the Ship Spotlight editor.
  if (!global.__shipSpotlightReliableClickGuardInstalled) {
    document.addEventListener('click', (event) => {
      const button = event.target?.closest?.('button');
      if (!button || !root()?.contains(button)) return;

      if (button.dataset.shipSpotlightPreviewTrigger === '1' || /^Preview Newsletter Block$/i.test(String(button.textContent || '').trim())) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openReliablePreview();
        return;
      }

      if (button.dataset.shipSpotlightSaveTrigger === '1' || /^Save Spotlight$/i.test(String(button.textContent || '').trim())) {
        event.preventDefault();
        event.stopImmediatePropagation();
        saveViaServer();
      }
    }, true);
    global.__shipSpotlightReliableClickGuardInstalled = true;
  }

  if (!global.__shipSpotlightReliablePublishGuardInstalled) {
    document.addEventListener('change', (event) => {
      if (event.target?.id !== 'ssPublished') return;
      setTimeout(() => saveViaServer({ quiet: true }), 0);
    }, true);
    global.__shipSpotlightReliablePublishGuardInstalled = true;
  }

  install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightReliabilityFix = { saveViaServer, openReliablePreview, removePreview, install };
})(window);
