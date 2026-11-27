import { NextResponse } from "next/server";
import { dispatchQueuedNotifications } from "@/lib/data/notifications";

/**
 * Draining the notification queue.
 *
 * Separate from the writing of a notification on purpose: `queue_notification()`
 * runs inside whatever transaction produced the event — a lecture cancelled, a
 * forecast crossing a tier — and a provider call in there would hold that
 * transaction open for as long as the provider felt like taking.
 *
 * Called by pg_cron every minute, or by a platform scheduler. Guarded by the
 * same shared secret the compliance job uses: an unauthenticated endpoint that
 * sends WhatsApp messages is an unauthenticated endpoint that spends money.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  // No secret configured is a refusal in production. Leaving it open would be
  // a way to make the department pay for somebody else's traffic.
  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET is not set, so this endpoint is closed." },
      { status: 503 },
    );
  }

  try {
    const summary = await dispatchQueuedNotifications();
    return NextResponse.json(summary);
  } catch (error) {
    console.error("notification dispatch failed", error);
    return NextResponse.json({ error: "Dispatch failed." }, { status: 503 });
  }
}
