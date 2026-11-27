import "server-only";

import { isDemoDeployment } from "@/lib/demo";

export type Channel = "whatsapp" | "sms" | "web_push";

export type SendResult =
  | { status: "sent"; providerRef: string | null }
  | { status: "failed"; error: string; expired?: boolean };

export function channelIsConfigured(channel: Channel): boolean {
  switch (channel) {
    case "whatsapp":
      return Boolean(
        process.env.WHATSAPP_API_TOKEN &&
        process.env.WHATSAPP_PHONE_NUMBER_ID,
      );

    case "sms":
      return Boolean(process.env.SMS_API_KEY);

    case "web_push":
      return Boolean(
        process.env.VAPID_PRIVATE_KEY &&
        process.env.VAPID_PUBLIC_KEY,
      );
  }
}

/**
 * WhatsApp Cloud API.
 *
 * Supports both named and positional template parameters.
 */
export async function sendWhatsApp(input: {
  to: string;
  template: string;
  variables: string[];
  parameterNames?: string[];
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

    console.info(
      `\n  [dev WhatsApp] ${input.to} · ${input.template}(${input.variables.join(" | ")})\n`,
    );

    return { status: "sent", providerRef: null };
  }

  const version = process.env.WHATSAPP_API_VERSION || "v23.0";

  const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  if (
    input.parameterNames &&
    input.parameterNames.length !== input.variables.length
  ) {
    return {
      status: "failed",
      error: "WhatsApp parameter names and values do not match.",
    };
  }

  const components: unknown[] = [];

  if (input.variables.length > 0) {
    components.push({
      type: "body",
      parameters: input.variables.map((text, index) => ({
        type: "text",
        text: templateText(text),
        ...(input.parameterNames?.[index]
          ? { parameter_name: input.parameterNames[index] }
          : {}),
      })),
    });
  }

  if (input.copyCode) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [
        {
          type: "text",
          text: input.copyCode,
        },
      ],
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

        to: input.to.replace(/^\+/, ""),

        type: "template",

        template: {
          name: input.template,

          language: {
            code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
          },

          components,
        },
      }),

      signal: AbortSignal.timeout(10_000),
    });

    const body = (await response.json().catch(() => null)) as {
      messages?: Array<{ id?: string }>;

      error?: {
        message?: string;
        code?: number;
        error_subcode?: number;

        error_data?: {
          details?: string;
        };

        fbtrace_id?: string;
      };
    } | null;

    if (!response.ok) {
      const metaError = body?.error;

      const reason = [
        metaError?.message,

        metaError?.error_data?.details,

        metaError?.error_subcode
          ? `Subcode: ${metaError.error_subcode}`
          : null,

        metaError?.fbtrace_id
          ? `Trace ID: ${metaError.fbtrace_id}`
          : null,
      ]
        .filter(Boolean)
        .join(" | ");

      return {
        status: "failed",

        error: `WhatsApp refused it: ${
          reason || `HTTP ${response.status}`
        }`,
      };
    }

    return {
      status: "sent",
      providerRef: body?.messages?.[0]?.id ?? null,
    };
  } catch (error) {
    return {
      status: "failed",

      error:
        error instanceof Error
          ? `WhatsApp unreachable: ${error.message}`
          : "WhatsApp unreachable.",
    };
  }
}

/**
 * Flatten WhatsApp template variables.
 */
function templateText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > 900
    ? `${flat.slice(0, 899)}…`
    : flat;
}

/**
 * SMS through Africa's Talking.
 */
export async function sendSms(input: {
  to: string;
  body: string;
}): Promise<SendResult> {
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

  const username = process.env.SMS_USERNAME;

  if (!username) {
    return {
      status: "failed",
      error: "SMS_USERNAME is not set.",
    };
  }

  const sandbox = process.env.SMS_SANDBOX === "true";

  const host = sandbox
    ? "api.sandbox.africastalking.com"
    : "api.africastalking.com";

  const form = new URLSearchParams({
    username,
    to: input.to,
    message: input.body,
  });

  if (process.env.SMS_SENDER_ID) {
    form.set("from", process.env.SMS_SENDER_ID);
  }

  try {
    const response = await fetch(
      `https://${host}/version1/messaging`,
      {
        method: "POST",

        headers: {
          apiKey: process.env.SMS_API_KEY!,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },

        body: form,

        signal: AbortSignal.timeout(10_000),
      },
    );

    const body = (await response.json().catch(() => null)) as {
      SMSMessageData?: {
        Recipients?: Array<{
          status?: string;
          statusCode?: number;
          messageId?: string;
        }>;
      };
    } | null;

    if (!response.ok) {
      return {
        status: "failed",
        error: `SMS refused it: HTTP ${response.status}`,
      };
    }

    const recipient = body?.SMSMessageData?.Recipients?.[0];

    if (
      !recipient ||
      ![100, 101, 102].includes(recipient.statusCode ?? -1)
    ) {
      return {
        status: "failed",

        error: `SMS refused it: ${
          recipient?.status ?? "no recipient returned"
        }`,
      };
    }

    return {
      status: "sent",
      providerRef: recipient.messageId ?? null,
    };
  } catch (error) {
    return {
      status: "failed",

      error:
        error instanceof Error
          ? `SMS unreachable: ${error.message}`
          : "SMS unreachable.",
    };
  }
}

/**
 * Web Push.
 */
export async function sendWebPush(input: {
  subscription: unknown;
  title: string;
  body: string;
  link: string | null;
  tag?: string;
}): Promise<SendResult> {
  if (!channelIsConfigured("web_push")) {
    if (process.env.NODE_ENV === "production") {
      return {
        status: "failed",
        error: "No VAPID keys are configured.",
      };
    }

    console.info(
      `\n  [dev push] ${input.title} — ${input.body}\n`,
    );

    return { status: "sent", providerRef: null };
  }

  const webpush = (await import("web-push")).default;

  type PushSubscription = Parameters<
    typeof webpush.sendNotification
  >[0];

  webpush.setVapidDetails(
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

      {
        TTL: 4 * 60 * 60,
      },
    );

    return {
      status: "sent",
      providerRef: null,
    };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;

    if (status === 404 || status === 410) {
      return {
        status: "failed",
        error: "gone",
        expired: true,
      };
    }

    return {
      status: "failed",

      error:
        error instanceof Error
          ? error.message
          : "The push service refused it.",
    };
  }
}

/**
 * OTP result.
 */
export type OtpResult =
  | SendResult
  | { status: "shown"; code: string };

/**
 * Send OTP through SMS or WhatsApp.
 */
export async function sendOtp(input: {
  to: string;
  code: string;
  channel: "sms" | "whatsapp";
}): Promise<OtpResult> {
  const otpTemplate = process.env.WHATSAPP_OTP_TEMPLATE;

  const canSend =
    input.channel === "sms"
      ? channelIsConfigured("sms")
      : channelIsConfigured("whatsapp") &&
        Boolean(otpTemplate);

  if (!canSend && isDemoDeployment()) {
    return {
      status: "shown",
      code: input.code,
    };
  }

  if (input.channel === "whatsapp") {
    if (channelIsConfigured("whatsapp") && !otpTemplate) {
      return {
        status: "failed",
        error: "No WhatsApp authentication template is configured.",
      };
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