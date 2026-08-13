// App entry — auth gate, shell injection, data load, and view wiring.
import shellHtml from './shell.html?raw';
import { supabase } from './lib/supabase.js';
import { refreshProfile, profile, signIn, onAuthChange } from './auth/auth.js';
import { loadAll, store } from './lib/store.js';
import { GAS_STATIONS } from './data/seed.js';
import { initMap, setupLayerToggle, plotSiteMarkers } from './map/map.js';

store.gasStations = GAS_STATIONS;

let bootStarted = false;

const holder = () => document.getElementById('app-shell-holder');
const loginEl = () => document.getElementById('login-screen');
const errorEl = () => document.getElementById('login-error');
const loginBtn = () => document.getElementById('login-btn');

function showLoginScreen(visible) {
    if (loginEl()) loginEl().classList.toggle('hidden', !visible);
    if (holder()) holder().classList.toggle('hidden', !!visible);
}

function wireSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const floatBtn = document.getElementById('floating-menu-btn');
    const closeBtn = document.getElementById('close-sidebar-btn');
    if (!sidebar || !floatBtn || !closeBtn) return;
    const invalidate = () => import('./map/map.js').then(m => m.map && m.map.invalidateSize());
    closeBtn.addEventListener('click', () => {
        sidebar.classList.add('collapsed');
        floatBtn.style.display = 'flex';
        setTimeout(invalidate, 400);
    });
    floatBtn.addEventListener('click', () => {
        sidebar.classList.remove('collapsed');
        floatBtn.style.display = 'none';
        setTimeout(invalidate, 400);
    });
}

async function bootApp() {
    if (bootStarted) return;
    bootStarted = true;

    holder().innerHTML = shellHtml;
    wireSidebarCollapse();

    const renderers = {
        dashboard: () => import('./views/dashboard.js').then(m => m.renderDashboard()),
        fleet: () => import('./views/dispatch.js').then(m => m.renderFleetTable()),
        history: () => import('./views/history.js').then(m => m.renderHistoryTable()),
        notifications: () => import('./views/notifications.js').then(m => m.renderNotificationsLog()),
        monitoring: () => import('./views/monitoring.js').then(m => m.renderMonitoringTable()),
        queue: () => import('./views/dispatch.js').then(m => m.renderDispatchQueue()),
        settings: () => import('./views/settings.js').then(m => { m.renderManualSiteList(); m.renderGeofenceList(); }),
        admin: () => import('./views/admin.js').then(m => m.renderAdminUsers())
    };

    const ui = await import('./views/ui.js');
    if (store.setting('language')) ui.setLanguage(store.setting('language'));
    if (store.setting('theme')) ui.setTheme(store.setting('theme'));
    ui.wireTopLevelControls(renderers);

    initMap();
    setupLayerToggle();
    plotSiteMarkers(store.sites);

    const dispatch = await import('./views/dispatch.js');
    dispatch.setupDispatchControls();
    dispatch.setupQueueControls();
    dispatch.updateWorkflowSummary();
    dispatch.renderFleetTable();

    const { setupMonitoringControls } = await import('./views/monitoring.js');
    setupMonitoringControls();

    const { setupSettingsControls, renderManualSiteList, renderGeofenceList } = await import('./views/settings.js');
    setupSettingsControls();
    renderManualSiteList();
    renderGeofenceList();

    const { setupHistoryControls } = await import('./views/history.js');
    setupHistoryControls();

    const { setupLiveFleetControls, refreshFullFleetLive } = await import('./views/liveTracking.js');
    setupLiveFleetControls();
    refreshFullFleetLive();

    const { setupAdminControls } = await import('./views/admin.js');
    if (profile()?.role === 'admin') setupAdminControls();

    ui.updateStatsDisplays();
    ui.switchView(roleDefaultView(), renderers);
}

function roleDefaultView() {
    return store.activeRuns && Object.keys(store.activeRuns).length > 0 ? 'fleet' : 'dashboard';
}

async function onSignedIn() {
    try {
        await refreshProfile();
        await loadAll();
        await bootApp();
    } catch (err) {
        console.error('Boot failed:', err);
        showLoginScreen(true);
        if (errorEl()) errorEl().textContent = `Failed to load the workspace: ${err.message}`;
    }
}

function onSignedOut() {
    showLoginScreen(true);
}

async function handleLogin() {
    if (errorEl()) errorEl().textContent = '';
    const email = document.getElementById('login-email')?.value.trim();
    const password = document.getElementById('login-password')?.value;
    if (!email || !password) {
        if (errorEl()) errorEl().textContent = 'Enter your email and password.';
        return;
    }
    const btn = loginBtn();
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    try {
        await signIn(email, password); // onAuthChange -> onSignedIn does the rest.
    } catch (err) {
        if (errorEl()) errorEl().textContent = err.message;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    }
}

// ---- wiring -------------------------------------------------------------
loginBtn()?.addEventListener('click', handleLogin);
document.getElementById('login-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
});

onAuthChange((event, session) => {
    if (session && !bootStarted) onSignedIn();
    else if (!session && bootStarted) { bootStarted = false; onSignedOut(); }
});