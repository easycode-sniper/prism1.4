// Dispatch view — convoy dispatch, live/manual position verification,
// active-fleet table, dispatch queue, and run lifecycle (stop → history).
// Ported from the legacy app; runs now persist to Supabase so the whole
// team sees the same active dispatches.
import L from 'leaflet';
import { store } from '../lib/store.js';
import { profile, canDispatch } from '../auth/auth.js';
import { map } from '../map/map.js';
import { createRouteControl, displayRunRoute } from '../map/routing.js';
import { AMOUDA_COORDS } from '../data/seed.js';
import { findWialonUnitPosition } from '../lib/wialon.js';
import {
    haversineMeters, projectPointOntoRoute, formatDuration, timeAgo
} from '../lib/geometry.js';
import { ROUTE_BUFFER_METERS } from '../lib/geofence.js';
import { upsertRun, updateRunFields, completeRun, runPayload } from '../lib/store.js';
import { updateStatsDisplays, switchView } from './ui.js';

const FALLBACK_AVG_SPEED_KMH = 65;

// ---- convoy selection state ------------------------------------------
const selectedTrucks = new Set();
let masterSiteOptions = [];

// ---------------------------------------------------------------------
// Truck / convoy UI
// ---------------------------------------------------------------------
export function renderTruckList(filterText) {
    const listEl = document.getElementById('truck-list');
    if (!listEl) return;
    const ft = (filterText || '').toLowerCase();
    listEl.innerHTML = '';
    store.trucks
        .filter(tr => tr.toLowerCase().includes(ft))
        .forEach(truck => {
            const row = document.createElement('div');
            row.className = 'truck-row' + (selectedTrucks.has(truck) ? ' checked' : '');
            row.innerHTML = `<input type="checkbox" ${selectedTrucks.has(truck) ? 'checked' : ''}> <span class="truck-id-label">${truck}</span>`;
            row.addEventListener('click', (e) => { e.preventDefault(); toggleTruck(truck); });
            listEl.appendChild(row);
        });
}

function toggleTruck(truck) {
    if (selectedTrucks.has(truck)) selectedTrucks.delete(truck);
    else selectedTrucks.add(truck);
    renderTruckList(document.getElementById('truck-search')?.value);
    renderConvoyChips();
    updateWorkflowSummary();
}

export function renderConvoyChips() {
    const wrap = document.getElementById('convoy-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    selectedTrucks.forEach(truck => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.innerHTML = `<span>${truck}</span>`;
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.onclick = () => toggleTruck(truck);
        chip.appendChild(removeBtn);
        wrap.appendChild(chip);
    });
}

export function updateWorkflowSummary() {
    const truckSummary = document.getElementById('truck-selection-summary');
    const routeSummary = document.getElementById('route-selection-summary');
    const truckStep = document.getElementById('workflow-step-trucks');
    const routeStep = document.getElementById('workflow-step-route');
    const verifyStep = document.getElementById('workflow-step-verify');
    const siteSelect = document.getElementById('site-select');
    const selectedOption = siteSelect && siteSelect.options[siteSelect.selectedIndex];
    const hasTrucks = selectedTrucks.size > 0;
    const hasRoute = !!(siteSelect && siteSelect.value);

    if (truckSummary) {
        truckSummary.innerHTML = hasTrucks
            ? `<strong>${selectedTrucks.size}</strong> truck${selectedTrucks.size === 1 ? '' : 's'} selected for this run.`
            : 'Select one or more trucks to build a convoy.';
    }
    if (routeSummary) {
        routeSummary.innerHTML = hasRoute
            ? `Destination: <strong>${selectedOption ? selectedOption.textContent.split(' — ')[0] : ''}</strong>`
            : 'Choose a destination to prepare the route.';
    }
    if (truckStep) truckStep.classList.toggle('is-ready', hasTrucks);
    if (routeStep) routeStep.classList.toggle('is-ready', hasRoute);
    if (verifyStep) verifyStep.classList.toggle('is-ready', Object.keys(store.activeRuns).length > 0);
}

