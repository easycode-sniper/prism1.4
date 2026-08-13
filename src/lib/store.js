// ---------------------------------------------------------------------
// Shared application store.
//
// This module is the single source of truth for the app's state, and it
// is BACKED BY SUPABASE. Because every table is team-readable/writable,
// anything User A changes (a dispatch, a site, a geofence) is visible to
// User B the moment they open the app — the "continue where the last
// shift left off" requirement.
//
// In-memory mirrors exist only to keep the rendering code fast and cheap;
// every mutation persists to the DB and every load() refreshes from it.
// ---------------------------------------------------------------------
import { supabase } from './supabase.js';

export const store = {
    // Static reference data (from seed.js — promotional, rarely changes).
    gasStations: null, // assigned at boot from GAS_STATIONS

    // Fleet (from trucks table — seeded once, admin-managed)
    trucks: [],

    // Sites (construction + manual) — loaded from DB; rendered on map
    sites: [],

    // Geofences (factory polygon, KML zones, circle sites)
    geofences: [],

    // Active runs: truckId -> run object (mirror of runs table status='active')
    activeRuns: {},

    // Run history (runs table status='completed')
    runHistory: [],

    // Notification log (notifications table)
    notifications: [],

    // Shared config settings (key -> value) incl. Wialon connection
    settings: {},

    // Live fleet data from Wialon (not persisted — always fresh per session)
    fleetLiveData: {},
    lastFleetRefreshAt: null,

    // ---- tools -------------------------------------------------------
    truck(id) {
        return this.trucks.find(t => t.id === id);
    },
    site(id) {
        return this.sites.find(s => s.id === id);
    },
    setting(key) {
        return this.settings[key] ?? null;
    },

    wialonConfig() {
        return {
            relay: this.setting('wialon_relay'),
            server: this.setting('wialon_server'),
            token: this.setting('wialon_token')
        };
    },
    wialonConfigured() {
        const { relay, server, token } = this.wialonConfig();
        return !!(relay && server && token);
    }
};

// ---------------------------------------------------------------------
// DB loaders — called after login (and on demand) to repopulate state.
// ---------------------------------------------------------------------
export async function loadTrucks() {
    const { data, error } = await supabase.from('trucks').select('id').order('id');
    if (error) throw error;
    store.trucks = (data || []).map(r => r.id);
    return store.trucks;
}

export async function loadSites() {
    const { data, error } = await supabase.from('sites').select('*').order('name');
    if (error) throw error;
    store.sites = (data || []).map(r => ({
        id: r.id,
        name: r.name,
        client: r.client,
        lat: r.lat,
        lng: r.lng,
        accuracy: r.accuracy,
        dupSuspect: r.dup_suspect,
        manuallyAdded: r.manual
    }));
    return store.sites;
}

export async function loadGeofences() {
    const { data, error } = await supabase.from('geofences').select('*');
    if (error) throw error;
    store.geofences = (data || []).map(g => ({
        ...g,
        polygon: g.polygon || null,
        center: g.center || null
    }));
    return store.geofences;
}

export async function loadActiveRuns() {
    const { data, error } = await supabase
        .from('runs')
        .select('*')
        .eq('status', 'active')
        .order('dispatched_at', { ascending: false });
    if (error) throw error;

    store.activeRuns = {};
    (data || []).forEach(run => {
        store.activeRuns[run.truck_id] = normalizeRunRecord(run);
    });
    return store.activeRuns;
}

export async function loadRunHistory() {
    const { data, error } = await supabase
        .from('runs')
        .select('*')
        .eq('status', 'completed')
        .order('stopped_at', { ascending: false })
        .limit(500);
    if (error) throw error;
    store.runHistory = (data || []).map(normalizeRunRecord);
    return store.runHistory;
}

export async function loadNotifications() {
    const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('event_time', { ascending: false })
        .limit(300);
    if (error) throw error;
    store.notifications = (data || []).map(r => ({
        time: new Date(r.event_time),
        kind: r.kind,
        truckId: r.truck_id,
        message: r.message
    }));
    return store.notifications;
}

export async function loadSettings() {
    const { data, error } = await supabase.from('settings').select('key, value');
    if (error) throw error;
    store.settings = {};
    (data || []).forEach(row => { store.settings[row.key] = row.value; });
    return store.settings;
}

/** One-shot: fetch everything the app needs after sign-in. */
export async function loadAll() {
    await Promise.all([
        loadTrucks(),
        loadSites(),
        loadGeofences(),
        loadActiveRuns(),
        loadRunHistory(),
        loadNotifications(),
        loadSettings()
    ]);
    return store;
}

// ---------------------------------------------------------------------
// DB writers — every mutation also updates the in-memory mirror.
// ---------------------------------------------------------------------
export async function insertTruck(truckId) {
    const { error } = await supabase.from('trucks').insert({ id: truckId });
    if (error) throw error;
    if (!store.trucks.includes(truckId)) store.trucks.push(truckId);
}

export async function removeTruck(truckId) {
    const { error } = await supabase.from('trucks').delete().eq('id', truckId);
    if (error) throw error;
    store.trucks = store.trucks.filter(t => t !== truckId);
}

