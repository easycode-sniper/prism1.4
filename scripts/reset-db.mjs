#!/usr/bin/env node
// Reset the team data tables to their seed state.
// - TRUNCATES: runs, notifications, geofences, sites, trucks
// - KEEPS:     settings (Wialon config), profiles
// - THEN:      reseeds trucks + sites from src/data/seed.js
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (in .env or process env).
// Service role bypasses RLS, so this wipes the team-owned data, not auth users.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Load .env if present (simple KEY=VALUE parser, ignores comments/quotes).
function loadEnv(path) {
    if (!existsSync(path)) return {};
    const out = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !line.trim().startsWith('#')) {
            out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
    }
    return out;
}

const env = { ...process.env, ...loadEnv(resolve(root, '.env')) };
const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (put them in .env or the process env).');
    process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const { default: seed } = await import(resolve(root, 'src/data/seed.js'));

console.log('Truncating runs, notifications, geofences, sites, trucks…');
await admin.from('runs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
await admin.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
await admin.from('geofences').delete().neq('id', '');
await admin.from('sites').delete().neq('id', '');
await admin.from('trucks').delete().neq('id', '');

console.log(`Reseeding ${seed.FLEET_TRUCKS.length} trucks…`);
await admin.from('trucks').insert(seed.FLEET_TRUCKS.map(id => ({ id })));

console.log(`Reseeding ${seed.CONSTRUCTION_SITES.length} sites…`);
const siteRows = seed.CONSTRUCTION_SITES.map(s => ({
    id: s.id,
    name: s.name,
    client: s.client ?? null,
    lat: s.lat,
    lng: s.lng,
    accuracy: s.accuracy || 'exact',
    dup_suspect: !!s.dupSuspect,
    manual: false
}));
await admin.from('sites').upsert(siteRows, { onConflict: 'id' });

console.log('Done. Settings (Wialon config) and profiles were preserved.');