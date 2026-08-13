// Notifications log — renders store.notifications (persisted in Supabase).
import { store } from '../lib/store.js';

const icons = { factory: '🟣', site: '🟢', offroute: '🔴', speeding: '🟠' };

export function renderNotificationsLog() {
    const tbody = document.getElementById('notiflog-tbody');
    if (!tbody) return;
    const emptyEl = document.getElementById('notiflog-empty');

    if (store.notifications.length === 0) {
        tbody.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
    } else {
        if (emptyEl) emptyEl.style.display = 'none';
        tbody.innerHTML = store.notifications.slice(0, 300).map(n => `
            <tr>
                <td>${n.time.toLocaleTimeString()}</td>
                <td>${icons[n.kind] || '•'} ${n.kind}</td>
                <td class="truck-cell">${n.truckId}</td>
                <td>${n.message}</td>
            </tr>
        `).join('');
    }

    const dashLatest = document.getElementById('dashboard-latest-notifs');
    if (dashLatest) {
        dashLatest.innerHTML = store.notifications.length === 0
            ? `<div style="color:var(--text-dim); font-size:.85rem; padding:10px;">No notifications yet this session.</div>`
            : store.notifications.slice(0, 6).map(n => `
                <div class="dash-notif-row">
                    <span>${icons[n.kind] || '•'}</span>
                    <span class="truck-cell" style="font-size:.8rem;">${n.truckId}</span>
                    <span style="color:var(--text-dim); font-size:.78rem; flex:1;">${n.message}</span>
                    <span style="color:var(--text-dim); font-size:.72rem;">${n.time.toLocaleTimeString()}</span>
                </div>
            `).join('');
    }
}