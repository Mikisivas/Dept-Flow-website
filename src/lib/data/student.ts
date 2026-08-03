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
        .select("course_id, courses(id, code, title)")
        .eq("student_id", session.profileId),
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
    const held = (instances ?? []).filter((instance) => instance.course_id === course.id);

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
    dues: {
      duesAmountKobo: Number(dues?.dues_amount_kobo ?? 0),
      resumptionDate: resumption,
      // Day 30 of the provisional window, counted from resumption.
      deadline: new Date(new Date(resumption).getTime() + 30 * 86_400_000).toISOString(),
      gracePeriodEnd: dues?.grace_period_end ?? null,
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
