// Shared UI logic: tab switching, theme, language/i18n, stats strip.
// Ported from the legacy app; state now reads from src/lib/store.js.
import { store } from '../lib/store.js';
import { profile, isAdmin, isOps } from '../auth/auth.js';
import { applyViewPermissions, roleLabel } from '../auth/requireRole.js';
import { map } from '../map/map.js';

let currentLanguage = 'en';

const translations = {
    en: {
        'nav.dashboard': '🏠 Dashboard', 'nav.dispatch': '🗺️ Dispatch', 'nav.monitoring': '🔎 Monitoring',
        'nav.queue': '📋 Queue', 'nav.fleet': '📊 Active Fleet', 'nav.history': '📜 History',
        'nav.notifications': '🔔 Notifications', 'nav.settings': '⚙️ Settings',
        'brand.title': 'Fleet Route Monitor', 'brand.subtitle': 'OMD Transport · Amouda Line',
        'sidebar.liveFleetOff': '📡 Live Fleet OFF', 'sidebar.liveFleetOn': '📡 Live Fleet ON',
        'sidebar.filterDispatched': 'Dispatched', 'sidebar.filterIdle': 'Idle', 'sidebar.filterOffline': 'Offline', 'sidebar.filterAll': 'All',
        'sidebar.searchPlaceholder': 'Search driver or truck ID...',
        'sidebar.step1': 'Select Truck(s)', 'sidebar.step2': 'Route', 'sidebar.step3': 'Verify Position',
        'sidebar.truckSearchPlaceholder': 'Type truck ID to filter...',
        'sidebar.startingFactory': 'Starting factory',
        'sidebar.destination': 'Destination — client or site name',
        'sidebar.destinationSearchPlaceholder': 'Type client name or town...',
        'sidebar.startBtn': '▶ Start Tracking Run',
        'sidebar.activeRun': 'Active run',
        'sidebar.fetchBtn': '📡 Fetch Live Position & Check Route',
        'sidebar.pasteManually': 'Paste coordinates manually instead',
        'sidebar.checkPasted': 'Check with pasted coordinates',
        'sidebar.notifyOff': '🔕 Arrival alerts OFF', 'sidebar.notifyOn': '🔔 Arrival alerts ON',
        'sidebar.soundOff': '🔇 Sound OFF', 'sidebar.soundOn': '🔊 Sound ON',
        'sidebar.activeFleet': 'Active monitored fleet',
        'table.truck': 'Truck', 'table.client': 'Client', 'table.destination': 'Destination',
        'table.driver': 'Driver', 'table.status': 'Status', 'table.eta': 'ETA', 'table.lastUpdate': 'Last update',
        'table.dispatched': 'Dispatched', 'table.stopped': 'Stopped', 'table.duration': 'Duration', 'table.outcome': 'Outcome',
        'btn.locate': 'Locate', 'btn.route': 'Route', 'btn.stop': 'Stop', 'btn.remove': 'Remove',
        'settings.title': 'Settings', 'settings.subtitle': 'Appearance, language, Wialon connection, and site/geofence data — everything you configure once and rarely touch.',
        'settings.appearance': '🎨 Appearance', 'settings.language': '🌐 Language',
        'settings.wialon': '🔌 Wialon Connection', 'settings.sites': '📍 Sites & Geofences',
        'settings.addSite': '➕ Add a new site', 'settings.bulkImport': '📦 Bulk import from Wialon (KML)',
        'settings.manualSites': 'Manually added sites', 'settings.loadedZones': 'Loaded KML zones',
        'settings.testConnection': 'Test Connection', 'settings.saveSite': 'Save site',
        'settings.saveWialon': 'Save Wialon settings'
    },
    fr: {
        'nav.dashboard': '🏠 Tableau de bord', 'nav.dispatch': '🗺️ Répartition', 'nav.monitoring': '🔎 Surveillance',
        'nav.queue': '📋 File d\'attente', 'nav.fleet': '📊 Flotte active', 'nav.history': '📜 Historique',
        'nav.notifications': '🔔 Notifications', 'nav.settings': '⚙️ Paramètres',
        'brand.title': 'Suivi des itinéraires', 'brand.subtitle': 'OMD Transport · Ligne Amouda',
        'sidebar.liveFleetOff': '📡 Suivi en direct DÉSACTIVÉ', 'sidebar.liveFleetOn': '📡 Suivi en direct ACTIVÉ',
        'sidebar.filterDispatched': 'Envoyés', 'sidebar.filterIdle': 'Inactifs', 'sidebar.filterOffline': 'Hors ligne', 'sidebar.filterAll': 'Tous',
        'sidebar.searchPlaceholder': 'Rechercher un chauffeur ou un camion...',
        'sidebar.step1': 'Sélectionner le(s) camion(s)', 'sidebar.step2': 'Itinéraire', 'sidebar.step3': 'Vérifier la position',
        'sidebar.truckSearchPlaceholder': 'Filtrer par ID de camion...',
        'sidebar.startingFactory': 'Usine de départ',
        'sidebar.destination': 'Destination — client ou site',
        'sidebar.destinationSearchPlaceholder': 'Nom du client ou de la ville...',
        'sidebar.startBtn': '▶ Démarrer le suivi',
        'sidebar.activeRun': 'Trajet actif',
        'sidebar.fetchBtn': '📡 Récupérer la position & vérifier l\'itinéraire',
        'sidebar.pasteManually': 'Coller les coordonnées manuellement',
        'sidebar.checkPasted': 'Vérifier avec les coordonnées collées',
        'sidebar.notifyOff': '🔕 Alertes d\'arrivée DÉSACTIVÉES', 'sidebar.notifyOn': '🔔 Alertes d\'arrivée ACTIVÉES',
        'sidebar.soundOff': '🔇 Son DÉSACTIVÉ', 'sidebar.soundOn': '🔊 Son ACTIVÉ',
        'sidebar.activeFleet': 'Flotte surveillée active',
        'table.truck': 'Camion', 'table.client': 'Client', 'table.destination': 'Destination',
        'table.driver': 'Chauffeur', 'table.status': 'Statut', 'table.eta': 'ETA', 'table.lastUpdate': 'Dernière mise à jour',
        'table.dispatched': 'Envoyé', 'table.stopped': 'Arrêté', 'table.duration': 'Durée', 'table.outcome': 'Résultat',
        'btn.locate': 'Localiser', 'btn.route': 'Itinéraire', 'btn.stop': 'Arrêter', 'btn.remove': 'Retirer',
        'settings.title': 'Paramètres', 'settings.subtitle': 'Apparence, langue, connexion Wialon et données des sites/géorepérages — tout ce que vous configurez une fois pour toutes.',
        'settings.appearance': '🎨 Apparence', 'settings.language': '🌐 Langue',
        'settings.wialon': '🔌 Connexion Wialon', 'settings.sites': '📍 Sites et géorepérages',
        'settings.addSite': '➕ Ajouter un nouveau site', 'settings.bulkImport': '📦 Import groupé depuis Wialon (KML)',
        'settings.manualSites': 'Sites ajoutés manuellement', 'settings.loadedZones': 'Zones KML chargées',
        'settings.testConnection': 'Tester la connexion', 'settings.saveSite': 'Enregistrer le site',
        'settings.saveWialon': 'Enregistrer la configuration Wialon'
    },
    ar: {
        'nav.dashboard': '🏠 لوحة التحكم', 'nav.dispatch': '🗺️ الإرسال', 'nav.monitoring': '🔎 المراقبة',
        'nav.queue': '📋 قائمة الانتظار', 'nav.fleet': '📊 الأسطول النشط', 'nav.history': '📜 السجل',
        'nav.notifications': '🔔 الإشعارات', 'nav.settings': '⚙️ الإعدادات',
        'brand.title': 'مراقبة مسارات الأسطول', 'brand.subtitle': 'OMD للنقل · خط أموداء',
        'sidebar.liveFleetOff': '📡 التتبع المباشر متوقف', 'sidebar.liveFleetOn': '📡 التتبع المباشر مفعّل',
        'sidebar.filterDispatched': 'تم الإرسال', 'sidebar.filterIdle': 'متوقف مؤقتاً', 'sidebar.filterOffline': 'غير متصل', 'sidebar.filterAll': 'الكل',
        'sidebar.searchPlaceholder': 'ابحث عن سائق أو رقم شاحنة...',
        'sidebar.step1': 'اختر الشاحنة (الشاحنات)', 'sidebar.step2': 'المسار', 'sidebar.step3': 'تحقق من الموقع',
        'sidebar.truckSearchPlaceholder': 'اكتب رقم الشاحنة للتصفية...',
        'sidebar.startingFactory': 'المصنع المنطلق',
        'sidebar.destination': 'الوجهة — العميل أو الموقع',
        'sidebar.destinationSearchPlaceholder': 'اسم العميل أو المدينة...',
        'sidebar.startBtn': '▶ بدء التتبع',
        'sidebar.activeRun': 'الرحلة النشطة',
        'sidebar.fetchBtn': '📡 جلب الموقع الحالي والتحقق من المسار',
        'sidebar.pasteManually': 'إدخال الإحداثيات يدوياً بدلاً من ذلك',
        'sidebar.checkPasted': 'تحقق بالإحداثيات المُدخلة',
        'sidebar.notifyOff': '🔕 تنبيهات الوصول متوقفة', 'sidebar.notifyOn': '🔔 تنبيهات الوصول مفعّلة',
        'sidebar.soundOff': '🔇 الصوت متوقف', 'sidebar.soundOn': '🔊 الصوت مفعّل',
        'sidebar.activeFleet': 'الأسطول المراقَب النشط',
        'table.truck': 'الشاحنة', 'table.client': 'العميل', 'table.destination': 'الوجهة',
        'table.driver': 'السائق', 'table.status': 'الحالة', 'table.eta': 'الوقت المتوقع للوصول', 'table.lastUpdate': 'آخر تحديث',
        'table.dispatched': 'تم الإرسال', 'table.stopped': 'تم الإيقاف', 'table.duration': 'المدة', 'table.outcome': 'النتيجة',
        'btn.locate': 'تحديد الموقع', 'btn.route': 'المسار', 'btn.stop': 'إيقاف', 'btn.remove': 'إزالة',
        'settings.title': 'الإعدادات', 'settings.subtitle': 'المظهر واللغة واتصال Wialon وبيانات المواقع/الجيوفنس — كل ما تقوم بإعداده مرة واحدة ونادراً ما تعدّله.',
        'settings.appearance': '🎨 المظهر', 'settings.language': '🌐 اللغة',
        'settings.wialon': '🔌 اتصال Wialon', 'settings.sites': '📍 المواقع والجيوفنس',
        'settings.addSite': '➕ إضافة موقع جديد', 'settings.bulkImport': '📦 استيراد جماعي من Wialon (KML)',
        'settings.manualSites': 'المواقع المضافة يدوياً', 'settings.loadedZones': 'مناطق KML المحمّلة',
        'settings.testConnection': 'اختبار الاتصال', 'settings.saveSite': 'حفظ الموقع',
        'settings.saveWialon': 'حفظ إعدادات Wialon'
    }
};

