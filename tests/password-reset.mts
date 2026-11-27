/**
 * Password reset — the decisions, tested without a database.
 *
 * This is the one flow where getting it wrong hands over an account, and the
 * screen it replaced accepted the hardcoded code "123456" and then told the
 * student their password had changed without writing anything. So the rules
 * are pinned here rather than trusted.
 *
 *   npm run test:reset
 */

import { mock } from "node:test";

let failed = 0;
function check(what: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} — ${what}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// A Supabase stub that records what was asked of it
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> | null;

const state = {
  student: null as Row,
  profile: null as Row,
  otp: null as Row,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  otpCount: 0,
  filters: [] as Array<[string, unknown]>,
};

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  for (const method of ["select", "eq", "is", "order", "limit", "gte"]) {
    chain[method] = (...args: unknown[]) => {
      if (method === "eq") state.filters.push([String(args[0]), args[1]]);
      return self();
    };
  }

  chain.maybeSingle = () =>
    Promise.resolve({
      data:
        table === "students" ? state.student : table === "profiles" ? state.profile : state.otp,
    });
  chain.single = chain.maybeSingle;
  chain.insert = (values: Record<string, unknown>) => {
    state.inserts.push({ table, values });
    return Promise.resolve({ error: null });
  };
  chain.update = (values: Record<string, unknown>) => {
    state.updates.push({ table, values });
    return { eq: () => Promise.resolve({ error: null }) };
  };

  // Awaiting the chain without a terminal call is the rate-limit probe:
  // `.select(..., { head: true }).eq(...).gte(...)` and then await.
  chain.then = (resolve: (value: unknown) => unknown) =>
    resolve({ data: [], count: state.otpCount });

  return chain;
}

mock.module("../src/lib/supabase/client.ts", {
  namedExports: {
    createServiceClient: () => ({ from: (table: string) => builder(table) }),
    createUserClient: () => ({ from: (table: string) => builder(table) }),
  },
});

const { hashPassword } = await import("../src/lib/auth/passwords.ts");
const {
  startPasswordReset,
  completePasswordReset,
  changePassword,
  startPhoneChange,
  completePhoneChange,
} = await import("../src/lib/data/password-reset.ts");

const PHONE = "+2348051234567";
const PROFILE = "44444444-4444-4444-4444-444444444401";

function reset() {
  state.student = null;
  state.profile = null;
  state.otp = null;
  state.updates = [];
  state.inserts = [];
  state.otpCount = 0;
  state.filters = [];
}

// ---------------------------------------------------------------------------
// Starting a reset
// ---------------------------------------------------------------------------

reset();
state.student = { id: PROFILE, status: "active", profiles: { phone: PHONE } };
let started = await startPasswordReset("CMP/2021/047");

check("a real account gets a code", started.outcome === "sent");
check(
  "the masked number hides the middle and shows enough to recognise",
  started.outcome === "sent" &&
    started.maskedPhone.includes("•") &&
    started.maskedPhone.endsWith("4567") &&
    !started.maskedPhone.includes("12345"),
);
check(
  "the code is stored hashed, never in plaintext",
  state.inserts.some(
    (row) =>
      row.table === "otp_codes" &&
      typeof row.values.code_hash === "string" &&
      !/^[0-9]{6}$/.test(String(row.values.code_hash)),
  ),
);
check(
  "the code is filed under password_reset, so a registration code cannot be spent here",
  state.inserts.some((row) => row.values.purpose === "password_reset"),
);
check(
  "the destination is the phone on the account, not anything from the form",
  state.inserts.some((row) => row.values.phone === PHONE),
);

reset();
state.student = null;
started = await startPasswordReset("CMP/2021/999");
check("a matric number with no account is refused quietly", started.outcome === "no_account");
check("and no code is written for it", state.inserts.length === 0);

reset();
state.student = { id: PROFILE, status: "deactivated", profiles: { phone: PHONE } };
started = await startPasswordReset("CMP/2021/047");
check(
  "a deactivated account cannot be reset, and is reported like an absent one",
  started.outcome === "no_account",
);

reset();
state.student = { id: PROFILE, status: "active", profiles: { phone: PHONE } };
state.otpCount = 5;
started = await startPasswordReset("CMP/2021/047");
check("the sixth code in an hour is refused", started.outcome === "rate_limited");

// ---------------------------------------------------------------------------
// Completing one
// ---------------------------------------------------------------------------

const CODE = "418902";
const hash = await hashPassword(CODE);
const future = new Date(Date.now() + 300_000).toISOString();
const past = new Date(Date.now() - 1_000).toISOString();

const live = () => ({
  id: "otp-1",
  profile_id: PROFILE,
  code_hash: hash,
  expires_at: future,
  attempts: 0,
  max_attempts: 5,
});