export async function upsertSite(site) {
    const payload = {
        id: site.id,
        name: site.name,
        client: site.client || null,
        lat: site.lat,
        lng: site.lng,
        accuracy: site.accuracy || 'exact',
        dup_suspect: !!site.dupSuspect,
        manual: !!site.manuallyAdded,
        created_by: null
    };
    const { error } = await supabase.from('sites').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    const idx = store.sites.findIndex(s => s.id === site.id);
    const normalized = {
        id: site.id, name: site.name, client: site.client || null, lat: site.lat, lng: site.lng,
        accuracy: site.accuracy || 'exact', dupSuspect: !!site.dupSuspect, manuallyAdded: !!site.manuallyAdded
    };
    if (idx === -1) store.sites.push(normalized);
    else store.sites[idx] = normalized;
    return normalized;
}

export async function deleteSite(id) {
    const { error } = await supabase.from('sites').delete().eq('id', id);
    if (error) throw error;
    store.sites = store.sites.filter(s => s.id !== id);
}

export async function upsertGeofence(g) {
    const { error } = await supabase.from('geofences').upsert({
        id: g.id, name: g.name, kind: g.kind, polygon: g.polygon || null,
        center: g.center || null, radius: g.radius || null, site_id: g.siteId || null
    }, { onConflict: 'id' });
    if (error) throw error;
    const idx = store.geofences.findIndex(x => x.id === g.id);
    if (idx === -1) store.geofences.push(g);
    else store.geofences[idx] = g;
    return g;
}

export async function deleteGeofence(id) {
    const { error } = await supabase.from('geofences').delete().eq('id', id);
    if (error) throw error;
    store.geofences = store.geofences.filter(g => g.id !== id);
}

export async function upsertSetting(key, value) {
    const { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
    store.settings[key] = value;
}

/**
 * Start (or restart) an active run for a truck.
 * If the truck already has an active run (partial unique index), update it;
 * otherwise insert a new row. Keeps `activeRuns` mirror in sync either way.
 */
export async function upsertRun(record, payload) {
    const existing = Object.values(store.activeRuns).find(r => r.truckId === record.truckId);
    let data;
    if (existing && existing.id) {
        const { data: d, error } = await supabase.from('runs').update(payload).eq('id', existing.id).select().single();
        if (error) throw error;
        data = d;
    } else {
        const { data: d, error } = await supabase.from('runs').insert(payload).select().single();
        if (error) throw error;
        data = d;
    }
    store.activeRuns[record.truckId] = { ...record, id: data.id };
    return data;
}

/** Update fields on an active run (position checks, arrival flags…). */
export async function updateRunFields(runId, fields) {
    const { error } = await supabase.from('runs').update(fields).eq('id', runId);
    if (error) throw error;
}

/** Mark a run completed; the mirror moves from activeRuns to runHistory. */
export async function completeRun(run) {
    if (!run.id) return;
    const { error } = await supabase.from('runs').update({
        status: 'completed', stopped_at: new Date().toISOString()
    }).eq('id', run.id);
    if (error) throw error;
    delete store.activeRuns[run.truckId];
    store.runHistory.unshift(run);
}

export async function insertNotification(kind, truckId, message) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('notifications').insert({
        kind, truck_id: truckId, message, event_time: now
    });
    if (error) throw error;
    store.notifications.unshift({ time: new Date(now), kind, truckId, message });
    return store.notifications[0];
}

// ---------------------------------------------------------------------
// Record normalization — DB rows hold snake_case / jsonb; the app's
// render code expects the camelCase shape it has always used.
// ---------------------------------------------------------------------
export function normalizeRunRecord(row) {
    let coords = null;
    if (row.last_coords) coords = Array.isArray(row.last_coords) ? row.last_coords : JSON.parse(JSON.stringify(row.last_coords));

    return {
        id: row.id,
        truckId: row.truck_id,
        siteId: row.site_id,
        siteName: row.site_name,
        client: row.client,
        routeCoords: row.route_coords || null,
        routeLine: row.route_line || null,
        routeTotalDistance: row.route_total_distance,
        routeTotalTime: row.route_total_time,
        dispatchedAt: new Date(row.dispatched_at),
        dispatchedBy: row.dispatched_by,
        stoppedAt: row.stopped_at ? new Date(row.stopped_at) : null,
        lastCoords: coords,
        lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at) : null,
        lastDeviationMeters: row.last_deviation_meters,
        lastDeviationBasis: row.last_deviation_basis,
        lastOnRoute: row.last_on_route,
        lastEtaSeconds: row.last_eta_seconds,
        lastEtaBasis: row.last_eta_basis,
        arrivedSiteAt: row.arrived_site_at ? new Date(row.arrived_site_at) : null,
        arrivedFactoryAt: row.arrived_factory_at ? new Date(row.arrived_factory_at) : null,
        everOffRoute: row.ever_off_route,
        everSpeeding: row.ever_speeding,

        // Transient per-run flags that the alert polling uses.
        siteArrivedNotified: !!row.arrived_site_at,
        arrivedNotified: !!row.arrived_factory_at,
        offRouteNotified: !!row.ever_off_route,
        speedingNotified: !!row.ever_speeding,
        marker: null
    };
}

/** Build the payload for an active run from a mirror object. */
export function runPayload(run) {
    return {
        truck_id: run.truckId,
        site_id: run.siteId,
        site_name: run.siteName,
        client: run.client || null,
        route_coords: run.routeCoords || null,
        route_line: run.routeLine || null,
        route_total_distance: run.routeTotalDistance ?? null,
        route_total_time: run.routeTotalTime ?? null,
        status: 'active'
    };
}