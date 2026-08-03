# Dept-Flow — agreed decisions

Decisions taken during the shared-components review, before any code was
written. Where these disagree with `system-operation-and-logic.md`,
`ui-build-specification.md` or `dept-flow-design-skill.md`, **these win** — the
older documents were written earlier and are kept as the reasoning behind the
design, not as the current specification.

---

## Naming

**Computer Science is `CMP` in this department, not `CSC`.** Programme prefixes
are `MTH | CMP | STA`. This applies to matric numbers (`CMP/2021/047`) and to
course codes (`CMP 301`). The design mockups in `design/` were supplied using
`CSC` throughout and have been corrected. Database constraints reject `CSC` in
both positions, so it cannot creep back in.

The department is the **Department of Mathematics and Computer Science**.
SAMACOSS — the association, and the crest — carries Statistics in its own name.
Don't add Statistics to the department; don't remove it from the crest.

## Identity and registration

- **No date of birth.** Anywhere. `system-operation-and-logic.md` §8 still shows
  it; that is superseded.
- **The identity check is matric number + surname + level.** These three are
  matched against the register.
- **Full name is collected at registration**: surname, first name, other names.
  First and other names are stored as account data and are **not** matched
  against the register — a student whose middle name is recorded as "Ngozi" and
  who types "N." must not be locked out of their own account.
- Other names are optional; many students have none.
- The whitelist CSV stays `matric_no, surname, level`.
- **Programme is never asked for.** It is read from the matric prefix and
  displayed back as confirmation.

### Name display

| Context | Form | Example |
|---|---|---|
| Registers, tables, rosters, eligibility list | Surname first, upper-case | `OKONKWO, Chidera Emeka` |
| Greetings, account menu | Conversational | `Chidera Okonkwo` |

Implemented as `display_name_register()` and `display_name_familiar()` in the
database, and mirrored in `lib/format.ts` on the frontend.

## Authentication — no email, anywhere

**The login identifier is the matric number** (or a staff ID for staff). There
is no email field in the product, in the schema, or in the account model.

**Supabase Auth is not used.** GoTrue is built around an email or a phone
number as the account identifier, and Dept-Flow has neither. The two ways of
bending it to fit are both worse than not using it:

- A *synthetic email* (`cmp2021047@dept-flow.local`) puts a fake value at the
  centre of the identity model, and it leaks the first time an error message
  or a support screen quotes it back.
- The *phone as the hidden identifier* makes a private number into a login
  credential, and any lookup that maps matric to phone becomes a way to
  harvest numbers.

So credentials live on `profiles` and the API issues its own JWT. The token
carries `sub` = `profiles.id`, which is exactly what `auth.uid()` reads, so
**every RLS policy already written keeps working unchanged**.

### What a login actually consists of

| Role | Identifier | Secret |
|---|---|---|
| Student | Matric number — `CMP/2021/047` | Password |
| Lecturer, HOD, Admin | Staff ID — `STF/CMP/001` | Password |

One field accepts either, so there is no role picker at login: the system can
work out which you are from what you typed.

The matric number is the **username, not the whole credential**. A password is
always required.

### Where the phone number still matters

The phone is collected at registration and OTP-verified, and it remains the
channel for password reset. It is simply not the login identifier, and it is
never shown unmasked to anyone but its owner.

### Password storage

Argon2id, hashed by the API. `profiles.password_hash` carries a check
constraint that only accepts a modular crypt string — anything that is not a
digest, including a plaintext password that has escaped a code path, cannot be
stored. Development seeds hash with pgcrypto so the seed needs no external
tooling; the constraint accepts both.

`resolve_login_identifier()` maps either identifier to an account and returns
no credential material and no phone number, because it runs before a session
exists.

## Money

**Amounts are held in kobo as `double precision`.** This was decided
deliberately; two consequences are designed around rather than argued with:

- Paystack's API requires an **integer** kobo amount, so the value is cast to an
  integer at the request boundary.
- Float equality is unreliable, so reconciliation uses
  `payment_matches_dues(paid, due)`, which compares within one kobo. A genuine
  shortfall is never a fraction of a kobo, and representation error is never a
  whole one.

Postgres `numeric` would remove both, and remains a one-line change if wanted
later.

## OTP

- The backend generates a 6-digit code and stores it **hashed**, with an expiry
  and an attempt counter.
- Delivery goes through a single `send_otp()` interface. The development
  implementation writes to the server log; the production one calls an SMS
  provider. Nothing above that line changes.
