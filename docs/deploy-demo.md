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

## 3b. WhatsApp alerts (optional, and worth it)

The most convincing moment in a demo is a warning arriving on a real phone in
the room. Meta's WhatsApp Cloud API gives every new app a free **test number**
that can message up to five phone numbers you verify — no business
verification, no SIM.

1. At [developers.facebook.com](https://developers.facebook.com) → **My Apps →
   Create App →** type **Business** → add the **WhatsApp** product.
2. **WhatsApp → API Setup.** Note the **Phone number ID** of the test number,
   and the version in the sample request URL (`…graph.facebook.com/v23.0/…`).
3. Under **To**, add the phone you will hold at the defence and confirm the code
   WhatsApp sends it. Up to five numbers.
4. **WhatsApp Manager → Message templates → Create template.** Category
   **Utility**, name **`eeas_alert`**, language **English**, body:

   > Examination-Eligibility Alert System, RMOAU. {{1}}: {{2}} Open the app for the details.

   Sample values when Meta asks: `CMP 301: you are on course to miss the 75% mark`
   and `CMP 301 is projected to finish at 66.5%. Attend 13 of the 17 lectures left and you reach 75%.`
   Submit; utility templates are usually approved within minutes to hours.
   (The body cannot start or end with a placeholder, which is why the fixed
   words are there.)
5. **A token.** The one on the API Setup page lasts 24 hours — fine if you make
   it on the morning of the defence. For a token that lasts, use **Business
   Settings → Users → System users → Add**, assign the app and the WhatsApp
   account, and **Generate token** with `whatsapp_business_messaging`.
6. Point a seeded student at your phone, in the Supabase SQL Editor (your
   number in `+234…` form):

   ```sql
   update profiles set whatsapp_phone = '+2348012345678', whatsapp_verified_at = now()
    where id = (select id from students where matric_no = 'CMP/2021/047');
   ```

   Only messages queued *after* this go to the new number.

Then add the WhatsApp variables in step 4. Codes still appear on screen: a
code by WhatsApp needs a separate *authentication* template, and the demo does
not need one.

To show it: log in as the **HOD → Messages**, send a message to Chidera alone,
and it arrives on the phone within a minute (the dispatch job runs every
minute). The forecast's warning for her goes the same way after
`select compute_risk_predictions(); select send_risk_alerts();`.

If nothing arrives, the reason is on the delivery row, in Meta's words:

```sql
select channel, status, error, attempted_at from notification_deliveries
 where channel = 'whatsapp' order by created_at desc limit 5;
```

"Recipient phone number not in allowed list" means step 3; "Template name does
not exist" means step 4 is not approved yet.

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
   | `WHATSAPP_API_TOKEN` | the token from 3b, if you did 3b |
   | `WHATSAPP_PHONE_NUMBER_ID` | the test number's Phone number ID |
   | `WHATSAPP_API_VERSION` | the version from the sample request, e.g. `v23.0` |
   | `NEXT_PUBLIC_SITE_URL` | leave for now — step 5 |

   Leave `SMS_API_KEY` and `WHATSAPP_OTP_TEMPLATE` **unset**. That is what
   makes the codes appear on screen.
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
  "Demonstration deployment" box under the code field. For more, see
  "Adding students for the demo" below.
- **A test payment.** Card `4084 0840 8408 4081`, any future expiry, CVV `408`,
  PIN `0000`, OTP `123456`.
- **The permit's QR code.** Scan it with a second phone; it should open
  `/check/permit` on your address, not `localhost`.

Logins for every role are in `docs/demo.md`; all use `demo-password`.

## Adding students for the demo

The admin does not create student accounts — nobody does but the student.
The admin puts students on the **register**, the department's list of who may
sign up, and each student then creates their own account on their phone. That
is the flow worth showing: it is how a real cohort would join.

1. Log in as the admin (`STF/ADM/007`, `demo-password`) → **Register** →
   **Upload register**.
2. Paste one row per student, `matric_no, surname, level`:

   ```
   CMP/2022/101, Agbo, 300
   CMP/2022/102, Terver, 300
   MTH/2022/103, Ochoche, 300
   ```

   - Matric numbers must start `CMP/`, `MTH/` or `STA/` — the database refuses
     anything else, including `CSC/`.
   - Use level **300**. Registration enrols each student in their level's core
     courses, and the seed's 300-level core course is CMP 301, which has a
     term of lectures and today's slot. A level with no seeded core course
     gives an account with nothing on its dashboard.
3. **Preview changes**, check the counts, then **Save N rows**. Nothing is
   written before the save.
4. On each student's phone: **Create account** → matric number, surname,
   level → full name and a phone number → the code appears on screen → choose
   a password.

Two rules that catch people at a rehearsal:

- **One phone number, one account.** Two students cannot register with the
  same number, so each person needs their own. Seeded students already use
  `+2348050000001` to `…003` and `+2348051111111`.
- **Five codes per number per hour.** Practise with one number and it can run
  out; the next hour it is back.

New students start with no attendance, so their forecast appears only after
five lectures. For the forecast itself, show the seeded students — Chidera's is
the one the walkthrough in `docs/demo.md` is built around.

## What to say if the panel asks

- **"The code was on the screen — isn't that insecure?"** On this deployment,
  yes, deliberately, and the banner says so. The code exists to prove a
  student holds the phone; with no SMS provider connected there is nothing to
  prove it with. The system refuses to show codes next to a live Paystack key,
  and in production with no SMS provider it refuses to register anyone rather
  than pretend. Connecting a provider is one function in `src/lib/messaging.ts`.
- **"Did that alert really go to WhatsApp?"** If you did 3b, yes — through
  Meta's Cloud API from its test number, and the delivery row carries Meta's
  message id. A real launch swaps the test number for the department's own
  registered number; no code changes. Without 3b, the row says "failed — Demo
  deployment: no WhatsApp provider is connected", which is the honest answer.
- **"And SMS?"** Not connected. It is reserved for the Critical tier because it
  costs money per message; connecting a provider (Termii, Africa's Talking) is
  one function in `src/lib/messaging.ts`.