export function t(key) {
    return (translations[currentLanguage] && translations[currentLanguage][key]) || translations.en[key] || key;
}

export function setLanguage(lang) {
    currentLanguage = lang;
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });
    applyTranslations();
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translated = t(key);
        if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
            el.setAttribute('placeholder', translated);
        } else {
            el.textContent = translated;
        }
    });
    // Refresh dynamic button labels that come from JS.
    const liveBtn = document.getElementById('live-tracking-toggle-btn');
    if (liveBtn && liveTrackingEnabled != null) {
        updateLiveTrackingToggleUI();
        updateNotificationToggleUI();
    }
}

export function setTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === name);
    });
}

import { liveTrackingEnabled, updateLiveTrackingToggleUI, updateNotificationToggleUI } from './liveTracking.js';

// ---------------------------------------------------------------------
// View switching + top-level wiring (called once after shell injection)
// ---------------------------------------------------------------------
export function wireTopLevelControls(renderers) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view, renderers));
    });

    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => setTheme(btn.dataset.theme));
    });
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
    });

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        const { signOut } = await import('../auth/auth.js');
        await signOut();
        location.reload(); // clean slate: drop the mounted map + injected shell
    });

    // Fill the user chip.
    const p = profile();
    const userEmail = document.getElementById('user-email');
    const userRole = document.getElementById('user-role');
    if (userEmail) userEmail.textContent = p?.email || '—';
    if (userRole) userRole.textContent = p ? roleLabel(p.role) : '—';

    applyViewPermissions();
    setTheme('dark');
}

