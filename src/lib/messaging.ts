import "server-only";

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
 *    code was never a return value: a body that can be returned is a body that
 *    ends up in a log, a toast, or a query string.
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
 * WhatsApp Business API.
 *
 * Nigerian students overwhelmingly have WhatsApp and it costs the department
 * nothing per message, which is why the policy leans on it for everything
 * short of the final warning. Business-initiated messages outside a 24-hour
 * window must use a pre-approved template — that is a real operational
 * constraint, not a detail, and a send that ignores it is rejected by Meta
 * rather than delivered late.
 */
export async function sendWhatsApp(input: {
  to: string;
  /** Name of the approved template. Required outside the 24-hour window. */
  template: string;
  /** Ordered substitutions for the template's placeholders. */
  variables: string[];
}): Promise<SendResult> {
  if (!channelIsConfigured("whatsapp")) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "No WhatsApp provider is configured." };
    }
    console.info(`\n  [dev WhatsApp] ${input.to} · ${input.template}(${input.variables.join(" | ")})\n`);
    return { status: "sent", providerRef: null };
  }

  // The real call goes here. Left unwritten rather than guessed: the request
  // shape depends on which number the department registers with Meta, and a
  // plausible-looking call to an endpoint nobody has tested is worse than an
  // honest gap, because it looks finished.
  return { status: "failed", error: "WhatsApp provider is configured but not implemented." };
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
      return { status: "failed", error: "No SMS provider is configured." };
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
 * A one-time code, on whichever channel it was asked for.
 *
 * Kept here rather than in the registration module so that there is exactly
 * one place in this codebase where a plaintext code is handed to a provider.
 */
export async function sendOtp(input: {
  to: string;
  code: string;
  channel: "sms" | "whatsapp";
}): Promise<SendResult> {
  if (input.channel === "whatsapp") {
    return sendWhatsApp({
      to: input.to,
      template: "dept_flow_otp",
      variables: [input.code],
    });
  }

  return sendSms({
    to: input.to,
    body: `${input.code} is your Dept-Flow verification code. It expires in 10 minutes.`,
  });
}
