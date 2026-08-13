// Settings view — shared Wialon config (admin-only, persisted to
// Supabase so every user reuses the same connection), manual sites,
// geofences, KML bulk import.
import L from 'leaflet';
import { store } from '../lib/store.js';
import { isAdmin, isOps } from '../auth/auth.js';
import { removeSiteMarker, removeGeofenceLayer } from '../map/map.js';
import { upsertSite, deleteSite, upsertGeofence, deleteGeofence, upsertSetting } from '../lib/store.js';
import { parseManualCoordinates, parseKmlGeofences, planGeofenceIngestion } from '../lib/geofence.js';
import { populateSiteDropdown, filterSiteSelect } from './dispatch.js';

const wialonResult = (cls, html) => `<div class="wialon-result ${cls}">${html}</div>`;

// ---------------------------------------------------------------------
// Wialon connection (shared, admin-managed)
// ---------------------------------------------------------------------
export function setupWialonControls() {
    const testBtn = document.getElementById('wialon-test-btn');
    const saveBtn = document.getElementById('wialon-save-btn');

    // Load stored (shared) config into the form for admins.
    if (isAdmin()) {
        const relayEl = document.getElementById('wialon-relay');
        const serverEl = document.getElementById('wialon-server');
        const tokenEl = document.getElementById('wialon-token');
        if (relayEl) relayEl.value = store.setting('wialon_relay') || '';
        if (serverEl) serverEl.value = store.setting('wialon_server') || 'hst-api.wialon.eu';
        if (tokenEl) tokenEl.value = store.setting('wialon_token') || '';
    } else {
        const note = document.getElementById('wialon-viewer-note');
        if (note) note.style.display = 'block';
    }

    if (testBtn) testBtn.addEventListener('click', testWialonFromFields);
    if (saveBtn) saveBtn.addEventListener('click', saveWialonSettings);
}

function currentWialonFields() {
    return {
        relay: document.getElementById('wialon-relay')?.value.trim().replace(/\/$/, '') || '',
        server: document.getElementById('wialon-server')?.value.trim() || '',
        token: document.getElementById('wialon-token')?.value.trim() || ''
    };
}

