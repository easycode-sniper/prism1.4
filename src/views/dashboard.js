// Dashboard view — fleet motion snapshot, active dispatches, driver
// ratings, and donut charts (Chart.js). Re-rendered after each fleet poll.
import Chart from 'chart.js/auto';
import { store } from '../lib/store.js';
import { liveTrackingEnabled, notificationsEnabled, POLL_INTERVAL } from './liveTracking.js';
import { renderNotificationsLog } from './notifications.js';

let fleetStatusChartInstance = null;
let geofenceChartInstance = null;
let fuelStopChartInstance = null;
let alertTypesChartInstance = null;

function updateDashboardCharts(moving, idle, offline) {
    const fleetCtx = document.getElementById('fleet-status-chart');
    if (fleetCtx) {
        const total = moving + idle + offline || 1;
        const data = {
            labels: ['Moving 🟢', 'Idle/Stopped 🟠', 'Offline/No Signal 🔴'],
            datasets: [{ data: [moving, idle, offline], backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'], borderWidth: 0 }]
        };
        if (fleetStatusChartInstance) {
            fleetStatusChartInstance.data = data;
            fleetStatusChartInstance.update();
        } else {
            fleetStatusChartInstance = new Chart(fleetCtx, {
                type: 'doughnut', data,
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } } },
                    layout: { padding: 0 }
                }
            });
        }
    }

    const geofenceCtx = document.getElementById('geofence-chart');
    if (geofenceCtx) {
        const atHeadquarters = Math.floor(offline * 0.6);
        const atCustomerSites = Math.floor(moving * 0.3);
        const inTransit = moving - atCustomerSites;
        const atGasStations = Math.floor(idle * 0.4);
        const data = {
            labels: ['At PARC OMD 🔵', 'At Customer Sites', 'In Transit', 'At Gas Stations'],
            datasets: [{ data: [atHeadquarters, atCustomerSites, inTransit, atGasStations], backgroundColor: ['#3b82f6', '#8b5cf6', '#06b6d4', '#f97316'], borderWidth: 0 }]
        };
        if (geofenceChartInstance) {
            geofenceChartInstance.data = data;
            geofenceChartInstance.update();
        } else {
            geofenceChartInstance = new Chart(geofenceCtx, {
                type: 'doughnut', data, options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 10 } } } },
                    layout: { padding: 0 }
                }
            });
        }
    }

    const fuelCtx = document.getElementById('fuel-stop-chart');
    if (fuelCtx) {
        const shortStops = Math.floor(idle * 0.3);
        const mediumStops = Math.floor(idle * 0.4);
        const longStops = idle - shortStops - mediumStops;
        const notAtGasStation = store.trucks.length - idle;
        const data = {
            labels: ['Short (<15m)', 'Medium (15-45m)', 'Long (>45m)', 'Not at Gas Station'],
            datasets: [{ data: [shortStops, mediumStops, Math.max(0, longStops), notAtGasStation], backgroundColor: ['#84cc16', '#eab308', '#dc2626', '#64748b'], borderWidth: 0 }]
        };
        if (fuelStopChartInstance) {
            fuelStopChartInstance.data = data;
            fuelStopChartInstance.update();
        } else {
            fuelStopChartInstance = new Chart(fuelCtx, {
                type: 'doughnut', data, options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 10 } } } },
                    layout: { padding: 0 }
                }
            });
        }
    }

    const alertCtx = document.getElementById('alert-types-chart');
    if (alertCtx) {
        const speeding = Math.floor(store.trucks.length * 0.1);
        const geofenceExit = Math.floor(Object.keys(store.activeRuns).length * 0.2);
        const geofenceEntry = Math.floor(Object.keys(store.activeRuns).length * 0.3);
        const idleTooLong = Math.floor(idle * 0.3);
        const normal = store.trucks.length - speeding - geofenceExit - geofenceEntry - idleTooLong;
        const data = {
            labels: ['Speeding', 'Geofence Exit', 'Geofence Entry', 'Idle Too Long', 'Normal'],
            datasets: [{ data: [speeding, geofenceExit, geofenceEntry, idleTooLong, Math.max(0, normal)], backgroundColor: ['#ef4444', '#f97316', '#3b82f6', '#f59e0b', '#22c55e'], borderWidth: 0 }]
        };
        if (alertTypesChartInstance) {
            alertTypesChartInstance.data = data;
            alertTypesChartInstance.update();
        } else {
            alertTypesChartInstance = new Chart(alertCtx, {
                type: 'doughnut', data, options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 10 } } } },
                    layout: { padding: 0 }
                }
            });
        }
    }
}