- **The code is never returned in an HTTP response**, in any environment.
- Rate limited per matric number and per phone.
- SMS provider for launch is still open — Termii and Africa's Talking are the
  local options; Twilio works but costs more per message to Nigeria.

## Payments — Paystack

- Test mode throughout the build. Test keys need no business KYC.
- **Card and Pay with Transfer only.** Dedicated virtual accounts stay dropped.
- The browser never talks to Paystack directly; the secret key is server-side.
- Webhook signature is verified as HMAC-SHA512 over the **raw request bytes**,
  before any JSON parsing.
- **A valid signature is not proof of payment.** The backend then calls
  `transaction/verify/:reference` and trusts only that. `payments.verified_at`
  is written from the verify response, never from the webhook payload — the
  schema enforces this.
- A nightly job re-verifies anything still pending, which is what makes the
  6–12 hour `PENDING_VERIFICATION` buffer honest.
- Webhook receiver: **Supabase Edge Function** initially, since the schema is
  being stood up before FastAPI exists. It can stay as a thin receiver
  afterwards.

## Shared components

The build spec names nine. Four more were agreed, each because it guards a rule
that gets broken when the same thing is hand-rolled per screen.

**The nine:** `AppShell` · `CheckpointStrip` · `StatusBadge` · `AttendanceMeter` ·
`ConfirmDialog` · `DataTable` · `EmptyState` · `Toast` · `PageHeader`

**Added:**

| Component | Guards |
|---|---|
| `CodeInput` | Never-block-paste, `inputmode="numeric"`, `autocomplete="one-time-code"`, auto-advance. Used at `/attend`, `/register/verify`, `/forgot`. |
| `Countdown` | `tabular-nums`, `aria-live`, `Intl` formatting across the Day-30/31 midnight boundary. |
| `StickyActionBar` | `env(safe-area-inset-bottom)` — the inset everyone forgets, which puts the primary button under the iOS home indicator. |
| `ComplianceBanner` | The five compliance states and their fix actions, in one place, so a sixth cannot be invented. |

**Plus, not components:**

- `lib/format.ts` — `Intl.NumberFormat` for Naira, `Intl.DateTimeFormat` for
  dates, and the two name-display helpers. Hardcoded formats are a pre-ship
  rejection.
- `usePendingSubmission` — `localStorage`-persisted, retries while the tab is
  open, and has **no "recorded" state** until the server acknowledges. A false
  "Recorded ✓" is the worst failure mode in the system, so this is shared code
  rather than a convention.

Deliberately **not** shared: the lecturer's live session-control screen. Used
once, with sizing rules nothing else has.

## Shell per role

| Role | Shell |
|---|---|
| Student | Bottom tab bar |
| Lecturer | Bottom tab bar — Today / Session / Schedule / You |
| HOD, Admin | Desktop sidebar |

The lecturer case was unspecified in the build spec. Session control is
operated on a phone standing in front of a class, which is the same constraint
students have.

**This is a website, not an app.** The bottom bar is a sticky nav of real `<a>`
links to real routes; every tab is a URL that can be pasted into WhatsApp, and
back/forward behave normally. No install prompt, no service worker, no web
manifest.

## Build order

Supabase schema first, then screens. The schema is in `supabase/`.

## The attendance path

Decided while wiring lecturer → checkpoint → student → score. The database
functions were already authoritative; these are the choices the API makes
around them.

**A lecture row is created when the lecturer starts the class, not by a
scheduler.** A `timetable_entries` row says a class is *meant* to happen; a
`session_instances` row says one *did*. Pre-creating instances would put
lectures that never ran into the attendance denominator, which is the one
number the whole product is about. Consequence: "Start session" is a POST that
creates the row, not a link — there is nothing to link to yet. Tapping it twice
returns the same instance rather than creating a second.

**`checkpoint_mode` is decided at close, from what was issued.** Two tokens →
`pair`, one → `single`. This is why the column is null until then. Closing with
one checkpoint requires a written reason and writes an audit row, because it
changes how every student in the hall is scored.

**Closing scores every enrolled student, including the absent ones.** A missing
`session_scores` row would silently forgive an absence. `resolve_session_score`
is called once per enrolment and is never reimplemented in TypeScript.

**A rejected mark can be corrected; an accepted one cannot.** The unique
constraint on `(student_id, checkpoint_id)` is the duplicate defence and stays,
but the API upserts: a student who mistypes writes a rejected row, and their
correct retry updates it in place. Inserting a second row would be blocked by
the constraint, so the first typo would cost them the checkpoint. Once a row is
accepted, further submissions are `already_submitted`.

