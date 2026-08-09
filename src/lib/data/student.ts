import "server-only";

import { createUserClient } from "@/lib/supabase/client";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import { loadLiveCheckpoint } from "@/lib/data/attendance";
import { lagosToday } from "@/lib/format";
import type { ComplianceState, CourseAttendance, RiskPattern, SessionCell } from "@/lib/types";
import type { DuesPeriod, StudentProfile, TodayClass } from "@/lib/data/fixtures";

/**
 * The student dashboard, read from Supabase as the signed-in student.
 *
 * Every query here runs under the session token, so row-level security is what
 * scopes the results — not a `where student_id = ...` clause that could be
 * forgotten. A student querying another student's scores gets an empty set from
 * Postgres, whatever this code asks for.
 */

export type StudentDashboard = {
  student: StudentProfile;
  compliance: ComplianceState;
  /**
   * Whether the student can start a payment at all. The portal is not open all
   * session: once locked, paying is shut along with recording attendance, and a
   * grace period reopens both because it is one lock.
   */
  paymentOpen: boolean;
  dues: DuesPeriod;
  courses: CourseAttendance[];
  today: TodayClass[];
  risk: { pattern: RiskPattern; courseCode: string } | null;
};

/**
 * PostgREST returns an embedded to-one relation as an object, but returns an
 * array when it cannot prove the relationship is to-one. Both shapes are valid
 * responses, so neither is assumed.
 */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Thrown with the failing table named, so a misconfiguration is diagnosable. */
export class DashboardUnavailable extends Error {
  constructor(what: string, cause?: string) {
    super(cause ? `${what}: ${cause}` : what);
    this.name = "DashboardUnavailable";
  }
}

/**
 * Today's timetable, with a live checkpoint attached to the class it belongs
 * to.
 *
 * The checkpoint has to be read with the service role: students have no read
 * policy on `checkpoints`, deliberately, because the code is what makes being
 * in the hall necessary. Only the fact that one is open crosses back — never
 * the code itself.
 */