// ---------------------------------------------------------------------
// Site dropdown
// ---------------------------------------------------------------------
export function populateSiteDropdown() {
    const siteSelect = document.getElementById('site-select');
    if (!siteSelect) return;
    siteSelect.innerHTML = '<option value="">-- Select Destination Site --</option>';
    store.sites
        .filter(s => s.id !== 'site_0')
        .forEach(site => {
            const opt = document.createElement('option');
            opt.value = site.id;
            const label = site.client ? `${site.name} — ${site.client}` : site.name;
            if (site.lat == null) opt.textContent = `${label} (⚠️ no coordinates)`;
            else if (site.dupSuspect) opt.textContent = `${label} (⚠️ suspect coords)`;
            else if (site.accuracy === 'town') opt.textContent = `${label} (~town-level)`;
            else opt.textContent = label;
            siteSelect.appendChild(opt);
        });
    masterSiteOptions = Array.from(siteSelect.options);
}

export function filterSiteSelect(rawFilterText) {
    const siteSelect = document.getElementById('site-select');
    if (!siteSelect) return;
    const filterText = rawFilterText.toLowerCase();
    siteSelect.innerHTML = '';
    masterSiteOptions.forEach(opt => {
        if (opt.text.toLowerCase().includes(filterText)) siteSelect.appendChild(opt.cloneNode(true));
    });
}

// ---------------------------------------------------------------------
// Dispatch — one destination, one or more trucks (convoy)
// ---------------------------------------------------------------------
async function persistNewRun(record) {
    const payload = {
        ...runPayload(record),
        dispatched_by: profile()?.id || null
    };
    const data = await upsertRun(record, payload);
    return data.id;
}

export async function startTrackingMission() {
    if (!canDispatch()) { alert('Your account does not have permission to dispatch trucks.'); return; }
    if (!map) {
        alert("The map didn't load, so runs can't be routed right now. Refresh the page once you have a stable connection.");
        return;
    }

    const siteId = document.getElementById('site-select').value;
    if (selectedTrucks.size === 0 || !siteId) {
        alert('Select at least one truck and a destination site first!');
        return;
    }

    const targetSite = store.sites.find(s => s.id === siteId);
    if (!targetSite || targetSite.lat == null || targetSite.lng == null) {
        alert(`No coordinates are available yet for "${targetSite ? targetSite.name : siteId}". Add its GPS location before it can be routed.`);
        return;
    }

    const destinationCoords = [targetSite.lat, targetSite.lng];
    const trucksInThisDispatch = Array.from(selectedTrucks);
    const idByTruck = {};

    // Create + persist all runs first so route geometry can attach to real ids.
    for (const truckId of trucksInThisDispatch) {
        const run = {
            truckId,
            siteId: targetSite.id,
            siteName: targetSite.name,
            client: targetSite.client,
            routeCoords: destinationCoords,
            marker: null,
            dispatchedAt: new Date(),
            lastVerifiedAt: null,
            lastCoords: null
        };
        try {
            idByTruck[truckId] = await persistNewRun(run);
        } catch (err) {
            console.error(`Could not start run for ${truckId}:`, err.message);
            alert(`Could not save the run for ${truckId}: ${err.message}`);
        }
    }

    // Capture real road geometry for deviation checks; fall back to
    // straight-line distance if OSRM never responds.
    const rc = createRouteControl(destinationCoords);
    rc.on('routesfound', async (e) => {
        const route = e.routes[0];
        const routeLine = route.coordinates.map(c => [c.lat, c.lng]);
        const totalDistance = route.summary.totalDistance;
        const totalTime = route.summary.totalTime;
        for (const truckId of trucksInThisDispatch) {
            const run = store.activeRuns[truckId];
            if (!run) continue;
            run.routeLine = routeLine;
            run.routeTotalDistance = totalDistance;
            run.routeTotalTime = totalTime;
            if (run.id) {
                try {
                    await updateRunFields(run.id, {
                        route_line: routeLine,
                        route_total_distance: totalDistance,
                        route_total_time: totalTime
                    });
                } catch (err) { console.warn('Could not persist route geometry:', err.message); }
            }
        }
    });
    rc.on('routingerror', () => console.warn('Route geometry could not be calculated — deviation check will fall back to straight-line distance.'));
    rc.addTo(map);
    setTimeout(() => { try { map.removeControl(rc); } catch { /* gone */ } }, 30000);

    rebuildActiveTrucksSelect(trucksInThisDispatch, targetSite);

    selectedTrucks.clear();
    renderTruckList(document.getElementById('truck-search')?.value);
    renderConvoyChips();

    updateStatsDisplays();
    renderFleetTable();
    map.fitBounds(L.latLngBounds([AMOUDA_COORDS, destinationCoords]), { padding: [60, 60] });
    import('../views/dashboard.js').then(m => m.renderDashboard());
    switchView('fleet');
}

