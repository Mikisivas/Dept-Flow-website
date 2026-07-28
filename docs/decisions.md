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