async function testWialonFromFields() {
    const resultEl = document.getElementById('wialon-test-result');
    if (!resultEl) return;
    const { relay, server, token } = currentWialonFields();
    if (!relay || !server || !token) {
        resultEl.innerHTML = wialonResult('error', 'Enter the relay URL, server address, and your token.');
        return;
    }

    resultEl.innerHTML = wialonResult('loading', `Connecting via relay to ${server}...`);
    try {
        const loginParams = JSON.stringify({ token });
        const loginUrl = `${relay}/?server=${encodeURIComponent(server)}&svc=${encodeURIComponent('token/login')}&params=${encodeURIComponent(loginParams)}`;
        const loginResp = await fetch(loginUrl);
        const loginData = await loginResp.json();

        if (loginData.error) {
            resultEl.innerHTML = wialonResult('error', `
                Login failed (error code ${loginData.error}${loginData.reason ? ': ' + loginData.reason : ''}).
                <div class="detail">Common causes: wrong/expired token, or wrong server (EU vs standard hosting).</div>`);
            return;
        }

        const sid = loginData.eid;
        const userName = loginData.au || 'unknown';

        const searchParams = JSON.stringify({ spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' }, force: 1, flags: 1, from: 0, to: 0 });
        const searchUrl = `${relay}/?server=${encodeURIComponent(server)}&svc=${encodeURIComponent('core/search_items')}&params=${encodeURIComponent(searchParams)}&sid=${encodeURIComponent(sid)}`;
        const searchResp = await fetch(searchUrl);
        const searchData = await searchResp.json();

        if (searchData.error) {
            resultEl.innerHTML = wialonResult('error', `
                Logged in as <b>${userName}</b>, but couldn't list units (error code ${searchData.error}).
                <div class="detail">The token may be scoped without unit/read access.</div>`);
            return;
        }

        const units = searchData.items || [];
        const unitListHtml = units.slice(0, 15).map(u => `<div>🚚 ${u.nm}</div>`).join('');
        const moreText = units.length > 15 ? `<div style="color:var(--text-dim)">...and ${units.length - 15} more</div>` : '';

        resultEl.innerHTML = wialonResult('success', `
            ✅ Connected successfully as <b>${userName}</b> (via relay).
            <div class="detail">Session established &middot; ${units.length} unit(s) visible to this token — click <b>Save</b> so the whole team uses it.</div>
            ${units.length > 0 ? `<div class="wialon-unit-list">${unitListHtml}${moreText}</div>` : ''}`);
    } catch (err) {
        resultEl.innerHTML = wialonResult('error', `
            Request failed: ${err.message}
            <div class="detail">The browser is only talking to your relay URL, not Wialon directly — if this still fails, check the relay URL and that the Worker is deployed (not just saved).</div>`);
        console.error('Wialon test error:', err);
    }
}

export async function saveWialonSettings() {
    if (!isAdmin()) { alert('Only admins can change the shared Wialon connection.'); return; }
    const resultEl = document.getElementById('wialon-test-result');
    const { relay, server, token } = currentWialonFields();
    if (!relay || !server || !token) {
        if (resultEl) resultEl.innerHTML = wialonResult('error', 'All three fields (relay, server, token) are required.');
        return;
    }
    try {
        await Promise.all([
            upsertSetting('wialon_relay', relay),
            upsertSetting('wialon_server', server),
            upsertSetting('wialon_token', token)
        ]);
        if (resultEl) resultEl.innerHTML = wialonResult('success', '✅ Wialon settings saved — every logged-in member of this workspace now uses this connection automatically.');
    } catch (err) {
        if (resultEl) resultEl.innerHTML = wialonResult('error', `Could not save settings: ${err.message}`);
    }
}

// ---------------------------------------------------------------------
// Manual sites
// ---------------------------------------------------------------------
export function renderManualSiteList() {
    const listEl = document.getElementById('manual-site-list');
    if (!listEl) return;
    const manual = store.sites.filter(s => s.manuallyAdded);
    if (manual.length === 0) {
        listEl.innerHTML = `<div style="padding:14px; color:var(--text-dim); font-size:.85rem;">No manually added sites yet.</div>`;
        return;
    }
    listEl.innerHTML = manual.map(site => `
        <div class="geofence-row">
            <span>✏️ ${site.name}${site.client ? ` — ${site.client}` : ''}</span>
            <span style="color:var(--text-dim); font-size:.75rem;">${Number(site.lat).toFixed(5)}, ${Number(site.lng).toFixed(5)}</span>
            <button class="geofence-remove-btn" data-id="${site.id}">✕</button>
        </div>`).join('');
    listEl.querySelectorAll('.geofence-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeManualSite(btn.dataset.id));
    });
}

async function saveManualSite() {
    if (!isOps()) { alert('Your account does not have permission to add sites.'); return; }
    const clientEl = document.getElementById('manual-site-client');
    const nameEl = document.getElementById('manual-site-name');
    const coordsEl = document.getElementById('manual-site-coords');
    const resultEl = document.getElementById('manual-site-result');

    const client = clientEl.value.trim();
    const name = nameEl.value.trim();
    const rawCoords = coordsEl.value.trim();

    if (!name || !rawCoords) {
        resultEl.innerHTML = `<div class="wialon-result error">Site name and coordinates are required.</div>`;
        return;
    }

    const parsed = parseManualCoordinates(rawCoords);
    if (!parsed) {
        resultEl.innerHTML = `<div class="wialon-result error">Couldn't read those coordinates. Try decimal format like "36.6417633, 3.2927783", or DMS like 36°38'30"N 3°17'34"E.</div>`;
        return;
    }

    const site = {
        id: 'site_manual_' + Date.now(),
        name, client: client || null,
        lat: parsed.lat, lng: parsed.lng,
        accuracy: 'exact', dupSuspect: false, manuallyAdded: true
    };

    try {
        await upsertSite(site);
    } catch (err) {
        resultEl.innerHTML = `<div class="wialon-result error">Could not save site: ${err.message}</div>`;
        return;
    }

    // Add to the map immediately.
    if (typeof L !== 'undefined') {
        const { siteClusterGroup, siteMarkers: markers } = await import('../map/map.js');
        const marker = L.marker([site.lat, site.lng], {
            icon: L.divIcon({ className: 'site-glow-marker', iconSize: [14, 14], iconAnchor: [7, 7] })
        });
        marker.bindPopup(`<b>🏗️ ${site.name}</b><br>${site.client || ''}<br><i style="color:#4ade80">✏️ manually added</i>`);
        marker.addTo(siteClusterGroup);
        markers[site.id] = marker;
    }

    refreshAllSiteDropdowns();
    renderManualSiteList();

    resultEl.innerHTML = `<div class="wialon-result success">✅ "${site.name}" added — it's on the map and ready to dispatch to.</div>`;
    clientEl.value = '';
    nameEl.value = '';
    coordsEl.value = '';
}

async function removeManualSite(id) {
    if (!isOps()) { alert('Your account does not have permission to remove sites.'); return; }
    try {
        await deleteSite(id);
    } catch (err) {
        alert(`Could not remove site: ${err.message}`);
        return;
    }
    removeSiteMarker(id);
    refreshAllSiteDropdowns();
    renderManualSiteList();
}

function refreshAllSiteDropdowns() {
    populateSiteDropdown();
    const currentSearch = document.getElementById('site-search')?.value || '';
    if (currentSearch) filterSiteSelect(currentSearch);
    const queueSiteSelect = document.getElementById('queue-site-select');
    if (queueSiteSelect) {
        queueSiteSelect.innerHTML = '<option value="">-- Select Destination --</option>';
        store.sites.filter(s => s.id !== 'site_0').forEach(site => {
            const opt = document.createElement('option');
            opt.value = site.id;
            opt.textContent = site.client ? `${site.name} — ${site.client}` : site.name;
            queueSiteSelect.appendChild(opt);
        });
    }
}

// ---------------------------------------------------------------------
// Geofences / KML ingestion
// ---------------------------------------------------------------------
function showGeofenceIngestSummary(summary, fileErrors) {
    const el = document.getElementById('geofence-ingest-summary');
    if (!el) return;

    let html = `<div class="wialon-result success">
        ✅ Matched ${summary.matchedCount} site zone(s)${summary.matchedFactoryCount > 0 ? ` + ${summary.matchedFactoryCount} factory zone(s)` : ''} of ${summary.totalCount} total &mdash; added to the map.
        ${summary.duplicateCount > 0 ? `<div class="detail">${summary.duplicateCount} zone(s) skipped — already loaded (same name as an existing zone).</div>` : ''}
        ${summary.unmatched.length > 0 ? `<div class="detail">${summary.unmatched.length} zone(s) didn't match your site list and were skipped. Some may be genuinely old — but some may be real clients missing from the original site list, so worth a look rather than assuming.</div>` : ''}
    </div>`;

    if (summary.unmatched.length > 0) {
        html += `<details style="margin-top:8px;">
            <summary style="cursor:pointer; font-size:.8rem; color:var(--text-dim);">Show ${summary.unmatched.length} unmatched zone name(s)</summary>
            <div class="wialon-unit-list" style="margin-top:6px;">
                ${summary.unmatched.slice(0, 200).map(n => `<div>⚪ ${n}</div>`).join('')}
                ${summary.unmatched.length > 200 ? `<div style="color:var(--text-dim)">...and ${summary.unmatched.length - 200} more</div>` : ''}
            </div>
        </details>`;
    }

    if (fileErrors.length > 0) {
        html += `<div class="wialon-result error" style="margin-top:8px;">${fileErrors.join('<br>')}</div>`;
    }

    el.innerHTML = html;
}

export function renderGeofenceList() {
    const listEl = document.getElementById('geofence-list');
    if (!listEl) return;
    if (store.geofences.length === 0) {
        listEl.innerHTML = `<div style="padding:14px; color:var(--text-dim); font-size:.85rem;">No geofences loaded yet.</div>`;
        return;
    }
    listEl.innerHTML = store.geofences.map(g => {
        const pointCount = g.polygon ? g.polygon.length : (g.center ? 'circle' : 0);
        const displayCount = pointCount === 'circle' ? '⊙ 150m radius' : `${pointCount} pts`;
        const icon = g.id === 'parc-omd' ? '🏢' : (g.kind === 'factory' ? '🏭' : '📍');
        return `
        <div class="geofence-row">
            <span>${icon} ${g.name}</span>
            <span style="color:var(--text-dim); font-size:.75rem;">${displayCount}</span>
            ${g.kind !== 'factory' && g.id !== 'parc-omd' ? `<button class="geofence-remove-btn" data-id="${g.id}">✕</button>` : ''}
        </div>`;
    }).join('');
    listEl.querySelectorAll('.geofence-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeGeofence(btn.dataset.id));
    });
}

async function removeGeofence(id) {
    if (!isOps()) { alert('Your account does not have permission to remove geofences.'); return; }
    try {
        await deleteGeofence(id);
    } catch (err) {
        alert(`Could not remove geofence: ${err.message}`);
        return;
    }
    const entry = store.geofences.find(g => g.id === id);
    if (entry) removeGeofenceLayer(entry);
    renderGeofenceList();
}

async function ingestKml(kmlText, sourceLabel) {
    if (!isOps()) { alert('Your account does not have permission to import geofences.'); return; }
    const el = document.getElementById('geofence-ingest-summary');
    if (!el) return;
    try {
        const zones = parseKmlGeofences(kmlText);
        const existingNames = store.geofences.map(g => g.name);
        const plan = planGeofenceIngestion(zones, store.sites, existingNames);

        el.innerHTML = `<div class="wialon-result loading">Ingesting ${zones.length} zone(s) from ${sourceLabel}...</div>`;

        let matchedCount = 0;
        let matchedFactoryCount = 0;
        let duplicateCount = 0;
        const unmatched = [];

        for (let i = 0; i < plan.length; i++) {
            const p = plan[i];
            if (p.action === 'skip') {
                if (p.reason === 'duplicate') duplicateCount++;
                else unmatched.push(p.zone.name);
                continue;
            }
            const id = p.action === 'factory'
                ? `geo_factory_${Date.now()}_${i}`
                : `geo_site_${p.site.id}`;
            try {
                const entry = {
                    id,
                    name: p.zone.name,
                    kind: p.action,
                    polygon: p.zone.polygon,
                    siteId: p.action === 'site' ? p.site.id : null
                };
                await upsertGeofence(entry);
                if (p.action === 'factory') matchedFactoryCount++;
                else matchedCount++;
            } catch (err) {
                console.warn(`Could not persist geofence "${p.zone.name}":`, err.message);
                unmatched.push(`${p.zone.name} (save failed: ${err.message})`);
            }
        }

        // Refresh map + list from store after persistence.
        const { drawGeofenceLayer } = await import('../map/map.js');
        store.geofences.forEach(g => drawGeofenceLayer(g));
        renderGeofenceList();

        showGeofenceIngestSummary({ totalCount: zones.length, matchedCount, matchedFactoryCount, duplicateCount, unmatched }, []);
    } catch (err) {
        el.innerHTML = `<div class="wialon-result error">Could not ingest KML: ${err.message}</div>`;
        console.error('KML ingest error:', err);
    }
}

export function setupGeofenceControls() {
    const fileInput = document.getElementById('geofence-file-input');
    const pasteBtn = document.getElementById('geofence-paste-btn');
    const pasteArea = document.getElementById('geofence-paste-area');

    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files || []);
            if (files.length === 0) return;
            let combined = '';
            const errors = [];
            for (const file of files) {
                try {
                    combined += await file.text() + '\n';
                } catch (err) {
                    errors.push(`Could not read ${file.name}: ${err.message}`);
                }
            }
            fileInput.value = '';
            combined = combined.trim();
            if (!combined) {
                const el = document.getElementById('geofence-ingest-summary');
                if (el) el.innerHTML = `<div class="wialon-result error">${errors.join('<br>')}</div>`;
                return;
            }
            await ingestKml(combined, `${files.length} file(s)`);
        });
    }

    if (pasteBtn) {
        pasteBtn.addEventListener('click', async () => {
            const text = (pasteArea?.value || '').trim();
            if (!text) { alert('Paste KML content first.'); return; }
            await ingestKml(text, 'pasted KML');
            if (pasteArea) pasteArea.value = '';
        });
    }
}

export function setupSettingsControls() {
    setupWialonControls();
    renderGeofenceList();
    renderManualSiteList();

    const saveSiteBtn = document.getElementById('manual-site-save-btn');
    if (saveSiteBtn) saveSiteBtn.addEventListener('click', saveManualSite);

    setupGeofenceControls();
}