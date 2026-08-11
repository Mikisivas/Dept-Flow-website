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

## Course registration

How a student comes to be on a course, agreed with the department. It matters
more than it sounds: `enrolments` is the DENOMINATOR of the attendance formula,
so it decides which lectures count against a student and therefore who sits an
exam.

- **The admin uploads core and elective courses per level.** Core enrols every
  student at that level automatically and cannot be opted out of. Electives are
  opt-in.
- **Students add their own carry-overs**, from levels below their own. No
  approval step — the department asked for it to be self-service.
- **24 credit units per semester**, counting core, electives and carry-overs
  alike. Core is fixed, so the cap governs what can be added on top.

Three calls made during the build, since they were left open:

**A course joined late does not inherit earlier absences.** `attendance_pct`
counts lectures held from the student's join date, not every lecture the course
held. A carry-over added in week 8 would otherwise read 0% for seven classes
the student had no way of attending, and that number bars people from exams.

**Dropping records rather than deletes**, keeping `enrolled_on`. Deleting would
take the join date with it, and a student could then drop and re-add a course
to erase every absence on it. Core cannot be dropped at all — a student who
could remove it would simply stop being tracked for a course they still have to
pass.

**`enrolled_on` is its own column, not `created_at`.** A seeded or back-filled
enrolment has to be able to say "from the start of the session", and the
difference between those two dates is every lecture held before the row
existed. Keying off row-creation time gave the entire seeded cohort a
denominator of zero.

Consequence for upgrades: a migration that adds a dated column to a populated
table needs a backfill, because a default that is right for new rows is wrong
for old ones. `supabase/backfill_course_registration.sql` exists for exactly
that and is documented in `setup.md`.

## The payment window closes with the lock

**The portal is not open all session.** Once a student is locked, paying is
shut along with recording attendance. Department decision, and the reasoning is
behavioural: a deadline that can be ignored indefinitely is not a deadline. If
the portal stays open all year, "pay within 30 days" is advice and the money
arrives in month three.

The cost is accepted rather than mitigated. A student who finds the money on
day 35 cannot hand it over until the HOD opens a window — that is the
compulsion working, not a gap in it.

**Implemented as one rule, not two.** `is_payment_open()` is defined as the
inverse of `is_attendance_locked()`. A separate payment calendar would need its
own dates, its own grace mechanism, and its own answer for every student the two
disagreed about. Being locked already means "the provisional window ran out and
you did not clear", which is exactly the condition to gate payment on — and the
lock check already consults grace periods, so a grace period reopens payment
without another line being written.

**Starting a payment is gated; verifying one is not.** A transfer begun on day
29 can settle on day 32, and a bank does not care about the window. Refusing to
verify money that has already left a student's account would take the payment
and withhold the clearance, which is the worst outcome this system can produce.
The asymmetry is deliberate and is asserted in the schema tests.

Consequence for the UI: the locked banner carries **no Pay dues button**, and
the dues screen replaces the payment form with an explanation. A button that can
only ever be refused reads as a broken site rather than as a passed deadline.

## What drives the deadline

`begin_pending_verification` and `lock_after_buffer` existed from the first
migration and **nothing ever called them**. The whole ladder was inert. That was
survivable while locking only stopped attendance recording — the seed sets a
locked student by hand — and stopped being survivable the moment the payment
window was tied to the lock, because a deadline nothing enforces is not one.

**The date rule lives in the function, not the caller.** The original moved
every uncleared student into the buffer whenever it was called; the day-30 rule
was entirely the assumption that somebody would call it on day 31 and never
sooner. A scheduler misfire, a manual run or a retry would have locked a whole
department early — and, now, out of paying. It reads the resumption date and
the configured window itself, so running it on day 3 does nothing.

**pg_cron in Supabase is the recommended driver**, with
`POST /api/cron/compliance` as the fallback for hosts without it. Running inside
the database means one less moving part, no shared secret, and it keeps working
while the web deployment is down.

## Grace periods

A grace period is the HOD saying: for these students, start recording
attendance again until this date, even though they have not paid. Locking is
blunt and the cause is often not the student's — a bursary disburses late, a
bank is down for three days — and those lectures cannot be attended
retroactively.

**It reopens payment as well as recording.** Once locked, a student cannot pay
either — see the section above — and the grace period is the only way back in.

**It restores recording, not counting.** Marks come back provisional exactly as
before. The student still has to pay for them to count towards the 75%. What
the grace period buys is the chance not to lose the lectures while the money is
sorted out.

