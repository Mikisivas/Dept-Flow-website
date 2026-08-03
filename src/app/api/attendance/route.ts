import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { submitCheckpointMark } from "@/lib/data/attendance";

/**
 * A student answering a checkpoint.
 *
 * The student's identity comes from the session cookie and nowhere else — the
 * body carries no student id, so there is nothing to tamper with. Everything
 * the answer depends on (the code, the venue's fence, the lock state) is read
 * server-side.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "student") {
    return NextResponse.json({ error: "Sign in to record attendance." }, { status: 401 });
  }

  let body: {
    checkpointId?: string;
    token?: string;
    coords?: { latitude?: number; longitude?: number; accuracy?: number };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const checkpointId = String(body.checkpointId ?? "");
  const token = String(body.token ?? "");
  const { latitude, longitude, accuracy } = body.coords ?? {};

  if (!checkpointId || !/^\d{4}$/.test(token)) {
    return NextResponse.json({ error: "Enter the 4-digit code." }, { status: 400 });
  }

  // No position, no submission. Treating a missing reading as "inside the
  // fence" would make the geo-fence opt-out, which is the same as not having
  // one.
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return NextResponse.json({ rejected: "location_blocked" }, { status: 200 });
  }

  try {
    const result = await submitCheckpointMark({
      studentId: session.profileId,
      checkpointId,
      token,
      coords: { latitude, longitude, accuracy: typeof accuracy === "number" ? accuracy : 0 },
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
      { error: "We couldn't record that. Try again while you're still in the hall." },
      { status: 503 },
    );
  }
}
