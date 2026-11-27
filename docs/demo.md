# Demo walkthrough

Every number below was produced by running these steps against a fresh
`supabase/setup.sql` + `supabase/seed.sql`. If yours differ, something is out
of step — open `/api/health` first, which names any migration that has not been
run.

The seed is written relative to `current_date`, so the session is always
mid-term and there are always lectures still to come. A forecast of a term that
has already ended is not a forecast.

Every seeded account logs in with **`demo-password`**.

| Role | Identifier |
|---|---|
| Student — attending, then stopped | `CMP/2021/047` (Chidera Okonkwo) |
| Student — paid, but far behind | `CMP/2021/112` (Halima Sanusi) |
| Student — exactly on the line | `MTH/2022/018` (Tunde Adeyemi) |
| Lecturer | `STF/CMP/014` (Dr Amina Bello) |
| HOD | `STF/CMP/001` (Dr Nnamdi Eze) |
| Admin | `STF/ADM/007` (Ibrahim Yusuf) |

Two browsers, or one plus a private window. Roles are separate sessions, and
logging in as the lecturer in the same browser signs the student out.

Before you start: run `select compute_risk_predictions(); select
send_risk_alerts();` in the SQL editor. Both are nightly pg_cron jobs, and the
walkthrough is about what they produce.

---

## 1. The argument, in one screen

Log in as **Chidera** (`CMP/2021/047`).

Her CMP 301 attendance reads **76.92%** — above the line, comfortably. A
scoreboard stops there and tells her she is fine.

Underneath it, the forecast reads **66.5%, Critical**.

That gap is the entire product. She attended ten lectures straight and then
missed the last three, and a percentage cannot tell those two facts apart from
a student who missed three at the start and has been perfect since. The strip
shows the shape; the forecast says where the shape is going.

Her notification, verbatim from the seed:

> **CMP 301: you are on course to miss the 75% mark**
> CMP 301 is projected to finish at 66.5%. Attend 13 of the 17 lectures left
> and you reach 75%. You can miss 4.

Read that aloud and note what it does not say. Not "your attendance is low" —
a student cannot act on that. It names the course, the number of lectures, and
how much room is left.

**Drag the what-if slider.** "What if I miss the next two?" is answered by the
server, using the same arithmetic that decides permits, so the answer a student
explores and the answer that bars them from a hall can never disagree.

Now scroll to **MTH 205**, a 200-level course she is carrying and has never
attended:

> **MTH 205: 75% is no longer reachable**
> MTH 205 is projected to finish at 0.0%. Even attending all 17 remaining
> lectures finishes below 75%. Attendance alone cannot fix this now — speak to
> the department office about a dispute.

This is the message worth pausing on. The system could have told her to attend
everything and reach 75%, and it would have been a lie she could not detect —
she would have done exactly that for eleven weeks and found out at the permit
screen. There is a schema test whose only job is to keep that sentence out.

---

## 2. Escalation, one rung at a time

Still as Chidera, then in the SQL editor:

```sql
select d.channel, d.status, count(*)
from notification_deliveries d
join notifications n on n.id = d.notification_id
where n.kind = 'attendance_warning'
group by 1, 2;
```

Four warnings went out to three students. In-app: 4. Web Push: 4. WhatsApp: 3.
SMS: 2.

The ladder is deliberate and it is about scarcity, not technology. Watch gets
in-app and push. Critical adds WhatsApp, which costs the department nothing.
SMS is spent only where there is nothing left to escalate to — a student who
gets a text in week six has nothing louder waiting in week eleven.

**Turn on notifications** from `/notifications`. It asks the browser once, from
behind a button, next to a sentence saying what will arrive: a permission
prompt fired on page load gets denied, and a denied prompt cannot be asked
again.

---

## 3. A lecture, start to finish

Log in as **Dr Bello** (`STF/CMP/014`).

Her dashboard lists today's classes from the timetable. **Start session**, then
**issue the code** — four digits, valid for a few minutes.

In the student's browser, `/attend`, enter it. One code, one submission. No
location, no second checkpoint, nothing to calculate a distance from. Attendance
is trust-based now, and the code on the board is the whole mechanism.

The screen does not say "Recorded" until the server has said so. Prove it:
switch the phone to airplane mode and submit. It reads

> **Waiting for a connection — you are not recorded yet**

with the instruction to leave the tab open. Turn the network back on and it
sends itself, carrying the timestamp from the moment the student pressed
Submit rather than the moment the signal returned. A code answered in the hall
and delivered from the car park is a record of the hall.

**End session**, and `resolve_session_score()` scores everyone: present or
absent, 1 or 0. There are no half marks any more, because there is no second
checkpoint to be half of.

---

## 4. What gates attendance now

Log in as the **admin** → **Configuration**, and look at the registration
window. Past its deadline, a student who has not confirmed their semester
registration cannot record attendance at all — `attendance_eligibility()`
returns `not_registered` and the code screen says so.

Confirming late does not quietly forgive the gap. `confirm_registration()`
stamps `registered_at` on the server and **backfills an absence for every
lecture held between the deadline and the moment they confirmed**. A student
who registers in week six has six weeks of absences, because that is what
happened.

The HOD can grant an individual exception where a student has a real reason —
under **Exceptions**, with a reason and an audit row.

---

## 5. Payment, which gates nothing here

Log back in as **Chidera**. She owes **₦5,000** and has paid nothing.

Her attendance still counts. Every one of those ten CMP 301 lectures is
counted, her percentage is 76.92%, and her forecast runs on the same numbers as
everybody else's. This is the change from the original design: dues used to
decide whether a lecture counted at all.

**Pay ₦5,000** → Paystack test card `4084 0840 8408 4081`, any future expiry,
CVV `408`, PIN `0000`, OTP `123456`. Nothing about her attendance moves,
because there is nothing for it to move.