**It suspends the consequence rather than rewriting the state.** The obvious
implementation — flip every locked student back to `uncleared` — is wrong
twice: it destroys the record of who was locked, so revoking would have to
guess who to re-lock, and it makes a student under grace indistinguishable from
one who never reached day 31. Instead the state stays `locked` and
`is_attendance_locked()` consults the grace period. Revocation is then
immediate and needs no compensating update, because nothing was written to
undo.

**One at a time per scope.** Two overlapping periods make "when does this end"
unanswerable, which is the only question a student inside one will ask.

Opening and revoking are both authority actions: they confirm, demand a written
reason, and write an audit row naming the actor. Enforced in the database
functions rather than in the API, so the rule holds for anything that ever
writes these tables.

## Waivers and disputes

The last two HOD decisions, and the two whose consequences reach furthest back
in time.

**A granted waiver clears the student, through the same path a payment takes.**
`decide_waiver` calls `clear_student(..., 'waiver', actor)` — the same function
the Paystack verification calls — so every provisional score the student holds
is confirmed in the same transaction. A waiver that only flipped a status and
left the marks provisional would be a kindness that changed nothing: the
student would still be under 75% and still barred from the exam. Granting a
waiver *is* the department deciding the money is not owed, so it has to land
exactly where paying it would have.

**Upholding a dispute is as much a decision as correcting one.** Both write a
reason, an actor, a timestamp and an audit row. Only correcting touches
attendance, but a student whose dispute was rejected is owed the same record —
they will ask why, and "it was closed" is not an answer. This was a real bug in
the screen: the Uphold button removed the card from the browser's state and
called nothing, so a rejection left no trace anywhere.

**Correcting re-scores rather than sets a score.** `resolve_dispute` accepts the
marks — the named checkpoint, or every checkpoint of the lecture when the
student disputed the whole thing — and then calls `resolve_session_score`, the
same function the lecturer's close runs. A corrected lecture is therefore
scored by the rules every other lecture is scored by, including the 1.0 / 0.5
split for a missed second checkpoint. Writing `1.0` directly would be the
easier code and would quietly hand out a full mark for half a lecture.

The marks are upserted, not inserted, because a dispute almost always follows a
rejected submission — the row already exists and carries the rejection.

**Both scores go into the audit row.** `score_before` and `score_after`, not
just the fact of a change. Six months later, at an exam board, "the score
changed" is not defensible; "it went from 0.5 to 1.0, on this date, by this
person, for this reason" is.

## The administrator's actions

Admin is the registry side: money, the register, configuration, the audit
trail. The dividing line against the HOD is that **admin never sees an
individual student's risk** — RLS refuses them `risk_predictions` outright.
Risk is a judgement about a person, and the person reconciling payments is not
the person who should be forming it.

**Deactivation is a soft delete, and reversible.** The login stops; every row
stays. Attendance, payments and audit rows survive, because the commonest
reason to look up a withdrawn student is a dispute about the term they were
still here for. It is reversible because the commonest cause of a deactivation
is a clerical error — a screen that can only close accounts turns a mis-click
into a database task. Reactivating carries the old reason into the audit row
before clearing it, so undoing does not erase what was undone.

**Revoking a registration does two things or it does nothing useful.** The
claiming account is frozen *and* the register row is released. Freezing alone
leaves the real student unable to register, because their own matric number is
still marked claimed. It goes through `deactivate_student` rather than writing
the columns directly, so there is one code path for "how a student stops being
able to log in" and the closure is recorded under `student.deactivate`, where
anyone would look for it.

**Dismissing a registration report is a decision too.** Reason required, audit
row written. This screen used to drop the card from the browser's state and
call nothing — a rejection that left no trace, so the same student could be
asked to prove the same thing three times.

**The level rollover marks graduands before it promotes anyone.** In the other
order the 300s become 400s first and then graduate — the wrong cohort leaves,
and nobody catches it until final results. It also refuses to run twice for the
same pair of sessions, opens the new session with every continuing student
uncleared, and switches the active session inside the same transaction:
promoting everyone and then forgetting to switch leaves the department at the
right levels in the wrong year, which is harder to detect than either half
failing outright.

On top of the reason every authority action takes, the rollover asks for the
closing session's name to be typed out. A reason can be written by someone who
did not read the dialog; the name of the year they are about to close cannot.

**A rate needs a sample before it is allowed to raise an alarm.** The admin
overview's GPS-rejection banner stays silent below twenty submissions on each
side of the window. Four rejections out of six is 67% and means nothing, and a
banner that cries wolf on noise is how a real spike becomes invisible.

## Schedule changes

**The schedule is the timetable projected forward, not a list of rows.**
`timetable_entries` is a weekly pattern — a class happens every Tuesday at ten.
A `session_instances` row is one specific date that was started, cancelled or
added. Instances are created when a lecturer *starts* a lecture, so listing only
instances would show an empty schedule. The screen projects three weeks from the
pattern and lays any instance for that date over the top.

