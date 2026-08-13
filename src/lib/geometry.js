// Geometry helpers — ported from the legacy app unchanged.

export function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

export function closestPointOnSegment(p, a, b) {
    const [px, py] = p, [ax, ay] = a, [bx, by] = b;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return a;
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return [ax + t * dx, ay + t * dy];
}

export function projectPointOntoRoute(point, routeLine) {
    if (!routeLine || routeLine.length < 2) return null;
    let minDist = Infinity;
    let cumulativeAtClosest = 0;
    let cumulative = 0;
    for (let i = 0; i < routeLine.length - 1; i++) {
        const a = routeLine[i], b = routeLine[i + 1];
        const segLen = haversineMeters(a[0], a[1], b[0], b[1]);
        const closest = closestPointOnSegment(point, a, b);
        const d = haversineMeters(point[0], point[1], closest[0], closest[1]);
        if (d < minDist) {
            minDist = d;
            cumulativeAtClosest = cumulative + haversineMeters(a[0], a[1], closest[0], closest[1]);
        }
        cumulative += segLen;
    }
    return { distanceToRoute: minDist, distanceCovered: cumulativeAtClosest, totalRouteLength: cumulative };
}

export function distanceToRouteMeters(point, routeLine) {
    const proj = projectPointOntoRoute(point, routeLine);
    return proj ? proj.distanceToRoute : null;
}

export function pointInPolygon(point, polygon) {
    const [py, px] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const yi = polygon[i][0], xi = polygon[i][1];
        const yj = polygon[j][0], xj = polygon[j][1];
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export function distanceToPolygonBoundaryMeters(point, polygon) {
    let min = Infinity;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const closest = closestPointOnSegment(point, a, b);
        const d = haversineMeters(point[0], point[1], closest[0], closest[1]);
        if (d < min) min = d;
    }
    return min;
}

export function formatDuration(totalSeconds) {
    if (totalSeconds == null || !isFinite(totalSeconds) || totalSeconds < 0) return '—';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.round((totalSeconds % 3600) / 60);
    if (h === 0) return `${m} min`;
    return `${h}h ${m}min`;
}

export function timeAgo(date) {
    if (!date) return '—';
    const s = Math.floor((new Date() - date) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
}

export function isSameCalendarDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}