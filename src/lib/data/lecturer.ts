import "server-only";

import { redirect } from "next/navigation";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import { createUserClient } from "@/lib/supabase/client";
import { lagosToday } from "@/lib/format";
import type { SessionClaims } from "@/lib/auth/session";
import type { LecturerClassStatus, RosterEntry, SessionControl } from "@/lib/types";

export type { LecturerClassStatus, RosterEntry, SessionControl };

/**
 * What a lecturer sees, read from Supabase as that lecturer.
 *
 * Every query runs under the session token. `teaches_course()` inside the
 * policies is what scopes these results to their own courses — this file never
 * filters by `lecturer_id` for security, only for tidiness, because a filter
 * that can be forgotten is not a control.
 */

export type LecturerClass = {
  /** Null until the lecturer starts it — the lecture row does not exist yet. */
  sessionInstanceId: string | null;
  /** What "Start session" creates the instance from. */
  timetableEntryId: string | null;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  enrolled: number;
  status: LecturerClassStatus;
};

export type LecturerDashboard = {
  lecturer: { surname: string; firstName: string };
  today: LecturerClass[];
  openSession: LecturerClass | null;
  recent: Array<{
    sessionInstanceId: string;
    courseCode: string;
    heldOn: string;
    full: number;
    half: number;
    absent: number;
    singleCheckpoint: boolean;
    fromPaper: boolean;
  }>;
};

export class LecturerDataUnavailable extends Error {
  constructor(what: string, cause?: string) {
    super(cause ? `${what}: ${cause}` : what);
    this.name = "LecturerDataUnavailable";
  }
}

const HOME_FOR_ROLE = {
  student: "/dashboard",
  lecturer: "/lecturer",
  hod: "/hod",
  admin: "/admin",
} as const;

/** The signed-in lecturer, or a redirect. Used by every lecturer screen. */
export async function requireLecturer(): Promise<SessionClaims> {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "lecturer") redirect(HOME_FOR_ROLE[session.role]);
  return session;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** '10:00:00' → '10:00'. Seconds are noise on a timetable. */
function hhmm(time: string | null | undefined): string {
  return (time ?? "").slice(0, 5);
}

/**
 * Venue names, looked up separately rather than embedded.
 *
 * `venues` is admin-only under RLS — the geo-fence centre and radius are what
 * that policy exists to hide — so a lecturer embedding `venues(name)` gets
 * nothing back. `venue_directory` carries the name and no coordinates.
 */
async function venueNames(
  db: ReturnType<typeof createUserClient>,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (unique.length === 0) return new Map();

  const { data } = await db.from("venue_directory").select("id, name").in("id", unique);
  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]));
}

