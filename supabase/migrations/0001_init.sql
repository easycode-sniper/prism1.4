-- =====================================================================
-- Prism Fleet — initial schema
-- Roles: 'admin' | 'dispatcher' | 'viewer'
-- Team-shared state: active runs persist across sessions; any
-- dispatcher/admin can act on any run (dispatched_by is audit-only).
-- =====================================================================

-- ---------------------------------------------------------------------
-- PROFILES — extends auth.users with role + display info
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    email       text not null,
    full_name   text,
    role        text not null default 'viewer'
                check (role in ('admin', 'dispatcher', 'viewer')),
    created_at  timestamptz not null default now()
);

-- Auto-create a profile row whenever a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    insert into public.profiles (id, email, full_name, role)
    values (new.id, new.email, new.raw_user_meta_data->>'full_name', 'viewer')
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Convenience role helper used by RLS policies.
create or replace function public.current_role()
returns text
language sql
stable
security definer set search_path = public
as $$
    select role from public.profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- TRUCKS — fleet directory (promoted from hardcoded array)
-- ---------------------------------------------------------------------
create table if not exists public.trucks (
    id          text primary key,          -- e.g. "000051-525-35"
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- SITES — construction sites (seeded from constructionSites, plus manual)
-- ---------------------------------------------------------------------
create table if not exists public.sites (
    id            text primary key,        -- 'site_42', 'site_manual_...'
    name          text not null,
    client        text,
    lat           double precision,
    lng           double precision,
    accuracy      text not null default 'exact' check (accuracy in ('exact','town')),
    dup_suspect   boolean not null default false,
    manual        boolean not null default false,
    created_by    uuid references auth.users(id),
    created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- GEOFENCES — KML polygons + circles, matched to sites
-- ---------------------------------------------------------------------
create table if not exists public.geofences (
    id          text primary key,
    name        text not null,
    kind        text not null default 'site' check (kind in ('factory','site')),
    polygon     jsonb,                      -- array of [lat,lng] pairs
    center      jsonb,                      -- [lat,lng] for circle zones
    radius      double precision,           -- meters, for circle zones
    site_id     text references public.sites(id) on delete set null,
    created_by  uuid references auth.users(id),
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RUNS — active dispatches + completed history in one table.
-- status = 'active' | 'completed'
-- ---------------------------------------------------------------------
create table if not exists public.runs (
    id                    uuid primary key default gen_random_uuid(),
    truck_id              text not null references public.trucks(id),
    site_id               text references public.sites(id) on delete set null,
    site_name             text not null,
    client                text,
    route_coords          jsonb,            -- destination [lat,lng]
    route_line            jsonb,            -- [[lat,lng],...] road geometry
    route_total_distance  double precision, -- meters
    route_total_time      double precision, -- seconds
    dispatched_by         uuid references auth.users(id),
    dispatched_at         timestamptz not null default now(),
    stopped_by            uuid references auth.users(id),
    stopped_at            timestamptz,
    status                text not null default 'active' check (status in ('active','completed')),

    last_coords           jsonb,
    last_verified_at      timestamptz,
    last_deviation_meters double precision,
    last_deviation_basis  text check (last_deviation_basis in ('route','straight')),
    last_on_route         boolean,
    last_eta_seconds      double precision,
    last_eta_basis        text check (last_eta_basis in ('osrm-speed','fallback-speed')),

    arrived_site_at       timestamptz,
    arrived_factory_at    timestamptz,
    ever_off_route        boolean not null default false,
    ever_speeding         boolean not null default false
);

create index if not exists runs_status_idx on public.runs (status);
create index if not exists runs_truck_idx on public.runs (truck_id);

-- One ACTIVE run per truck (partial unique index).
-- Completed runs are not constrained, so a truck can appear in history
-- and later start a fresh active run.
create unique index if not exists runs_active_truck_uidx on public.runs (truck_id) where status = 'active';

-- ---------------------------------------------------------------------
-- NOTIFICATIONS — alert log (off-route, arrivals, speeding)
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
    id          uuid primary key default gen_random_uuid(),
    kind        text not null check (kind in ('factory','site','offroute','speeding')),
    truck_id    text,
    message     text not null,
    event_time  timestamptz not null default now(),
    created_by  uuid references auth.users(id)
);

create index if not exists notifications_time_idx on public.notifications (event_time desc);

-- ---------------------------------------------------------------------
-- SETTINGS — shared key/value config.
-- Wialon relay/server are non-secret and readable by all team members
-- so nobody re-enters the connection settings. The API token itself is
-- readable by dispatcher+admin (the people who run the app); only
-- admins may write.
-- ---------------------------------------------------------------------
create table if not exists public.settings (
    key         text primary key,
    value       text,
    updated_by  uuid references auth.users(id),
    updated_at  timestamptz not null default now()
);

-- Seed default settings so the app has sane starting values.
insert into public.settings (key, value) values
    ('wialon_relay', 'https://wialon-relay1.ferdjellahsouhaibomd.workers.dev'),
    ('wialon_server', 'hst-api.wialon.eu'),
    ('wialon_token', '')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Rule: every team member can view fleet/ops data; dispatchers and
-- admins write; only admins manage users/settings.
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.trucks        enable row level security;
alter table public.sites         enable row level security;
alter table public.geofences     enable row level security;
alter table public.runs          enable row level security;
alter table public.notifications enable row level security;
alter table public.settings      enable row level security;

-- PROFILES
-- Anyone authenticated can read profiles (needed for user list / names).
create policy "profiles_read_authed"  on public.profiles for select to authenticated using (true);
-- Users may update their own non-role fields.
create policy "profiles_update_self"  on public.profiles for update to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id and role = (select current_role() from public.profiles p where p.id = auth.uid()));
-- Admins manage roles and other users.
create policy "profiles_admin_update" on public.profiles for update to authenticated
    using (current_role() = 'admin');
create policy "profiles_admin_insert" on public.profiles for insert to authenticated
    with check (current_role() = 'admin');

-- TRUCKS
create policy "trucks_read_authed" on public.trucks for select to authenticated using (true);
create policy "trucks_admin_write" on public.trucks for all to authenticated
    using (current_role() = 'admin') with check (current_role() = 'admin');

-- SITES
create policy "sites_read_authed"      on public.sites for select to authenticated using (true);
create policy "sites_ops_write"        on public.sites for all to authenticated
    using (current_role() in ('dispatcher','admin'))
    with check (current_role() in ('dispatcher','admin'));

-- GEOFENCES
create policy "geofences_read_authed"  on public.geofences for select to authenticated using (true);
create policy "geofences_ops_write"    on public.geofences for all to authenticated
    using (current_role() in ('dispatcher','admin'))
    with check (current_role() in ('dispatcher','admin'));

-- RUNS — team-owned. Any authenticated member reads; dispatchers/admins
-- create and act on any active run (handover between shifts works because
-- there is no owner-exclusivity on writes).
create policy "runs_read_authed" on public.runs for select to authenticated using (true);
create policy "runs_ops_insert"  on public.runs for insert to authenticated
    with check (current_role() in ('dispatcher','admin'));
create policy "runs_ops_update"  on public.runs for update to authenticated
    using (current_role() in ('dispatcher','admin'))
    with check (current_role() in ('dispatcher','admin'));

-- NOTIFICATIONS
create policy "notifs_read_authed" on public.notifications for select to authenticated using (true);
create policy "notifs_ops_insert"  on public.notifications for insert to authenticated
    with check (current_role() in ('dispatcher','admin'));
-- No delete policy — the log is append-only.

-- SETTINGS — admins write; the Wialon config row is readable by
-- dispatchers+admins (the people who operate the app), viewers get
-- everything except the token so monitoring still works and secrets
-- stay out of plain view for read-only accounts.
create policy "settings_read_ops" on public.settings for select to authenticated
    using (
        current_role() in ('dispatcher','admin')
        or key <> 'wialon_token'
    );
create policy "settings_admin_write" on public.settings for all to authenticated
    using (current_role() = 'admin')
    with check (current_role() = 'admin');