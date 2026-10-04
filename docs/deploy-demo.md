# Deploying the demo for the defence

A deployment for the panel, not for a cohort: seeded data, Paystack in test
mode, and verification codes shown on screen because no SMS provider is
connected. Every page says so in a banner. For a real launch, see
`docs/setup.md` and connect an SMS provider instead.

Allow an afternoon the first time. Do it at least a week before the defence,
then re-seed a day or two before (step 7).

---

## 1. A Supabase project of its own

Create a **new** project at [supabase.com](https://supabase.com/dashboard) for
the demo — don't reuse your development one. The seed only runs on an empty
project, and re-seeding before the defence (step 7) means starting fresh.
Region: the one nearest Nigeria (currently Europe West / London or Frankfurt).

Then, in that project:

1. **SQL Editor → New query →** paste the whole of `supabase/setup.sql` → Run.
2. **New query →** paste `supabase/seed.sql` → Run.
3. **New query →** paste `supabase/seed_today.sql` → Run. This puts a CMP 301
   lecture on today's weekday, so the attendance path has something to open.
4. **Database → Extensions →** enable `pg_cron` and `pg_net`.

From **Settings → API**, copy the project URL, the `anon` key, the
`service_role` key and the JWT secret. Keep them out of chat, screenshots and
commits.

## 2. Paystack, in test mode

In the [Paystack dashboard](https://dashboard.paystack.com), with the toggle on
**Test Mode**, copy the **test secret key** (`sk_test_…`). Demo mode will not
switch on next to a live key — that is deliberate.

The webhook URL is set in step 5, once the site has an address.

## 3. Web Push keys

```bash
npx web-push generate-vapid-keys
```

Keep both keys. Push works on Android in Chrome directly; on iPhone the site
has to be added to the home screen first.

## 4. Deploy to Vercel

1. Sign in at [vercel.com](https://vercel.com) with GitHub and **Add New →
   Project →** import `Dept-Flow-website`.
2. **The work is on `claude/supervisor-adjustments-c8e5ac`, not `main`.**
   Either merge it into `main` first, or after importing go to **Settings →
   Git → Production Branch** and set it to that branch.
3. **Environment Variables** — add each of these:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | the demo project's URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | its `anon` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | its `service_role` key |
   | `SUPABASE_JWT_SECRET` | its JWT secret |
   | `PAYSTACK_SECRET_KEY` | the `sk_test_…` key |
   | `CRON_SECRET` | any long random string |
   | `VAPID_PUBLIC_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the public key, in both |
   | `VAPID_PRIVATE_KEY` | the private key |
   | `VAPID_SUBJECT` | `mailto:` and an address you read |
   | `DEMO_DEPLOYMENT` | `true` |
   | `NEXT_PUBLIC_SITE_URL` | leave for now — step 5 |

   Leave `SMS_API_KEY` and the WhatsApp variables **unset**. That is what makes
   the codes appear on screen.
4. **Deploy.** Note the address it gives you, e.g. `https://eeas-demo.vercel.app`.

## 5. Point everything at the address

1. Vercel → **Settings → Environment Variables →** set `NEXT_PUBLIC_SITE_URL`
   to that address, then **Deployments → ⋯ → Redeploy**. It is baked in at
   build time, and the permit's QR code and Paystack's return trip both use
   it — left unset they point at `localhost`, which on a scanning phone is the
   phone itself.
2. Paystack (Test Mode) → **Settings → API Keys & Webhooks → Test Webhook URL**:
   `https://<your address>/api/payments/webhook`.

## 6. The schedules

In the Supabase SQL Editor, the five jobs from `docs/setup.md` §"Scheduling",
with `<your site>` and `<CRON_SECRET>` filled in. The one that matters most is
the forecast — without it nobody is ever warned:

```sql
select cron.schedule('dept-flow-compliance', '0 1 * * *',
  $$select advance_compliance_states()$$);

select cron.schedule('dept-flow-reminders', '*/5 * * * *',
  $$select send_lecture_reminders(60)$$);

select cron.schedule('dept-flow-forecast', '30 1 * * *',
  $$select compute_risk_predictions(); select send_risk_alerts();$$);

select cron.schedule('dept-flow-dispatch', '* * * * *',
  $$select net.http_post(
      url := 'https://<your address>/api/cron/notifications',
      headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'))$$);

select cron.schedule('dept-flow-reconcile', '*/2 * * * *',
  $$select net.http_post(
      url := 'https://<your address>/api/cron/reconcile',
      headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'))$$);
```

Then run the forecast once now rather than waiting for tonight:

```sql
select compute_risk_predictions(); select send_risk_alerts();
```

## 7. Re-seed a day or two before the defence

The seed is written relative to the day it runs: the term is always mid-way,
with lectures still to come. Seeded a month early, the lectures it scheduled
as "upcoming" are in the past and the numbers in `docs/demo.md` drift.

So, a day or two before: create a fresh Supabase project again (or delete and
recreate the demo one), repeat step 1 and step 6, and update the three
Supabase variables in Vercel if the project changed, then redeploy.

## 8. Rehearse, on a phone, on mobile data

Open `https://<your address>/api/health` first. Everything should be green: no
missing migrations, Paystack answering, pg_cron installed.

Then the walkthrough in `docs/demo.md`, plus the three things it cannot show
from a laptop:

- **Registration.** `STA/2022/091`, surname **Bassey**, level **300** is the
  one seeded student without an account. The code appears in a dashed
  "Demonstration deployment" box under the code field. To register more people
  live, log in as admin and add rows to the register first.
- **A test payment.** Card `4084 0840 8408 4081`, any future expiry, CVV `408`,
  PIN `0000`, OTP `123456`.
- **The permit's QR code.** Scan it with a second phone; it should open
  `/check/permit` on your address, not `localhost`.

Logins for every role are in `docs/demo.md`; all use `demo-password`.

## What to say if the panel asks

- **"The code was on the screen — isn't that insecure?"** On this deployment,
  yes, deliberately, and the banner says so. The code exists to prove a
  student holds the phone; with no SMS provider connected there is nothing to
  prove it with. The system refuses to show codes next to a live Paystack key,
  and in production with no SMS provider it refuses to register anyone rather
  than pretend. Connecting a provider is one function in `src/lib/messaging.ts`.
- **"Did that alert go to WhatsApp?"** No. The delivery record says "failed —
  Demo deployment: no WhatsApp provider is connected", which is the honest
  answer. The in-app notification and Web Push are real.
