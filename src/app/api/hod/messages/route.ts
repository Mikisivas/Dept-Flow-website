import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/current-user";
import { messageAudience, sendHodMessage, type MessageScope } from "@/lib/data/hod";
import { createServiceClient } from "@/lib/supabase/client";
import { dispatchQueuedNotifications } from "@/lib/data/notifications";

/**
 * The HOD messaging students.
 *
 * An authority action: one call can reach every phone in the department. Every
 * rule about that — who may send, what counts as a message, the audit row — is
 * enforced inside `send_hod_message()` rather than here. This route decides who
 * is allowed to call it and turns a matric number into a student id.
 */
export async function POST(request: Request) {
  const session = await currentUser();
  if (!session || session.role !== "hod") {
    return NextResponse.json({ error: "Only the HOD can message students." }, { status: 403 });
  }

  let body: {
    action?: string;
    scope?: string;
    matricNo?: string;
    courseId?: string;
    level?: number;
    programme?: string;
    subject?: string;
    body?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const scope: MessageScope =
    body.scope === "level"
      ? "level"
      : body.scope === "course"
        ? "course"
        : body.scope === "programme_level"
          ? "programme_level"
          : "student";

  const db = createServiceClient();

  // A matric number is what the HOD typed; a student id is what the function
  // needs. Resolved here, and a number that names nobody is said so plainly —
  // a message silently sent to no one is worse than an error.
  let target: string | null = null;
  if (scope === "student") {
    const matricNo = String(body.matricNo ?? "").trim().toUpperCase();
    const { data: student } = await db
      .from("students")
      .select("id")
      .eq("matric_no", matricNo)
      .maybeSingle();

    if (!student) {
      return NextResponse.json(
        { error: `No student is registered under ${matricNo || "that matric number"}.` },
        { status: 404 },
      );
    }
    target = student.id;
  }

  if (scope === "course") {
    target = String(body.courseId ?? "");
    if (!target) return NextResponse.json({ error: "Which course?" }, { status: 400 });
  }

  // Both level-bearing scopes carry one, and the check is the same for each:
  // the database refuses a level-scoped row with no level, and answering that
  // refusal with a Postgres error is worse than asking the question here.
  const level = scope === "level" || scope === "programme_level" ? Number(body.level) : null;
  if (level !== null && ![100, 200, 300, 400].includes(level)) {
    return NextResponse.json({ error: "Which level?" }, { status: 400 });
  }

  // MTH, CMP or STA. CSC is the one that gets typed, and it names no programme
  // in this department — said plainly rather than sent to an audience of nobody.
  const programme = scope === "programme_level" ? String(body.programme ?? "").trim().toUpperCase() : null;
  if (scope === "programme_level" && !["MTH", "CMP", "STA"].includes(programme ?? "")) {
    return NextResponse.json(
      {
        error:
          programme === "CSC"
            ? "Computer Science is CMP in this department, not CSC."
            : "Which programme? Choose Mathematics, Computer Science or Statistics.",
      },
      { status: 400 },
    );
  }

  // The confirmation asks how many phones this reaches before it reaches them.
  // "Message 412 students" is a different decision from "message 12", and the
  // HOD should be making the one they think they are making.
  if (body.action === "audience") {
    return NextResponse.json({ recipients: await messageAudience(scope, target, level, programme) });
  }

  try {
    const result = await sendHodMessage({
      actorId: session.profileId,
      scope,
      target,
      level,
      programme,
      subject: String(body.subject ?? ""),
      body: String(body.body ?? ""),
    });

    // Drained now rather than on the next scheduled tick. An HOD who has just
    // told four hundred students that a lecture moved should not be waiting on
    // a cron job for it to leave the building.
    await dispatchQueuedNotifications(200);

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "That didn't send.";
    return NextResponse.json({ error: readable(message) }, { status: 400 });
  }
}

/** The database raises in plain English; this strips Postgres's prefix. */
function readable(message: string): string {
  const cleaned = message.replace(/^.*?:\s*/, "").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
