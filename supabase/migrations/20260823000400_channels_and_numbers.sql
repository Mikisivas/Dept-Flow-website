-- Dept-Flow — the numbers a student can be reached on, and the channels
--
-- The revised flow turns Dept-Flow from a tracker into a warning system, and a
-- warning system is only as good as its ability to reach somebody. Everything
-- from §5 — the tiered alerts, the escalation, the WhatsApp-then-SMS fallback —
-- rests on two things this schema does not have: a number per channel, and a
-- record of what was actually delivered.
--
-- THE NUMBERS (§1)
--
-- `profiles.phone` is the primary number: SMS reaches it, and it doubles as the
-- account's identity. Most students' WhatsApp runs on that same number, and for
-- them nothing changes. Some run WhatsApp on a data-only SIM that is not in the
-- phone they carry, so a separate WhatsApp number is optional and, when given,
-- separately verified — a number nobody has proved is reachable is worse than
-- no number, because the system will believe it delivered a warning.
--
-- THE CHANNELS (§5.3)
--
-- in-app always · Web Push at Watch · WhatsApp at Critical · SMS last.
-- The ordering is not decoration: SMS costs money and needs no data
-- connection, which is exactly why it is reserved for the most severe warning
-- and exactly why it must not be spent on a Monday digest.
--
-- WHAT IS NOT HERE
--
-- No provider. `notification_deliveries` records an attempt and its outcome;
-- what actually calls WhatsApp or an SMS gateway is application code with a
-- seam that throws in production until it is wired, the same way the OTP seam
-- has always worked. A schema that pretended to have a provider would be the
-- more dangerous of the two.

-- ---------------------------------------------------------------------------
-- The WhatsApp number
-- ---------------------------------------------------------------------------

alter table profiles
  add column whatsapp_phone text,
  add column phone_verified_at timestamptz,
  add column whatsapp_verified_at timestamptz;

alter table profiles
  add constraint profile_whatsapp_format check (
    whatsapp_phone is null or whatsapp_phone ~ '^\+234[0-9]{10}$'
  ),
  -- Storing the same number twice would mean two OTPs to one handset at
  -- registration and two sends for every Critical alert afterwards. Null means
  -- "the primary number is the WhatsApp number", which is the common case.
  add constraint profile_whatsapp_distinct check (
    whatsapp_phone is null or whatsapp_phone <> phone
  ),
  add constraint profile_whatsapp_verified_has_number check (
    whatsapp_verified_at is null or whatsapp_phone is not null
  );

comment on column profiles.whatsapp_phone is
  'Only when WhatsApp runs on a different SIM from the phone the student carries. Null means WhatsApp goes to the primary number.';

-- Where a WhatsApp message should go, resolved once so that no caller has to
-- remember the fallback. Every send reads this rather than reimplementing
-- `coalesce`, which is the kind of thing that gets it right in four places and
-- wrong in the fifth.
create or replace function whatsapp_number(p_profile_id uuid)
returns text
language sql
stable
as $$
  select coalesce(p.whatsapp_phone, p.phone)
  from profiles p
  where p.id = p_profile_id;
$$;

