import "server-only";

import { isDemoDeployment } from "@/lib/demo";

/**
 * The one place a message leaves this system.
 *
 * Everything above this file — the risk tiers, the reminders, the digests, the
 * OTPs — decides WHAT to say and to whom. This decides how it physically goes
 * out, and it is deliberately the only place that knows.
 *
 * Three rules, all of them learned from the OTP seam that came before it:
 *
 * 1. **Development prints; production throws.** A stub that silently succeeds
 *    in production is the worst possible failure mode for a warning system:
 *    every delivery row reads `sent`, every screen says the student was told,
 *    and nobody finds out until an exam board. Failing loudly means the
 *    delivery row says `failed` and the WhatsApp→SMS fallback gets its chance.
 *
 * 2. **The caller never sees the message body come back.** Same reason the OTP
 *    code is not a return value: a body that can be returned is a body that
 *    ends up in a log, a toast, or a query string. The single exception is a
 *    demo deployment with no provider connected, where `sendOtp` hands the
 *    code back as `shown` so the screen can display it — see `src/lib/demo.ts`
 *    for why, and for the interlock that keeps it off a real launch.
 *
 * 3. **A send is an attempt, not a delivery.** `sent` here means a provider
 *    accepted it. Whether a student read it is not knowable and is never
 *    claimed.
 */

export type Channel = "whatsapp" | "sms" | "web_push";

export type SendResult =
  | { status: "sent"; providerRef: string | null }
  /**
   * `expired` marks a recipient the provider says no longer exists — a push
   * endpoint for a browser whose data was cleared. Distinct from an ordinary
   * failure because it is not worth retrying: the fix is to delete the
   * subscription, not to send again.
   */
  | { status: "failed"; error: string; expired?: boolean };

/** Whether a channel can actually deliver right now. */
export function channelIsConfigured(channel: Channel): boolean {
  switch (channel) {
    case "whatsapp":
      return Boolean(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    case "sms":
      return Boolean(process.env.SMS_API_KEY);
    case "web_push":
      return Boolean(process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY);
  }
}

/**
 * WhatsApp, through Meta's WhatsApp Cloud API.
 *
 * Nigerian students overwhelmingly have WhatsApp and it costs the department
 * little or nothing per message, which is why the policy leans on it for
 * everything short of the final warning.
 *
 * Every message this system sends is business-initiated, and Meta only
 * delivers those as a pre-approved TEMPLATE — free text is rejected outside a
 * 24-hour window the student would have to open by writing first. So a send
 * names a template and fills its placeholders; it never carries a body of its
 * own. The templates are created and approved in Meta's WhatsApp Manager
 * (docs/deploy-demo.md has the exact wording), and their names are config,
 * because a renamed template must not need a deploy.
 *
 * For a demo, Meta's free test number sends to up to five recipient numbers
 * that have been verified in the dashboard — enough for a defence, no
 * business verification needed.
 */
export async function sendWhatsApp(input: {
  to: string;
  /** Name of the approved template. */
  template: string;
  /** Ordered substitutions for the template body's {{1}}, {{2}}, … */
  variables: string[];
  /**
   * The value for an authentication template's copy-code button. Meta
   * requires it on every authentication template, and the code goes in it as
   * well as in the body.
   */
  copyCode?: string;
}): Promise<SendResult> {
  if (!channelIsConfigured("whatsapp")) {
    if (process.env.NODE_ENV === "production") {
      return {
        status: "failed",
        error: isDemoDeployment()
          ? "Demo deployment: no WhatsApp provider is connected."
          : "No WhatsApp provider is configured.",
      };
    }
    console.info(`\n  [dev WhatsApp] ${input.to} · ${input.template}(${input.variables.join(" | ")})\n`);
    return { status: "sent", providerRef: null };
  }

  const version = process.env.WHATSAPP_API_VERSION || "v23.0";
  const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const components: unknown[] = [];
  if (input.variables.length > 0) {
    components.push({
      type: "body",
      parameters: input.variables.map((text) => ({ type: "text", text: templateText(text) })),
    });
  }
  if (input.copyCode) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: input.copyCode }],
    });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Meta takes the number in international form without the plus.
        to: input.to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: input.template,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
          components,
        },
      }),
      // The dispatcher drains a batch per tick. One provider that hangs must
      // not hold every other student's warning behind it.
      signal: AbortSignal.timeout(10_000),
    });

    const body = (await response.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } }
      | null;

    if (!response.ok) {
      // Meta's own message, verbatim, onto the delivery row: "Recipient phone
      // number not in allowed list" and "Template name does not exist" are
      // the two a demo hits, and each says exactly what to fix.
      const reason = body?.error?.message ?? `HTTP ${response.status}`;
      return { status: "failed", error: `WhatsApp refused it: ${reason}` };
    }

    // Accepted by Meta, which is all `sent` has ever claimed. Delivery and
    // reads arrive later as webhooks this system does not subscribe to.
    return { status: "sent", providerRef: body?.messages?.[0]?.id ?? null };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? `WhatsApp unreachable: ${error.message}` : "WhatsApp unreachable.",
    };
  }
}