// ---------------------------------------------------------------------
// Active-truck dropdown (sidebar verify step)
// ---------------------------------------------------------------------
export function rebuildActiveTrucksSelect(dispatchTrucks, targetSite) {
    const activeSelect = document.getElementById('active-trucks');
    if (!activeSelect) return;
    const trucks = dispatchTrucks || Object.keys(store.activeRuns);
    trucks.forEach(truckId => {
        const run = store.activeRuns[truckId];
        const existingOpt = Array.from(activeSelect.options).find(o => o.value === truckId);
        if (existingOpt) existingOpt.remove();
        const site = targetSite || store.site(run ? run.siteId : null);
        const label = site && site.client
            ? `${truckId} (➡️ ${run ? run.siteName : site.name} — ${site.client})`
            : `${truckId} (➡️ ${run ? run.siteName : '—'})`;
        const opt = document.createElement('option');
        opt.value = truckId;
        opt.textContent = label;
        activeSelect.appendChild(opt);
    });
}

// ---------------------------------------------------------------------
// Position verification — the piece shared by manual paste, live fetch,
// and background alert polling.
// ---------------------------------------------------------------------
export function applyPositionCheck(truckId, coordsArray, sourceLabel, options = {}) {
    const { openPopup = true, recenterMap = true } = options;
    if (!map) {
        alert("The map didn't load, so position can't be plotted right now. Refresh the page once you have a stable connection.");
        return;
    }
    const run = store.activeRuns[truckId];
    if (!run) {
        alert("That truck isn't currently an active run. Start a tracking run for it first.");
        return;
    }

    if (run.marker) map.removeLayer(run.marker);

    let deviationMeters = null;
    let deviationBasis = 'route';
    let etaSeconds = null;
    let etaBasis = null;

    if (run.routeLine && run.routeLine.length >= 2) {
        const proj = projectPointOntoRoute(coordsArray, run.routeLine);
        deviationMeters = proj.distanceToRoute;
        if (run.routeTotalDistance && run.routeTotalTime) {
            const remainingDistance = Math.max(0, proj.totalRouteLength - proj.distanceCovered);
            const avgSpeedMps = run.routeTotalDistance / run.routeTotalTime;
            etaSeconds = remainingDistance / avgSpeedMps;
            etaBasis = 'osrm-speed';
        }
    } else {
        deviationBasis = 'straight';
        deviationMeters = haversineMeters(coordsArray[0], coordsArray[1], run.routeCoords[0], run.routeCoords[1]);
        etaSeconds = (deviationMeters / 1000) / FALLBACK_AVG_SPEED_KMH * 3600;
        etaBasis = 'fallback-speed';
    }

    const onRoute = deviationBasis === 'route' && deviationMeters <= ROUTE_BUFFER_METERS;
    const markerClass = deviationBasis === 'route'
        ? (onRoute ? 'truck-pos-marker' : 'truck-pos-marker off-route')
        : 'truck-pos-marker unknown-route';

    const truckMarker = L.marker(coordsArray, {
        icon: L.divIcon({ className: markerClass, iconSize: [16, 16], iconAnchor: [8, 8] })
    }).addTo(map);

    let popupText = `<b>🚚 Truck ${truckId}</b><br>${run.siteName}<br>`;
    if (sourceLabel) popupText += `<span style="color:#8f8fb0; font-size:.8em;">${sourceLabel}</span><br>`;
    if (deviationBasis === 'route') {
        popupText += onRoute
            ? `<span style="color:#4ade80">✅ On route</span> (${Math.round(deviationMeters)}m from road)`
            : `<span style="color:#f87171">⚠️ Off route by ${(deviationMeters / 1000).toFixed(1)}km</span>`;
    } else {
        popupText += `<span style="color:#ffb703">ℹ️ Route geometry unavailable — showing straight-line distance to destination: ${(deviationMeters / 1000).toFixed(1)}km</span>`;
    }
    if (etaSeconds != null) {
        const etaLabel = etaBasis === 'osrm-speed'
            ? `⏱️ ~${formatDuration(etaSeconds)} to destination`
            : `⏱️ ~${formatDuration(etaSeconds)} to destination <i>(rough estimate — no route data, assumes ${FALLBACK_AVG_SPEED_KMH}km/h)</i>`;
        popupText += `<br>${etaLabel}`;
    }
    truckMarker.bindPopup(popupText);
    if (openPopup) truckMarker.openPopup();

    run.marker = truckMarker;
    run.lastVerifiedAt = new Date();
    run.lastCoords = coordsArray;
    run.lastDeviationMeters = deviationMeters;
    run.lastDeviationBasis = deviationBasis;
    run.lastOnRoute = deviationBasis === 'route' ? onRoute : null;
    run.lastEtaSeconds = etaSeconds;
    run.lastEtaBasis = etaBasis;

    if (recenterMap) map.setView(coordsArray, 10);

    // Persist so the next user to open the app (or a refresh) sees the check.
    if (run.id) {
        updateRunFields(run.id, {
            last_coords: coordsArray,
            last_verified_at: new Date().toISOString(),
            last_deviation_meters: deviationMeters,
            last_deviation_basis: deviationBasis,
            last_on_route: deviationBasis === 'route' ? onRoute : null,
            last_eta_seconds: etaSeconds,
            last_eta_basis: etaBasis
        }).catch(err => console.warn('Could not persist position check:', err.message));
    }

    updateStatsDisplays();
    renderFleetTable();
}

