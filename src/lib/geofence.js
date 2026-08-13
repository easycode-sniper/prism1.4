// Geofence helpers — KML parsing, site matching, ingestion.
// All geofence persistence now goes through supabase via src/lib/store.js.

export const ROUTE_BUFFER_METERS = 400;
export const FACTORY_ZONE_EDGE_BUFFER_METERS = 150;
export const SITE_ARRIVAL_BUFFER_METERS = 300;
export const SPEED_LIMIT_KMH = 90;

export function normalizeForMatch(s) {
    return (s || '')
        .toUpperCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim();
}

const MATCH_SCORE_THRESHOLD = 40;

export function looksLikeOwnFactoryZone(zoneName) {
    const norm = normalizeForMatch(zoneName);
    if (!norm.includes('AMOUDA')) return false;
    if (norm.includes('LAFARGE')) return false;
    if (norm.includes('CLIENT')) return false;
    return norm.includes('USINE');
}

export function parseKmlGeofences(kmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlText, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error('Invalid KML/XML — could not parse the file.');

    const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
    if (placemarks.length === 0) throw new Error('No <Placemark> zones found in this file.');

    const results = [];
    placemarks.forEach((pm, idx) => {
        const nameEl = pm.getElementsByTagName('name')[0];
        const name = nameEl ? nameEl.textContent.trim() : `Zone ${idx + 1}`;
        const coordsEl = pm.getElementsByTagName('coordinates')[0];
        if (!coordsEl) return;

        const raw = coordsEl.textContent.trim();
        const points = raw.split(/\s+/).filter(Boolean).map(triplet => {
            const [lon, lat] = triplet.split(',').map(Number);
            return [lat, lon];
        }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));

        if (points.length > 1 &&
            points[0][0] === points[points.length - 1][0] &&
            points[0][1] === points[points.length - 1][1]) {
            points.pop();
        }

        if (points.length >= 3) {
            results.push({ name, polygon: points });
        }
    });

    if (results.length === 0) throw new Error('Found placemarks, but none had usable polygon coordinates.');
    return results;
}

/**
 * Decide how a batch of parsed KML zones should be consumed:
 *  - factory zones (yours only) -> kind 'factory'
 *  - zones matching a real site -> kind 'site' linked to that site
 *  - everything else -> skipped
 * Returns a plan the caller acts on (persisting each decision to Supabase).
 */
export function planGeofenceIngestion(zones, sites, existingNames) {
    const existingNorm = new Set((existingNames || []).map(normalizeForMatch));
    const plan = [];

    zones.forEach(z => {
        const norm = normalizeForMatch(z.name);
        if (existingNorm.has(norm)) {
            plan.push({ zone: z, action: 'skip', reason: 'duplicate' });
            return;
        }
        if (looksLikeOwnFactoryZone(z.name)) {
            plan.push({ zone: z, action: 'factory', site: null });
            return;
        }
        const match = matchZoneToSite(z.name, sites);
        if (match) {
            plan.push({ zone: z, action: 'site', site: match.site, score: match.score });
        } else {
            plan.push({ zone: z, action: 'skip', reason: 'unmatched' });
        }
    });

    return plan;
}

export function matchZoneToSite(zoneName, sites) {
    const normZone = normalizeForMatch(zoneName);
    if (!normZone) return null;

    let best = null;
    let bestScore = 0;

    (sites || []).forEach(site => {
        if (site.id === 'site_0') return;
        const normSiteName = normalizeForMatch(site.name);
        const normClient = normalizeForMatch(site.client);

        let score = 0;
        if (normZone === normSiteName) {
            score = 100;
        } else if (normSiteName && (normZone.includes(normSiteName) || normSiteName.includes(normZone))) {
            score = 80;
        } else if (normClient && (normZone.includes(normClient) || normClient.includes(normZone))) {
            score = 60;
        } else {
            const zoneWords = new Set(normZone.split(' ').filter(w => w.length > 2));
            const siteWords = new Set(normSiteName.split(' ').filter(w => w.length > 2));
            const overlap = [...zoneWords].filter(w => siteWords.has(w)).length;
            if (overlap > 0 && siteWords.size > 0) {
                score = Math.round((overlap / siteWords.size) * 50);
            }
        }

        if (score > bestScore) {
            bestScore = score;
            best = site;
        }
    });

    return bestScore >= MATCH_SCORE_THRESHOLD ? { site: best, score: bestScore } : null;
}

// Manual coordinate parsing (decimal / DMS) — ported from legacy settings.
export function parseManualCoordinates(raw) {
    raw = (raw || '').trim();

    const decMatch = raw.match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (decMatch) {
        const lat = parseFloat(decMatch[1]), lng = parseFloat(decMatch[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }

    const dmsMatch = raw.match(/(\d+)[°\s]+(\d+)['\s]+([\d.]+)"?\s*([NSEW])[,\s]+(\d+)[°\s]+(\d+)['\s]+([\d.]+)"?\s*([NSEW])/i);
    if (dmsMatch) {
        const [, d1, m1, s1, h1, d2, m2, s2, h2] = dmsMatch;
        const toDec = (d, m, s, h) => {
            let v = Number(d) + Number(m) / 60 + Number(s) / 3600;
            if (h.toUpperCase() === 'S' || h.toUpperCase() === 'W') v = -v;
            return v;
        };
        const v1 = toDec(d1, m1, s1, h1), v2 = toDec(d2, m2, s2, h2);
        if (h1.toUpperCase() === 'N' || h1.toUpperCase() === 'S') return { lat: v1, lng: v2 };
        return { lat: v2, lng: v1 };
    }

    return null;
}