// Monitoring view — live search + filter over the whole fleet.
// Data comes from store.fleetLiveData (refreshed by the polling loop).
import { store } from '../lib/store.js';
import { map } from '../map/map.js';
import { switchView } from './ui.js';

export function renderMonitoringTable() {
    const tbody = document.getElementById('monitoring-tbody');
    if (!tbody) return;

    const searchText = (document.getElementById('monitoring-search')?.value || '').toLowerCase();
    const activeFilter = document.querySelector('.monitoring-filter-btn.active')?.dataset.filter || 'all';

    let rows = store.trucks.filter(truckId => {
        const data = store.fleetLiveData[truckId] || { status: 'offline', matched: false };
        if (activeFilter === 'dispatched' && !store.activeRuns[truckId]) return false;
        if (activeFilter === 'moving' && data.status !== 'moving') return false;
        if (activeFilter === 'idle' && data.status !== 'idle') return false;
        if (activeFilter === 'offline' && data.status !== 'offline') return false;
        return true;
    });

    if (searchText) {
        rows = rows.filter(truckId => {
            const data = store.fleetLiveData[truckId] || {};
            return truckId.toLowerCase().includes(searchText) ||
                (data.driverName && data.driverName.toLowerCase().includes(searchText));
        });
    }

    const countEl = document.getElementById('monitoring-count');
    if (countEl) countEl.textContent = `${rows.length} / ${store.trucks.length}`;

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:30px;">No trucks match.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(truckId => {
        const data = store.fleetLiveData[truckId] || { status: 'offline', matched: false };
        const run = store.activeRuns[truckId];
        const isOffRoute = run && run.lastDeviationBasis === 'route' && run.lastOnRoute === false;
        let statusClass, statusLabel;
        if (isOffRoute) { statusClass = 'off-route'; statusLabel = '🔴 off-route'; }
        else if (data.status === 'moving') { statusClass = 'verified'; statusLabel = '🟢 moving'; }
        else if (data.status === 'idle') { statusClass = 'unknown-route'; statusLabel = '🔵 idle'; }
        else { statusClass = 'dispatched'; statusLabel = '⚪ offline'; }

        return `
            <tr class="monitoring-row" data-truck="${truckId}">
                <td class="truck-cell">${truckId}</td>
                <td>${data.driverName || '—'}</td>
                <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
                <td>${data.speed != null ? data.speed + ' km/h' : '—'}</td>
                <td>${run ? run.siteName : '—'}</td>
                <td>${data.ageMinutes != null ? data.ageMinutes + 'min ago' : '—'}</td>
                <td><button class="row-actions monitoring-locate-btn" data-truck="${truckId}">Locate</button></td>
            </tr>`;
    }).join('');

    tbody.querySelectorAll('.monitoring-locate-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const truckId = btn.dataset.truck;
            const data = store.fleetLiveData[truckId];
            switchView('dispatch');
            if (data && data.lat != null && map) {
                setTimeout(() => { map.invalidateSize(); map.setView([data.lat, data.lng], 12); }, 60);
            }
        });
    });
}

export function setupMonitoringControls() {
    const searchEl = document.getElementById('monitoring-search');
    if (searchEl) searchEl.addEventListener('input', renderMonitoringTable);

    document.querySelectorAll('.monitoring-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.monitoring-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderMonitoringTable();
        });
    });

    renderMonitoringTable();
}