grant execute on function whatsapp_number(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- OTP, per channel
-- ---------------------------------------------------------------------------

-- A code sent by SMS to the primary number and a code sent by WhatsApp to the
-- WhatsApp number are two different codes with two different fates, and the
-- table had no way to tell them apart.
create type otp_channel as enum ('sms', 'whatsapp');

alter table otp_codes
  add column channel otp_channel not null default 'sms';

drop index if exists otp_codes_lookup_idx;
create index otp_codes_lookup_idx
  on otp_codes (phone, purpose, channel, created_at desc)
  where consumed_at is null;

comment on column otp_codes.channel is
  'How this code was sent. Both numbers are verified before either is trusted, so registration can have two live codes at once.';

-- ---------------------------------------------------------------------------
-- Channels, and what was actually delivered
-- ---------------------------------------------------------------------------

create type notification_channel as enum ('in_app', 'web_push', 'whatsapp', 'sms');

-- 'sent' is what a provider accepted, not what a student read. The distinction
-- matters for the fallback: WhatsApp accepting a message is the signal NOT to
-- spend an SMS, and WhatsApp rejecting it is the signal to spend one
-- immediately rather than waiting for the next scheduled alert.
create type delivery_status as enum ('queued', 'sent', 'failed', 'skipped');

-- Four new kinds. Rebuilt rather than extended, for the reason the grace scope
-- was: `alter type ... add value` cannot be followed by a use of that value in
-- the same transaction, and setup.sql is one paste into the SQL Editor. The
-- `notification_policy` seed below names all four, so the extend-in-place form
-- applied cleanly from psql and failed for anyone following the setup guide.
--
-- It got that far because the transaction check in scripts/schema-test.sh was
-- grepping for psql's "file:line:" error prefix, which psql only writes when
-- reading a file — from a pipe it prints a bare "ERROR:". The check matched
-- nothing and passed everything. Both are fixed.
alter type notification_kind rename to notification_kind_old;

create type notification_kind as enum (
  'payment_reminder',
  'payment_confirmed',
  'risk_nudge',
  'grace_period',
  'schedule_change',
  'clearance_granted',
  -- New with the warning system.
  'lecture_reminder',
  'attendance_warning',
  'weekly_report',
  'hod_message'
);

-- notify_enrolled() takes the type in its signature, so it goes before the type
-- does and is recreated below against the new one, unchanged.
drop function if exists notify_enrolled(uuid, notification_kind_old, text, text, text);

alter table notifications
  alter column kind type notification_kind using kind::text::notification_kind;

drop type notification_kind_old;

-- Recreated against the new type, verbatim apart from one change: it now
-- queues through queue_notification() rather than inserting the in-app row
-- itself, so a schedule change reaches students on the channels the policy
-- allows instead of only inside the app. That is defined further down this
-- file, so the recreation is at the bottom rather than here.

-- One row per channel per notification. The in-app copy still lives in
-- `notifications` — it is the thing the student opens — and this records every
-- attempt made to push that same notification outward.
create table notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications (id) on delete cascade,
  channel         notification_channel not null,
  status          delivery_status not null default 'queued',
  -- The number or endpoint it was addressed to, as it was at the time. A
  -- student who changes their number later must not silently rewrite the
  -- history of where a warning went.
  destination     text,
  provider_ref    text,
  error           text,
  -- Set when this send exists because another channel failed. The whole point
  -- of the WhatsApp→SMS rule is that it is visible afterwards.
  fell_back_from  notification_channel,
  attempted_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, channel),
  constraint delivery_failed_has_error check (
    status <> 'failed' or length(btrim(coalesce(error, ''))) > 0
  ),
  constraint delivery_sent_has_timestamp check (
    status not in ('sent', 'failed') or attempted_at is not null
  )
);

create index notification_deliveries_notification_idx
  on notification_deliveries (notification_id);
create index notification_deliveries_queued_idx
  on notification_deliveries (channel, created_at)
  where status = 'queued';

comment on table notification_deliveries is
  'One attempt per channel per notification. A failed WhatsApp send is what triggers the SMS, and this is where that decision is recorded.';

-- ---------------------------------------------------------------------------
-- Web Push subscriptions
-- ---------------------------------------------------------------------------

-- A push endpoint belongs to a BROWSER, not to a person: the same student on a
-- phone and a laptop is two subscriptions, and reaching them on the device
-- they are holding is the entire value of the channel. So this is one row per
-- endpoint rather than one per student.
--
-- Endpoints expire. A push service answers a dead one with 410 Gone, which is
-- the signal to delete the row rather than to retry it — an expired
-- subscription retried forever is a channel that reports failures every night
-- for a student who simply cleared their browser data.
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles (id) on delete cascade,
  -- The push service's URL for this browser. Unique because re-subscribing the
  -- same browser must update the row rather than accumulate duplicates that
  -- each deliver the same notification.
  endpoint     text not null unique,
  subscription jsonb not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index push_subscriptions_profile_idx on push_subscriptions (profile_id);

