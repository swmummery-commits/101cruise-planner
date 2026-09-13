/* Reliable Ship Spotlight preview + save/publish controls.
 * Loaded after the presentation patches so it can use the final emailHtml output.
 */
(function (global) {
  'use strict';

  const SAVE_ENDPOINT = '/.netlify/functions/admin-ship-spotlight-save';
  const LIVE_BASE = 'https://admirable-tiramisu-d4da8a.netlify.app/ships/';
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
      const helper = root()?.querySelector('section .admin-helper');
      if (helper && data.public_url) helper.textContent = `${LIVE_BASE}${encodeURIComponent(body.public_slug)}`;

      if (!options?.quiet) {
        // Keep the editor in place; the server is now authoritative. Refresh is optional.
      }
      return data.spotlight || true;
    } catch (error) {
      console.error('Ship Spotlight save failed', error);
      setStatus(error.message || 'Could not save Ship Spotlight.', 'error');
      return false;
    }
  }

  function removePreview() {
    document.getElementById('ssReliablePreviewBackdrop')?.remove();
  }

  function openReliablePreview() {
    const api = global.ShipSpotlightAdmin;
    try {
      api?.capture?.();
      const html = api?.emailHtml?.() || '';
      if (!html) {
        setStatus('The newsletter preview needs a hero image.', 'error');
        return;
      }
      removePreview();
      const backdrop = document.createElement('div');
      backdrop.id = 'ssReliablePreviewBackdrop';
      backdrop.className = 'ss-preview-backdrop';
      backdrop.innerHTML = `<div class="ss-preview-modal"><div class="ss-preview-head"><div><strong>Newsletter block preview</strong><div class="admin-small">600px email canvas. Resize the browser to inspect mobile stacking.</div></div><button type="button" class="admin-button secondary small" data-close-reliable-preview>Close</button></div><div class="ss-preview-canvas">${html}</div></div>`;
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop || event.target.closest('[data-close-reliable-preview]')) removePreview();
      });
      document.body.appendChild(backdrop);
      global.ShipSpotlightLayoutFix?.transformRoot?.(backdrop);
      setStatus('', '');
    } catch (error) {
      console.error('Ship Spotlight preview failed', error);
      setStatus(`Preview failed: ${error.message || error}`, 'error');
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

  function install() {
    const api = global.ShipSpotlightAdmin;
    if (!api) return;
    if (!api.__reliablePreviewSaveInstalled) {
      api.openPreview = openReliablePreview;
      api.closePreview = removePreview;
      api.save = saveViaServer;
      api.__reliablePreviewSaveInstalled = true;
    }
    addPublishHint();
    statusNode();
  }

  document.addEventListener('change', (event) => {
    if (event.target?.id !== 'ssPublished') return;
    setTimeout(() => global.ShipSpotlightAdmin?.save?.({ quiet: true }), 0);
  }, true);

  install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightReliabilityFix = { saveViaServer, openReliablePreview };
})(window);