export async function fetchAndVerifyTruckPosition() {
    if (!canDispatch()) { alert('Your account does not have permission to verify truck positions.'); return; }
    const truckId = document.getElementById('active-trucks').value;
    const statusEl = document.getElementById('wialon-fetch-status');
    if (!truckId) {
        alert('Select an Active Monitored Truck first.');
        return;
    }
    if (!store.activeRuns[truckId]) {
        alert("That truck isn't currently an active run. Start a tracking run for it first.");
        return;
    }

    if (!store.wialonConfigured()) {
        statusEl.innerHTML = `<span style="color:#ffb703">⚠️ Wialon isn't configured. An admin must set the relay, server, and token in Settings.</span>`;
        return;
    }

    statusEl.innerHTML = `<span style="color:#8f8fb0">Fetching live position for ${truckId}...</span>`;
    try {
        const pos = await findWialonUnitPosition(truckId);
        const ageMinutes = pos.timestamp ? Math.round((Date.now() / 1000 - pos.timestamp) / 60) : null;
        const ageLabel = ageMinutes != null ? ` (${ageMinutes < 1 ? 'just now' : ageMinutes + 'min old'})` : '';
        statusEl.innerHTML = `<span style="color:#4ade80">✅ Got position from "${pos.unitName}"${ageLabel}</span>`;
        applyPositionCheck(truckId, [pos.lat, pos.lng], `Live from Wialon${ageLabel}`);
    } catch (err) {
        statusEl.innerHTML = `<span style="color:#f87171">⚠️ ${err.message}</span>`;
        console.error('Wialon fetch error:', err);
    }
}

export function verifyTruckPositionManual() {
    if (!canDispatch()) { alert('Your account does not have permission to verify truck positions.'); return; }
    const truckId = document.getElementById('active-trucks').value;
    const rawCoords = document.getElementById('wialon-coords').value;

    if (!truckId || !rawCoords) {
        alert('Please select an Active Monitored Truck and paste coordinates from Wialon!');
        return;
    }
    const coordsArray = rawCoords.split(',').map(num => parseFloat(num.trim()));
    if (coordsArray.length !== 2 || isNaN(coordsArray[0]) || isNaN(coordsArray[1])) {
        alert('Invalid format! Please paste normal coordinates like: 36.2341, 2.9845');
        return;
    }
    applyPositionCheck(truckId, coordsArray, 'Pasted manually');
}