async function loadToday(
  db: ReturnType<typeof createUserClient>,
  studentId: string,
  courses: CourseAttendance[],
): Promise<TodayClass[]> {
  if (courses.length === 0) return [];

  const { dayOfWeek } = lagosToday();

  const { data: entries } = await db
    .from("timetable_entries")
    .select("course_id, start_time, end_time, venue_id")
    .in(
      "course_id",
      courses.map((course) => course.courseId),
    )
    .eq("day_of_week", dayOfWeek);

  if (!entries || entries.length === 0) return [];

  const { data: venues } = await db
    .from("venue_directory")
    .select("id, name")
    .in("id", [...new Set(entries.map((entry) => entry.venue_id))]);

  const venueName = new Map((venues ?? []).map((row) => [row.id as string, row.name as string]));
  const live = await loadLiveCheckpoint(studentId);
  const byId = new Map(courses.map((course) => [course.courseId, course]));

  return entries
    .map((entry) => {
      const course = byId.get(entry.course_id);
      return {
        courseId: entry.course_id,
        code: course?.code ?? "",
        title: course?.title ?? "",
        venue: venueName.get(entry.venue_id) ?? "",
        startsAt: (entry.start_time ?? "").slice(0, 5),
        endsAt: (entry.end_time ?? "").slice(0, 5),
        liveCheckpoint:
          live && live.courseCode === course?.code
            ? { index: live.index, expiresAt: live.expiresAt }
            : null,
      };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export async function loadStudentDashboard(): Promise<StudentDashboard> {
  const session = await currentUser();
  if (!session) throw new DashboardUnavailable("Not signed in");

  const token = await currentAccessToken();
  const db = createUserClient(token);

  const [{ data: profile, error: profileError }, { data: student, error: studentError }] =
    await Promise.all([
      db.from("profiles").select("surname, first_name, other_names, phone").eq("id", session.profileId).single(),
      db.from("students").select("id, matric_no, level").eq("id", session.profileId).single(),
    ]);

  if (profileError || !profile) throw new DashboardUnavailable("profiles", profileError?.message);
  if (studentError || !student) throw new DashboardUnavailable("students", studentError?.message);

  const { data: activeSession, error: sessionError } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  if (sessionError || !activeSession) {
    throw new DashboardUnavailable("academic_sessions", sessionError?.message);
  }

  const [{ data: dues }, { data: compliance }, { data: enrolments, error: enrolmentError }] =
    await Promise.all([
      db
        .from("dues_periods")
        .select("dues_amount_kobo, resumption_date, grace_period_end")
        .eq("academic_session_id", activeSession.id)
        .maybeSingle(),
      db
        .from("compliance_statuses")
        .select("state")
        .eq("student_id", session.profileId)
        .eq("academic_session_id", activeSession.id)
        .maybeSingle(),
      db
        .from("enrolments")
        // Dropped courses are excluded here but not deleted in the database:
        // the row survives so the join date does, which is what stops a
        // drop-and-re-add erasing an absence record.
        .select("course_id, enrolled_on, dropped_at, courses(id, code, title)")
        .eq("student_id", session.profileId)
        .is("dropped_at", null),
    ]);

  if (enrolmentError) throw new DashboardUnavailable("enrolments", enrolmentError.message);

  const courseIds = (enrolments ?? []).map((row) => row.course_id);

  // Lectures actually held, and this student's score for each. Cancelled
  // instances are excluded here for the same reason the SQL excludes them:
  // a cancelled class must not count against anyone.
  const [{ data: instances }, { data: scores }] = courseIds.length
    ? await Promise.all([
        db
          .from("session_instances")
          .select("id, course_id, held_on, checkpoint_mode, status")
          .in("course_id", courseIds)
          .eq("status", "closed")
          .order("held_on"),
        db
          .from("session_scores")
          .select("session_instance_id, score, status, source")
          .eq("student_id", session.profileId),
      ])
    : [{ data: [] }, { data: [] }];

  const scoreByInstance = new Map(
    (scores ?? []).map((row) => [row.session_instance_id, row]),
  );

  const courses: CourseAttendance[] = (enrolments ?? []).map((enrolment) => {
    const course = one(enrolment.courses as unknown as { id: string; code: string; title: string });
    if (!course) throw new DashboardUnavailable("enrolments.courses", "no course behind an enrolment");
    // The denominator is lectures held while this student was on the course,
    // mirroring attendance_pct() in the database. A carry-over added in week 8
    // must not inherit the absences from weeks 1 to 7 — and if this filter and
    // the SQL ever disagree, a student sees one number here and is judged by
    // another.
    const held = (instances ?? []).filter(
      (instance) =>
        instance.course_id === course.id && instance.held_on >= enrolment.enrolled_on,
    );

    const sessions: SessionCell[] = held.map((instance, index) => {
      const score = scoreByInstance.get(instance.id);
      const value = Number(score?.score ?? 0);
      const single = instance.checkpoint_mode === "single";

      return {
        id: instance.id,
        label: `Week ${index + 1}`,
        heldOn: instance.held_on,
        mode: single ? "single" : "pair",
        // The stored score is the source of truth; the cells are drawn from it
        // rather than from a second read of attendance_marks, which a student
        // cannot see the coordinates of anyway.
        checkpointOne: value > 0,
        checkpointTwo: value === 1 && !single,
        status: score?.status === "confirmed" ? "confirmed" : "provisional",
        source: score?.source === "manually_entered" ? "manually_entered" : "digital",
        score: value,
      };
    });

    const confirmedScore = sessions
      .filter((s) => s.status === "confirmed")
      .reduce((sum, s) => sum + s.score, 0);
    const provisionalScore = sessions
      .filter((s) => s.status === "provisional")
      .reduce((sum, s) => sum + s.score, 0);

    return {
      courseId: course.id,
      code: course.code,
      title: course.title,
      confirmedScore,
      provisionalScore,
      sessionsHeld: held.length,
      sessions,
    };
  });

  // The grace period the HOD actually opened, not the static column on
  // dues_periods. Without this the HOD unlocks a level and the students it
  // covers see nothing on the screen that told them they were locked.
  const { data: grace } = await db
    .from("grace_periods")
    .select("expires_on, scope, level")
    .eq("academic_session_id", activeSession.id)
    .is("revoked_at", null)
    .gte("expires_on", new Date().toISOString().slice(0, 10))
    .order("expires_on", { ascending: false });

  const covering = (grace ?? []).find(
    (row) => row.scope === "department" || row.level === student.level,
  );

  const today = await loadToday(db, session.profileId, courses);

  const { data: risk } = await db
    .from("risk_predictions")
    .select("pattern, courses(code)")
    .eq("student_id", session.profileId)
    .order("predicted_pct")
    .limit(1)
    .maybeSingle();

  const resumption = dues?.resumption_date ?? new Date().toISOString();

  return {
    student: {
      id: student.id,
      matricNo: student.matric_no,
      surname: profile.surname,
      firstName: profile.first_name,
      otherNames: profile.other_names,
      level: student.level,
      phone: profile.phone ?? "",
    },
    compliance: (compliance?.state ?? "uncleared") as ComplianceState,
    paymentOpen: (compliance?.state ?? "uncleared") !== "locked" || covering != null,
    dues: {
      duesAmountKobo: Number(dues?.dues_amount_kobo ?? 0),
      resumptionDate: resumption,
      // Day 30 of the provisional window, counted from resumption.
      deadline: new Date(new Date(resumption).getTime() + 30 * 86_400_000).toISOString(),
      gracePeriodEnd: covering?.expires_on ?? dues?.grace_period_end ?? null,
    },
    courses,
    today,
    risk: risk
      ? {
          pattern: risk.pattern as RiskPattern,
          courseCode: one(risk.courses as unknown as { code: string })?.code ?? "",
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// One course, in full
// ---------------------------------------------------------------------------

export type CourseDetail = {
  course: CourseAttendance;
  lecturer: string | null;
  /** "Tuesday 10:00–12:00", or null when the course has no weekly slot. */
  schedule: string | null;
  venue: string | null;
  /**
   * Advisory only, and null until the model has run. Never the eligibility
   * determination — that is confirmed score over lectures held, and nothing
   * else is allowed to stand in for it.
   */
  projectedPct: number | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The student's own view of one course they are enrolled in.
 *
 * Built with the same window and the same rules as the dashboard — lectures
 * held since they joined, confirmed scores in the numerator — because a
 * student who sees 73% on one screen and 76% on another has no way to know
 * which one the exam board will use.
 */
export async function loadCourseDetail(code: string): Promise<CourseDetail | null> {
  const session = await currentUser();
  if (!session) throw new DashboardUnavailable("Not signed in");

  const db = createUserClient(await currentAccessToken());
  const wanted = decodeURIComponent(code).toUpperCase();

  const { data: enrolments } = await db
    .from("enrolments")
    .select("course_id, enrolled_on, courses(id, code, title, lecturer_id)")
    .eq("student_id", session.profileId)
    .is("dropped_at", null);

  const enrolment = (enrolments ?? []).find((row) => {
    const course = one(row.courses as unknown as { code: string });
    return course?.code.toUpperCase() === wanted;
  });

  // Not enrolled is indistinguishable from not existing, on purpose. A student
  // must not be able to probe the catalogue for courses they are not on.
  if (!enrolment) return null;

  const course = one(
    enrolment.courses as unknown as {
      id: string;
      code: string;
      title: string;
      lecturer_id: string | null;
    },
  );
  if (!course) return null;

  const [{ data: instances }, { data: scores }, { data: entry }] = await Promise.all([
    db
      .from("session_instances")
      .select("id, held_on, checkpoint_mode")
      .eq("course_id", course.id)
      .eq("status", "closed")
      .gte("held_on", enrolment.enrolled_on)
      .order("held_on"),
    db
      .from("session_scores")
      .select("session_instance_id, score, status, source")
      .eq("student_id", session.profileId),
    db
      .from("timetable_entries")
      .select("day_of_week, start_time, end_time, venue_id")
      .eq("course_id", course.id)
      .maybeSingle(),
  ]);

  const scoreByInstance = new Map((scores ?? []).map((row) => [row.session_instance_id, row]));

  const sessions: SessionCell[] = (instances ?? []).map((instance, index) => {
    const score = scoreByInstance.get(instance.id);
    const value = Number(score?.score ?? 0);
    const single = instance.checkpoint_mode === "single";

    return {
      id: instance.id,
      label: `Week ${index + 1}`,
      heldOn: instance.held_on,
      mode: single ? "single" : "pair",
      checkpointOne: value > 0,
      checkpointTwo: value === 1 && !single,
      status: score?.status === "confirmed" ? "confirmed" : "provisional",
      source: score?.source === "manually_entered" ? "manually_entered" : "digital",
      score: value,
    };
  });

  const [{ data: lecturer }, { data: venue }, { data: risk }] = await Promise.all([
    course.lecturer_id
      ? db.from("profiles").select("surname, first_name").eq("id", course.lecturer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    entry?.venue_id
      ? db.from("venue_directory").select("name").eq("id", entry.venue_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from("risk_predictions")
      .select("predicted_pct")
      .eq("student_id", session.profileId)
      .eq("course_id", course.id)
      .maybeSingle(),
  ]);

  return {
    course: {
      courseId: course.id,
      code: course.code,
      title: course.title,
      confirmedScore: sessions
        .filter((s) => s.status === "confirmed")
        .reduce((sum, s) => sum + s.score, 0),
      provisionalScore: sessions
        .filter((s) => s.status === "provisional")
        .reduce((sum, s) => sum + s.score, 0),
      sessionsHeld: sessions.length,
      sessions,
    },
    lecturer: lecturer ? `${lecturer.first_name} ${lecturer.surname}` : null,
    schedule: entry
      ? `${WEEKDAYS[entry.day_of_week] ?? ""} ${String(entry.start_time).slice(0, 5)}–${String(entry.end_time).slice(0, 5)}`.trim()
      : null,
    venue: venue?.name ?? null,
    projectedPct: risk ? Number(risk.predicted_pct) : null,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationItem = {
  id: string;
  kind: "payment_reminder" | "payment_confirmed" | "risk_nudge" | "grace_period" | "schedule_change" | "clearance_granted";
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
};

export async function loadNotifications(): Promise<NotificationItem[]> {
  const session = await currentUser();
  if (!session) throw new DashboardUnavailable("Not signed in");

  const db = createUserClient(await currentAccessToken());

  // No `where recipient_id = ...` clause: the policy is what scopes this, and
  // relying on it here is what proves it works.
  const { data } = await db
    .from("notifications")
    .select("id, kind, title, body, link, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind as NotificationItem["kind"],
    title: row.title,
    body: row.body,
    link: row.link,
    createdAt: row.created_at,
    readAt: row.read_at,
  }));
}

/**
 * Marking everything read.
 *
 * Under the student's own token, not the service role: `notifications_self_update`
 * is the policy that makes this safe, and going around it with the service key
 * would leave the policy untested and a student able to mark another's read the
 * day someone adds an id parameter.
 */
export async function markNotificationsRead(): Promise<number> {
  const session = await currentUser();
  if (!session) throw new DashboardUnavailable("Not signed in");

  const db = createUserClient(await currentAccessToken());

  const { data } = await db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null)
    .select("id");

  return data?.length ?? 0;
}
