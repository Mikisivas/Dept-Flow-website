import { NextResponse } from "next/server";
import { markNotificationsRead } from "@/lib/data/student";

/**
 * Marking every notification read.
 *
 * Runs under the student's own token rather than the service role, so
 * `notifications_self_update` is what scopes it. Going around the policy with
 * the service key would leave it untested — and would make a student able to
 * mark someone else's read the day an id parameter is added.
 */
export async function POST() {
  try {
    const marked = await markNotificationsRead();
    return NextResponse.json({ ok: true, marked });
  } catch {
    return NextResponse.json({ error: "Could not update your notifications." }, { status: 400 });
  }
}
