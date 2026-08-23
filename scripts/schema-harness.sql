-- Dept-Flow — the Supabase surface the schema is written against
--
-- setup.sql and the schema tests are written to be pasted into the Supabase
-- SQL Editor, where `auth.users`, `auth.uid()` and the three PostgREST roles
-- already exist. A bare Postgres has none of them, so this stands them up
-- first and nothing else: it is a test harness, never applied to a project.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase reads the signed-in user from a request-scoped GUC. The tests set
-- `request.jwt.claim.sub` to impersonate; unset, it returns null, which is
-- what an anonymous request looks like.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase grants the PostgREST roles full table access and then relies on
-- row-level security to decide what they actually see. Without these the RLS
-- section of the suite fails on the grant rather than on the policy, which
-- tests nothing and looks like a policy bug.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