alter table push_subscriptions enable row level security;

-- A student manages their own devices and sees nobody else's. Staff have no
-- read policy at all: the list of browsers a student signs in from is not
-- something the department needs.
create policy push_subscriptions_self on push_subscriptions
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

comment on table push_subscriptions is
  'One row per browser, not per student. A 410 from the push service means delete this row, not retry it.';

-- ---------------------------------------------------------------------------
-- Which channels a tier earns
-- ---------------------------------------------------------------------------

-- §5.3, as data rather than as a branch buried in application code. The
-- department will want to change this — turning SMS off for a term is a budget
-- decision, not a deploy — and a table is the difference between that being a
-- config change and a release.
create table notification_policy (
  kind        notification_kind primary key,
  in_app      boolean not null default true,
  web_push    boolean not null default false,
  whatsapp    boolean not null default false,
  sms         boolean not null default false,
  updated_at  timestamptz not null default now()
);

create trigger notification_policy_updated_at
  before update on notification_policy
  for each row execute function set_updated_at();

insert into notification_policy (kind, in_app, web_push, whatsapp, sms) values
  -- Escalation lives on the risk tier rather than the kind, so the warning row
  -- enables every channel and `channels_for_tier()` narrows it.
  ('attendance_warning', true,  true,  true,  true),
  -- A reminder an hour before a lecture. WhatsApp, because it is free and the
  -- student is looking at their phone anyway; never SMS, which would spend the
  -- budget reserved for the warning that matters.
  ('lecture_reminder',   true,  true,  true,  false),
  ('weekly_report',      true,  false, true,  false),
  ('hod_message',        true,  true,  true,  false),
  ('payment_reminder',   true,  false, false, false),
  ('payment_confirmed',  true,  false, false, false),
  ('risk_nudge',         true,  true,  false, false),
  ('grace_period',       true,  false, true,  false),
  ('schedule_change',    true,  true,  true,  false),
  ('clearance_granted',  true,  false, false, false)
on conflict (kind) do nothing;

comment on table notification_policy is
  'Which channels each kind of notification may use. SMS costs money, so turning it off for a term is a row edit rather than a deploy.';

alter table notification_policy enable row level security;

create policy notification_policy_read on notification_policy
  for select to authenticated using (is_admin() or is_hod());

alter table notification_deliveries enable row level security;

-- A student sees where their own notifications were sent. Not a secret — it is
-- their number and their warning — and it answers "I never got that" without a
-- support ticket.
create policy notification_deliveries_self_read on notification_deliveries
  for select to authenticated using (
    exists (
      select 1 from notifications n
      where n.id = notification_deliveries.notification_id
        and n.recipient_id = auth.uid()
    )
  );

create policy notification_deliveries_staff_read on notification_deliveries
  for select to authenticated using (is_admin() or is_hod());

-- ---------------------------------------------------------------------------
-- Queueing one
-- ---------------------------------------------------------------------------

-- Writes the in-app notification and one queued delivery row per channel the
-- policy allows. Deliberately does NOT send anything: sending needs a network
-- call, and a database function that could block on one would hold a
-- transaction open for as long as a provider felt like taking.
--
-- `p_channels` overrides the policy, for the risk tiers — Watch and Critical
-- are the same KIND of notification and earn different channels.
create or replace function queue_notification(
  p_recipient_id uuid,
  p_kind         notification_kind,
  p_title        text,
  p_body         text,
  p_link         text default null,
  p_channels     notification_channel[] default null
)
returns uuid
language plpgsql
as $$
declare
  v_id       uuid;
  v_policy   notification_policy%rowtype;
  v_wanted   notification_channel[];
  v_channel  notification_channel;
  v_dest     text;
