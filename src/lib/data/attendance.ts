import "server-only";

import { createServiceClient } from "@/lib/supabase/client";
import type { CheckpointOutcome, LiveCheckpoint, SubmitRejection } from "@/lib/types";

/**
 * The attendance path, server side.
 *
 * Two things here are deliberate and load-bearing:
 *
 * 1. The token never reaches the student's browser. Students have no read
 *    policy on `checkpoints` at all, and this module — which does hold the
 *    service role — returns every field of a live code *except* the code
 *    itself. Being in the hall to read it off the board is the point, and
 *    since the geo-fence was removed it is the ONLY point: there is no second
 *    check behind it to catch a code read out over the phone.
 *
 * 2. Nothing is reported to the student until the row is written. The decision
 *    is made here, persisted here, and only then returned.
 */

/**
 * `mark_reject_reason` is the governance record and is deliberately coarser
 * than the message on screen: a student who mistypes and a student whose code
 * lapsed are the same event to the HOD, but need different instructions in the
 * hall.
 */
const STORED_REASON: Record<SubmitRejection, string> = {
  invalid_or_expired_token: "invalid_or_expired_token",
  wrong_code: "invalid_or_expired_token",
  not_registered: "not_registered",
  account_locked: "account_locked",
  already_submitted: "already_submitted",
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * The code this student can answer right now, if any.
 *
 * Scoped by enrolment, so a student cannot see — let alone submit to — a code
 * for a course they do not take.
 */
export async function loadLiveCheckpoint(studentId: string): Promise<LiveCheckpoint | null> {
  const db = createServiceClient();

  const { data: enrolments } = await db
    .from("enrolments")
    .select("course_id")
    .eq("student_id", studentId)
    .is("dropped_at", null);

  const courseIds = (enrolments ?? []).map((row) => row.course_id);
  if (courseIds.length === 0) return null;

  const { data: open } = await db
    .from("session_instances")
    .select("id, course_id, courses(code, title, profiles:lecturer_id(surname, first_name)), venues(name)")
    .in("course_id", courseIds)
    .eq("status", "open");

  if (!open || open.length === 0) return null;

  const { data: checkpoints } = await db
    .from("checkpoints")
    .select("id, session_instance_id, expires_at")
    .in(
      "session_instance_id",
      open.map((row) => row.id),
    )
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: false })
    .limit(1);

  const checkpoint = checkpoints?.[0];
  if (!checkpoint) return null;

  const instance = open.find((row) => row.id === checkpoint.session_instance_id);
  if (!instance) return null;

  const course = one(
    instance.courses as unknown as {
      code: string;
      title: string;
      profiles: { surname: string; first_name: string } | null;
    },
  );
  const lecturer = one(course?.profiles);

  return {
    sessionInstanceId: instance.id,
    checkpointId: checkpoint.id,
    courseCode: course?.code ?? "",
    courseTitle: course?.title ?? "",
    lecturer: lecturer ? `${lecturer.first_name} ${lecturer.surname}` : "",
    venue: one(instance.venues as unknown as { name: string })?.name ?? "",
    expiresAt: checkpoint.expires_at,
  };
}

export type SubmitResult =
  | { outcome: "accepted"; result: CheckpointOutcome }
  | { outcome: "rejected"; reason: SubmitRejection };

/**
 * Record a submission and return the server's decision.
 *
 * Checks run in the order that produces the most useful instruction: whether
 * this student may record attendance on this course at all, then the account,
 * then the code. A student who never confirmed their semester registration is
 * told that, rather than being sent back to the board to retype a code that
 * was never going to be accepted.
 */
export async function submitCheckpointMark(input: {
  studentId: string;
  checkpointId: string;
  token: string;
  /**
   * When the student actually pressed submit. Supplied by the offline queue,
   * which may be replaying something recorded before the tab lost the network;
   * absent for a live submission, which is simply now.
   */
  submittedAt?: string;
}): Promise<SubmitResult> {
  const db = createServiceClient();

  const { data: checkpoint } = await db
    .from("checkpoints")
    .select("id, token, expires_at, session_instance_id, session_instances(id, course_id, status)")
    .eq("id", input.checkpointId)
    .maybeSingle();

  if (!checkpoint) return { outcome: "rejected", reason: "invalid_or_expired_token" };

  const instance = one(
    checkpoint.session_instances as unknown as {
      id: string;
      course_id: string;
      status: string;
    },
  );
  if (!instance) return { outcome: "rejected", reason: "invalid_or_expired_token" };

  // Whether this student may record attendance on this course at all —
  // enrolment, account status, the registration deadline and the HOD's
  // exception, decided in one place in the database rather than reassembled
  // here. `attendance_eligibility` returns the reason, and its values are the
  // same vocabulary the screen has copy for.
  const { data: eligibility } = await db.rpc("attendance_eligibility", {
    p_student_id: input.studentId,
    p_course_id: instance.course_id,
  });

  const gate = typeof eligibility === "string" ? eligibility : "not_registered";

  // An accepted mark is final. A rejected one is not — a student who mistyped
  // must be able to try again inside the window, which is why the write below
  // updates rather than inserts a second row.
  const { data: existing } = await db
    .from("attendance_marks")
    .select("id, accepted")
    .eq("student_id", input.studentId)
    .eq("checkpoint_id", checkpoint.id)
    .maybeSingle();

  if (existing?.accepted) return { outcome: "rejected", reason: "already_submitted" };

  const reason = decide();

  const row = {
    student_id: input.studentId,
    checkpoint_id: checkpoint.id,
    accepted: reason === null,
    reject_reason: reason === null ? null : STORED_REASON[reason],
    submitted_at: input.submittedAt ?? new Date().toISOString(),
  };

  const { error } = await db
    .from("attendance_marks")
    .upsert(row, { onConflict: "student_id,checkpoint_id" });

  // The student is told nothing until the row is written. A failure here is a
  // failure to record attendance, and it has to read like one.
  if (error) throw new Error(`Could not record the submission: ${error.message}`);

  if (reason !== null) return { outcome: "rejected", reason };

  return { outcome: "accepted", result: { sessionScore: 1 } };

  function decide(): SubmitRejection | null {
    // The gate first, because it produces the most useful instruction. A
    // student who never confirmed their registration is told that, rather than
    // being sent back to the board to retype a code that was never going to be
    // accepted.
    if (gate === "not_registered") return "not_registered";
    if (gate === "account_locked") return "account_locked";

    if (instance!.status !== "open") return "invalid_or_expired_token";

    // Judged against the server's clock and the stored expiry, never against
    // the client's. A replayed offline submission carries its original
    // timestamp for the record, but it does not get to reopen a lapsed code.
    if (Date.parse(checkpoint!.expires_at) <= Date.now()) return "invalid_or_expired_token";
    if (input.token.trim() !== checkpoint!.token) return "wrong_code";

    return null;
  }
}