This is also why the administrator's timetable screen shows weekdays and the
lecturer's schedule shows dates. They are different objects, and letting "the
timetable" mean both is how two roles end up describing different things with
the same word.

**Cancelling writes a row rather than deleting one.** There is usually nothing
to delete — a future occurrence is only a pattern. The cancelled instance is
what removes the lecture from the student's schedule, and it is also what shows
later that the lecture was deliberately called off rather than quietly skipped.

**A lecture that was held cannot be cancelled.** It would drop out of every
enrolled student's denominator and move their percentage — including the
students who came. The function refuses it outright.

**Rescheduling is one transaction and one notification.** A lecturer could
cancel and then add a makeup, and both steps would be correct. What they would
not be is atomic: a cancellation that lands while the makeup fails leaves
students told a lecture is off with no replacement, and two notifications for
one change reads as two changes.

**Students are notified from the database, not the API.** `notify_enrolled` is
called inside `cancel_session`, `schedule_makeup` and `reschedule_session`, so
the promise the screen makes — "every enrolled student is notified straight
away" — is attached to the write itself. A caller cannot perform half of it.

**Average attendance is the average of each student's own percentage**, and each
student's denominator is the lectures held since *they* joined. A carry-over
student who joined in week eight is not marked absent for the seven weeks
before that, on the lecturer's course list any more than anywhere else.

## Password reset

The one flow where getting it wrong hands over an account. The screen that
existed before accepted the hardcoded code `123456` and then told the student
their password had changed, having written nothing.

**The phone is never taken from the form.** It is looked up from the profile
and only ever returned masked. Letting whoever knows a matric number nominate
where the code goes would make this the account-takeover path it exists to
prevent.

**A matric number with no account walks the same path and is told the same
things.** "No such student" would make this an oracle for which matric numbers
are worth attacking — and a deactivated account is reported identically, since
"that account is deactivated" is a fact about a student the person typing may
have no business knowing. The masked number is the only difference, and it only
appears when a code was genuinely sent.

**Reset codes live in their own namespace.** `purpose = 'password_reset'`, so a
registration code cannot be spent here. Without the separation, someone who
triggered a registration OTP against an unclaimed matric number could use it to
reset a real account.

**Verifying and changing are one call, not two.** A "verify" step that answers
yes and leaves the client to ask for the change is a step an attacker can skip.
The code is spent at the moment the password moves.

**Resetting clears the lockout.** A student resetting their password is very
often a student locked out by failed attempts; leaving `locked_until` in place
means the reset appears to work and the login still refuses them.

## Authorizing an eligibility list

The final authoritative output of the whole system: who may sit a paper.

**Authorizing snapshots, it does not flip a status.** Every enrolled student's
percentage is copied into `eligibility_entries` at that moment, and the screen
reads the snapshot from then on. If it recomputed, a grace period opened next
week or a dispute corrected next month would silently rewrite the list an exam
board already sat with — and "frozen" would be decoration. The existing
`eligibility_entries_frozen` trigger then refuses any edit at the database
level.

**A correction is a new list, never an edit to this one**, so the version the
board saw stays recoverable.

**A course that has held no lectures makes nobody eligible.** 0 of 0 is not a
failure to attend, but it is not a pass either; the list records them as not
eligible and the count says how many lectures it was computed from.

## Uploading the register

**The preview is the safeguard, not a courtesy.** One column out of alignment
turns every surname into a level and locks out an entire year — and the
register is what decides whether a student can create an account at all. The
diff is a step the administrator has to read before anything is written.

**A row a student has already claimed is never rewritten.** They registered
against that surname and level; changing them underneath would break the
identity the register exists to establish, and would do it silently. Those rows
are reported and left alone for the office to correct individually.

**Rows absent from an upload are never deleted.** A paste that lost its last
two hundred lines would otherwise lock those students out of registration with
no trace of what happened.

## Changing a password or a phone number while signed in

**A password change asks for the current password.** A signed-in session is not
proof of identity — a borrowed unlocked phone is exactly the case that check
exists for. This is what makes it different from a reset, which proves identity
through the phone instead.

**A phone change sends its code to the new number.** What needs proving is that
the person asking can receive messages there. Sending it to the old number
would prove only that they are already signed in, which was never in question.
The new number is refused if it is already on another account: one phone, one
account, or two students can reset each other's passwords.

## Why every helper function is SECURITY INVOKER

PostgREST publishes **every** function in `public` as an RPC, and Supabase
grants execute on them to `authenticated` by default. So
`attendance_pct(student_id, course_id)` — which takes *another student's id as
an argument* — is callable by anybody with a login.

