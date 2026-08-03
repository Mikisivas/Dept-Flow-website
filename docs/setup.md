# Getting Dept-Flow running against your Supabase project

Two things stand between the code and a working system: the schema needs to
exist in your project, and four secrets need to be in `.env.local`. Neither
requires sharing anything with anyone.

## 1. Apply the schema

Open your project → **SQL Editor** → **New query**. Paste the whole of
[`supabase/setup.sql`](../supabase/setup.sql) and run it.

That is every migration concatenated in order. It creates 28 tables, the
attendance functions, and the row-level security policies. It needs no database
password and no service-role key.

Then, optionally, paste [`supabase/seed.sql`](../supabase/seed.sql) and run that
too. It creates the people and courses from the design mockups —
`CMP/2021/047` and the rest — all with the password `demo-password`.

The seeded timetable puts CMP 301 on Tuesdays, which is faithful and unhelpful
on a Monday. [`supabase/seed_today.sql`](../supabase/seed_today.sql) adds a slot
on whatever weekday you run it, so the lecturer's "Today's classes" has
something in it. It is safe to run repeatedly, and its trailing comments explain
how to point the geo-fence at wherever you are actually testing from.

To confirm it worked, paste
[`supabase/tests/schema_test.sql`](../supabase/tests/schema_test.sql) and run
it. It returns a grid of 96 assertions — one row each, in plain English — then
rolls back, changing nothing. A failure aborts with the assertion that broke.

The SQL Editor may warn that a transaction is already in progress. That is
harmless; the file opens its own so it can roll back cleanly under psql too.

## 2. Fill in `.env.local`

Copy `.env.example` to `.env.local`. The public values are already filled in
for you. Three secrets are not, and each has one place it comes from:

| Variable | Where |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → Project API keys → `service_role` |
| `SUPABASE_JWT_SECRET` | Settings → API → JWT Settings → JWT Secret |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → Settings → API Keys → Test Secret Key |

There is no Paystack **public** key to fill in either. Dept-Flow uses the
redirect flow — the server initialises the transaction and sends the student to
Paystack's own page — rather than the inline popup, and the public key exists
only for the popup. On a phone on a poor connection a full page beats loading a
third-party script into an iframe.

There is no separate session secret to generate. The login token is signed with
`SUPABASE_JWT_SECRET` — signing with the project's own secret is what lets
Supabase accept a token we minted, so `auth.uid()` resolves and every RLS policy
applies to a login that never involved an email address.

**None of these belong in a chat window, a screenshot, or a commit.** The
service-role key bypasses row-level security completely — anything holding it
can read and write every student's record. `.env.local` is gitignored.

## 3. Run it

```bash
npm install
npm run dev
```

Log in at `/login` with `CMP/2021/047` and `demo-password`.

If you are testing on a phone against your laptop's dev server, set
`NEXT_PUBLIC_SITE_URL` to the LAN address Next prints (`http://10.x.x.x:3000`).
Paystack uses it to send the student back after checkout, so pointing it at
`localhost` would land them on their own phone's loopback.

## Testing a payment

Paystack test mode takes the card `4084 0840 8408 4081`, any future expiry, CVV
`408`, and PIN `0000` / OTP `123456` when it asks.

Paystack cannot deliver a webhook to a laptop, so in development the student's
return from checkout is what settles the payment — `/dues/result` verifies the
reference against Paystack on load and clears the student. That is not a
workaround: a bank transfer settles asynchronously and the student frequently
gets back before the webhook does, so both paths have to work in production too.

Point the webhook at a deployed URL only. It is at `/api/payments/webhook` and
rejects any body whose `x-paystack-signature` does not verify.

## How login works, given there is no email

Supabase Auth is not used — see [`decisions.md`](decisions.md). Instead:

1. You submit a matric number and a password to `/api/auth/login`.
2. The server resolves the identifier to an account, compares the password
   against an Argon2id digest, and mints a JWT signed with your project's
   `SUPABASE_JWT_SECRET`.
3. That token carries `sub` = `profiles.id` and `role: authenticated` — exactly
   what `auth.uid()` reads inside every RLS policy. Supabase accepts it because
   it is signed with the project secret, and every policy written against
   `auth.uid()` works unchanged.
4. It travels in an httpOnly cookie. The browser never sees the digest, the
   lookup, or the service-role key.

A wrong password and an unregistered matric number return the same message and
take the same time to do it — matric numbers are sequential and guessable, so
distinguishing them would turn the login form into a way to enumerate the
register.

## What is not wired yet

The screens still read from `src/lib/data/queries.ts`, which resolves fixtures.
Login is the first path connected end to end. Reads move to Supabase and writes
to FastAPI next.
