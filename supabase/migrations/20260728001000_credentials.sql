-- Dept-Flow — matric-number credentials, with no email anywhere
--
-- Supabase Auth (GoTrue) is built around an email or a phone number as the
-- account identifier. Dept-Flow has neither: a student is identified by their
-- matric number, and staff by a staff ID. Bending GoTrue to fit — a synthetic
-- email, or the phone as a hidden identifier — puts a fake or private value at
-- the centre of the identity model and leaks it the first time an error
-- message quotes it.
--
-- So the credential store lives here, and the API issues its own JWT. The
-- token carries `sub` = profiles.id, which is exactly what `auth.uid()` reads,
-- so every RLS policy already written keeps working unchanged.
--
-- Passwords are hashed by the API with Argon2id and only ever arrive here
-- already hashed. Nothing in this schema can read a password.

-- ---------------------------------------------------------------------------
-- Detach profiles from auth.users
-- ---------------------------------------------------------------------------

alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles alter column id set default gen_random_uuid();

comment on column profiles.id is
  'Account identifier. Issued here, not by GoTrue. Travels as the JWT `sub` claim, which is what auth.uid() returns.';

-- ---------------------------------------------------------------------------
-- Credentials
-- ---------------------------------------------------------------------------

alter table profiles
  add column password_hash        text,
  add column password_updated_at  timestamptz,
  add column failed_attempts      integer not null default 0,
  add column locked_until         timestamptz,
  add column last_login_at        timestamptz;

-- A bcrypt or Argon2 digest, never a password. The check is deliberately loose
-- on algorithm and strict on shape: anything that is not a modular crypt
-- string is a plaintext password that has escaped, and it must not be storable.
alter table profiles
  add constraint profile_password_is_hashed
  check (password_hash is null or password_hash ~ '^\$(argon2(i|d|id)|2[aby])\$');

alter table profiles
  add constraint profile_failed_attempts_sane
  check (failed_attempts >= 0);

comment on column profiles.password_hash is
  'Argon2id digest written by the API. A plaintext password cannot satisfy the check constraint.';

comment on column profiles.locked_until is
  'Set by the API after repeated failures. Throttles credential stuffing against a known matric number format.';

-- ---------------------------------------------------------------------------
-- Login lookup
-- ---------------------------------------------------------------------------

-- Login takes a matric number or a staff ID and has to resolve it to a profile
-- in one hop, on a path that runs during checkpoint bursts.
create index if not exists students_matric_lookup_idx on students (matric_no);
create index if not exists profiles_staff_lookup_idx on profiles (staff_id) where staff_id is not null;

-- Resolves either identifier to the account behind it. Security definer so the
-- API can call it before a session exists; it returns no password material and
-- no personal data beyond what the caller already typed.
create or replace function resolve_login_identifier(p_identifier text)
returns table (profile_id uuid, role app_role, is_deactivated boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.role,
         coalesce(s.status = 'deactivated', false)
  from profiles p
  left join students s on s.id = p.id
  where p.staff_id = p_identifier
     or s.matric_no = upper(btrim(p_identifier));
$$;

comment on function resolve_login_identifier(text) is
  'Matric number or staff ID to account. Returns no credential material — the API compares the hash itself.';

revoke all on function resolve_login_identifier(text) from anon, authenticated;
