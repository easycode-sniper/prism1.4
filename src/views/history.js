// History view — completed runs, today's summary, CSV export, and the
// printable daily summary. Data comes from store.runHistory (Supabase).
import { store } from '../lib/store.js';
import { isSameCalendarDay } from '../lib/geometry.js';

function deriveOutcome(r) {
    return {
        reachedFactory: !!r.arrivedFactoryAt,
        reachedSite: !!r.arrivedSiteAt,
        hadDeviation: !!r.everOffRoute,
        hadSpeeding: !!r.everSpeeding,
    };
}

export function renderHistoryTable() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    const emptyEl = document.getElementById('history-empty');

    const today = new Date();
    const todaysRuns = store.runHistory.filter(r => isSameCalendarDay(r.stoppedAt || r.dispatchedAt, today));

    const totalEl = document.getElementById('history-total-today');
    const devEl = document.getElementById('history-deviations-today');
    const speedEl = document.getElementById('history-speeding-today');
    const factoryEl = document.getElementById('history-factory-today');
    if (totalEl) totalEl.textContent = todaysRuns.length;
    if (devEl) devEl.textContent = todaysRuns.filter(r => r.everOffRoute).length;
    if (speedEl) speedEl.textContent = todaysRuns.filter(r => r.everSpeeding).length;
    if (factoryEl) factoryEl.textContent = todaysRuns.filter(r => r.arrivedFactoryAt).length;

    if (store.runHistory.length === 0) {
        tbody.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    tbody.innerHTML = store.runHistory.map(r => {
        const from = r.dispatchedAt ? new Date(r.dispatchedAt) : null;
        const to = r.stoppedAt ? new Date(r.stoppedAt) : null;
        const durationMin = from && to ? Math.round((to - from) / 60000) : '—';
        const outcome = deriveOutcome(r);
        let text = outcome.reachedFactory ? '🏭 Reached factory' : outcome.reachedSite ? '🟢 Reached site' : 'Stopped early';
        if (outcome.hadDeviation) text += ' &middot; ⚠️ had deviation';
        if (outcome.hadSpeeding) text += ' &middot; 🟠 exceeded 90km/h';
        return `
            <tr>
                <td class="truck-cell">${r.truckId}</td>
                <td>${r.client || '—'}</td>
                <td>${r.siteName}</td>
                <td>${r.driverName || '—'}</td>
                <td>${from ? from.toLocaleString() : '—'}</td>
                <td>${to ? to.toLocaleString() : '—'}</td>
                <td>${durationMin}</td>
                <td>${text}</td>
            </tr>`;
    }).join('');
}

function csvEscape(s) {
    if (s == null) return '';
    const str = String(s);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

export function exportHistoryCsv() {
    const today = new Date();
    const rows = store.runHistory.filter(r => isSameCalendarDay(r.stoppedAt || r.dispatchedAt, today));
    if (rows.length === 0) {
        alert('No completed runs today yet — nothing to export.');
        return;
    }
    const header = ['Truck', 'Client', 'Destination', 'Driver', 'Dispatched At', 'Stopped At', 'Duration (min)', 'Reached Factory', 'Reached Site', 'Had Deviation', 'Exceeded Speed Limit'];
    const csvRows = [header.join(',')];
    rows.forEach(r => {
        const outcome = deriveOutcome(r);
        const from = r.dispatchedAt ? new Date(r.dispatchedAt) : null;
        const to = r.stoppedAt ? new Date(r.stoppedAt) : null;
        const durationMin = from && to ? Math.round((to - from) / 60000) : '';
        csvRows.push([
            csvEscape(r.truckId), csvEscape(r.client), csvEscape(r.siteName), csvEscape(r.driverName),
            from ? csvEscape(from.toLocaleString()) : '', to ? csvEscape(to.toLocaleString()) : '', durationMin,
            outcome.reachedFactory ? 'Yes' : 'No', outcome.reachedSite ? 'Yes' : 'No',
            outcome.hadDeviation ? 'Yes' : 'No', outcome.hadSpeeding ? 'Yes' : 'No'
        ].join(','));
    });
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dispatch-summary-${today.toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

export function printDailySummary() {
    const today = new Date();
    const rows = store.runHistory.filter(r => isSameCalendarDay(r.stoppedAt || r.dispatchedAt, today));
    const printArea = document.getElementById('print-summary-area');
    if (!printArea) return;

    if (rows.length === 0) {
        alert('No completed runs today yet — nothing to print.');
        return;
    }

    const deviations = rows.filter(r => r.everOffRoute).length;
    const speedingCount = rows.filter(r => r.everSpeeding).length;
    const returned = rows.filter(r => r.arrivedFactoryAt).length;

    const rowsHtml = rows.map(r => {
        const outcome = deriveOutcome(r);
        const from = r.dispatchedAt ? new Date(r.dispatchedAt).toLocaleString() : '—';
        const to = r.stoppedAt ? new Date(r.stoppedAt).toLocaleString() : '—';
        let status = outcome.reachedFactory ? '🏭 Reached factory' : outcome.reachedSite ? '🟢 Reached site' : 'Stopped early';
        if (outcome.hadDeviation) status += ' / ⚠️ deviation';
        if (outcome.hadSpeeding) status += ' / 🟠 speeding';
        return `<tr><td>${r.truckId}</td><td>${r.client || '—'}</td><td>${r.siteName}</td><td>${from}</td><td>${to}</td><td>${status}</td></tr>`;
    }).join('');

    printArea.innerHTML = `
        <h2>OMD Transport — Daily Dispatch Summary</h2>
        <p style="color:#444;">${today.toLocaleDateString()} &middot; ${rows.length} completed run(s)</p>
        <table border="1" cellpadding="6" style="border-collapse:collapse; width:100%; font-size:12px;">
            <thead><tr><th>Truck</th><th>Client</th><th>Destination</th><th>Dispatched</th><th>Stopped</th><th>Outcome</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
        <p style="margin-top:12px; font-size:12px; color:#444;">
            <b>Deviations:</b> ${deviations} &middot; <b>Speed limit breaches:</b> ${speedingCount} &middot; <b>Returned to factory:</b> ${returned}
        </p>`;

    setTimeout(() => window.print(), 200);
}

export function setupHistoryControls() {
    const csvBtn = document.getElementById('history-export-csv-btn');
    const printBtn = document.getElementById('history-print-btn');
    if (csvBtn) csvBtn.addEventListener('click', exportHistoryCsv);
    if (printBtn) printBtn.addEventListener('click', printDailySummary);
    renderHistoryTable();
}