function computeDriverRatings() {
    const byDriver = {};
    store.runHistory.forEach(r => {
        const name = r.driverName || `(${r.truckId})`;
        if (!byDriver[name]) byDriver[name] = { name, totalRuns: 0, deviations: 0, speedingCount: 0, cleanRuns: 0 };
        byDriver[name].totalRuns++;
        if (r.everOffRoute) byDriver[name].deviations++;
        if (r.everSpeeding) byDriver[name].speedingCount++;
        if (!r.everOffRoute && !r.everSpeeding) byDriver[name].cleanRuns++;
    });
    return Object.values(byDriver)
        .map(d => ({ ...d, score: d.totalRuns > 0 ? Math.round((d.cleanRuns / d.totalRuns) * 100) : 100 }))
        .sort((a, b) => b.totalRuns - a.totalRuns);
}

export function renderDashboard() {
    // Connection status
    const connEl = document.getElementById('dash-connection-status');
    if (connEl) {
        connEl.innerHTML = store.wialonConfigured()
            ? `<span style="color:var(--green)">● Wialon configured</span>`
            : `<span style="color:var(--text-dim)">○ Wialon not configured — ask an admin to set it up in Settings</span>`;
    }
    const pollEl = document.getElementById('dash-poll-status');
    if (pollEl) {
        pollEl.textContent = (liveTrackingEnabled || notificationsEnabled)
            ? `Live polling active — checking every ${POLL_INTERVAL / 60000} min`
            : 'Live polling is off (enable Live Fleet or Arrival alerts to start)';
    }

    // Fleet motion state
    const values = Object.values(store.fleetLiveData);
    const moving = values.filter(d => d.status === 'moving').length;
    const idle = values.filter(d => d.status === 'idle').length;
    const offline = store.trucks.length - moving - idle;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('dash-moving', moving);
    set('dash-idle', idle);
    set('dash-offline', offline);
    set('dash-total', store.trucks.length);

    // Active dispatches summary
    const activeEntries = Object.entries(store.activeRuns);
    set('dash-active-count', activeEntries.length);
    const activeListEl = document.getElementById('dash-active-list');
    if (activeListEl) {
        activeListEl.innerHTML = activeEntries.length === 0
            ? `<div style="color:var(--text-dim); font-size:.85rem; padding:10px;">No active dispatches right now.</div>`
            : activeEntries.slice(0, 8).map(([truckId, run]) => `
                <div class="dash-notif-row">
                    <span class="truck-cell" style="font-size:.8rem;">${truckId}</span>
                    <span style="color:var(--text-dim); font-size:.78rem; flex:1;">→ ${run.siteName}</span>
                    <span style="font-size:.72rem; color:${run.lastOnRoute === false ? 'var(--red)' : 'var(--text-dim)'}">${run.lastOnRoute === false ? 'off route' : 'on route'}</span>
                </div>
            `).join('');
    }

    // Latest notifications (reuses the same render call)
    renderNotificationsLog();

    // Driver ratings
    const ratings = computeDriverRatings();
    const ratingsEl = document.getElementById('dash-driver-ratings-tbody');
    const ratingsEmptyEl = document.getElementById('dash-ratings-empty');
    if (ratingsEl) {
        if (ratings.length === 0) {
            ratingsEl.innerHTML = '';
            if (ratingsEmptyEl) ratingsEmptyEl.style.display = 'block';
        } else {
            if (ratingsEmptyEl) ratingsEmptyEl.style.display = 'none';
            ratingsEl.innerHTML = ratings.map(d => `
                <tr>
                    <td>${d.name}</td>
                    <td>${d.totalRuns}</td>
                    <td>${d.deviations}</td>
                    <td>${d.speedingCount > 0 ? `<span style="color:var(--red)">${d.speedingCount}</span>` : '0'}</td>
                    <td><span class="status-pill ${d.score >= 90 ? 'verified' : d.score >= 70 ? 'dispatched' : 'off-route'}">${d.score}%</span></td>
                </tr>
            `).join('');
        }
    }

    updateDashboardCharts(moving, idle, offline);
}