# OMD Fleet Route Verification (Prism 1.2)

Leaflet-based fleet route verification for **OMD Transport · Amouda Line**. Live
truck positions come from Wialon via a Cloudflare Worker relay; routes are
computed on OSRM; runs, alerts, sites, geofences, and the shared Wialon
connection live in **Supabase**, so two users logging in from different
machines see the same active dispatches and hand off shifts seamlessly.

> The original single-file app is preserved untouched at `legacy/index.html`.

## Stack

- **Frontend**: Vite + vanilla ES modules + Leaflet (`leaflet.markercluster`,
  `leaflet-routing-machine`), Chart.js donuts on the dashboard.
- **Auth / Data**: Supabase (email/password), row-level security, roles
  `admin` / `dispatcher` / `viewer`.
- **Hosting**: Vercel (SPA + serverless function for admin user management).
- **Wialon**: browser → Cloudflare relay (avoids the CORS block) → Wialon API.

## Roles

| Role        | Can do                                                        | Can't do                       |
|-------------|---------------------------------------------------------------|--------------------------------|
| `admin`     | Everything + user management, Wialon config, RLS overrides    | —                              |
| `dispatcher`| Dispatch/stop runs, verify positions, add sites & geofences   | manage users, edit Wialon token|
| `viewer`    | Watch every view, notifications, history                      | dispatch, writes               |

Permission is enforced server-side by Postgres RLS in
`supabase/migrations/0001_init.sql`; the UI only *hides* what a role can't do.

## Project layout

```
index.html                 Login gate + app shell holder
src/
  main.js                  Boot: auth → loadAll → inject shell → wire views
  shell.html               The app shell (sidebar, views, admin tab)
  styles/main.css          Extracted legacy CSS (5 blocks, verbatim)
  auth/                    supabase client wrappers + role helpers
  lib/                     store (state↔Supabase), wialon client, geometry, geofence
  map/                     Leaflet map + OSRM routing modules
  views/                   dashboard, dispatch, monitoring, fleet, history,
                           notifications, queue, settings, admin, liveTracking, ui
  data/seed.js             Generated fallback data (also seeds the DB)
api/admin/users.js         Vercel serverless fn (invite / list / role / delete)
supabase/migrations/       0001_init.sql (schema+RLS), 0002_seed_data.sql
scripts/                   generate-seeds.mjs, extract.mjs, reset-db.mjs
legacy/                    The original single-file app (do not edit)
```

## Setup

1. **Supabase project** — apply migrations in order, then seed:
   ```bash
   # from the Supabase SQL editor (or supabase CLI):
   supabase/migrations/0001_init.sql
   supabase/migrations/0002_seed_data.sql
   ```
   Or regenerate the seed from the legacy app whenever the source changes:
   ```bash
   node scripts/generate-seeds.mjs   # rewrites BOTH 0002_seed_data.sql and src/data/seed.js
   ```

2. **Env** — create `.env` from `.env.example`:
   - `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (browser-safe)
   - `SUPABASE_SERVICE_ROLE_KEY` — **Vercel env only**, used by `api/admin/users.js`

3. **First admin** — after signup the first account is a `viewer`. Promote it in
   the Supabase dashboard (`profiles.role = 'admin'`), then sign in as admin →
   **Admin** tab → invite teammates, and **Settings → Wialon Connection** to save
   the relay/server/token once. Everyone else reuses it automatically.

4. **Local dev**
   ```bash
   npm install
   npm run dev        # http://localhost:5173
   npm run build      # production build (test before deploy)
   npm run db:reset   # wipe runs/notifications/geofences/sites/trucks + reseed
   ```
   Note: `/api/admin/users` only runs on Vercel — for local admin testing,
   deploy the function or use the Supabase dashboard.

## Deploy (Vercel)

- Framework preset: **Vite**. `vercel.json` routes `/api/*` to
  `api/*` and rewrites everything else to `/index.html`.
- Add **envvars**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`.

## Wialon relay

The app calls your Cloudflare Worker like the legacy app did:

```
<relay>/?server=<server>&svc=token/login&params=<encoded {token}>
```

Browser traffic only ever touches the relay, never Wialon directly. The worker
must be deployed (not just saved) for the connection test to pass.

## Data model notes

- `runs` has a partial unique index on `(truck_id) WHERE status='active'` — one
  active run per truck; stopping a run makes that truck immediately re-dispatchable.
- Runs are team-owned: `dispatched_by` is audit-only, any dispatcher can continue
  a run another shift started.
- The Wialon `wialon_token` row is readable only by dispatchers+admins; viewers
  get every other setting but the token.

## Verification

- `npm run build` must pass before deploy (already verified clean).
- `npm run lint` requires eslint installed with a config; the script is a stub
  until you add one.