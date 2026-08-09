import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * Freezing an eligibility list.
 *
 * The snapshot is the point — the numbers are copied at the moment of
 * authorization so a grace period or a corrected dispute next month cannot
 * retroactively change the list an exam board already sat with. All of that
 * lives in `authorize_eligibility_list`.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "hod") {
    return NextResponse.json(
      { error: "Only the head of department can authorize an eligibility list." },
      { status: 403 },
    );
  }

  let body: { courseId?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("authorize_eligibility_list", {
    p_course_id: String(body.courseId ?? ""),
    p_actor_id: session.profileId,
    p_note: String(body.note ?? "").trim(),
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  const result = Array.isArray(data) ? data[0] : data;

  // Zero on both counts is the function's way of saying it was already frozen.
  if ((result?.eligible ?? 0) === 0 && (result?.not_eligible ?? 0) === 0) {
    return NextResponse.json(
      { error: "That list is already authorized. A correction means issuing a new one." },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    eligible: result.eligible,
    notEligible: result.not_eligible,
  });
}