Pay half instead, from a second account, and watch the balance run down rather
than the payment being refused for not matching. Instalments are how students
actually pay.

---

## 6. Where dues and attendance meet: the permit

`/permit`, as **Chidera**. She has not paid, and the seed ships no authorized
eligibility list, so the first thing she sees is the live panel and

> **Not issued yet** — your permit becomes available once the Head of
> Department authorizes the eligibility list for your courses.

That is the department not having decided, which is a different thing from
having decided against her, and the screen never collapses the two.

**Authorize the list.** As the HOD (`STF/CMP/001`) → **Eligibility** → CMP 301
→ **Authorize list**. Come back as Chidera and the headline changes:

> Your attendance clears you — your dues do not.

The department has cleared her for the paper she is above the line in, and the
permit prints once the ₦5,000 outstanding is paid. Both conditions, and the
screen says which one is missing.

Above it — and above every one of those states, including this one — the live
panel says exactly what is outstanding, per course:

| | |
|---|---|
| Dues | ₦5,000 outstanding |
| CMP 301 · 76.92% | above the 75% line |
| MTH 205 · 0.00% | attending all 17 remaining lectures still finishes below 75% |

Now look at **Halima** (`CMP/2021/112`), who has paid in full and is on
**38.46%** in CMP 301. She has the opposite half of the problem, and her panel
says so: dues clear, one course out of reach. Two students, two different
things missing, and neither of them is shown a flat "not eligible".

Once a permit issues, it carries a **QR code** to `/check/permit`. The QR is
not what makes it hard to forge — anyone can generate a QR. What makes it hard
is that it carries a reference the database has to recognise, and the page it
opens reads the record from the server rather than from the paper: edit a name
on a screenshot and the code still opens the real record, under the real name.
The reference is printed beside it in full, because a check that only works
with a working camera fails at the one door it was built for.

---

## 7. The HOD's afternoon

Log in as the **HOD** (`STF/CMP/001`).

**At-risk students** is sorted by severity and every row is a link. "Chidera is
projected at 66.5% in CMP 301" is where a conversation starts, not where it
ends — the drill-through shows whether she stopped coming in week four or has
been at half marks all term, which are the same number on the list and
completely different meetings.

Each row also carries the number that makes the meeting useful: **13 of the 17
remaining**. Not a percentage the student already knew.

**Message students** — one student, a whole level, or everyone currently
registered for a course. The audience count is fetched from the server before
you send, because "message 412 students" is a different decision from "message
12". Messages go out on the same channels as the warnings, with the same
delivery record, and never on SMS: an HOD who could spend the SMS budget on a
routine notice would eventually spend it, and then the final attendance warning
arrives on a channel nobody reads.

**Payment compliance** exists *because* payment was decoupled. Dues used to be
readable off the attendance screens as a side effect of gating them; they gate
nothing now, so the department's money would be invisible unless there were
somewhere to look. Three columns rather than paid/unpaid — a student who has
paid half is not a student who has not paid.

**Eligibility** → pick a course → **Authorize list**, which you did in §6. The
list freezes with the HOD's name and a timestamp and every percentage is copied
as it stands. Prove
it afterwards: change another student's attendance on that course and their
live percentage moves while the authorized list does not. A board that has sat
must not be rewritten by next week's grace period, and the database refuses the
edit rather than trusting the screen to hide the button.

---

## 8. Governance

Log in as the **admin** (`STF/ADM/007`).

- **Audit log** — every decision above is here, with actor, reason and
  timestamp. Append-only, enforced by a trigger.
- **Students** — deactivate one and their login stops immediately; their
  attendance and payment history is kept and their matric number stays retired.
  It is reversible.
- **Register** — paste a CSV. Nothing is written until the diff is shown: how
  many new, changed, already claimed. Rows a student has already registered
  against are never rewritten, and rows absent from the paste are never
  deleted.
- **No individual risk data.** The admin has no at-risk list, no forecast and
  no student record. That is not a hidden menu item — `risk_predictions` is
  readable by the student it concerns and the HOD, and by nobody else. Ask to
  see it as the admin and the row is simply not there.

---

## What is not built

Say so rather than being asked.

- **A trained model.** The advisory signal is computed — half a student's
  recent attendance, half their whole term, carried forward per course — rather
  than fitted. Say why if asked: the department has one session of history, and
  a classifier trained on three students has memorised them rather than learned
  anything. The rule also has the property a first-deployment model could not:
  a student flagged by it can be told exactly why. `risk_predictions` is the
  seam, and swapping the writer changes no reader.
- **WhatsApp and SMS delivery.** Both seams report failure in production rather
  than pretending to have sent. In development they print to the server
  terminal. The queue, the fallback and the delivery record around them are
  real and tested — what is missing is one HTTP call per provider, which
  depends on which number the department registers with Meta.
- **Deployment.**

Web Push **is** wired end to end. It needs only VAPID keys —
`npx web-push generate-vapid-keys`.

## Three things to set up first

- **pg_cron.** Without it the forecast never refreshes, no warnings go out, and
  no lecture reminder fires — which is most of the system. `/api/health`
  reports whether the extension is installed. Run
  `compute_risk_predictions()`, `send_risk_alerts()` and
  `send_lecture_reminders()` by hand for the walkthrough.
- **`NEXT_PUBLIC_SITE_URL`.** Paystack sends the student back here after
  checkout, and the permit's QR code is built from it. Left unset it defaults
  to `localhost:3000`, which lands a phone on its own loopback.
- **VAPID keys**, if you want to demonstrate a notification arriving with the
  site closed. Without them the push channel reports failure and the escalation
  falls through to WhatsApp, which is the correct behaviour and a duller demo.