// ---------------------------------------------------------------------
// Active fleet table
// ---------------------------------------------------------------------
export function renderFleetTable() {
    const tbody = document.getElementById('fleet-tbody');
    const wrap = document.getElementById('fleet-table-wrap');
    if (!tbody) return;
    const emptyEl = document.getElementById('fleet-empty');
    const entries = Object.entries(store.activeRuns);

    const kpiActive = document.getElementById('kpi-active');
    const kpiVerified = document.getElementById('kpi-verified');
    const kpiUnverified = document.getElementById('kpi-unverified');
    const kpiFleet = document.getElementById('kpi-fleet');
    const kpiOffRoute = document.getElementById('kpi-offroute');
    if (kpiActive) kpiActive.textContent = entries.length;
    if (kpiVerified) kpiVerified.textContent = entries.filter(([, r]) => r.lastVerifiedAt).length;
    if (kpiUnverified) kpiUnverified.textContent = entries.filter(([, r]) => !r.lastVerifiedAt).length;
    if (kpiFleet) kpiFleet.textContent = store.trucks.length;
    if (kpiOffRoute) kpiOffRoute.textContent = entries.filter(([, r]) => r.lastDeviationBasis === 'route' && r.lastOnRoute === false).length;

    const table = document.getElementById('fleet-table');
    if (entries.length === 0) {
        if (table) table.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'block';
        if (wrap) wrap.style.display = 'block';
        return;
    }
    if (table) table.style.display = 'table';
    if (emptyEl) emptyEl.style.display = 'none';

    tbody.innerHTML = '';
    entries
        .sort((a, b) => b[1].dispatchedAt - a[1].dispatchedAt)
        .forEach(([truckId, run]) => {
            const verified = !!run.lastVerifiedAt;
            let statusClass = 'dispatched';
            let statusText = 'Awaiting check';
            if (run.arrivedFactoryAt || run.arrivedNotified) {
                statusClass = 'arrived';
                statusText = '🏭 Arrived at factory';
            } else if (verified) {
                if (run.lastDeviationBasis === 'route') {
                    statusClass = run.lastOnRoute ? 'verified' : 'off-route';
                    statusText = run.lastOnRoute
                        ? 'On route'
                        : `Off route (${(run.lastDeviationMeters / 1000).toFixed(1)}km)`;
                } else {
                    statusClass = 'unknown-route';
                    statusText = 'Checked — no route data';
                }
            }

            const etaText = run.lastEtaSeconds != null
                ? formatDuration(run.lastEtaSeconds) + (run.lastEtaBasis === 'fallback-speed' ? ' (est.)' : '')
                : '—';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="truck-cell">${truckId}</td>
                <td>${run.client || '—'}</td>
                <td>${run.siteName}</td>
                <td><span class="status-pill ${statusClass}"><span class="status-dot"></span>${statusText}</span></td>
                <td>${etaText}</td>
                <td>${verified ? timeAgo(run.lastVerifiedAt) : 'Dispatched ' + timeAgo(run.dispatchedAt)}</td>
                <td class="row-actions">
                    <button class="jump-btn">Locate</button>
                    <button class="route-btn">Route</button>
                    <button class="stop stop-btn">Stop</button>
                </td>
            `;
            tr.querySelector('.jump-btn').onclick = () => {
                switchView('dispatch');
                if (!map) return;
                setTimeout(() => {
                    map.invalidateSize();
                    if (run.lastCoords) map.setView(run.lastCoords, 10);
                    else map.fitBounds(L.latLngBounds([AMOUDA_COORDS, run.routeCoords]), { padding: [60, 60] });
                }, 60);
            };
            tr.querySelector('.route-btn').onclick = () => displayRunRoute(truckId, run);
            tr.querySelector('.stop-btn').onclick = () => stopTracking(truckId);
            tbody.appendChild(tr);
        });
    if (wrap) wrap.style.display = 'block';
}

export async function stopTracking(truckId) {
    const run = store.activeRuns[truckId];
    if (!run) return;
    if (run.marker && map) map.removeLayer(run.marker);
    run.stoppedAt = new Date();
    try {
        await completeRun(run);
    } catch (err) {
        alert(`Could not save the completed run to history: ${err.message}`);
        return;
    }
    rebuildActiveTrucksSelect();
    updateStatsDisplays();
    renderFleetTable();
    import('../views/history.js').then(m => m.renderHistoryTable());
    import('../views/dashboard.js').then(m => m.renderDashboard());
}

// ---------------------------------------------------------------------
// Dispatch queue (view-queue)
// ---------------------------------------------------------------------
let dispatchQueue = []; // [{ truckId, siteId, siteName, client, driverName }]

export function renderDispatchQueue() {
    const tbody = document.getElementById('queue-tbody');
    const emptyEl = document.getElementById('queue-empty');
    const startBtn = document.getElementById('queue-start-btn');
    if (!tbody) return;

    if (dispatchQueue.length === 0) {
        tbody.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        if (startBtn) startBtn.disabled = true;
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (startBtn) startBtn.disabled = false;

    tbody.innerHTML = dispatchQueue.map(q => `
        <tr>
            <td class="truck-cell">${q.truckId}</td>
            <td>${q.client || '—'}</td>
            <td>${q.siteName}</td>
            <td>${q.driverName || '—'}</td>
            <td><span class="status-pill dispatched"><span class="status-dot"></span>READY</span></td>
            <td><button class="row-actions queue-remove-btn" data-truck="${q.truckId}">Remove</button></td>
        </tr>
    `).join('');

    tbody.querySelectorAll('.queue-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeFromDispatchQueue(btn.dataset.truck));
    });
}

export function addToDispatchQueue() {
    if (!canDispatch()) { alert('Your account does not have permission to dispatch.'); return; }
    const truckId = document.getElementById('queue-truck-select').value;
    const siteId = document.getElementById('queue-site-select').value;
    if (!truckId || !siteId) {
        alert('Pick both a truck and a destination to add to the queue.');
        return;
    }
    if (dispatchQueue.find(q => q.truckId === truckId)) {
        alert(`${truckId} is already in the queue.`);
        return;
    }
    const site = store.sites.find(s => s.id === siteId);
    const driverName = store.fleetLiveData[truckId]?.driverName || null;
    dispatchQueue.push({ truckId, siteId, siteName: site.name, client: site.client || null, driverName });
    renderDispatchQueue();
    updateQueueReadyCount();
}

export function removeFromDispatchQueue(truckId) {
    dispatchQueue = dispatchQueue.filter(q => q.truckId !== truckId);
    renderDispatchQueue();
    updateQueueReadyCount();
}

function updateQueueReadyCount() {
    const countEl = document.getElementById('queue-ready-count');
    if (countEl) countEl.textContent = dispatchQueue.length;
    const startBtn = document.getElementById('queue-start-btn');
    if (startBtn) startBtn.disabled = dispatchQueue.length === 0;
}

export function startQueuedDispatch() {
    if (!canDispatch()) { alert('Your account does not have permission to dispatch.'); return; }
    if (dispatchQueue.length === 0) return;
    if (!map) {
        alert("The map hasn't loaded — can't calculate routes right now.");
        return;
    }

    let delay = 0;
    const queued = dispatchQueue.slice();
    dispatchQueue = [];
    renderDispatchQueue();
    updateQueueReadyCount();

    queued.forEach(q => {
        setTimeout(() => dispatchSingleQueueEntry(q), delay);
        delay += 400;
    });

    setTimeout(() => switchView('fleet'), delay + 200);
}

async function dispatchSingleQueueEntry(q) {
    const targetSite = store.sites.find(s => s.id === q.siteId);
    if (!targetSite || targetSite.lat == null || targetSite.lng == null) {
        console.warn(`Skipping ${q.truckId} — no coordinates for ${q.siteName}`);
        return;
    }
    const destinationCoords = [targetSite.lat, targetSite.lng];
    const run = {
        truckId: q.truckId,
        siteId: targetSite.id,
        siteName: targetSite.name,
        client: targetSite.client,
        routeCoords: destinationCoords,
        marker: null,
        dispatchedAt: new Date(),
        lastVerifiedAt: null,
        lastCoords: null
    };

    try {
        const id = await persistNewRun(run);
        run.id = id;
    } catch (err) {
        console.error(`Could not persist queued dispatch for ${q.truckId}:`, err.message);
        return;
    }

    const rc = createRouteControl(destinationCoords);
    rc.on('routesfound', async (e) => {
        const route = e.routes[0];
        const current = store.activeRuns[q.truckId];
        if (!current) return;
        current.routeLine = route.coordinates.map(c => [c.lat, c.lng]);
        current.routeTotalDistance = route.summary.totalDistance;
        current.routeTotalTime = route.summary.totalTime;
        if (current.id) {
            try {
                await updateRunFields(current.id, {
                    route_line: current.routeLine,
                    route_total_distance: current.routeTotalDistance,
                    route_total_time: current.routeTotalTime
                });
            } catch (err) { console.warn('Could not persist queued route geometry:', err.message); }
        }
    });
    rc.addTo(map);
    setTimeout(() => { try { map.removeControl(rc); } catch { /* gone */ } }, 30000);

    rebuildActiveTrucksSelect([q.truckId], targetSite);
    updateStatsDisplays();
    renderFleetTable();
    import('../views/dashboard.js').then(m => m.renderDashboard());
}

export function setupQueueControls() {
    const truckSelect = document.getElementById('queue-truck-select');
    const siteSelect = document.getElementById('queue-site-select');
    const addBtn = document.getElementById('queue-add-btn');
    const startBtn = document.getElementById('queue-start-btn');

    if (truckSelect) {
        truckSelect.innerHTML = '<option value="">-- Select Truck --</option>';
        store.trucks.forEach(truck => {
            const opt = document.createElement('option');
            opt.value = truck;
            opt.textContent = truck;
            truckSelect.appendChild(opt);
        });
    }
    if (siteSelect) {
        siteSelect.innerHTML = '<option value="">-- Select Destination --</option>';
        store.sites.filter(s => s.id !== 'site_0').forEach(site => {
            const opt = document.createElement('option');
            opt.value = site.id;
            opt.textContent = site.client ? `${site.name} — ${site.client}` : site.name;
            siteSelect.appendChild(opt);
        });
    }
    if (addBtn) addBtn.addEventListener('click', addToDispatchQueue);
    if (startBtn) startBtn.addEventListener('click', startQueuedDispatch);
    updateQueueReadyCount();
    renderDispatchQueue();
}

// ---------------------------------------------------------------------
// Sidebar dispatch controls wiring
// ---------------------------------------------------------------------
export function setupDispatchControls() {
    const startBtn = document.getElementById('start-btn');
    const fetchBtn = document.getElementById('fetch-verify-btn');
    const verifyBtn = document.getElementById('verify-btn');
    if (startBtn) startBtn.addEventListener('click', startTrackingMission);
    if (fetchBtn) fetchBtn.addEventListener('click', fetchAndVerifyTruckPosition);
    if (verifyBtn) verifyBtn.addEventListener('click', verifyTruckPositionManual);

    const truckSearch = document.getElementById('truck-search');
    if (truckSearch) truckSearch.addEventListener('input', e => renderTruckList(e.target.value));
    const siteSearch = document.getElementById('site-search');
    if (siteSearch) siteSearch.addEventListener('input', e => {
        filterSiteSelect(e.target.value);
        updateWorkflowSummary();
    });
    const siteSelect = document.getElementById('site-select');
    if (siteSelect) siteSelect.addEventListener('change', updateWorkflowSummary);

    populateSiteDropdown();
    renderTruckList('');
    renderConvoyChips();
    updateWorkflowSummary();
    rebuildActiveTrucksSelect();
}

export function updateFleetRefresh() {
    renderFleetTable();
    updateStatsDisplays();
}