begin
  insert into notifications (recipient_id, kind, title, body, link)
  values (p_recipient_id, p_kind, p_title, p_body, p_link)
  returning id into v_id;

  if p_channels is not null then
    v_wanted := p_channels;
  else
    select * into v_policy from notification_policy where kind = p_kind;

    v_wanted := array_remove(array[
      case when coalesce(v_policy.in_app, true)   then 'in_app'   end,
      case when coalesce(v_policy.web_push, false) then 'web_push' end,
      case when coalesce(v_policy.whatsapp, false) then 'whatsapp' end,
      case when coalesce(v_policy.sms, false)      then 'sms'      end
    ]::notification_channel[], null);
  end if;

  foreach v_channel in array v_wanted loop
    v_dest := case v_channel
                when 'whatsapp' then whatsapp_number(p_recipient_id)
                when 'sms'      then (select phone from profiles where id = p_recipient_id)
                else null
              end;

    insert into notification_deliveries (notification_id, channel, status, destination, attempted_at)
    values (
      v_id,
      v_channel,
      -- The in-app copy is the notifications row itself, which now exists, so
      -- it is delivered by definition. Everything else waits for a sender.
      (case when v_channel = 'in_app' then 'sent' else 'queued' end)::delivery_status,
      v_dest,
      case when v_channel = 'in_app' then now() end
    )
    on conflict (notification_id, channel) do nothing;
  end loop;

  return v_id;
end;
$$;

revoke all on function queue_notification(uuid, notification_kind, text, text, text, notification_channel[])
  from public, anon, authenticated;
grant execute on function queue_notification(uuid, notification_kind, text, text, text, notification_channel[])
  to service_role;

comment on function queue_notification(uuid, notification_kind, text, text, text, notification_channel[]) is
  'Writes the in-app notification and queues a delivery per allowed channel. Sends nothing — a provider call inside a transaction holds it open for as long as the provider likes.';

-- ---------------------------------------------------------------------------
-- The fallback
-- ---------------------------------------------------------------------------

-- "If a WhatsApp send fails to deliver, the system falls back to SMS
-- immediately rather than waiting for the next scheduled alert."
--
-- Recorded here rather than decided by the sender, so the reason an SMS was
-- spent is visible on the row afterwards. It refuses to fall back for a
-- notification whose policy does not permit SMS at all: a lecture reminder that
-- fails on WhatsApp is a lecture reminder that does not arrive, not a reason to
-- spend money the department decided not to spend.
create or replace function record_delivery_failure(
  p_delivery_id uuid,
  p_error       text
)
returns text
language plpgsql
as $$
declare
  v_row     notification_deliveries%rowtype;
  v_kind    notification_kind;
  v_allowed boolean;
  v_dest    text;
begin
  select * into v_row from notification_deliveries where id = p_delivery_id;
  if v_row.id is null then return 'not_found'; end if;

  update notification_deliveries
     set status = 'failed',
         error = coalesce(nullif(btrim(p_error), ''), 'delivery failed'),
         attempted_at = coalesce(attempted_at, now())
   where id = p_delivery_id;

  if v_row.channel <> 'whatsapp' then return 'failed'; end if;

  select n.kind into v_kind from notifications n where n.id = v_row.notification_id;
  select sms into v_allowed from notification_policy where kind = v_kind;

  if not coalesce(v_allowed, false) then
    return 'failed_no_fallback';
  end if;

  -- Already tried, or already queued by something else. Falling back twice
  -- would send the student two texts for one warning.
  if exists (
    select 1 from notification_deliveries d
    where d.notification_id = v_row.notification_id and d.channel = 'sms'
  ) then
    return 'failed_fallback_exists';
  end if;

  select phone into v_dest
  from profiles p
  join notifications n on n.recipient_id = p.id
  where n.id = v_row.notification_id;

  insert into notification_deliveries (
    notification_id, channel, status, destination, fell_back_from
  )
  values (v_row.notification_id, 'sms', 'queued', v_dest, 'whatsapp');

  return 'fell_back_to_sms';
end;
$$;

revoke all on function record_delivery_failure(uuid, text) from public, anon, authenticated;
grant execute on function record_delivery_failure(uuid, text) to service_role;

