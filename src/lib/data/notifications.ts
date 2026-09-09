import "server-only";

import { createServiceClient } from "@/lib/supabase/client";
import { sendSms, sendWebPush, sendWhatsApp, type SendResult } from "@/lib/messaging";
import { ok } from "@/lib/supabase/result";

/**
 * Draining the delivery queue.
 *
 * `queue_notification()` writes the in-app copy and one queued row per allowed
 * channel, and stops there — a provider call inside a database transaction
 * holds it open for as long as the provider feels like taking. This is the
 * other half: it picks up queued rows, calls the provider, and records what
 * happened.
 *
 * The WhatsApp→SMS fallback is NOT decided here. `record_delivery_failure()`
 * owns it, because the rule has a condition the sender should not be
 * re-deriving — a failed lecture reminder must not spend an SMS the department
 * chose not to spend on reminders. The sender reports the failure; the
 * database decides what it costs.
 */

export type DispatchSummary = { attempted: number; sent: number; failed: number; fellBack: number };

/** Bounded: a request that drains the queue must not become an unbounded job. */
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

export async function dispatchQueuedNotifications(limit = BATCH): Promise<DispatchSummary> {
  const db = createServiceClient();

  const { data: queued } = ok(await db
    .from("notification_deliveries")
    .select("id, channel, destination, notifications(recipient_id, title, body, link, kind)")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit), "queued");

  const rows = (queued ?? []) as unknown as QueuedDelivery[];
  const summary: DispatchSummary = { attempted: 0, sent: 0, failed: 0, fellBack: 0 };

  for (const row of rows) {
    const notification = one(row.notifications);
    if (!notification) continue;

    summary.attempted += 1;
    const result = await deliver(row, notification);

    if (result.status === "sent") {
      // Checked, because this row is the only record that it went. Discarded, a
      // refusal leaves the delivery queued, the next tick sends it again, and
      // the student's phone repeats the same warning until somebody notices.
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

    // Through the function, never as a plain update: the fallback fires from
    // here, and a sender that wrote `status = 'failed'` itself would silently
    // skip it.
    const { data: outcome } = ok(await db.rpc("record_delivery_failure", {
      p_delivery_id: row.id,
      p_error: result.error,
    }), "outcome");

    summary.failed += 1;
    if (outcome === "fell_back_to_sms") summary.fellBack += 1;
  }

  return summary;

  async function deliver(
    row: QueuedDelivery,
    notification: QueuedDelivery["notifications"] & object,
  ): Promise<SendResult> {
    switch (row.channel) {
      case "whatsapp":
        if (!row.destination) return { status: "failed", error: "No WhatsApp number on file." };
        return sendWhatsApp({
          to: row.destination,
          template: "dept_flow_alert",
          variables: [notification.title, notification.body],
        });

      case "sms":
        if (!row.destination) return { status: "failed", error: "No phone number on file." };
        // One message, not two: an SMS that runs to a second part costs twice
        // and arrives out of order often enough to matter.
        return sendSms({ to: row.destination, body: truncateForSms(notification.body) });

      case "web_push": {
        // Every browser the student has subscribed from, because reaching them
        // on the device they are holding is the whole value of the channel.
        // One row's destination could not express that, which is why push is
        // the one channel whose address is not on the delivery row.
        const { data: subscriptions } = ok(await db
          .from("push_subscriptions")
          .select("id, subscription")
          .eq("profile_id", notification.recipient_id), "subscriptions");

        if (!subscriptions?.length) {
          return { status: "failed", error: "No push subscription on any device." };
        }

        const results = await Promise.all(
          subscriptions.map(async (row) => ({
            id: row.id,
            result: await sendWebPush({
              subscription: row.subscription,
              title: notification.title,
              body: notification.body,
              link: notification.link,
              // The notification's kind, so a second attendance warning
              // REPLACES the first in the tray rather than stacking beside it.
              // Four identical warnings is how a student learns to swipe them
              // all away without reading one.
              tag: notification.kind,
            }),
          })),
        );

        // A push service answering 404 or 410 is telling us this browser is
        // gone — data cleared, permission revoked, app uninstalled. Deleted
        // rather than retried forever: an endpoint that will never answer
        // again makes every future push for this student look like a failure,
        // and a failure is what escalates to SMS.
        const gone = results
          .filter((entry) => entry.result.status === "failed" && entry.result.expired)
          .map((entry) => entry.id);

        if (gone.length > 0) {
          await db.from("push_subscriptions").delete().in("id", gone);
        }

        // One device reached is a delivered notification. Reporting failure
        // because a stale laptop subscription rejected it would spend an SMS
        // on a student whose phone already buzzed.
        const delivered = results.find((entry) => entry.result.status === "sent");
        if (delivered) return delivered.result;

        // Every subscription was stale, which is the same situation as having
        // none: the student has no working browser to push to, and the
        // fallback should treat it that way.
        if (gone.length === results.length) {
          return { status: "failed", error: "No push subscription on any device." };
        }

        return results[0]?.result ?? { status: "failed", error: "No push subscription on any device." };
      }

      case "in_app":
        // Queued in-app rows should not exist — queue_notification() writes
        // them as already sent, because the notifications row IS the delivery.
        // Reaching here means something inserted one by hand.
        return { status: "sent", providerRef: null };
    }
  }
}

/**
 * 160 GSM-7 characters is one SMS segment. Going over does not fail, it
 * silently costs another message per recipient, which on a department-wide
 * send is real money.
 */
function truncateForSms(body: string): string {
  const limit = 160;
  if (body.length <= limit) return body;
  return `${body.slice(0, limit - 1).trimEnd()}…`;
}