It is safe only because it is `SECURITY INVOKER`: its internal reads run under
the caller's own row-level security, so a student asking for another student's
attendance gets 0 rather than the real figure. The function is not the guard.
RLS is.

That makes the invoker property load-bearing and easy to break by accident —
"make it definer so the HOD screen can see everyone" is a plausible change that
would silently turn it into a way to read any student's record. The schema
suite therefore asserts that **no function reachable by `authenticated` is
`SECURITY DEFINER`**, with one documented exception: `current_app_role` takes
no arguments, so it can only report the caller's own role, and it has to be
definer because the RLS policies call it and reading `profiles` to answer would
recurse through those same policies.

The suite also asserts that every authority action — clearing, waiving,
deactivating, rolling over, authorizing — is reachable by neither `anon` nor
`authenticated`. Each one goes through an API route that checks the role first.

## Knowing whether the database is up to date

Migrations are applied by hand, one file at a time, in the SQL Editor. Missing
one is the likeliest way this project breaks, and the symptom is unhelpful:
PostgREST answers a call to a function that does not exist with a generic
error that reaches the screen as "That did not go through."

`dept_flow_schema_report()` lists what is absent, so `/api/health` can name the
file to run instead of shrugging. It also reports whether pg_cron is installed
and whether the active session has a dues period — without either, nothing ever
locks, and a demo that expects a locked student silently gets none.

It is `SECURITY DEFINER` because it reads the catalog, and granted to
`service_role` alone. It takes no arguments, so there is nothing to point at
another user's data.

## The paper register

The one route into attendance with no token, no geo-fence and no device check
behind it. A lecturer transcribing a sign-in sheet can mark anybody present, so
what makes it a monitored path rather than a silent backdoor is that it leaves
a trail nobody has to remember to leave.

**The batch row is created before any score.** Every mark it writes carries
`manual_batch_id` and `source = 'manually_entered'`, so a paper mark can always
be told apart from one a student submitted. A manually-entered score with no
batch behind it would be an untraceable mark, which is the thing the table
exists to prevent — so the order is not incidental.

**It asks for twenty characters of justification, not ten.** The HOD reads this
one while deciding whether a lecturer is leaning on the paper route, and
"network" is not an account of anything.

**A paper mark is gated on dues exactly like a digital one.** A transcription
for an unpaid student stays provisional. The fallback exists for the network,
not for the money.

**Everyone in the batch must be enrolled in the course.** Without the check a
mistyped id awards attendance on a course the student never took, and it would
surface at the exam board.

**Transcribing closes the lecture**, so the digital path cannot later overwrite
the sheet.

`resolve_session_score` gained an optional score override rather than the
manual path getting its own writer: the rule deciding whether a score lands
confirmed or provisional lives in one place, and two copies of it would drift.
Adding the parameter meant dropping the old four-argument version explicitly —
a `create or replace` with a new parameter creates an overload, and every
existing two-argument call would then fail as ambiguous.

## The exam permit

The document a student carries into the hall, and the end of every path in this
system: dues cleared, attendance counted, the list authorized.

**It reads the authorized eligibility list, never live attendance.** This is
the whole design. A permit computed from current figures could disagree with
the list the exam board sat with — a student who clears their dues the week
after authorization would print a document saying they may sit a paper the
department's own record says they may not, and the system would have forged it
itself.

So a course appears on a permit only when its list is `authorized` and the
snapshot inside it marks the student eligible. Before that there is no permit —
not an empty one and not a provisional one. The department has not decided yet,
and saying otherwise on a printed document is worse than saying nothing.

**Three states, and the last two are not the same thing.** "Not authorized yet"
is the department not having decided; "not eligible" is the department having
decided against you. Collapsing them into one message leaves a student unable
to tell whether to wait or to appeal.

**One reference per student per session, allocated once.** Re-issuing on every
download would make every previously printed copy unverifiable, which is the
opposite of what a reference is for.

**Refused papers are printed on the permit, not omitted.** A student who thinks
the document covers everything and is turned away at one door has been misled
by it rather than informed.

**Verification is unauthenticated, and narrow.** An invigilator holding the
paper will not be issued an account, so `/check/permit` takes the reference and
answers with the name, the matric number and the papers. No attendance
percentages, no dues history. A permit check is not a records request, and a
hall door is not the place to disclose one. The reference is unguessable, and
whoever holds it already holds the document.

**A permit belonging to a since-deactivated account still verifies, and says
so.** The document was genuinely issued; the account is closed. Showing a
valid-looking permit with no further word would get that student admitted.

**Printed, not generated as a PDF.** Every browser prints to PDF, the output
keeps the page's own typography, and a server-side renderer would be a second
place for the numbers to come from — which is how two versions of one permit
start disagreeing.

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