export function switchView(viewName, renderers = {}) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
    document.querySelectorAll('.view').forEach(v => {
        const perm = v.dataset.perm;
        const allowed =
            !perm ||
            perm === 'viewer' ||
            (perm === 'dispatcher' && isOps()) ||
            (perm === 'admin' && isAdmin());
        v.classList.toggle('active', allowed && v.id === `view-${viewName}`);
    });

    if (renderers[viewName]) renderers[viewName]();
    if (viewName === 'dispatch') {
        setTimeout(() => { if (map) map.invalidateSize(); }, 50);
    }
}

// ---------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------
export function updateStatsDisplays() {
    const activeCount = Object.keys(store.activeRuns).length;
    const el = document.getElementById('active-count');
    if (el) el.textContent = activeCount;
    const fleetTotal = document.getElementById('fleet-total');
    if (fleetTotal) fleetTotal.textContent = store.trucks.length;
    const topbarActive = document.getElementById('topbar-active-count');
    if (topbarActive) topbarActive.textContent = activeCount;
    const topbarFleet = document.getElementById('topbar-fleet-total');
    if (topbarFleet) topbarFleet.textContent = store.trucks.length;
    updateOperationsStrip();
}

export function updateOperationsStrip() {
    const activeCount = Object.keys(store.activeRuns).length;
    const offRouteCount = Object.values(store.activeRuns).filter(run => run.lastOnRoute === false).length;

    const liveDot = document.getElementById('ops-live-dot');
    const liveLabel = document.getElementById('ops-live-label');
    const activeEl = document.getElementById('ops-active-count');
    const offRouteEl = document.getElementById('ops-offroute-count');
    const lastUpdateEl = document.getElementById('ops-last-update');

    if (liveDot) liveDot.classList.toggle('live', liveTrackingEnabled);
    if (liveLabel) liveLabel.textContent = liveTrackingEnabled ? 'Live tracking active' : 'Live tracking paused';
    if (activeEl) activeEl.textContent = activeCount;
    if (offRouteEl) offRouteEl.textContent = offRouteCount;
    if (lastUpdateEl) {
        lastUpdateEl.textContent = store.lastFleetRefreshAt ? new Date(store.lastFleetRefreshAt).toLocaleTimeString() : 'Not yet synced';
    }
}

export function canRenderOpsControls() {
    return isOps();
}