// Routing module — wraps leaflet-routing-machine (OSRM) and captures the
// road geometry for a dispatch so deviation checks can use real road
// distance instead of straight-line distance.
import L from 'leaflet';
import 'leaflet-routing-machine';
import { map } from './map.js';
import { AMOUDA_COORDS } from '../data/seed.js';

let previewRouteLine = null;

/** Create a hidden routing control between the factory and destination. */
export function createRouteControl(destCoords, { color = '#6d5bff', weight = 5, opacity = 0.9 } = {}) {
    const rc = L.Routing.control({
        waypoints: [
            L.latLng(AMOUDA_COORDS[0], AMOUDA_COORDS[1]),
            L.latLng(destCoords[0], destCoords[1])
        ],
        lineOptions: { styles: [{ color, weight, opacity }] },
        createMarker: () => null,
        addWaypoints: false,
        show: false
    });
    return rc;
}

/** Load a route in the background (no visible control) and call back with geometry. */
export function fetchRouteGeometry(destCoords, onGeometry, onError) {
    const rc = createRouteControl(destCoords);
    rc.on('routesfound', e => {
        const route = e.routes[0];
        const routeLine = route.coordinates.map(c => [c.lat, c.lng]);
        onGeometry({
            routeLine,
            totalDistance: route.summary.totalDistance,
            totalTime: route.summary.totalTime
        });
    });
    rc.on('routingerror', () => {
        if (onError) onError();
    });
    rc.addTo(map);
    setTimeout(() => { try { map.removeControl(rc); } catch { /* already removed */ } }, 20000);
    return rc;
}

/** Draw a run's cached route on the map; fall back to a straight dashed line. */
export function displayRunRoute(truckId, run) {
    if (!map) return;
    if (previewRouteLine) map.removeLayer(previewRouteLine);

    if (run.routeLine && run.routeLine.length > 1) {
        previewRouteLine = L.polyline(run.routeLine, { color: '#6d5bff', weight: 5, opacity: 0.9 }).addTo(map);
        previewRouteLine.bindPopup(`<b>🚚 ${truckId}</b><br>Route to ${run.siteName}`).openPopup();
        map.fitBounds(L.latLngBounds(run.routeLine), { padding: [60, 60] });
    } else {
        previewRouteLine = L.polyline([AMOUDA_COORDS, run.routeCoords], {
            color: '#6d5bff', weight: 4, opacity: 0.6, dashArray: '8,8'
        }).addTo(map);
        previewRouteLine.bindPopup(`<b>🚚 ${truckId}</b><br>Route to ${run.siteName}<br><i style="color:#ffb703">Road geometry not cached yet — showing straight line</i>`).openPopup();
        map.fitBounds(L.latLngBounds([AMOUDA_COORDS, run.routeCoords]), { padding: [60, 60] });
    }
}