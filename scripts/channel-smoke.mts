/**
 * Live smoke test for one outbound channel.
 *
 * Usage:
 *
 * npm run smoke -- push
 *
 * npm run smoke -- push --profile <profile_id>
 *
 * npm run smoke -- whatsapp --to +2348012345678
 *
 * npm run smoke -- sms --to +2348012345678
 */

import { createClient } from "@supabase/supabase-js";

import {
  channelIsConfigured,
  sendSms,
  sendWebPush,
  sendWhatsApp,
} from "../src/lib/messaging.ts";

const [channel, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);

  return i >= 0 ? rest[i + 1] : undefined;
}

function die(message: string): never {
  console.error(`\n  ${message}\n`);

  process.exit(1);
}

function report(result: {
  status: string;
  error?: string;
  providerRef?: string | null;
  expired?: boolean;
}) {
  if (result.status === "sent") {
    console.log(
      `\n  ACCEPTED by the provider${
        result.providerRef ? ` (ref ${result.providerRef})` : ""
      }.`,
    );

    console.log(
      "  'Accepted' is not 'delivered': confirm it arrived on the handset.\n",
    );

    return 0;
  }

  console.log(
    `\n  FAILED: ${result.error}${
      result.expired ? "  [subscription expired]" : ""
    }\n`,
  );

  return 1;
}

async function main(): Promise<number> {
  if (
    process.env.DEMO_DEPLOYMENT === "true" &&
    process.env.NODE_ENV === "production"
  ) {
    console.log("  Note: demo deployment flag is set; this script ignores it.");
  }

  // WEB PUSH TEST

  if (channel === "push") {
    if (!channelIsConfigured("web_push")) {
      die(
        "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not both set. Nothing was sent.",
      );
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      die("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
    }

    const db = createClient(url, key, {
      auth: {
        persistSession: false,
      },
    });

    let query = db
      .from("push_subscriptions")
      .select(
        "id, profile_id, endpoint, subscription, user_agent, last_used_at",
      )
      .order("last_used_at", {
        ascending: false,
        nullsFirst: false,
      });

    const profile = flag("profile");

    if (profile) {
      query = query.eq("profile_id", profile);
    }

    const { data, error } = await query.limit(1);

    if (error) {
      die(`Could not read push_subscriptions: ${error.message}`);
    }

    const row = data?.[0];

    if (!row) {
      die(
        "No stored subscription. Open /notifications in a browser and switch notifications on first.",
      );
    }

    console.log(
      `  Sending to ${new URL(row.endpoint).host} (profile ${row.profile_id})`,
    );

    const result = await sendWebPush({
      subscription: row.subscription,
      title: "EEAS smoke test",
      body: "If you can read this, Web Push works end to end.",
      link: "/notifications",
      tag: "smoke-test",
    });

    if (result.status === "failed" && result.expired) {
      if (rest.includes("--prune")) {
        await db.from("push_subscriptions").delete().eq("id", row.id);

        console.log(
          "  Expired subscription deleted. Re-subscribe from /notifications.",
        );
      } else {
        console.log(
          "  The push service says this browser is gone. Re-run with --prune to delete the row, then re-subscribe.",
        );
      }
    }

    return report(result);
  }

  // WHATSAPP TEST

  if (channel === "whatsapp") {
    if (!channelIsConfigured("whatsapp")) {
      die(
        "WHATSAPP_API_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not set. Nothing was sent.",
      );
    }

    const to = flag("to");

    if (!to) {
      die(
        "Give a number: --to +2348012345678 (must be a verified test recipient in Meta).",
      );
    }

    const template =
      flag("template") ?? process.env.WHATSAPP_ALERT_TEMPLATE ?? "eeas_alert";

    const isDefaultNamedAlert = template === "eeas_alert";

    return report(
      await sendWhatsApp({
        to,

        template,

        variables:
          template === "hello_world"
            ? []
            : [
                "Smoke test",
                "If you can read this, WhatsApp works end to end.",
              ],

        parameterNames: isDefaultNamedAlert
          ? ["alert_title", "alert_detail"]
          : undefined,
      }),
    );
  }

  // SMS TEST

  if (channel === "sms") {
    if (!channelIsConfigured("sms")) {
      die("SMS_API_KEY is not set. Nothing was sent.");
    }

    const to = flag("to");

    if (!to) {
      die("Give a number: --to +2348012345678");
    }

    return report(
      await sendSms({
        to,

        body: "EEAS smoke test: if you can read this, SMS works.",
      }),
    );
  }

  die(
    "Usage: npm run smoke -- <push|whatsapp|sms> [--profile id] [--to +234...] [--template name] [--prune]",
  );
}

process.exit(await main());
