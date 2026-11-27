import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/client";
import { dispatchQueuedNotifications } from "@/lib/data/notifications";

/**
 * Pre-lecture reminders, and the Monday digest.
 *
 * Called every few minutes. `send_lecture_reminders()` is idempotent per slot
 * per day — it marks the slot sent before it sends anything — so calling it
 * often is the design rather than a risk, and calling it rarely is what breaks
 * it: a job that runs hourly on an hour-wide window will miss lectures.
 *
 * The digest is folded in here rather than given a schedule of its own,
 * because two schedules is two things that can fail to be scheduled. It gates
 * itself on the day and the hour instead.
 */

/** Wide enough that a student can still get up and go. */
const WINDOW_MINUTES = 60;

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET is not set, so this endpoint is closed." },
      { status: 503 },
    );
  }

  const db = createServiceClient();

  try {
    const { data: reminded, error } = await db.rpc("send_lecture_reminders", {
      p_within_minutes: WINDOW_MINUTES,
    });

    if (error) throw new Error(error.message);

    // Monday morning, Lagos time. Checked here rather than in SQL so the one
    // schedule stays "every few minutes" — the alternative is a second cron
    // entry, which is a second thing that can quietly not exist.
    const lagos = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }),
    );
    const digestDue = lagos.getDay() === 1 && lagos.getHours() === 7;

    let digested = 0;
    if (digestDue) {
      const { data, error: digestError } = await db.rpc("send_weekly_digests");
      if (digestError) throw new Error(digestError.message);
      digested = Number(data ?? 0);
    }

    // Drained in the same call: a reminder that sits in the queue until the
    // next dispatch tick is a reminder that arrives after the lecture.
    const dispatch = await dispatchQueuedNotifications(100);

    return NextResponse.json({ reminded: Number(reminded ?? 0), digested, dispatch });
  } catch (error) {
    console.error("reminder job failed", error);
    return NextResponse.json({ error: "Reminder job failed." }, { status: 503 });
  }
}