export async function loadLecturerDashboard(): Promise<LecturerDashboard> {
  const session = await requireLecturer();
  const db = createUserClient(await currentAccessToken());
  const { date, dayOfWeek } = lagosToday();

  const [{ data: profile, error: profileError }, { data: courses, error: courseError }] =
    await Promise.all([
      db.from("profiles").select("surname, first_name").eq("id", session.profileId).single(),
      db.from("courses").select("id, code, title").eq("lecturer_id", session.profileId),
    ]);

  if (profileError || !profile) throw new LecturerDataUnavailable("profiles", profileError?.message);
  if (courseError) throw new LecturerDataUnavailable("courses", courseError.message);

  const courseIds = (courses ?? []).map((c) => c.id);
  const courseById = new Map((courses ?? []).map((c) => [c.id, c]));

  if (courseIds.length === 0) {
    return {
      lecturer: { surname: profile.surname, firstName: profile.first_name },
      today: [],
      openSession: null,
      recent: [],
    };
  }

  const [{ data: timetable }, { data: enrolments }, { data: instances }] = await Promise.all([
    db
      .from("timetable_entries")
      .select("id, course_id, start_time, end_time, venue_id")
      .in("course_id", courseIds)
      .eq("day_of_week", dayOfWeek),
    db.from("enrolments").select("course_id").in("course_id", courseIds),
    // Today's lectures plus anything still open from an earlier day — a
    // lecturer who forgot to end a session must be able to find it.
    db
      .from("session_instances")
      .select(
        "id, course_id, timetable_entry_id, held_on, status, checkpoint_mode, scheduled_start, scheduled_end, venue_id, timetable_entries(start_time, end_time)",
      )
      .in("course_id", courseIds)
      .or(`held_on.eq.${date},status.eq.open`),
  ]);

  const enrolledByCourse = new Map<string, number>();
  for (const row of enrolments ?? []) {
    enrolledByCourse.set(row.course_id, (enrolledByCourse.get(row.course_id) ?? 0) + 1);
  }

  const venueName = await venueNames(db, [
    ...(timetable ?? []).map((entry) => entry.venue_id),
    ...(instances ?? []).map((instance) => instance.venue_id),
  ]);

  const toClass = (instance: NonNullable<typeof instances>[number]): LecturerClass => {
    const course = courseById.get(instance.course_id);
    const slot = one(instance.timetable_entries as unknown as { start_time: string; end_time: string });
    return {
      sessionInstanceId: instance.id,
      timetableEntryId: instance.timetable_entry_id,
      courseId: instance.course_id,
      courseCode: course?.code ?? "",
      courseTitle: course?.title ?? "",
      venue: venueName.get(instance.venue_id) ?? "",
      startsAt: hhmm(slot?.start_time),
      endsAt: hhmm(slot?.end_time),
      enrolled: enrolledByCourse.get(instance.course_id) ?? 0,
      status: instance.status as LecturerClassStatus,
    };
  };

  const todayInstances = (instances ?? []).filter((i) => i.held_on === date);
  const startedEntries = new Set(
    todayInstances.map((i) => i.timetable_entry_id).filter(Boolean) as string[],
  );

  // A timetable slot that has not been started yet has no lecture row, so it is
  // shown from the timetable and given a "Start session" button rather than a
  // link to an instance that does not exist.
  const notYetStarted: LecturerClass[] = (timetable ?? [])
    .filter((entry) => !startedEntries.has(entry.id))
    .map((entry) => {
      const course = courseById.get(entry.course_id);
      return {
        sessionInstanceId: null,
        timetableEntryId: entry.id,
        courseId: entry.course_id,
        courseCode: course?.code ?? "",
        courseTitle: course?.title ?? "",
        venue: venueName.get(entry.venue_id) ?? "",
        startsAt: hhmm(entry.start_time),
        endsAt: hhmm(entry.end_time),
        enrolled: enrolledByCourse.get(entry.course_id) ?? 0,
        status: "scheduled" as const,
      };
    });

  const today = [...todayInstances.map(toClass), ...notYetStarted]
    .filter((entry) => entry.status !== "cancelled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const open = (instances ?? []).find((i) => i.status === "open");

  return {
    lecturer: { surname: profile.surname, firstName: profile.first_name },
    today,
    openSession: open ? toClass(open) : null,
    recent: await loadRecent(db, courseById),
  };
}

async function loadRecent(
  db: ReturnType<typeof createUserClient>,
  courseById: Map<string, { id: string; code: string; title: string }>,
): Promise<LecturerDashboard["recent"]> {
  const { data: closed } = await db
    .from("session_instances")
    .select("id, course_id, held_on, checkpoint_mode")
    .in("course_id", [...courseById.keys()])
    .eq("status", "closed")
    .order("held_on", { ascending: false })
    .limit(5);

  const ids = (closed ?? []).map((row) => row.id);
  if (ids.length === 0) return [];

  const { data: scores } = await db
    .from("session_scores")
    .select("session_instance_id, score, source")
    .in("session_instance_id", ids);

  return (closed ?? []).map((instance) => {
    const rows = (scores ?? []).filter((s) => s.session_instance_id === instance.id);
    return {
      sessionInstanceId: instance.id,
      courseCode: courseById.get(instance.course_id)?.code ?? "",
      heldOn: instance.held_on,
      full: rows.filter((r) => Number(r.score) === 1).length,
      half: rows.filter((r) => Number(r.score) === 0.5).length,
      absent: rows.filter((r) => Number(r.score) === 0).length,
      singleCheckpoint: instance.checkpoint_mode === "single",
      fromPaper: rows.some((r) => r.source === "manually_entered"),
    };
  });
}

export type SessionRoster = {
  sessionInstanceId: string;
  courseCode: string;
  heldOn: string;
  /** A lecture where only one token was ever issued is scored present/absent. */
  mode: "pair" | "single";
  roster: RosterEntry[];
};

/**
 * Who was recorded, per checkpoint.
 *
 * Built from `attendance_marks` rather than from `session_scores`, because the
 * lecturer is checking the capture — a student who caught one checkpoint and a
 * student who caught none both score 0.5 and 0, but only the strip shows which
 * half of the lecture they were in the room for.
 */
export async function loadSessionRoster(id: string): Promise<SessionRoster | null> {
  await requireLecturer();
  const db = createUserClient(await currentAccessToken());

  const { data: instance } = await db
    .from("session_instances")
    .select("id, course_id, held_on, checkpoint_mode, courses(code)")
    .eq("id", id)
    .maybeSingle();

  if (!instance) return null;

  const [{ data: enrolments }, { data: checkpoints }] = await Promise.all([
    db
      .from("enrolments")
      .select("student_id, students(matric_no, profiles(surname, first_name, other_names))")
      .eq("course_id", instance.course_id),
    db.from("checkpoints").select("id, index").eq("session_instance_id", id),
  ]);

  const checkpointIds = (checkpoints ?? []).map((cp) => cp.id);
  const indexById = new Map((checkpoints ?? []).map((cp) => [cp.id, cp.index]));

  const { data: marks } = checkpointIds.length
    ? await db
        .from("attendance_marks")
        .select("student_id, checkpoint_id, accepted, flagged_for_review")
        .in("checkpoint_id", checkpointIds)
        .eq("accepted", true)
    : { data: [] };

  const roster: RosterEntry[] = (enrolments ?? [])
    .map((row) => {
      const student = one(
        row.students as unknown as {
          matric_no: string;
          profiles: { surname: string; first_name: string; other_names: string | null } | null;
        },
      );
      const person = one(student?.profiles);
      const mine = (marks ?? []).filter((m) => m.student_id === row.student_id);

      return {
        studentId: row.student_id,
        matricNo: student?.matric_no ?? "",
        surname: person?.surname ?? "",
        firstName: person?.first_name ?? "",
        otherNames: person?.other_names ?? null,
        checkpointOne: mine.some((m) => indexById.get(m.checkpoint_id) === 1),
        checkpointTwo: mine.some((m) => indexById.get(m.checkpoint_id) === 2),
        flagged: mine.some((m) => m.flagged_for_review),
      };
    })
    .sort((a, b) => a.matricNo.localeCompare(b.matricNo));

  return {
    sessionInstanceId: instance.id,
    courseCode: one(instance.courses as unknown as { code: string })?.code ?? "",
    heldOn: instance.held_on,
    mode: instance.checkpoint_mode === "single" ? "single" : "pair",
    roster,
  };
}

export async function loadSessionControl(id: string): Promise<SessionControl | null> {
  await requireLecturer();
  const db = createUserClient(await currentAccessToken());

  const { data: instance } = await db
    .from("session_instances")
    .select("id, course_id, status, opened_at, held_on, venue_id, courses(code, title)")
    .eq("id", id)
    .maybeSingle();

  // Null rather than an error: the policies return nothing for a lecture that
  // belongs to another lecturer, which is exactly the same shape as a lecture
  // that does not exist, and the caller should not be able to tell them apart.
  if (!instance) return null;

  const course = one(instance.courses as unknown as { code: string; title: string });

  const [{ count: enrolled }, { data: checkpoints }, venueName] = await Promise.all([
    db
      .from("enrolments")
      .select("id", { count: "exact", head: true })
      .eq("course_id", instance.course_id),
    db
      .from("checkpoints")
      .select("id, index, token, expires_at")
      .eq("session_instance_id", id)
      .order("index"),
    venueNames(db, [instance.venue_id]),
  ]);

  const checkpointIds = (checkpoints ?? []).map((cp) => cp.id);
  const { data: marks } = checkpointIds.length
    ? await db
        .from("attendance_marks")
        .select("checkpoint_id, accepted, reject_reason")
        .in("checkpoint_id", checkpointIds)
    : { data: [] };

  const now = Date.now();

  return {
    sessionInstanceId: instance.id,
    courseCode: course?.code ?? "",
    courseTitle: course?.title ?? "",
    venue: venueName.get(instance.venue_id) ?? "",
    status: instance.status as LecturerClassStatus,
    openedAt: instance.opened_at ?? instance.held_on,
    enrolled: enrolled ?? 0,
    liveCheckpointIndex:
      ((checkpoints ?? []).find((cp) => Date.parse(cp.expires_at) > now)?.index as 1 | 2) ?? null,
    checkpoints: (checkpoints ?? []).map((cp) => {
      const mine = (marks ?? []).filter((m) => m.checkpoint_id === cp.id);
      const rejections = new Map<string, number>();
      for (const mark of mine) {
        if (mark.accepted || !mark.reject_reason) continue;
        rejections.set(mark.reject_reason, (rejections.get(mark.reject_reason) ?? 0) + 1);
      }

      return {
        index: cp.index as 1 | 2,
        token: cp.token,
        expiresAt: cp.expires_at,
        submissions: mine.filter((m) => m.accepted).length,
        rejections: [...rejections].map(([reason, count]) => ({ reason, count })),
      };
    }),
  };
}
