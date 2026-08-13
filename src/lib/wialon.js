// Wialon API client.
//
// Unlike the legacy app, the connection config (relay URL, server, token)
// is read from the SHARED Supabase settings table via src/lib/store.js, so
// it is entered ONCE by an admin and automatically used by every logged-in
// user. No one re-enters the token on login.
import { store } from './store.js';

const SESSION_TTL_MS = 8 * 60 * 1000;

let wialonSession = null; // { sid, token, relay, server, timestamp }

async function wialonCall(config, svc, params, sid) {
    const url = `${config.relay}/?server=${encodeURIComponent(config.server)}&svc=${encodeURIComponent(svc)}&params=${encodeURIComponent(JSON.stringify(params))}` +
        (sid ? `&sid=${encodeURIComponent(sid)}` : '');
    const resp = await fetch(url);
    return resp.json();
}

async function ensureWialonSession(config) {
    const now = Date.now();
    if (wialonSession && wialonSession.token === config.token &&
        wialonSession.relay === config.relay && wialonSession.server === config.server &&
        (now - wialonSession.timestamp) < SESSION_TTL_MS) {
        return wialonSession.sid;
    }
    const loginData = await wialonCall(config, 'token/login', { token: config.token });
    if (loginData.error) {
        throw new Error(`Wialon login failed (code ${loginData.error}${loginData.reason ? ': ' + loginData.reason : ''})`);
    }
    wialonSession = { sid: loginData.eid, token: config.token, relay: config.relay, server: config.server, timestamp: now };
    return loginData.eid;
}

async function withSession(fn) {
    const config = store.wialonConfig();
    if (!config.relay || !config.server || !config.token) {
        throw new Error('Wialon is not configured. An admin must set the connection in Settings first.');
    }
    const sid = await ensureWialonSession(config);
    return fn(config, sid);
}

export { withSession };

/** Fetch a single unit's live position by our truck ID (loose matching). */
export async function findWialonUnitPosition(truckId) {
    return withSession(async (config, sid) => {
        const candidates = [truckId, truckId.replace(/^0+/, ''), truckId.split('-')[0]];
        let items = [];
        for (const candidate of candidates) {
            const data = await wialonCall(config, 'core/search_items', {
                spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: `*${candidate}*`, sortType: 'sys_name' },
                force: 1, flags: 1025, from: 0, to: 0
            }, sid);
            if (data.error) throw new Error(`Wialon search failed (code ${data.error})`);
            if (data.items && data.items.length > 0) {
                items = data.items;
                break;
            }
        }

        if (items.length === 0) {
            throw new Error(`No Wialon unit found matching "${truckId}".`);
        }
        if (items.length > 1) {
            throw new Error(`Multiple Wialon units matched "${truckId}": ${items.map(i => i.nm).join(', ')}.`);
        }

        const unit = items[0];
        if (!unit.pos) {
            throw new Error(`Found "${unit.nm}" in Wialon, but it has no recent position data.`);
        }
        return { lat: unit.pos.y, lng: unit.pos.x, timestamp: unit.pos.t, unitName: unit.nm };
    });
}

export const WIALON_UNIT_FLAGS = 1439;
export const WIALON_RESOURCE_FLAGS = 0x0001FFFF;

async function fetchAllWialonUnitsRaw(config, sid) {
    const data = await wialonCall(config, 'core/search_items', {
        spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
        force: 1, flags: WIALON_UNIT_FLAGS, from: 0, to: 0
    }, sid);
    if (data.error) throw new Error(`Wialon unit search failed (code ${data.error})`);
    return data.items || [];
}

async function fetchWialonDriverMaps(config, sid) {
    const data = await wialonCall(config, 'core/search_items', {
        spec: { itemsType: 'avl_resource', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
        force: 1, flags: WIALON_RESOURCE_FLAGS, from: 0, to: 0
    }, sid);
    if (data.error) throw new Error(`Wialon resource search failed (code ${data.error})`);

    const driverByUnitId = {};
    const driverByCode = {};
    (data.items || []).forEach(resource => {
        const drvrs = resource.drvrs || {};
        Object.values(drvrs).forEach(drv => {
            if (drv.bu) driverByUnitId[drv.bu] = drv.n;
            if (drv.c) driverByCode[drv.c] = drv.n;
        });
    });
    return { driverByUnitId, driverByCode };
}

function resolveDriverName(unit, driverMaps) {
    if (driverMaps.driverByUnitId[unit.id]) return driverMaps.driverByUnitId[unit.id];
    const code = (unit.lmsg && unit.lmsg.p && unit.lmsg.p.drv) || (unit.pos && unit.pos.p && unit.pos.p.drv) || unit.drv;
    if (code && driverMaps.driverByCode[code]) return driverMaps.driverByCode[code];
    return null;
}

/** Fetch entire fleet (units + driver names). Returns raw unit array + maps. */
export async function fetchFullFleet() {
    return withSession(async (config, sid) => {
        let driverMaps = { driverByUnitId: {}, driverByCode: {} };
        try {
            driverMaps = await fetchWialonDriverMaps(config, sid);
        } catch (err) {
            console.warn('Driver library fetch failed — falling back to truck IDs only:', err.message);
        }
        const units = await fetchAllWialonUnitsRaw(config, sid);
        return { units, driverMaps };
    });
}

/** Test the connection (used by the settings admin form). */
export async function testWialonConnection() {
    return withSession(async (config, sid) => {
        const data = await wialonCall(config, 'core/search_items', {
            spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
            force: 1, flags: 1, from: 0, to: 0
        }, sid);
        if (data.error) throw new Error(`Wialon search failed (code ${data.error})`);
        return {
            sessionBound: true,
            units: (data.items || []).map(u => u.nm),
            server: config.server
        };
    });
}