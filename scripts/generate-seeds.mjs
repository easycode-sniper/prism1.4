// Extracts the hardcoded fleet/trucks/sites/gas-stations arrays from the
// legacy single-file app and emits:
//   1. supabase/migrations/0002_seed_data.sql   — for deployment
//   2. src/data/seed.js                          — runtime fallback + exports
//
// Run: node scripts/generate-seeds.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const legacyHtml = fs.readFileSync(path.join(root, 'legacy', 'index.html'), 'utf8');

function extractArray(html, varName) {
    const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm');
    const m = html.match(re);
    if (!m) throw new Error(`Could not find ${varName} in legacy/index.html`);
    return Function(`return [${m[1]}];`)();
}

const fleetTrucks = extractArray(legacyHtml, 'fleetTrucks');
const constructionSites = extractArray(legacyHtml, 'constructionSites');
const gasStationsData = extractArray(legacyHtml, 'gasStationsData');

// Build the seed SQL ------------------------------------------------------
const esc = s => `'${String(s).replace(/'/g, "''")}'`;
const sql = (() => {
    const lines = [];
    lines.push('-- Seed data generated from legacy/index.html (do not edit by hand — run the generator).');
    lines.push('');
    lines.push('insert into public.trucks (id) values');
    lines.push(fleetTrucks.map(t => `    (${esc(t)})`).join(',\n') + '\non conflict (id) do nothing;');
    lines.push('');
    lines.push('insert into public.sites (id, name, client, lat, lng, accuracy, dup_suspect, manual) values');
    lines.push(constructionSites.map(s => {
        const lat = s.lat == null ? 'null' : s.lat;
        const lng = s.lng == null ? 'null' : s.lng;
        const acc = s.accuracy === 'town' ? 'town' : 'exact';
        return `    (${esc(s.id)}, ${esc(s.name)}, ${s.client ? esc(s.client) : 'null'}, ${lat}, ${lng}, ${esc(acc)}, ${!!s.dupSuspect}, false)`;
    }).join(',\n') + '\non conflict (id) do nothing;');
    return lines.join('\n');
})();

fs.mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
fs.writeFileSync(path.join(root, 'supabase', 'migrations', '0002_seed_data.sql'), sql);

// Build the JS seed module ------------------------------------------------
const seedJs = `// Generated from legacy/index.html (do not edit by hand — run the generator).
// Fallback + static reference data. The app's source of truth is Supabase;
// these are used to seed the DB and to render lists before sync completes.
export const FLEET_TRUCKS = ${JSON.stringify(fleetTrucks, null, 4)};

export const CONSTRUCTION_SITES = ${JSON.stringify(constructionSites, null, 4)};

export const GAS_STATIONS = ${JSON.stringify(gasStationsData, null, 4)};

export const AMOUDA_COORDS = [34.4368063, 2.058655];
`;

fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'data', 'seed.js'), seedJs);

console.log(`Done.
  trucks:         ${fleetTrucks.length}
  constructionSites: ${constructionSites.length}
  gasStations:    ${gasStationsData.length}
Wrote supabase/migrations/0002_seed_data.sql and src/data/seed.js`);