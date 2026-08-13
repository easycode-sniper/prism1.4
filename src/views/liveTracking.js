// Live fleet polling + active-run alerts.
// Uses the SHARED Wialon config from store (set once by admin) and writes
// notifications + run updates to Supabase so the whole team sees them.
import { store } from '../lib/store.js';
import { fetchFullFleet, findWialonUnitPosition } from '../lib/wialon.js';
import { updateRunFields, insertNotification } from '../lib/store.js';
import {
    haversineMeters, pointInPolygon, distanceToPolygonBoundaryMeters, timeAgo
} from '../lib/geometry.js';
import { SITE_ARRIVAL_BUFFER_METERS, SPEED_LIMIT_KMH, FACTORY_ZONE_EDGE_BUFFER_METERS } from '../lib/geofence.js';
import { map, truckClusterGroup, liveTruckMarkers, animateMarkerTo } from '../map/map.js';
import { applyPositionCheck } from './dispatch.js';
import { t } from './ui.js';

const POLL_INTERVAL_MS = 60 * 1000;
const MOVING_SPEED_THRESHOLD_KMH = 5;
const OFFLINE_AFTER_MINUTES = 30;

export let liveTrackingEnabled = false;
export let notificationsEnabled = false;
let pollIntervalId = null;
let soundAlertsEnabled = false;

export const liveFleetFilters = { dispatched: true, idle: false, offline: false, all: false };

export { soundAlertsEnabled };

// ---------------------------------------------------------------------
// Polling control
// ---------------------------------------------------------------------
export function toggleLiveTracking() {
    liveTrackingEnabled = !liveTrackingEnabled;
    updateLiveTrackingToggleUI();
    if (!liveTrackingEnabled) {
        Object.values(liveTruckMarkers).forEach(m => truckClusterGroup && truckClusterGroup.removeLayer(m));
        for (const k of Object.keys(liveTruckMarkers)) delete liveTruckMarkers[k];
    }
    updatePollingState();
}

export function updateLiveTrackingToggleUI() {
    const btn = document.getElementById('live-tracking-toggle-btn');
    if (!btn) return;
    btn.classList.toggle('active', liveTrackingEnabled);
    btn.textContent = liveTrackingEnabled ? t('sidebar.liveFleetOn') : t('sidebar.liveFleetOff');
    const ops = document.getElementById('ops-live-dot');
    if (ops) ops.classList.toggle('live', liveTrackingEnabled);
}

export async function toggleNotifications() {
    if (notificationsEnabled) {
        notificationsEnabled = false;
        updateNotificationToggleUI();
        updatePollingState();
        return;
    }
    if (typeof Notification === 'undefined') {
        alert("This browser doesn't support desktop notifications.");
        return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        alert("Notifications weren't enabled. If you didn't see a permission prompt, they may be blocked for this page in your browser's site settings.");
        return;
    }
    notificationsEnabled = true;
    updateNotificationToggleUI();
    updatePollingState();
}

export function updateNotificationToggleUI() {
    const btn = document.getElementById('notify-toggle-btn');
    const statusEl = document.getElementById('notify-status');
    if (!btn) return;
    btn.classList.toggle('active', notificationsEnabled);
    btn.textContent = notificationsEnabled ? t('sidebar.notifyOn') : t('sidebar.notifyOff');
    if (statusEl) {
        statusEl.textContent = notificationsEnabled
            ? `Checking active trucks every ${POLL_INTERVAL_MS / 60000} min while this tab stays open`
            : '';
    }
}

export function toggleSoundAlerts() {
    soundAlertsEnabled = !soundAlertsEnabled;
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
        btn.classList.toggle('active', soundAlertsEnabled);
        btn.textContent = soundAlertsEnabled ? t('sidebar.soundOn') : t('sidebar.soundOff');
    }
    if (soundAlertsEnabled) playAlertSound('arrival');
}