comment on function record_delivery_failure(uuid, text) is
  'Marks a send failed and, for WhatsApp, queues the SMS immediately. Refuses to fall back where the policy forbids SMS — a failed reminder is not a reason to spend money the department chose not to spend.';

-- ---------------------------------------------------------------------------
-- notify_enrolled, rebuilt on the channel layer
-- ---------------------------------------------------------------------------

-- The schedule screen promises "every enrolled student is notified straight
-- away". Notifying from the database rather than the API keeps that promise
-- attached to the write itself: a caller that cancels a lecture cannot forget
-- the half that students actually experience.
--
-- Unchanged in what it does and who it reaches. What changed is the row it
-- writes: through queue_notification(), so a cancelled lecture goes out on
-- WhatsApp and Web Push as well as in-app. A student who does not open the
-- site before walking to a hall that is shut is exactly who this is for.
create or replace function notify_enrolled(
  p_course_id uuid,
  p_kind      notification_kind,
  p_title     text,
  p_body      text,
  p_link      text default null
)
returns integer
language plpgsql
as $$
declare
  v_student uuid;
  v_sent    integer := 0;
begin
  for v_student in
    select e.student_id
    from enrolments e
    where e.course_id = p_course_id
      and e.dropped_at is null
  loop
    perform queue_notification(v_student, p_kind, p_title, p_body, p_link);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function notify_enrolled(uuid, notification_kind, text, text, text)
  from public, anon, authenticated;
grant execute on function notify_enrolled(uuid, notification_kind, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Throttling (§1.6)
-- ---------------------------------------------------------------------------

-- "The registration endpoint is rate-limited to stop scripted claiming of the
-- whole roster."
--
-- There is already a per-phone OTP limit, and it does not address this at all:
-- a script claiming the roster varies the phone number on every request, so
-- every request is the first one for its number. What has to be limited is the
-- CALLER — and specifically the register-match step, which is the one that
-- answers "is CMP/2021/047 a real unclaimed matric number" and can therefore
-- be walked through the whole department.
--
-- In the database rather than in memory: a Next.js instance is not the only
-- instance, and a limiter that resets on deploy is a limiter a patient script
-- outlasts. The stack names Redis and this is exactly what Redis is for —
-- swap the implementation, keep the interface, change no caller.
create table request_throttle (
  bucket       text not null,
  subject      text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, subject, window_start)
);

create index request_throttle_sweep_idx on request_throttle (window_start);

comment on table request_throttle is
  'Fixed-window counters, keyed on caller rather than on the thing being asked about. Redis would do this better; the interface is take_token().';

-- Returns true when the caller may proceed. Fixed windows rather than a
-- sliding log: a sliding window is more accurate and needs a row per request,
-- which for a login endpoint is a table that grows faster than the one it
-- protects.
create or replace function take_token(
  p_bucket        text,
  p_subject       text,
  p_limit         integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
as $$
declare
  v_start timestamptz;
  v_hits  integer;
begin
  if p_subject is null or btrim(p_subject) = '' then
    -- No identifiable caller. Allowed rather than blocked: failing closed here
    -- would lock out everyone behind a proxy that strips the header, which is
    -- a worse outcome than a script getting through.
    return true;
  end if;

  v_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into request_throttle (bucket, subject, window_start, hits)
  values (p_bucket, btrim(p_subject), v_start, 1)
  on conflict (bucket, subject, window_start) do update
    set hits = request_throttle.hits + 1
  returning hits into v_hits;

  -- Old windows, cleared opportunistically. A sweep job would be tidier and
  -- would be one more thing that has to be running for the table not to grow.
  delete from request_throttle
   where window_start < now() - interval '1 day';

  return v_hits <= p_limit;
end;
$$;

revoke all on function take_token(text, text, integer, integer) from public, anon, authenticated;
grant execute on function take_token(text, text, integer, integer) to service_role;

alter table request_throttle enable row level security;

create policy request_throttle_no_read on request_throttle
  for select to authenticated using (false);