**`mark_reject_reason` is coarser than the message on screen, deliberately.** A
mistyped code and a lapsed code are one event to the HOD and two different
instructions in the hall, so `wrong_code` is stored as
`invalid_or_expired_token` and only the UI distinguishes them.

**The geo-fence allows the phone's own error, capped at 35 m.** A reading of
±60 m inside a 40 m fence cannot prove the student is outside; rejecting it
punishes a cloudy day and looks identical to cheating in the audit trail. The
cap exists because a ±500 m reading carries no information about which building
you are in. Distance is stored on every mark, accepted or not — it survives the
coordinate purge and is the only evidence a disputed rejection leaves.

**Venue names split from venue coordinates — `venue_directory`.** `venues` is
admin-only under RLS, and correctly so: a student who can read the fence centre
and radius knows exactly how far they can stray. But the venue *name* is on the
timetable and has to appear on both the lecturer's session screen and the
student's checkpoint screen. `venue_directory` is a view of `id, name` and
nothing else, on the same reasoning as `my_attendance_marks` — the coordinates
are not hidden there, they are absent.

**The token never reaches a student's browser.** Students have no read policy on
`checkpoints` at all. The server returns every field of a live checkpoint except
the code; being in the room to read it off the board is the mechanism.

## Paying dues

Decided while wiring Paystack. `clear_student()` was already the authoritative
implementation — the state flips and every provisional score confirms in one
transaction — so these are the choices the API makes around it.

**Redirect flow, not the inline popup, so there is no public key.** The server
initialises the transaction and sends the student to Paystack's own page. The
popup is the only thing `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` exists for, so that
variable is gone from `.env.example` rather than sitting there unread — an
unused variable in that file is a trap, which `SESSION_SECRET` already
demonstrated. On a phone on a poor connection, a full page navigation beats
loading a third-party script into an iframe.

**Paystack requires an email; Dept-Flow collects none.** Identity here is a
matric number, and asking a student for an address purely to satisfy a required
field would put a contact detail in the system that nothing else needs and
someone would eventually mail. The slot is filled with a derived address at
`students.example.com` — reserved by RFC 2606, held by IANA, and guaranteed to
black-hole everything sent to it. Receipts are in-app. The matric number
travels in `metadata` as well, so the Paystack dashboard stays searchable by
the identifier the department actually uses.

This was `dept-flow.invalid` first, which the same RFC reserves. The difference
that matters to a payment processor: `.invalid` has no entry in the root zone,
so any validator checking the TLD against the real list refuses the address,
while `example.com` resolves and simply never delivers. Identical guarantee,
fewer ways to be rejected.

**The amount is read from `dues_periods` on the server.** The browser sends no
figure. A client that can name its own price has defeated the whole mechanism.
The one thing it does choose is the channel, and only the chosen one is passed
to Paystack — Paystack shows exactly the channels it is given and cannot
preselect, so passing both would make our radio group decorative.

**Our reference, minted before the student leaves.** The `payments` row exists
first, so an abandoned checkout is a pending row that can be re-verified rather
than a transaction we never heard about.

**A webhook is a notification, never evidence.** Anyone can POST JSON at a
public URL. `/api/payments/webhook` verifies the HMAC-SHA512 signature over the
*raw* request bytes — re-serialising the parsed body changes key order and
whitespace and the signature stops matching — and then still calls
`transaction/verify` before anything changes.

**Both settlement paths have to work.** The webhook and the student's return
from checkout race each other, and on a laptop the webhook cannot arrive at
all. `settlePayment()` is idempotent and is called from both; a row already
`success` is a no-op rather than a second `clear_student()`.

**An underpayment stays pending and keeps its payload.** Money that arrives and
does not settle the debt is recorded, not cleared and not silently accepted. It
is a thing a person has to look at, and the verification response is kept so
they can.

## Palette

`#FF9935`, eyedropped from the crest, superseding the `#F0952B` visual estimate
in `dept-flow-design-skill.md` §3 and `ui-build-specification.md` §1. Black text
on orange (9.30:1). White on orange is 2.13:1 and never appears.

### `--on-brand`, and why it is not `--ink`

Added during the build. `--ink` inverts in dark mode — that is its job — so a
primary button styled `bg-brand text-ink` renders black on orange in light mode
and **white on orange in dark mode, at 2.13:1**. The bug is invisible in light
mode and was caught by screenshotting the built page in both schemes.

`--on-brand: #0a0a0a` is the foreground for anything sitting on an orange fill,
and it never changes between schemes. Any new orange surface uses it.

The crest still shows its white raster box on dark backgrounds, as the design
docs predicted. It needs a transparent original before launch; nothing in the
code can fix it.