function playAlertSound(kind) {
    if (!soundAlertsEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        if (kind === 'offroute') {
            osc.type = 'square';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
        } else {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(660, ctx.currentTime);
            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
        }
        gain.gain.setValueAtTime(0.22, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
    } catch { /* audio unavailable — ignore */ }
}

function updatePollingState() {
    if (liveTrackingEnabled || notificationsEnabled) startPolling();
    else stopPolling();
}

function startPolling() {
    if (pollIntervalId) return;
    refreshFullFleetLive();
    pollIntervalId = setInterval(refreshFullFleetLive, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollIntervalId) clearInterval(pollIntervalId);
    pollIntervalId = null;
}

// ---------------------------------------------------------------------
// Full-fleet refresh
// ---------------------------------------------------------------------
function classifyTruckStatus(unit) {
    if (!unit || !unit.pos) return 'offline';
    const speed = unit.pos.s || 0;
    const ageMinutes = (Date.now() / 1000 - unit.pos.t) / 60;
    if (ageMinutes >= OFFLINE_AFTER_MINUTES) return 'offline';
    if (speed > MOVING_SPEED_THRESHOLD_KMH) return 'moving';
    return 'idle';
}

function matchFleetToUnits(rawUnits) {
    const matched = {};
    const usedUnitIds = new Set();
    store.trucks.forEach(truckId => {
        const candidates = [truckId, truckId.replace(/^0+/, ''), truckId.split('-')[0]];
        let foundUnit = null;
        for (const candidate of candidates) {
            const hit = rawUnits.find(u => !usedUnitIds.has(u.id) && u.nm && u.nm.includes(candidate));
            if (hit) { foundUnit = hit; break; }
        }
        if (foundUnit) {
            matched[truckId] = foundUnit;
            usedUnitIds.add(foundUnit.id);
        }
    });
    return matched;
}

export async function refreshFullFleetLive() {
    const config = store.wialonConfig();
    if (!config.relay || !config.server || !config.token) return;

    let units, driverMaps;
    try {
        ({ units, driverMaps } = await fetchFullFleet());
    } catch (err) {
        console.warn('Full fleet refresh failed:', err.message);
        return;
    }

    const matched = matchFleetToUnits(units);
    store.fleetLiveData = {};
    store.trucks.forEach(truckId => {
        const unit = matched[truckId];
        if (!unit) {
            store.fleetLiveData[truckId] = { matched: false, status: 'offline' };
            return;
        }
        const status = classifyTruckStatus(unit);
        const driverName = (driverMaps.driverByUnitId[unit.id]) ||
            ((unit.pos?.lmsg?.p?.drv || unit.pos?.p?.drv || unit.drv) && driverMaps.driverByCode[unit.pos.lmsg?.p?.drv || unit.pos?.p?.drv || unit.drv]) ||
            null;
        store.fleetLiveData[truckId] = {
            matched: true,
            lat: unit.pos ? unit.pos.y : null,
            lng: unit.pos ? unit.pos.x : null,
            speed: unit.pos ? unit.pos.s : null,
            course: unit.pos && unit.pos.c != null ? unit.pos.c : null,
            ageMinutes: unit.pos ? Math.round((Date.now() / 1000 - unit.pos.t) / 60) : null,
            status,
            unitName: unit.nm,
            driverName
        };
    });

    store.lastFleetRefreshAt = new Date();
    await Promise.all([
        renderLiveFleetMarkers(),
        renderLiveFleetList(),
        updateHeaderStats(),
        updateOpsStripLite(),
        import('../views/dashboard.js').then(m => m.renderDashboard())
    ]);

    if (notificationsEnabled) checkActiveRunsForAlerts();
}

function updateOpsStripLite() {
    const el = document.getElementById('ops-last-update');
    if (el) el.textContent = store.lastFleetRefreshAt.toLocaleTimeString();
}

function updateHeaderStats() {
    const values = Object.values(store.fleetLiveData);
    const moving = values.filter(d => d.status === 'moving').length;
    const idle = values.filter(d => d.status === 'idle').length;
    const offline = values.filter(d => d.status === 'offline').length;
    const el = document.getElementById('topbar-live-stats');
    if (el) el.textContent = `${moving} Moving · ${idle} Idle · ${offline} Offline`;
}

export function passesLiveFilter(data, truckId) {
    if (liveFleetFilters.all) return true;
    if (liveFleetFilters.dispatched && store.activeRuns[truckId]) return true;
    if (liveFleetFilters.idle && data.status === 'idle') return true;
    if (liveFleetFilters.offline && data.status === 'offline') return true;
    return false;
}

function renderLiveFleetMarkers() {
    if (!map) return;
    Object.entries(store.fleetLiveData).forEach(([truckId, data]) => {
        const shouldShow = liveTrackingEnabled && data.matched && data.lat != null && passesLiveFilter(data, truckId);

        if (!shouldShow) {
            if (liveTruckMarkers[truckId]) {
                truckClusterGroup.removeLayer(liveTruckMarkers[truckId]);
                delete liveTruckMarkers[truckId];
            }
            return;
        }

        const label = data.driverName ? `${data.driverName} · ${truckId}` : truckId;
        const run = store.activeRuns[truckId];
        const isOffRoute = run && run.lastDeviationBasis === 'route' && run.lastOnRoute === false;

        let statusColor;
        if (isOffRoute) statusColor = '#d92d42';
        else if (data.status === 'moving') statusColor = '#159c83';
        else if (data.status === 'idle') statusColor = '#167d8d';
        else statusColor = '#6b7280';

        const markerShapeHtml = data.course != null
            ? `<svg class="live-truck-arrow" width="22" height="22" viewBox="0 0 24 24" style="transform:rotate(${data.course}deg); filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));"><path d="M12 1.5 L20 21 L12 16 L4 21 Z" fill="${statusColor}" stroke="#0a0a14" stroke-width="1.75" stroke-linejoin="round"/></svg>`
            : `<div class="live-truck-dot" style="background:${statusColor}; box-shadow:0 0 8px ${statusColor}"></div>`;

        const icon = L.divIcon({
            className: 'live-truck-marker',
            html: `<div class="live-truck-label">${label}</div>${markerShapeHtml}`,
            iconSize: [140, 34],
            iconAnchor: [70, 30]
        });

        if (liveTruckMarkers[truckId]) {
            animateMarkerTo(liveTruckMarkers[truckId], [data.lat, data.lng]);
            liveTruckMarkers[truckId].setIcon(icon);
        } else {
            liveTruckMarkers[truckId] = L.marker([data.lat, data.lng], { icon }).addTo(truckClusterGroup);
        }
        liveTruckMarkers[truckId].bindPopup(
            `<b>🚚 ${truckId}</b>${data.driverName ? `<br>Driver: ${data.driverName}` : ''}<br>${data.status} &middot; ${data.speed || 0} km/h${data.course != null ? ` &middot; heading ${Math.round(data.course)}°` : ''}<br><span style="color:#8f8fb0; font-size:.8em;">Updated ${data.ageMinutes}min ago</span>`
        );
    });
    if (truckClusterGroup.refreshClusters) truckClusterGroup.refreshClusters();
}

function renderLiveFleetList() {
    const listEl = document.getElementById('live-fleet-list');
    if (!listEl) return;

    const searchText = (document.getElementById('live-fleet-search')?.value || '').toLowerCase();
    const rows = store.trucks
        .filter(truckId => passesLiveFilter(store.fleetLiveData[truckId] || { status: 'offline' }, truckId))
        .filter(truckId => {
            if (!searchText) return true;
            const data = store.fleetLiveData[truckId] || {};
            return truckId.toLowerCase().includes(searchText) ||
                (data.driverName && data.driverName.toLowerCase().includes(searchText));
        });

    if (rows.length === 0) {
        listEl.innerHTML = `<div style="padding:14px; color:var(--text-dim); font-size:.8rem; text-align:center;">No trucks match the current filters.</div>`;
        return;
    }

    listEl.innerHTML = rows.map(truckId => {
        const data = store.fleetLiveData[truckId] || { status: 'offline', matched: false };
        const run = store.activeRuns[truckId];
        const isOffRoute = run && run.lastDeviationBasis === 'route' && run.lastOnRoute === false;
        let statusColor, statusLabel;
        if (isOffRoute) { statusColor = '#f87171'; statusLabel = 'off-route'; }
        else if (data.status === 'moving') { statusColor = 'var(--green)'; statusLabel = 'moving'; }
        else if (data.status === 'idle') { statusColor = '#22d3ee'; statusLabel = 'idle'; }
        else { statusColor = 'var(--text-dim)'; statusLabel = 'offline'; }
        return `
            <div class="live-fleet-row" data-truck="${truckId}">
                <div class="live-fleet-row-main">
                    <span class="live-fleet-driver">${data.driverName || '—'}</span>
                    <span class="live-fleet-truckid">${truckId}</span>
                </div>
                <div class="live-fleet-row-meta">
                    <span style="color:${statusColor}">● ${data.matched ? statusLabel : 'unmatched'}</span>
                    ${data.speed != null ? `<span>${data.speed} km/h</span>` : ''}
                    ${run ? `<span class="live-fleet-dest">→ ${run.siteName}</span>` : ''}
                </div>
            </div>`;
    }).join('');

    listEl.querySelectorAll('.live-fleet-row').forEach(row => {
        row.addEventListener('click', () => {
            const truckId = row.dataset.truck;
            const data = store.fleetLiveData[truckId];
            if (map && data && data.lat != null) map.setView([data.lat, data.lng], 12);
        });
    });
}

// ---------------------------------------------------------------------
// Active-run alerts (off-route, speeding, arrivals)
// ---------------------------------------------------------------------
function isNearGeofence(point, geofence) {
    if (geofence.center && geofence.radius) {
        const dist = haversineMeters(point[0], point[1], geofence.center[0], geofence.center[1]);
        return dist <= geofence.radius + 50;
    }
    if (pointInPolygon(point, geofence.polygon)) return true;
    return distanceToPolygonBoundaryMeters(point, geofence.polygon) <= FACTORY_ZONE_EDGE_BUFFER_METERS;
}

export async function checkActiveRunsForAlerts() {
    const entries = Object.entries(store.activeRuns);
    for (const [truckId, run] of entries) {
        const data = store.fleetLiveData[truckId];
        if (!data || !data.matched || data.lat == null) continue;

        const point = [data.lat, data.lng];
        applyPositionCheck(truckId, point, `Auto-checked ${new Date().toLocaleTimeString()}`, {
            openPopup: false, recenterMap: false
        });

        const updates = {};
        let notifyMe = null;

        if (run.lastDeviationBasis === 'route') {
            if (!run.lastOnRoute && !run.offRouteNotified) {
                run.offRouteNotified = true;
                run.everOffRoute = true;
                updates.ever_off_route = true;
                notifyMe = ['offroute', truckId, `${truckId} has deviated from its route to ${run.siteName} (${(run.lastDeviationMeters / 1000).toFixed(1)}km off).`];
            } else if (run.lastOnRoute) {
                run.offRouteNotified = false;
            }
        }

        if (data.speed != null) {
            if (data.speed > SPEED_LIMIT_KMH && !run.speedingNotified) {
                run.speedingNotified = true;
                run.everSpeeding = true;
                updates.ever_speeding = true;
                notifyMe = notifyMe || ['speeding', truckId, `${truckId} is going ${Math.round(data.speed)}km/h on the run to ${run.siteName} (limit ${SPEED_LIMIT_KMH}km/h).`];
            } else if (data.speed <= SPEED_LIMIT_KMH) {
                run.speedingNotified = false;
            }
        }

        const factoryGeofence = store.geofences.find(g => g.kind === 'factory');
        if (factoryGeofence && !run.arrivedNotified && isNearGeofence(point, factoryGeofence)) {
            run.arrivedNotified = true;
            run.arrivedFactoryAt = new Date();
            updates.arrived_factory_at = new Date().toISOString();
            notifyMe = notifyMe || ['factory', truckId, `${truckId} is back at Usine Amouda Ciment (was on a run to ${run.siteName}).`];
        }

        if (!run.siteArrivedNotified) {
            const siteGeofence = store.geofences.find(g => g.kind === 'site' && g.siteId === run.siteId);
            let arrived = false;
            if (siteGeofence) arrived = isNearGeofence(point, siteGeofence);
            else if (run.routeCoords) arrived = haversineMeters(point[0], point[1], run.routeCoords[0], run.routeCoords[1]) <= SITE_ARRIVAL_BUFFER_METERS;
            if (arrived) {
                run.siteArrivedNotified = true;
                run.arrivedSiteAt = new Date();
                updates.arrived_site_at = new Date().toISOString();
                notifyMe = notifyMe || ['site', truckId, `${truckId} has arrived at ${run.siteName}.`];
            }
        }

        if (Object.keys(updates).length > 0 && run.id) {
            await updateRunFields(run.id, updates);
        }
        if (notifyMe) {
            fireNotification(...notifyMe, run);
        }
    }
}

async function fireNotification(kind, truckId, message) {
    playAlertSound(kind === 'offroute' || kind === 'speeding' ? 'offroute' : 'arrival');
    const iconMap = { factory: '🟣', site: '🟢', offroute: '🔴', speeding: '🟠' };
    try {
        await insertNotification(kind, truckId, message);
    } catch (err) {
        console.warn('Could not persist notification:', err.message);
    }
    import('../views/notifications.js').then(m => m.renderNotificationsLog());

    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const titles = {
        factory: '🟣 Truck entered factory',
        site: '🟢 Truck arrived at customer',
        offroute: '🔴 Truck left assigned route',
        speeding: '🟠 Speed limit exceeded'
    };
    try {
        const n = new Notification(titles[kind], { body: message, tag: `${kind}-${truckId}` });
        n.onclick = () => window.focus();
    } catch { /* notifications blocked — ignore */ }
}

export function callFindWialonUnitPosition(truckId) {
    return findWialonUnitPosition(truckId);
}

// Expose for ui.js live flag reads when no renderers are attached yet.
export function isLiveTrackingEnabled() { return liveTrackingEnabled; }
export const POLL_INTERVAL = POLL_INTERVAL_MS;

// ---------------------------------------------------------------------
// Sidebar live-fleet controls wiring
// ---------------------------------------------------------------------
export function setupLiveFleetControls() {
    const toggleBtn = document.getElementById('live-tracking-toggle-btn');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleLiveTracking);

    const notifyBtn = document.getElementById('notify-toggle-btn');
    if (notifyBtn) notifyBtn.addEventListener('click', toggleNotifications);

    const soundBtn = document.getElementById('sound-toggle-btn');
    if (soundBtn) soundBtn.addEventListener('click', toggleSoundAlerts);

    ['dispatched', 'idle', 'offline', 'all'].forEach(key => {
        const cb = document.getElementById(`filter-${key}`);
        if (!cb) return;
        cb.addEventListener('change', () => {
            liveFleetFilters[key] = cb.checked;
            if (key === 'all' && cb.checked) {
                ['dispatched', 'idle', 'offline'].forEach(k => {
                    liveFleetFilters[k] = false;
                    const otherCb = document.getElementById(`filter-${k}`);
                    if (otherCb) otherCb.checked = false;
                });
            } else if (cb.checked) {
                liveFleetFilters.all = false;
                const allCb = document.getElementById('filter-all');
                if (allCb) allCb.checked = false;
            }
            renderLiveFleetMarkers();
            renderLiveFleetList();
        });
    });

    const searchEl = document.getElementById('live-fleet-search');
    if (searchEl) searchEl.addEventListener('input', renderLiveFleetList);

    updateLiveTrackingToggleUI();
    updateNotificationToggleUI();
    updateSoundToggleUI();
    renderLiveFleetList();
}

function updateSoundToggleUI() {
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
        btn.classList.toggle('active', soundAlertsEnabled);
        btn.textContent = soundAlertsEnabled ? t('sidebar.soundOn') : t('sidebar.soundOff');
    }
}

// Re-export helpers used by views.
export { timeAgo };
export async function exportHistoryCsv() { const m = await import('./history.js'); return m.exportHistoryCsv(); }
export async function printDailySummary() { const m = await import('./history.js'); return m.printDailySummary(); }