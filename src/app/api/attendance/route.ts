import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { submitCheckpointMark } from "@/lib/data/attendance";

/**
 * A student answering the attendance code.
 *
 * The student's identity comes from the session cookie and nowhere else — the
 * body carries no student id, so there is nothing to tamper with. Everything
 * the answer depends on (the code, the registration, the lock state) is read
 * server-side.
 *
 * There is no longer a position in the body. Attendance is trust-based: the
 * code on the board is the whole mechanism, and a request that carried
 * coordinates would be recording something the system has undertaken not to
 * keep.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Sign in to record attendance." }, { status: 401 });
  }

  let body: { checkpointId?: string; token?: string; submittedAt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const checkpointId = String(body.checkpointId ?? "");
  const token = String(body.token ?? "");

  if (!checkpointId || !/^\d{4}$/.test(token)) {
    return NextResponse.json({ error: "Enter the 4-digit code." }, { status: 400 });
  }

  // A queued submission replayed on reconnect says when it was actually made.
  // Accepted as a record of the attempt, never as a reason to accept a lapsed
  // code — that judgement stays on the server's clock.
  const submittedAt = parseReplayTimestamp(body.submittedAt);

  try {
    const result = await submitCheckpointMark({
      studentId: session.profileId,
      checkpointId,
      token,
      submittedAt,
    });

    if (result.outcome === "rejected") {
      // 200, not 4xx: the server understood the request and reached a decision.
      // The client distinguishes a decision from a failure, and only the second
      // one is worth retrying.
      return NextResponse.json({ rejected: result.reason });
    }

    return NextResponse.json({ recorded: result.result });
  } catch {
    // Nothing was written, so nothing may be reported as recorded.
    return NextResponse.json(
      { error: "We couldn't record that. Try again while the code is still up." },
      { status: 503 },
    );
  }
}

/**
 * A replayed timestamp is only believed when it is a real time in the recent
 * past. A future one, or one from last week, is a client whose clock cannot be
 * trusted; the submission still stands, it is simply stamped on arrival.
 */
function parseReplayTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;

  const now = Date.now();
  const sixHours = 6 * 60 * 60 * 1000;
  if (when > now || when < now - sixHours) return undefined;

  return new Date(when).toISOString();
}
