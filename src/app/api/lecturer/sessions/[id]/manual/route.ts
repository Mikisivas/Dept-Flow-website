import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { createServiceClient } from "@/lib/supabase/client";

/**
 * The paper register.
 *
 * The route that bypasses every anti-proxy check, so it is the one whose
 * refusals matter most. All of them live in `submit_manual_batch`: the
 * lecturer must own the course, every student must be enrolled in it, the
 * justification must be a real account, and the batch row is created before
 * any score so no manually-entered mark can exist without one behind it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentUser();
  if (!session || session.role !== "lecturer") {
    return NextResponse.json(
      { error: "Only a lecturer can enter a paper register." },
      { status: 403 },
    );
  }

  const { id } = await params;

  let body: { justification?: string; marks?: Array<{ studentId?: string; score?: number }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const marks = (body.marks ?? [])
    .filter((mark) => Number(mark.score) > 0)
    .map((mark) => ({ student_id: String(mark.studentId ?? ""), score: Number(mark.score) }));

  if (marks.length === 0) {
    return NextResponse.json(
      { error: "Mark at least one student before submitting." },
      { status: 400 },
    );
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("submit_manual_batch", {
    p_session_instance_id: id,
    p_actor_id: session.profileId,
    p_justification: String(body.justification ?? "").trim(),
    p_marks: marks,
  });

  if (error) {
    const cleaned = error.message.replace(/^.*?:\s*/, "").trim();
    return NextResponse.json(
      { error: cleaned.charAt(0).toUpperCase() + cleaned.slice(1) },
      { status: 400 },
    );
  }

  const result = Array.isArray(data) ? data[0] : data;

  if (!result?.batch_id) {
    return NextResponse.json({ error: "That lecture no longer exists." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, recorded: result.recorded });
}
