// Map module — Leaflet setup, base layers, clusters, site dots, geofence
// layers, gas stations, and live fleet truck markers.
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet-routing-machine';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';

import { store } from '../lib/store.js';
import { AMOUDA_COORDS } from '../data/seed.js';

export let map = null;
export let siteClusterGroup = null;
export let truckClusterGroup = null;

export const siteMarkers = {};   // siteId -> L.marker (amber dot)
export const liveTruckMarkers = {}; // truckId -> L.marker

let tileLayers = {};
let currentBaseLayerName = 'dark';
let geofencesLayerVisible = true;
let gasStationsLayer = null;
let gasStationsVisible = false;
let driverNamesVisible = true;

export function isGeofencesVisible() { return geofencesLayerVisible; }
export function isDriverNamesVisible() { return driverNamesVisible; }

export function initMap() {
    map = L.map('map-viewport', { zoomControl: true }).setView([35.2500, 3.0000], 7);

    tileLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19
    });
    tileLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri, Maxar, Earthstar Geographics',
        maxZoom: 19
    });
    tileLayers.satelliteLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri, Garmin, GEBCO, NOAA, NGA',
        maxZoom: 19
    });

    tileLayers[currentBaseLayerName].addTo(map);
    if (currentBaseLayerName === 'satellite') tileLayers.satelliteLabels.addTo(map);

    siteClusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        iconCreateFunction: (cluster) => L.divIcon({
            html: `<div class="cluster-bubble cluster-site">${cluster.getChildCount()}</div>`,
            className: '', iconSize: [34, 34]
        })
    }).addTo(map);

    truckClusterGroup = L.markerClusterGroup({
        maxClusterRadius: 45,
        iconCreateFunction: (cluster) => L.divIcon({
            html: `<div class="cluster-bubble cluster-truck">${cluster.getChildCount()}</div>`,
            className: '', iconSize: [34, 34]
        })
    }).addTo(map);

    L.marker(AMOUDA_COORDS, {
        icon: L.icon({
            iconUrl: 'https://cdn-icons-png.flaticon.com/512/2689/2689947.png',
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        })
    }).addTo(map).bindPopup('<b>🏭 Usine Amouda Ciment</b><br>Loading base — El Baida');

    // Factory + any stored geofences (from Supabase)
    store.geofences.forEach(g => drawGeofenceLayer(g));

    wrapLeafletGlobal();
}

// The legacy app used an inline Leaflet where L was a global. The bundled
// build keeps it module-scoped; expose the pieces our HTML helpers need.
function wrapLeafletGlobal() {
    if (typeof window !== 'undefined' && !window.L) {
        window.L = L;
    }
}

export function switchBaseLayer(name) {
    if (name === currentBaseLayerName || !tileLayers[name]) return;
    map.removeLayer(tileLayers[currentBaseLayerName]);
    if (currentBaseLayerName === 'satellite' && tileLayers.satelliteLabels) {
        map.removeLayer(tileLayers.satelliteLabels);
    }
    tileLayers[name].addTo(map);
    if (name === 'satellite' && tileLayers.satelliteLabels) {
        tileLayers.satelliteLabels.addTo(map);
    }
    currentBaseLayerName = name;
    updateLayerToggleUI();
}

function updateLayerToggleUI() {
    const darkBtn = document.getElementById('layer-btn-dark');
    const satBtn = document.getElementById('layer-btn-satellite');
    if (!darkBtn || !satBtn) return;
    darkBtn.classList.toggle('active', currentBaseLayerName === 'dark');
    satBtn.classList.toggle('active', currentBaseLayerName === 'satellite');
}

export function setupLayerToggle() {
    const darkBtn = document.getElementById('layer-btn-dark');
    const satBtn = document.getElementById('layer-btn-satellite');
    const geoBtn = document.getElementById('layer-btn-geofences');
    const namesBtn = document.getElementById('layer-btn-names');
    const gasBtn = document.getElementById('layer-btn-gasstations');

    if (darkBtn) darkBtn.addEventListener('click', () => switchBaseLayer('dark'));
    if (satBtn) satBtn.addEventListener('click', () => switchBaseLayer('satellite'));
    updateLayerToggleUI();

    if (geoBtn) {
        geoBtn.addEventListener('click', () => {
            geofencesLayerVisible = !geofencesLayerVisible;
            toggleGeofenceLayerVisibility(geofencesLayerVisible);
            geoBtn.classList.toggle('active', geofencesLayerVisible);
        });
    }
    if (namesBtn) {
        namesBtn.addEventListener('click', () => {
            driverNamesVisible = !driverNamesVisible;
            document.getElementById('map-viewport')?.classList.toggle('hide-driver-names', !driverNamesVisible);
            namesBtn.classList.toggle('active', driverNamesVisible);
        });
    }
    if (gasBtn) {
        gasBtn.addEventListener('click', toggleGasStations);
    }
    if (namesBtn) namesBtn.classList.add('active');

    // Sync current visual state after the shell is wired.
    if (!driverNamesVisible) document.getElementById('map-viewport')?.classList.add('hide-driver-names');
}