/**
 * Meta rejects a template parameter containing a newline, a tab or more than
 * four spaces in a row, and caps its length. A notification body is prose
 * written for the in-app screen, so it is flattened to one line rather than
 * refused — the in-app copy keeps its paragraphs.
 */
function templateText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 900 ? `${flat.slice(0, 899)}…` : flat;
}

/**
 * SMS — the last resort, and the only channel that needs no data connection.
 *
 * Every send costs the department money, which is why the policy reserves it
 * for the final warning and why `record_delivery_failure()` refuses to fall
 * back to it for anything else.
 */
export async function sendSms(input: { to: string; body: string }): Promise<SendResult> {
  if (!channelIsConfigured("sms")) {
    if (process.env.NODE_ENV === "production") {
      return {
        status: "failed",
        error: isDemoDeployment()
          ? "Demo deployment: no SMS provider is connected."
          : "No SMS provider is configured.",
      };
    }
    console.info(`\n  [dev SMS] ${input.to} → ${input.body}\n`);
    return { status: "sent", providerRef: null };
  }

  // Termii or Africa's Talking, whichever the department contracts with.
  return { status: "failed", error: "SMS provider is configured but not implemented." };
}

/**
 * Web Push.
 *
 * Direct in the browser on Android; on iOS the site has to be added to the
 * home screen first, which is why the PWA shell exists at all. A subscription
 * that has expired comes back as a 410 from the push service and is the signal
 * to drop it rather than to retry.
 */
export async function sendWebPush(input: {
  subscription: unknown;
  title: string;
  body: string;
  link: string | null;
  /** Groups replaceable notifications so a second warning supersedes the first. */
  tag?: string;
}): Promise<SendResult> {
  if (!channelIsConfigured("web_push")) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "No VAPID keys are configured." };
    }
    console.info(`\n  [dev push] ${input.title} — ${input.body}\n`);
    return { status: "sent", providerRef: null };
  }

  // Imported here rather than at the top of the file. `web-push` reaches for
  // Node's crypto and https modules, and this module is also read by code
  // paths that only ever call `channelIsConfigured()`.
  const webpush = (await import("web-push")).default;
  type PushSubscription = Parameters<typeof webpush.sendNotification>[0];

  webpush.setVapidDetails(
    // The contact the push service complains to when this application starts
    // sending badly. A mailto: that nobody reads is still better than the
    // service having no way to reach the department at all.
    process.env.VAPID_SUBJECT || "mailto:deptflow@example.edu.ng",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );

  try {
    await webpush.sendNotification(
      input.subscription as PushSubscription,
      JSON.stringify({
        title: input.title,
        body: input.body,
        link: input.link,
        tag: input.tag,
      }),
      // Four hours. A pre-lecture reminder delivered the next morning is worse
      // than one not delivered at all — it teaches the student that Dept-Flow
      // notifications are about things that already happened.
      { TTL: 4 * 60 * 60 },
    );

    return { status: "sent", providerRef: null };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;

    // 404 and 410 are the push service saying this browser is gone: the
    // student cleared their data, uninstalled, or revoked permission. It is
    // reported distinctly so the caller can drop the row rather than retry
    // forever against an endpoint that will never answer again.
    if (status === 404 || status === 410) {
      return { status: "failed", error: "gone", expired: true };
    }

    return {
      status: "failed",
      error: error instanceof Error ? error.message : "The push service refused it.",
    };
  }
}

/**
 * What happened to a one-time code. `shown` exists only on a demo deployment
 * with no provider for the channel: the code was not sent anywhere, and the
 * caller is to put it on the screen, labelled as a demonstration.
 */
export type OtpResult = SendResult | { status: "shown"; code: string };

/**
 * A one-time code, on whichever channel it was asked for.
 *
 * Kept here rather than in the registration module so that there is exactly
 * one place in this codebase where a plaintext code is handed to a provider —
 * registration, password reset and a phone-number change all come through it.
 */
export async function sendOtp(input: {
  to: string;
  code: string;
  channel: "sms" | "whatsapp";
}): Promise<OtpResult> {
  // A code by WhatsApp needs its own AUTHENTICATION template on top of the
  // connection itself — Meta will not carry a code in the alert template. So
  // a WhatsApp connection made for alerts alone is not one that can send
  // codes, and is treated as absent for this purpose.
  const otpTemplate = process.env.WHATSAPP_OTP_TEMPLATE;
  const canSend =
    input.channel === "sms"
      ? channelIsConfigured("sms")
      : channelIsConfigured("whatsapp") && Boolean(otpTemplate);

  if (!canSend && isDemoDeployment()) {
    return { status: "shown", code: input.code };
  }

  if (input.channel === "whatsapp") {
    if (channelIsConfigured("whatsapp") && !otpTemplate) {
      return { status: "failed", error: "No WhatsApp authentication template is configured." };
    }
    return sendWhatsApp({
      to: input.to,
      template: otpTemplate ?? "eeas_otp",
      variables: [input.code],
      copyCode: input.code,
    });
  }

  return sendSms({
    to: input.to,
    body: `${input.code} is your EEAS verification code. It expires in 10 minutes.`,
  });
}
