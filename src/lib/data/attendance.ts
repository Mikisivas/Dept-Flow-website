import "server-only";

import { createServiceClient } from "@/lib/supabase/client";
import { distanceMetres, withinFence } from "@/lib/geo";
import type { CheckpointOutcome, LiveCheckpoint, SubmitRejection } from "@/lib/types";

/**
 * The attendance path, server side.
 *
 * Two things here are deliberate and load-bearing:
 *
 * 1. The token never reaches the student's browser. Students have no read
 *    policy on `checkpoints` at all, and this module — which does hold the
 *    service role — returns every field of a live checkpoint *except* the code.
 *    Being in the hall to read it off the board is the point.
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
const STORED_REASON: Record<Exclude<SubmitRejection, "location_blocked">, string> = {
  outside_geofence: "outside_geofence",
  invalid_or_expired_token: "invalid_or_expired_token",
  wrong_code: "invalid_or_expired_token",
  account_locked: "account_locked",
  already_submitted: "already_submitted",
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * The checkpoint this student can answer right now, if any.
 *
 * Scoped by enrolment, so a student cannot see — let alone submit to — a
 * checkpoint in a course they do not take.
 */
export async function loadLiveCheckpoint(studentId: string): Promise<LiveCheckpoint | null> {
  const db = createServiceClient();

  const { data: enrolments } = await db
    .from("enrolments")
    .select("course_id")
    .eq("student_id", studentId);

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
    .select("id, session_instance_id, index, expires_at")
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

  // Whether checkpoint 1 is already banked changes the sentence the student
  // reads, so it is read rather than guessed.
  const { data: earlier } = await db
    .from("attendance_marks")
    .select("id, checkpoints!inner(session_instance_id, index)")
    .eq("student_id", studentId)
    .eq("accepted", true)
    .eq("checkpoints.session_instance_id", instance.id)
    .eq("checkpoints.index", 1);

  return {
    sessionInstanceId: instance.id,
    checkpointId: checkpoint.id,
    courseCode: course?.code ?? "",
    courseTitle: course?.title ?? "",
    lecturer: lecturer ? `${lecturer.first_name} ${lecturer.surname}` : "",
    venue: one(instance.venues as unknown as { name: string })?.name ?? "",
    index: checkpoint.index as 1 | 2,
    expiresAt: checkpoint.expires_at,
    firstCheckpointCaptured: (earlier ?? []).length > 0,
  };
}

export type SubmitResult =
  | { outcome: "accepted"; result: CheckpointOutcome }
  | { outcome: "rejected"; reason: SubmitRejection };

/**
 * Record a checkpoint submission and return the server's decision.
 *
 * Checks run in the order the spec fixes them: identity and lock state first,
 * then the token, then the geo-fence. A locked student is told about their dues
 * rather than being sent to fiddle with their location settings.
 */
export async function submitCheckpointMark(input: {
  studentId: string;
  checkpointId: string;
  token: string;
  coords: { latitude: number; longitude: number; accuracy: number };
}): Promise<SubmitResult> {
  const db = createServiceClient();

  const { data: checkpoint } = await db
    .from("checkpoints")
    .select(
      "id, index, token, expires_at, session_instance_id, session_instances(id, course_id, status, venue_id, courses(academic_session_id))",
    )
    .eq("id", input.checkpointId)
    .maybeSingle();

  if (!checkpoint) return { outcome: "rejected", reason: "invalid_or_expired_token" };

  const instance = one(
    checkpoint.session_instances as unknown as {
      id: string;
      course_id: string;
      status: string;
      venue_id: string;
      courses: { academic_session_id: string } | null;
    },
  );
  if (!instance) return { outcome: "rejected", reason: "invalid_or_expired_token" };

  // Enrolment is an authorisation check, not a convenience: without it a
  // student holding a code shouted across a corridor could mark themselves
  // present in a course they do not take.
  const { data: enrolment } = await db
    .from("enrolments")
    .select("id")
    .eq("student_id", input.studentId)
    .eq("course_id", instance.course_id)
    .maybeSingle();

  if (!enrolment) return { outcome: "rejected", reason: "invalid_or_expired_token" };

  const academicSessionId = one(instance.courses)?.academic_session_id;

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

  const { data: venue } = await db
    .from("venues")
    .select("centre_lat, centre_lng, radius_m")
    .eq("id", instance.venue_id)
    .maybeSingle();

  // Kept whatever the decision is. `distance_m` survives the coordinate purge,
  // so it is the only evidence a disputed rejection leaves behind.
  const distance = venue
    ? distanceMetres({ latitude: venue.centre_lat, longitude: venue.centre_lng }, input.coords)
    : null;

  const reason = await decide();

  const row = {
    student_id: input.studentId,
    checkpoint_id: checkpoint.id,
    accepted: reason === null,
    reject_reason: reason === null ? null : STORED_REASON[reason],
    gps_lat: input.coords.latitude,
    gps_lng: input.coords.longitude,
    gps_accuracy_m: input.coords.accuracy,
    distance_m: distance,
    submitted_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("attendance_marks")
    .upsert(row, { onConflict: "student_id,checkpoint_id" });

  // The student is told nothing until the row is written. A failure here is a
  // failure to record attendance, and it has to read like one.
  if (error) throw new Error(`Could not record the submission: ${error.message}`);

  if (reason !== null) return { outcome: "rejected", reason };

  const { data: accepted } = await db
    .from("attendance_marks")
    .select("id, checkpoints!inner(session_instance_id)")
    .eq("student_id", input.studentId)
    .eq("accepted", true)
    .eq("checkpoints.session_instance_id", instance.id);

  const captured = (accepted ?? []).length;

  return {
    outcome: "accepted",
    result: {
      index: checkpoint.index as 1 | 2,
      // Provisional arithmetic for the confirmation sentence only. The score
      // that counts is written by resolve_session_score() when the lecture
      // closes, from these same marks.
      sessionScore: captured >= 2 ? 1 : 0.5,
      bothCaptured: captured >= 2,
    },
  };

  async function decide(): Promise<Exclude<SubmitRejection, "location_blocked"> | null> {
    if (academicSessionId) {
      const { data: locked } = await db.rpc("is_attendance_locked", {
        p_student_id: input.studentId,
        p_academic_session_id: academicSessionId,
      });
      if (locked === true) return "account_locked";
    }

    if (instance!.status !== "open") return "invalid_or_expired_token";
    if (Date.parse(checkpoint!.expires_at) <= Date.now()) return "invalid_or_expired_token";
    if (input.token.trim() !== checkpoint!.token) return "wrong_code";

    // A venue with no fence recorded cannot reject anyone. Failing open here is
    // the right way round: the alternative locks a whole hall out of attendance
    // over a missing configuration row.
    if (!venue || distance === null) return null;

    return withinFence(distance, venue.radius_m, input.coords.accuracy)
      ? null
      : "outside_geofence";
  }
}
