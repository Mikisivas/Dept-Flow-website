-- Dept-Flow — lock down function execution
--
-- Postgres grants EXECUTE on every new function to PUBLIC, and PostgREST
-- publishes everything in the `public` schema as an RPC endpoint. Together
-- that means a function is callable by anyone holding the anon key — which is
-- in the browser bundle by design — unless PUBLIC is revoked explicitly.
--
-- Revoking from `anon` and `authenticated` by name does NOT do this. Those
-- roles inherit PUBLIC's grant, so the named revoke removes a permission they
-- were never relying on and leaves the real one in place. It has to be
-- `revoke ... from public`.
--
-- The write functions were already protected by accident rather than design:
-- none of them are SECURITY DEFINER, so they run with the caller's privileges
-- and hit the table-level revoke. That is defence in depth doing its job, but
-- it is not a reason to leave the endpoints exposed.

-- ---------------------------------------------------------------------------
-- The one that was actually exploitable
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, so it runs as the owner and sails past every table grant.
-- Exposed to PUBLIC it let anyone POST /rest/v1/rpc/resolve_login_identifier
-- and walk the register: matric numbers are sequential, so a few hundred
-- requests enumerate who has an account, their role, and whether they have
-- been deactivated.
--
-- Only the API needs it, and the API holds the service role.
revoke all on function resolve_login_identifier(text) from public, anon, authenticated;
grant execute on function resolve_login_identifier(text) to service_role;

-- ---------------------------------------------------------------------------
-- Functions the RLS policies call
-- ---------------------------------------------------------------------------

-- These are evaluated as the caller inside a policy, so `authenticated` must
-- keep EXECUTE or every policy that references them fails closed and the
-- product stops working. `anon` has no policies and needs none of them.
revoke all on function current_app_role() from public, anon;
revoke all on function is_admin() from public, anon;
revoke all on function is_hod() from public, anon;
revoke all on function is_lecturer() from public, anon;
revoke all on function is_student() from public, anon;
revoke all on function teaches_course(uuid) from public, anon;

grant execute on function current_app_role() to authenticated, service_role;
grant execute on function is_admin() to authenticated, service_role;
grant execute on function is_hod() to authenticated, service_role;
grant execute on function is_lecturer() to authenticated, service_role;
grant execute on function is_student() to authenticated, service_role;
grant execute on function teaches_course(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Anything that writes, or that a scheduled job runs
-- ---------------------------------------------------------------------------

-- The API owns every one of these. None should be reachable as an RPC.
revoke all on function clear_student(uuid, uuid, clearance_route, uuid) from public, anon, authenticated;
revoke all on function resolve_session_score(uuid, uuid, score_source, uuid) from public, anon, authenticated;
revoke all on function begin_pending_verification(uuid) from public, anon, authenticated;
revoke all on function lock_after_buffer(uuid) from public, anon, authenticated;
revoke all on function purge_expired_coordinates() from public, anon, authenticated;
revoke all on function write_audit(uuid, app_role, text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function clear_student(uuid, uuid, clearance_route, uuid) to service_role;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid) to service_role;
grant execute on function begin_pending_verification(uuid) to service_role;
grant execute on function lock_after_buffer(uuid) to service_role;
grant execute on function purge_expired_coordinates() to service_role;
grant execute on function write_audit(uuid, app_role, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Pure calculation, safe to expose
-- ---------------------------------------------------------------------------

-- These read nothing a signed-in user cannot already read under RLS, or take
-- all their inputs as arguments and touch no table at all. A student computing
-- their own percentage client-side is a feature, not a leak.
revoke all on function attendance_pct(uuid, uuid) from public, anon;
revoke all on function is_attendance_locked(uuid, uuid) from public, anon;
revoke all on function full_sessions_needed(numeric, numeric, numeric) from public, anon;
revoke all on function payment_matches_dues(double precision, double precision) from public, anon;
revoke all on function display_name_register(text, text, text) from public, anon;
revoke all on function display_name_familiar(text, text) from public, anon;

grant execute on function attendance_pct(uuid, uuid) to authenticated, service_role;
grant execute on function is_attendance_locked(uuid, uuid) to authenticated, service_role;
grant execute on function full_sessions_needed(numeric, numeric, numeric) to authenticated, service_role;
grant execute on function payment_matches_dues(double precision, double precision) to authenticated, service_role;
grant execute on function display_name_register(text, text, text) to authenticated, service_role;
grant execute on function display_name_familiar(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- And for everything added later
-- ---------------------------------------------------------------------------

-- New functions in this schema default to PUBLIC EXECUTE, which is how this
-- hole appeared in the first place. Stop it happening again.
alter default privileges in schema public revoke execute on functions from public;