reset();
state.otp = live();
let done = await completePasswordReset({
  matricNo: "CMP/2021/047",
  code: CODE,
  password: "correct horse battery",
});
check("the right code changes the password", done.outcome === "changed");
check(
  "the new password is stored hashed",
  state.updates.some(
    (row) =>
      row.table === "profiles" &&
      typeof row.values.password_hash === "string" &&
      !String(row.values.password_hash).includes("correct horse"),
  ),
);
check(
  "resetting clears a lockout — otherwise the reset works and the login still refuses them",
  state.updates.some(
    (row) => row.table === "profiles" && row.values.failed_attempts === 0 && row.values.locked_until === null,
  ),
);
check(
  "the code is consumed, so it cannot be replayed",
  state.updates.some((row) => row.table === "otp_codes" && row.values.consumed_at != null),
);

reset();
state.otp = live();
done = await completePasswordReset({ matricNo: "CMP/2021/047", code: "000000", password: "correct horse battery" });
check("a wrong code is refused", done.outcome === "bad_code");
check(
  "and the attempt is counted, so guessing runs out",
  state.updates.some((row) => row.table === "otp_codes" && row.values.attempts === 1),
);
check(
  "a wrong code changes no password",
  !state.updates.some((row) => row.table === "profiles"),
);

reset();
state.otp = { ...live(), expires_at: past };
done = await completePasswordReset({ matricNo: "CMP/2021/047", code: CODE, password: "correct horse battery" });
check(
  "an expired code is refused even when it is the right code",
  done.outcome === "bad_code" && /expired/i.test(done.reason),
);

reset();
state.otp = { ...live(), attempts: 5 };
done = await completePasswordReset({ matricNo: "CMP/2021/047", code: CODE, password: "correct horse battery" });
check(
  "a code that ran out of attempts is refused even when it is the right code",
  done.outcome === "bad_code" && /too many/i.test(done.reason),
);

reset();
state.otp = live();
done = await completePasswordReset({ matricNo: "CMP/2021/047", code: CODE, password: "short" });
check("a password under 8 characters is refused", done.outcome === "weak_password");
check("and nothing is written for it", state.updates.length === 0);

reset();
state.otp = null;
done = await completePasswordReset({ matricNo: "CMP/2021/047", code: CODE, password: "correct horse battery" });
check("with no outstanding code there is nothing to spend", done.outcome === "bad_code");

// ---------------------------------------------------------------------------
// Changing a password while signed in
// ---------------------------------------------------------------------------

const currentHash = await hashPassword("the old one");

reset();
state.profile = { password_hash: currentHash };
let changed = await changePassword({
  profileId: PROFILE,
  currentPassword: "the old one",
  newPassword: "a longer new one",
});
check("the right current password changes it", changed.outcome === "changed");

reset();
state.profile = { password_hash: currentHash };
changed = await changePassword({
  profileId: PROFILE,
  currentPassword: "not the old one",
  newPassword: "a longer new one",
});
check(
  "a wrong current password is refused — a borrowed unlocked phone is exactly this case",
  changed.outcome === "wrong_current",
);
check("and nothing is written", state.updates.length === 0);

reset();
state.profile = { password_hash: currentHash };
changed = await changePassword({
  profileId: PROFILE,
  currentPassword: "the old one",
  newPassword: "short",
});
check("a short new password is refused", changed.outcome === "weak_password");

// ---------------------------------------------------------------------------
// Changing a phone number
// ---------------------------------------------------------------------------

reset();
let phoneStart = await startPhoneChange({ profileId: PROFILE, phone: "08051234567" });
check("a number without the +234 country code is refused", phoneStart.outcome === "invalid");

reset();
state.profile = { id: "someone-else" };
phoneStart = await startPhoneChange({ profileId: PROFILE, phone: "+2348051112222" });
check(
  "a number already on another account is refused — otherwise two students can reset each other",
  phoneStart.outcome === "phone_taken",
);

reset();
phoneStart = await startPhoneChange({ profileId: PROFILE, phone: "+2348051112222" });
check("a free, well-formed number gets a code", phoneStart.outcome === "sent");
check(
  "the code goes to the NEW number, which is the thing being proved",
  state.inserts.some((row) => row.values.phone === "+2348051112222"),
);
check(
  "and it is filed under phone_change, not reusable as a reset",
  state.inserts.some((row) => row.values.purpose === "phone_change"),
);

reset();
state.otp = { id: "otp-2", code_hash: hash, expires_at: future, attempts: 0, max_attempts: 5 };
const phoneDone = await completePhoneChange({
  profileId: PROFILE,
  phone: "+2348051112222",
  code: CODE,
});
check("the right code moves the number", phoneDone.outcome === "changed");
check(
  "the number only changes once the code is entered",
  state.updates.some((row) => row.table === "profiles" && row.values.phone === "+2348051112222"),
);

console.log(failed === 0 ? "\nALL PASSWORD RESET CHECKS PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
