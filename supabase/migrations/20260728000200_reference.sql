-- Dept-Flow — reference and configuration tables
--
-- Everything here is admin-owned. The HOD never sees dues configuration,
-- geo-fence coordinates, or the whitelist (system doc §2).

-- ---------------------------------------------------------------------------
-- Academic sessions
-- ---------------------------------------------------------------------------

create table academic_sessions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,          -- '2025/2026'
  starts_on     date not null,
  ends_on       date not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint academic_session_dates check (ends_on > starts_on),
  constraint academic_session_name_format check (name ~ '^[0-9]{4}/[0-9]{4}$')
);

-- Exactly one active academic session at a time. Timetables, whitelists and
-- dues periods are all versioned against it.
create unique index academic_sessions_one_active
  on academic_sessions ((true))
  where is_active;

create trigger academic_sessions_updated_at
  before update on academic_sessions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Venues and the geo-fence
-- ---------------------------------------------------------------------------

-- The fence is stored as a centre point plus a radius, which is what the
-- distance check actually uses. `boundary` optionally holds a GeoJSON polygon
-- for irregular halls; PostGIS is deliberately not a dependency yet, since the
-- distance computation lives in the API.
--
-- Raw student coordinates are never stored here — only the hall's own location,
-- which is not personal data.
create table venues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  centre_lat    double precision not null,
  centre_lng    double precision not null,
  radius_m      integer not null default 40,
  boundary      jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint venue_lat_range check (centre_lat between -90 and 90),
  constraint venue_lng_range check (centre_lng between -180 and 180),
  -- The spec fixes the geo-fence radius at 30–50 m. Wider and a student in the
  -- corridor is counted; narrower and GPS drift rejects someone in their seat.
  constraint venue_radius_range check (radius_m between 30 and 50)
);

create trigger venues_updated_at
  before update on venues
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- System configuration
-- ---------------------------------------------------------------------------

-- Single row. Every change is confirmed in the UI and audit-logged.
create table app_config (
  id                                integer primary key default 1,
  provisional_window_days           integer not null default 30,
  grace_window_days                 integer not null default 30,
  pending_verification_buffer_hours integer not null default 12,
  gps_retention_days                integer not null default 14,
  default_geofence_radius_m         integer not null default 40,
  attendance_threshold_pct          numeric(5,2) not null default 75.00,
  checkpoint_token_ttl_seconds      integer not null default 300,
  timetable_tolerance_minutes       integer not null default 15,
  updated_at                        timestamptz not null default now(),
  constraint app_config_single_row check (id = 1),
  -- System doc §4: the Day-31 buffer is 6–12 hours, no wider.
  constraint app_config_buffer_range check (pending_verification_buffer_hours between 6 and 12),
  constraint app_config_retention_range check (gps_retention_days between 7 and 30),
  constraint app_config_radius_range check (default_geofence_radius_m between 30 and 50),
  constraint app_config_token_ttl_range check (checkpoint_token_ttl_seconds between 60 and 600)
);

insert into app_config (id) values (1);

create trigger app_config_updated_at
  before update on app_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Dues
-- ---------------------------------------------------------------------------

create table dues_periods (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null unique references academic_sessions (id) on delete cascade,
  resumption_date     date not null,
  -- Amounts are held in kobo. Stored as double precision by project decision.
  --
  -- Two consequences to design around, neither of them fatal but both real:
  -- Paystack's API requires an integer kobo amount, so this value is cast to an
  -- integer at the request boundary; and equality comparison against a paid
  -- amount is inexact, so reconciliation compares with a tolerance rather than
  -- `=` (see payment_matches_dues()). Postgres `numeric` would remove both.
  dues_amount_kobo    double precision not null,
  grace_period_end    date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint dues_amount_positive check (dues_amount_kobo > 0),
  constraint dues_amount_whole_kobo check (dues_amount_kobo = trunc(dues_amount_kobo))
);

create trigger dues_periods_updated_at
  before update on dues_periods
  for each row execute function set_updated_at();

comment on column dues_periods.resumption_date is
  'Day 0 of the provisional window. Day 31 is the lock boundary.';