function toggleGasStations() {
    gasStationsVisible = !gasStationsVisible;
    const gasBtn = document.getElementById('layer-btn-gasstations');
    if (gasStationsVisible) {
        if (!gasStationsLayer) {
            gasStationsLayer = L.layerGroup();
            const GAS_STATION_RADIUS = 30;
            store.gasStations?.forEach(station => {
                const circle = L.circle(station.coords, {
                    radius: GAS_STATION_RADIUS,
                    color: '#ff6b35',
                    weight: 1,
                    fillColor: '#ff6b35',
                    fillOpacity: 0.4
                }).bindPopup(`<b>⛽ ${station.name}</b>`);
                const marker = L.marker(station.coords, {
                    icon: L.divIcon({
                        className: 'gas-station-marker',
                        html: '<div style="background:#ff6b35;color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;">⛽</div>',
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    })
                }).bindPopup(`<b>⛽ ${station.name}</b>`);
                gasStationsLayer.addLayer(L.layerGroup([circle, marker]));
            });
        }
        if (map) map.addLayer(gasStationsLayer);
    } else if (gasStationsLayer && map) {
        map.removeLayer(gasStationsLayer);
    }
    if (gasBtn) gasBtn.classList.toggle('active', gasStationsVisible);
}

export function plotSiteMarkers(sites) {
    (sites || []).forEach(site => {
        if (site.id === 'site_0') return;
        if (site.lat == null || site.lng == null) return;
        if (siteMarkers[site.id]) siteClusterGroup.removeLayer(siteMarkers[site.id]);

        const isApprox = site.accuracy === 'town';
        const isSuspect = site.dupSuspect === true;
        let cls = 'site-glow-marker';
        if (isSuspect) cls += ' suspect';
        else if (isApprox) cls += ' approx';

        const marker = L.marker([site.lat, site.lng], {
            icon: L.divIcon({ className: cls, iconSize: [14, 14], iconAnchor: [7, 7] })
        }).addTo(siteClusterGroup);

        let note = '';
        if (isSuspect) note = '<br><i style="color:#f87171">⚠️ shares coordinates with another site — check source data</i>';
        else if (isApprox) note = '<br><i style="color:#ffb703">~town-level location</i>';

        marker.bindPopup(`<b>🏗️ ${site.name}</b><br>${site.client || ''}${note}`);
        siteMarkers[site.id] = marker;
    });
}

export function removeSiteMarker(siteId) {
    const m = siteMarkers[siteId];
    if (m && siteClusterGroup) siteClusterGroup.removeLayer(m);
    delete siteMarkers[siteId];
}

export function drawGeofenceLayer(entry) {
    if (!map) return;
    const color = entry.kind === 'factory' ? '#6d5bff' : (entry.id === 'parc-omd' ? '#00c853' : '#ffb703');

    if (entry.center && entry.radius) {
        entry.layer = L.circle(entry.center, {
            radius: entry.radius,
            color, weight: 2, fillColor: color, fillOpacity: 0.15
        }).bindPopup(`<b>🏢 ${entry.name}</b><br>Headquarters & Truck Parking`);
    } else {
        entry.layer = L.polygon(entry.polygon, {
            color, weight: 2, fillColor: color, fillOpacity: 0.10
        }).bindPopup(`<b>${entry.kind === 'factory' ? '🏭' : '📍'} ${entry.name}</b>`);
    }

    if (geofencesLayerVisible) entry.layer.addTo(map);
}

export function removeGeofenceLayer(entry) {
    if (entry.layer && map) map.removeLayer(entry.layer);
    entry.layer = null;
}

export function toggleGeofenceLayerVisibility(show) {
    store.geofences.forEach(g => {
        if (!g.layer) return;
        if (show && !map.hasLayer(g.layer)) g.layer.addTo(map);
        if (!show && map.hasLayer(g.layer)) map.removeLayer(g.layer);
    });
    const sitesWithPolygon = new Set(store.geofences.filter(g => g.siteId).map(g => g.siteId));
    Object.entries(siteMarkers).forEach(([siteId, marker]) => {
        if (sitesWithPolygon.has(siteId)) return;
        if (show && !siteClusterGroup.hasLayer(marker)) siteClusterGroup.addLayer(marker);
        if (!show && siteClusterGroup.hasLayer(marker)) siteClusterGroup.removeLayer(marker);
    });
}

export function hasGeofenceLayer(g) {
    return !!(g.layer && map && map.hasLayer(g.layer));
}

export function animateMarkerTo(marker, toLatLng, duration = 1200) {
    const from = marker.getLatLng();
    const start = performance.now();
    if (marker._animFrame) cancelAnimationFrame(marker._animFrame);

    function step(now) {
        const t = Math.min((now - start) / duration, 1);
        const lat = from.lat + (toLatLng[0] - from.lat) * t;
        const lng = from.lng + (toLatLng[1] - from.lng) * t;
        marker.setLatLng([lat, lng]);
        if (t < 1) marker._animFrame = requestAnimationFrame(step);
    }
    marker._animFrame = requestAnimationFrame(step);
}