import "server-only";

import { createServiceClient } from "@/lib/supabase/client";

import {
  sendSms,
  sendWebPush,
  sendWhatsApp,
  type SendResult,
} from "@/lib/messaging";

import { ok } from "@/lib/supabase/result";

export type DispatchSummary = {
  attempted: number;
  sent: number;
  failed: number;
  fellBack: number;
};

const BATCH = 25;

type QueuedDelivery = {
  id: string;

  channel: "in_app" | "web_push" | "whatsapp" | "sms";

  destination: string | null;

  notifications: {
    recipient_id: string;
    title: string;
    body: string;
    link: string | null;
    kind: string;
  } | null;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;

  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function dispatchQueuedNotifications(
  limit = BATCH,
): Promise<DispatchSummary> {
  const db = createServiceClient();

  const { data: queued } = ok(
    await db
      .from("notification_deliveries")
      .select(
        "id, channel, destination, notifications(recipient_id, title, body, link, kind)",
      )
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(limit),

    "queued",
  );

  const rows = (queued ?? []) as unknown as QueuedDelivery[];

  const summary: DispatchSummary = {
    attempted: 0,
    sent: 0,
    failed: 0,
    fellBack: 0,
  };

  for (const row of rows) {
    const notification = one(row.notifications);

    if (!notification) continue;

    summary.attempted += 1;

    const result = await deliver(row, notification);

    if (result.status === "sent") {
      ok(
        await db
          .from("notification_deliveries")
          .update({
            status: "sent",
            attempted_at: new Date().toISOString(),
            provider_ref: result.providerRef,
          })
          .eq("id", row.id),

        "marking the delivery sent",
      );

      summary.sent += 1;

      continue;
    }

    const { data: outcome } = ok(
      await db.rpc("record_delivery_failure", {
        p_delivery_id: row.id,
        p_error: result.error,
      }),

      "outcome",
    );

    summary.failed += 1;

    if (outcome === "fell_back_to_sms") {
      summary.fellBack += 1;
    }
  }

  return summary;

  async function deliver(
    row: QueuedDelivery,

    notification: QueuedDelivery["notifications"] & object,
  ): Promise<SendResult> {
    switch (row.channel) {
      // WHATSAPP

      case "whatsapp": {
        if (!row.destination) {
          return {
            status: "failed",
            error: "No WhatsApp number on file.",
          };
        }

        const template = process.env.WHATSAPP_ALERT_TEMPLATE || "eeas_alert";

        return sendWhatsApp({
          to: row.destination,

          template,

          variables: [notification.title, notification.body],

          parameterNames:
            template === "eeas_alert"
              ? ["alert_title", "alert_detail"]
              : undefined,
        });
      }

      // SMS

      case "sms": {
        if (!row.destination) {
          return {
            status: "failed",
            error: "No phone number on file.",
          };
        }

        return sendSms({
          to: row.destination,

          body: truncateForSms(notification.body),
        });
      }

      // WEB PUSH

      case "web_push": {
        const { data: subscriptions } = ok(
          await db
            .from("push_subscriptions")
            .select("id, subscription")
            .eq("profile_id", notification.recipient_id),

          "subscriptions",
        );

        if (!subscriptions?.length) {
          return {
            status: "failed",
            error: "No push subscription on any device.",
          };
        }

        const results = await Promise.all(
          subscriptions.map(async (row) => ({
            id: row.id,

            result: await sendWebPush({
              subscription: row.subscription,

              title: notification.title,

              body: notification.body,

              link: notification.link,

              tag: notification.kind,
            }),
          })),
        );

        const gone = results
          .filter(
            (entry) => entry.result.status === "failed" && entry.result.expired,
          )
          .map((entry) => entry.id);

        if (gone.length > 0) {
          await db.from("push_subscriptions").delete().in("id", gone);
        }

        const delivered = results.find(
          (entry) => entry.result.status === "sent",
        );

        if (delivered) {
          return delivered.result;
        }

        if (gone.length === results.length) {
          return {
            status: "failed",
            error: "No push subscription on any device.",
          };
        }

        return (
          results[0]?.result ?? {
            status: "failed",
            error: "No push subscription on any device.",
          }
        );
      }

      // IN-APP

      case "in_app": {
        return {
          status: "sent",
          providerRef: null,
        };
      }
    }
  }
}

/**
 * Limit SMS to one segment where possible.
 */
function truncateForSms(body: string): string {
  const limit = 160;

  if (body.length <= limit) {
    return body;
  }

  return `${body.slice(0, limit - 1).trimEnd()}…`;
}
