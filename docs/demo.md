# Demo walkthrough

Every number below was produced by running these steps against a fresh
`supabase/setup.sql` + `supabase/seed.sql`. If yours differ, something is out
of step — open `/api/health` first, which names any migration that has not been
run.

Every seeded account logs in with **`demo-password`**.

| Role | Identifier |
|---|---|
| Student — attended but has not paid | `CMP/2021/047` (Chidera Okonkwo) |
| Student — paid | `CMP/2021/112` (Halima Sanusi) |
| Student — locked | `MTH/2022/018` (Tunde Adeyemi) |
| Lecturer | `STF/CMP/014` (Dr Amina Bello) |
| HOD | `STF/CMP/001` (Dr Nnamdi Eze) |
| Admin | `STF/ADM/007` (Ibrahim Yusuf) |

Two browsers, or one plus a private window. Roles are separate sessions, and
logging in as the lecturer in the same browser signs the student out.

---

## 1. The argument, in one screen

Log in as **Chidera** (`CMP/2021/047`).

Her dashboard reads **0%**. She has attended ten of thirteen lectures in
CMP 301 and every one of them is recorded — the checkpoint strip shows them.
None of them count, because she has not paid her dues.

This is the whole thesis in one number, and it is worth pausing on: the system
is not withholding a record, it is withholding *credit* for one. The strip
shows what she did; the meter shows what it is worth to her.

**Pay ₦5,000** → Paystack test card `4084 0840 8408 4081`, any future expiry,
CVV `408`, PIN `0000`, OTP `123456`.

Come back and the same ten sessions now read **76.92%**. Nothing was added.
Thirteen provisional scores were confirmed in one transaction, and she crossed
the 75% line without attending anything further.

---

## 2. A lecture, start to finish

Log in as **Dr Bello** (`STF/CMP/014`).

Her dashboard lists today's classes from the timetable. **Start session** on
one, then **issue the first checkpoint** — a four-digit code appears, valid for
five minutes (`app_config.checkpoint_token_ttl_seconds`).

In the student's browser, `/attend`, enter the code. It is submitted with the
phone's position and checked against the venue's geo-fence. The screen does not
say "Recorded" until the server has said so.

Issue the second checkpoint, submit it, then **End session**. Everyone present
for both is scored 1.0; one checkpoint only is 0.5; neither is 0. Marks land
provisional for anyone who has not paid.

Coordinates are never displayed, and the student never sees the code before the
lecturer issues it — students have no read access to `checkpoints` at all.

---

## 3. A dispute, corrected

Log in as the **HOD** (`STF/CMP/001`) → **Disputes**.

Halima says she was in the hall for the lecture of 28 October but was marked
outside. Her score for it is **0.5**.

**Correct** it, with a reason. Her score becomes **1.0**, and the audit row
records `score_before: 0.5, score_after: 1.0` — not merely that something
changed. Six months later at an exam board, "it changed" is not an answer.

**Uphold the rejection** is equally a decision: it also takes a reason and also
writes a row. A student told no is owed the same record as one told yes.

---

## 4. A waiver, granted

Still as the HOD → **Waivers**.

Tunde is **locked**: day 30 passed, he never paid, and the payment portal is
shut to him as well as attendance recording. His counted attendance is
**0.00%** — though he holds 4.5 marks across six lectures.

Grant his waiver. He becomes **cleared at exactly 75.00%**.

That is the point to make aloud: the waiver did not change his attendance by
one lecture. It changed whether the attendance counted, and that was the
difference between not sitting the paper and sitting it.

---

## 5. Freezing the eligibility list

HOD → **Eligibility** → pick a course → **Authorize list**.

The list freezes with the HOD's name and a timestamp, and every percentage is
**copied as it stands**. Prove it afterwards: clear another student on that
course and their live percentage moves while the authorized list does not.

That is what freezing is for. A grace period opened next week must not
retroactively rewrite the list a board already sat with, and the database
refuses any edit to the entries rather than trusting the screen to hide the
buttons.

---

## 6. Governance

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
- **Registration disputes** — revoking frees the matric number *and* freezes
  the claiming account, because the real student cannot register while their
  own number is marked claimed.

---

## What is not built

Say so rather than being asked.

- **The scikit-learn advisory model.** The schema and screens carry it as
  advisory only, and the projection is hidden rather than invented — the
  eligibility determination has never been allowed to consult it.
- **SMS delivery.** The OTP seam throws in production; in development the code
  is printed to the server terminal. Registration and password reset are
  otherwise complete.
- **Deployment.**

## Two things to set up first

- **pg_cron.** Without it nothing advances the compliance ladder on a schedule,
  so no student ever locks on their own. The seed has one locked student by
  hand, which is enough for the walkthrough. `/api/health` reports whether the
  extension is installed; the migration comment in
  `20260728001600_compliance_schedule.sql` has the `cron.schedule` call.
- **`NEXT_PUBLIC_SITE_URL`.** Paystack sends the student back here after
  checkout. Left unset it defaults to `localhost:3000`, which lands a phone on
  its own loopback.
