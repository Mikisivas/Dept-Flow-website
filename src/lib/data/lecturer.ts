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

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

export type ScheduledSession = {
  /** Null until somebody starts, cancels or schedules it — see below. */
  sessionInstanceId: string | null;
  timetableEntryId: string | null;
  courseId: string;
  courseCode: string;
  heldOn: string;
  startsAt: string;
  endsAt: string;
  venue: string;
  type: "recurring" | "makeup" | "reschedule";
  status: "scheduled" | "open" | "closed" | "cancelled";
  cancellationReason: string | null;
};

const SCHEDULE_HORIZON_DAYS = 21;

/**
 * The lecturer's upcoming lectures.
 *
 * Two sources, and they mean different things. `timetable_entries` is a weekly
 * pattern — it says a class is *meant* to happen every Tuesday. A
 * `session_instances` row is a specific date that was started, cancelled or
 * added. So the schedule is the pattern projected forward, with any instance
 * for that date laid over the top of it.
 *
 * Doing it the other way — listing only instances — would show an empty
 * schedule, because instances are created when a lecture starts. Nothing is
 * scheduled ahead of time.
 */
export async function loadLecturerSchedule(): Promise<ScheduledSession[]> {
  const session = await requireLecturer();
  const db = createUserClient(await currentAccessToken());
  const { date } = lagosToday();

  const { data: courses } = await db
    .from("courses")
    .select("id, code")
    .eq("lecturer_id", session.profileId);

  const courseIds = (courses ?? []).map((course) => course.id);
  if (courseIds.length === 0) return [];

  const codeById = new Map((courses ?? []).map((course) => [course.id, course.code]));

  const horizon = new Date(`${date}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + SCHEDULE_HORIZON_DAYS);
  const until = horizon.toISOString().slice(0, 10);

  const [{ data: timetable }, { data: instances }] = await Promise.all([
    db
      .from("timetable_entries")
      .select("id, course_id, day_of_week, start_time, end_time, venue_id")
      .in("course_id", courseIds),
    db
      .from("session_instances")
      .select(
        "id, course_id, timetable_entry_id, held_on, scheduled_start, scheduled_end, venue_id, type, status, cancellation_reason",
      )
      .in("course_id", courseIds)
      .gte("held_on", date)
      .lte("held_on", until),
  ]);

  const venues = await venueNames(db, [
    ...(timetable ?? []).map((entry) => entry.venue_id),
    ...(instances ?? []).map((instance) => instance.venue_id),
  ]);

  // Keyed by course and date rather than by timetable entry: a makeup has no
  // entry at all, and a cancellation written against the course still has to
  // suppress the projected occurrence.
  const instanceByDay = new Map(
    (instances ?? []).map((instance) => [`${instance.course_id}|${instance.held_on}`, instance]),
  );

  const rows: ScheduledSession[] = [];

  for (let offset = 0; offset <= SCHEDULE_HORIZON_DAYS; offset += 1) {
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const iso = day.toISOString().slice(0, 10);
    // Postgres `day_of_week` matches JavaScript's: 0 is Sunday.
    const weekday = day.getUTCDay();

    for (const entry of timetable ?? []) {
      if (entry.day_of_week !== weekday) continue;

      const instance = instanceByDay.get(`${entry.course_id}|${iso}`);

      rows.push({
        sessionInstanceId: instance?.id ?? null,
        timetableEntryId: entry.id,
        courseId: entry.course_id,
        courseCode: codeById.get(entry.course_id) ?? "",
        heldOn: iso,
        startsAt: hhmm(entry.start_time),
        endsAt: hhmm(entry.end_time),
        venue: venues.get(entry.venue_id) ?? "Venue not set",
        type: (instance?.type as ScheduledSession["type"]) ?? "recurring",
        status: (instance?.status as ScheduledSession["status"]) ?? "scheduled",
        cancellationReason: instance?.cancellation_reason ?? null,
      });
    }
  }

  // Makeups and reschedules have no weekly pattern to project, so they are
  // added from the instances directly.
  for (const instance of instances ?? []) {
    if (instance.timetable_entry_id) continue;

    rows.push({
      sessionInstanceId: instance.id,
      timetableEntryId: null,
      courseId: instance.course_id,
      courseCode: codeById.get(instance.course_id) ?? "",
      heldOn: instance.held_on,
      startsAt: hhmm(instance.scheduled_start?.slice(11, 19)),
      endsAt: hhmm(instance.scheduled_end?.slice(11, 19)),
      venue: venues.get(instance.venue_id) ?? "Venue not set",
      type: instance.type as ScheduledSession["type"],
      status: instance.status as ScheduledSession["status"],
      cancellationReason: instance.cancellation_reason ?? null,
    });
  }

  return rows.sort((a, b) =>
    a.heldOn === b.heldOn ? a.startsAt.localeCompare(b.startsAt) : a.heldOn.localeCompare(b.heldOn),
  );
}

export type LecturerVenue = { id: string; name: string };

/** For the makeup-class form. Names only — coordinates are admin-only. */
export async function loadVenueOptions(): Promise<LecturerVenue[]> {
  await requireLecturer();
  const db = createUserClient(await currentAccessToken());
  const { data } = await db.from("venue_directory").select("id, name").order("name");
  return (data ?? []).map((venue) => ({ id: venue.id, name: venue.name }));
}

// ---------------------------------------------------------------------------
// The lecturer's own courses
// ---------------------------------------------------------------------------

export type LecturerCourse = {
  courseId: string;
  code: string;
  title: string;
  enrolled: number;
  sessionsHeld: number;
  /** Counted attendance across the class, or null when nothing has been held. */
  averagePct: number | null;
};

export async function loadLecturerCourses(): Promise<LecturerCourse[]> {
  const session = await requireLecturer();
  const db = createUserClient(await currentAccessToken());

  const { data: courses } = await db
    .from("courses")
    .select("id, code, title")
    .eq("lecturer_id", session.profileId)
    .order("code");

  const courseIds = (courses ?? []).map((course) => course.id);
  if (courseIds.length === 0) return [];

  const [{ data: enrolments }, { data: instances }, { data: scores }] = await Promise.all([
    db
      .from("enrolments")
      .select("student_id, course_id, enrolled_on")
      .in("course_id", courseIds)
      .is("dropped_at", null),
    db
      .from("session_instances")
      .select("id, course_id, held_on")
      .in("course_id", courseIds)
      .eq("status", "closed"),
    db.from("session_scores").select("student_id, session_instance_id, score, status"),
  ]);

  const scoreByKey = new Map(
    (scores ?? []).map((row) => [`${row.student_id}|${row.session_instance_id}`, row]),
  );

  return (courses ?? []).map((course) => {
    const held = (instances ?? []).filter((instance) => instance.course_id === course.id);
    const roll = (enrolments ?? []).filter((row) => row.course_id === course.id);

    // The class average is the average of each student's own percentage, and
    // each student's denominator is the lectures held since THEY joined. A
    // carry-over student who joined in week 8 is not marked absent for the
    // seven weeks before that, here or anywhere else.
    let totalPct = 0;
    let counted = 0;

    for (const enrolment of roll) {
      const mine = held.filter((instance) => instance.held_on >= enrolment.enrolled_on);
      if (mine.length === 0) continue;

      const confirmed = mine.reduce((sum, instance) => {
        const score = scoreByKey.get(`${enrolment.student_id}|${instance.id}`);
        return sum + (score?.status === "confirmed" ? Number(score.score) : 0);
      }, 0);

      totalPct += (confirmed / mine.length) * 100;
      counted += 1;
    }

    return {
      courseId: course.id,
      code: course.code,
      title: course.title,
      enrolled: roll.length,
      sessionsHeld: held.length,
      averagePct: counted === 0 ? null : Math.round(totalPct / counted),
    };
  });
}
