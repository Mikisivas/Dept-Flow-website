import "server-only";

import { redirect } from "next/navigation";
import { createServiceClient, createUserClient } from "@/lib/supabase/client";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import { attendancePct } from "@/lib/format";
import type { SessionClaims } from "@/lib/auth/session";
import { programmeLevelLabel } from "@/lib/types";
import type { SessionCell } from "@/lib/types";

/**
 * What the HOD sees, read as the HOD.
 *
 * The authoritative eligibility number is computed here the same way
 * `attendance_pct()` computes it — confirmed scores over lectures held while
 * the student was enrolled. The risk model is never consulted for it. A
 * prediction is advice about the future; this is a determination about the
 * past, and the two must never be confused on a screen that decides who sits
 * an exam.
 */

const HOME_FOR_ROLE = {
  student: "/dashboard",
  lecturer: "/lecturer",
  hod: "/hod",
  admin: "/admin",
} as const;

export async function requireHod(): Promise<SessionClaims> {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "hod") redirect(HOME_FOR_ROLE[session.role]);
  return session;
}

export type HodOverview = {
  totalStudents: number;
  belowThreshold: number;
  trendingBelow: number;
  compliance: { cleared: number; provisional: number; locked: number; pending: number };
  activeGrace: { expiresOn: string; scope: string; studentsAffected: number } | null;
  pending: { disputes: number };
};

/**
 * One student's standing, per course and overall.
 *
 * Built once and reused by the overview, the at-risk list and the eligibility
 * list, because three screens computing the same percentage three ways is how
 * they end up disagreeing in front of a student.
 */
export type StudentStanding = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  compliance: string;
  courses: Array<{
    courseId: string;
    code: string;
    attendedCount: number;
    sessionsHeld: number;
    pct: number;
    /** Per lecture, so the shape of the trouble is visible and not just its size. */
    sessions: SessionCell[];
  }>;
  /** Across every course they are enrolled in. */
  overallPct: number;
  sessionsHeld: number;
};

type Db = ReturnType<typeof createUserClient>;

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function loadStandings(db: Db, courseId?: string): Promise<StudentStanding[]> {
  const [{ data: students }, { data: enrolments }, { data: instances }, { data: scores }] =
    await Promise.all([
      db.from("students").select("id, matric_no, level, profiles(surname, first_name, other_names)"),
      db
        .from("enrolments")
        .select("student_id, course_id, enrolled_on, courses(id, code)")
        .is("dropped_at", null),
      db
        .from("session_instances")
        .select("id, course_id, held_on")
        .eq("status", "closed")
        .order("held_on"),
      db.from("session_scores").select("student_id, session_instance_id, score"),
    ]);

  const { data: compliance } = await db
    .from("compliance_statuses")
    .select("student_id, state");

  const stateByStudent = new Map((compliance ?? []).map((row) => [row.student_id, row.state]));

  // Scores keyed by student, so each student's loop is a map lookup rather than
  // a scan of the whole table.
  const scoresByStudent = new Map<string, typeof scores>();
  for (const score of scores ?? []) {
    const list = scoresByStudent.get(score.student_id) ?? [];
    list.push(score);
    scoresByStudent.set(score.student_id, list);
  }

  return (students ?? []).map((student) => {
    const person = one(
      student.profiles as unknown as {
        surname: string;
        first_name: string;
        other_names: string | null;
      },
    );

    const mine = (enrolments ?? []).filter(
      (row) => row.student_id === student.id && (!courseId || row.course_id === courseId),
    );
    const myScores = scoresByStudent.get(student.id) ?? [];

    const courses = mine.map((enrolment) => {
      const course = one(enrolment.courses as unknown as { id: string; code: string });

      // The denominator is lectures held while they were on the course, the
      // same window attendance_pct() uses.
      const held = (instances ?? []).filter(
        (instance) =>
          instance.course_id === enrolment.course_id &&
          instance.held_on >= enrolment.enrolled_on,
      );
      const heldIds = new Set(held.map((instance) => instance.id));

      const relevant = (myScores ?? []).filter((score) => heldIds.has(score.session_instance_id));
      const attendedCount = relevant.reduce((sum, score) => sum + Number(score.score), 0);

      const scoreByInstance = new Map(relevant.map((score) => [score.session_instance_id, score]));

      const sessions: SessionCell[] = held.map((instance, index) => {
        const score = scoreByInstance.get(instance.id);
        const value = Number(score?.score ?? 0);

        return {
          id: instance.id,
          label: `Week ${index + 1}`,
          heldOn: instance.held_on,
          attended: value > 0,
          source: "digital",
          score: value,
        };
      });

      return {
        courseId: enrolment.course_id,
        code: course?.code ?? "",
        attendedCount,
        sessionsHeld: held.length,
        pct: attendancePct(attendedCount, held.length),
        sessions,
      };
    });

    const totalConfirmed = courses.reduce((sum, course) => sum + course.attendedCount, 0);
    const totalHeld = courses.reduce((sum, course) => sum + course.sessionsHeld, 0);

    return {
      studentId: student.id,
      matricNo: student.matric_no,
      surname: person?.surname ?? "",
      firstName: person?.first_name ?? "",
      otherNames: person?.other_names ?? null,
      level: student.level,
      compliance: stateByStudent.get(student.id) ?? "uncleared",
      courses,
      overallPct: attendancePct(totalConfirmed, totalHeld),
      sessionsHeld: totalHeld,
    };
  });
}

export async function loadHodOverview(): Promise<HodOverview> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const standings = await loadStandings(db);

  const compliance = { cleared: 0, provisional: 0, locked: 0, pending: 0 };
  for (const student of standings) {
    if (student.compliance === "cleared") compliance.cleared += 1;
    else if (student.compliance === "locked") compliance.locked += 1;
    else if (student.compliance === "pending_verification") compliance.pending += 1;
    else compliance.provisional += 1;
  }

  // Only students whose courses have actually held lectures can be below the
  // line. Someone with no lectures yet is at 0% by the arithmetic and is not
  // failing anything.
  const measurable = standings.filter((student) => student.sessionsHeld > 0);
  const belowThreshold = measurable.filter((student) => student.overallPct < 75).length;

  const [{ data: grace }, { count: disputes }, { data: predictions }] =
    await Promise.all([
      db
        .from("grace_periods")
        .select("expires_on, scope, level, students_affected")
        .is("revoked_at", null)
        .gte("expires_on", new Date().toISOString().slice(0, 10))
        .order("expires_on", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("attendance_disputes").select("id", { count: "exact", head: true }).eq("status", "open"),
      // Advisory only, and labelled as such wherever it is shown.
      db.from("risk_predictions").select("student_id, predicted_pct").lt("predicted_pct", 75),
    ]);

  const atRisk = new Set((predictions ?? []).map((row) => row.student_id));
  const trendingBelow = standings.filter(
    (student) => atRisk.has(student.studentId) && student.overallPct >= 75,
  ).length;

  return {
    totalStudents: standings.length,
    belowThreshold,
    trendingBelow,
    compliance,
    activeGrace: grace
      ? {
          expiresOn: grace.expires_on,
          scope: grace.scope === "department" ? "Whole department" : `${grace.level} level`,
          studentsAffected: grace.students_affected,
        }
      : null,
    pending: { disputes: disputes ?? 0 },
  };
}

export type AtRiskStudent = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  courseId: string;
  courseCode: string;
  currentPct: number;
  predictedPct: number;
  tier: "watch" | "critical";
  /** Null for a student whose projection is above the line but without room. */
  pattern: "disengagement" | "partial_attendance" | null;
  /** Percentage points per lecture. Negative is a student falling away. */
  trend: number;
  mustAttend: number;
  canStillMiss: number;
  lecturesRemaining: number;
  sessions: SessionCell[];
};

/**
 * The advisory list. `currentPct` is a determination; `predictedPct` is a
 * guess — they sit in separate columns and the screen says which is which,
 * because a student is never barred from an exam on the strength of a model.
 *
 * Filtered to Watch and Critical here rather than in the caller. The forecast
 * table holds a row for EVERY enrolment now, Safe ones included, because the
 * student's own dashboard needs the good news as much as the bad. A list
 * headed "at-risk students" that reads that table unfiltered would put the
 * whole department on it, which is the same as putting nobody on it.
 */
export async function loadAtRiskStudents(): Promise<AtRiskStudent[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const [{ data: predictions }, standings] = await Promise.all([
    db
      .from("risk_predictions")
      .select(
        "student_id, course_id, predicted_pct, pattern, tier, trend, must_attend, can_still_miss, lectures_held, lectures_expected, courses(code)",
      )
      .in("tier", ["watch", "critical"])
      // Critical before Watch, and within each the worst projection first.
      // Severity is the only order that survives a list of four hundred: an
      // HOD reads down it until they run out of afternoon.
      .order("tier", { ascending: false })
      .order("predicted_pct"),
    loadStandings(createUserClient(await currentAccessToken())),
  ]);

  const byId = new Map(standings.map((student) => [student.studentId, student]));

  return (predictions ?? []).flatMap((prediction) => {
    const student = byId.get(prediction.student_id);
    if (!student) return [];

    const course = one(prediction.courses as unknown as { code: string });
    const standing = student.courses.find((entry) => entry.courseId === prediction.course_id);

    return [
      {
        studentId: student.studentId,
        matricNo: student.matricNo,
        surname: student.surname,
        firstName: student.firstName,
        otherNames: student.otherNames,
        level: student.level,
        courseId: prediction.course_id,
        courseCode: course?.code ?? "",
        currentPct: standing?.pct ?? 0,
        predictedPct: Number(prediction.predicted_pct),
        tier: prediction.tier as AtRiskStudent["tier"],
        pattern: (prediction.pattern as AtRiskStudent["pattern"]) ?? null,
        trend: Number(prediction.trend ?? 0),
        mustAttend: Number(prediction.must_attend ?? 0),
        canStillMiss: Number(prediction.can_still_miss ?? 0),
        lecturesRemaining: Math.max(
          0,
          Number(prediction.lectures_expected ?? 0) - Number(prediction.lectures_held ?? 0),
        ),
        sessions: standing?.sessions ?? [],
      },
    ];
  });
}

export type EligibilityRow = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  attendancePct: number;
  scoreTotal: number;
  sessionsHeld: number;
  eligible: boolean;
};

export type EligibilityList = {
  courses: Array<{ courseId: string; code: string; title: string }>;
  course: { courseId: string; code: string; title: string } | null;
  thresholdPct: number;
  rows: EligibilityRow[];
  authorizedAt: string | null;
  authorizedBy: string | null;
};

/**
 * The output of the entire system: who may sit the exam for one course.
 *
 * Computed from confirmed scores only, which is why a student who has attended
 * everything but not cleared their dues shows as ineligible with a large
 * provisional figure beside it. That is the mechanism working, and the column
 * is there so the HOD can see it rather than having to guess why.
 */
export async function loadEligibilityList(courseId?: string): Promise<EligibilityList> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  const { data: catalogue } = await db
    .from("courses")
    .select("id, code, title")
    .eq("academic_session_id", session?.id ?? "")
    .order("code");

  const courses = (catalogue ?? []).map((row) => ({
    courseId: row.id,
    code: row.code,
    title: row.title,
  }));

  const chosen = courses.find((row) => row.courseId === courseId) ?? courses[0] ?? null;
  if (!chosen) {
    return {
      courses,
      course: null,
      thresholdPct: 75,
      rows: [],
      authorizedAt: null,
      authorizedBy: null,
    };
  }

  const { data: list } = await db
    .from("eligibility_lists")
    .select("id, threshold_pct, status, authorized_at, authorized_by")
    .eq("course_id", chosen.courseId)
    .maybeSingle();

  const thresholdPct = Number(list?.threshold_pct ?? 75);

  // An authorized list is read from its own snapshot, never recomputed. If it
  // were recomputed, a grace period opened next week would silently rewrite the
  // list an exam board already sat with — and freezing would be decoration.
  if (list?.status === "authorized") {
    const [{ data: entries }, { data: authoriser }] = await Promise.all([
      db
        .from("eligibility_entries")
        .select("student_id, attendance_pct, score_total, sessions_held, eligible")
        .eq("list_id", list.id),
      list.authorized_by
        ? db.from("profiles").select("surname, first_name").eq("id", list.authorized_by).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const ids = (entries ?? []).map((row) => row.student_id);
    const { data: people } = ids.length
      ? await db
          .from("students")
          .select("id, matric_no, profiles(surname, first_name, other_names)")
          .in("id", ids)
      : { data: [] };

    const byId = new Map((people ?? []).map((row) => [row.id, row]));

    return {
      courses,
      course: chosen,
      thresholdPct,
      rows: (entries ?? [])
        .map((entry) => {
          const student = byId.get(entry.student_id);
          const person = one(
            student?.profiles as unknown as {
              surname: string;
              first_name: string;
              other_names: string | null;
            },
          );
          return {
            studentId: entry.student_id,
            matricNo: student?.matric_no ?? "",
            surname: person?.surname ?? "",
            firstName: person?.first_name ?? "",
            otherNames: person?.other_names ?? null,
            attendancePct: Number(entry.attendance_pct),
            scoreTotal: Number(entry.score_total),
            sessionsHeld: entry.sessions_held,
            eligible: entry.eligible,
          };
        })
        .sort((a, b) => a.matricNo.localeCompare(b.matricNo)),
      authorizedAt: list.authorized_at ?? null,
      authorizedBy: authoriser ? `${authoriser.first_name} ${authoriser.surname}` : null,
    };
  }

  const standings = await loadStandings(db, chosen.courseId);

  const rows: EligibilityRow[] = standings
    // Only students actually on this course. `loadStandings` returns everyone,
    // and a student with no enrolment in it has no standing to report.
    .filter((student) => student.courses.length > 0)
    .map((student) => {
      const course = student.courses[0];
      return {
        studentId: student.studentId,
        matricNo: student.matricNo,
        surname: student.surname,
        firstName: student.firstName,
        otherNames: student.otherNames,
        attendancePct: course.pct,
        scoreTotal: course.attendedCount,
        sessionsHeld: course.sessionsHeld,
        eligible: course.sessionsHeld > 0 && course.pct >= thresholdPct,
      };
    })
    .sort((a, b) => a.matricNo.localeCompare(b.matricNo));

  return {
    courses,
    course: chosen,
    thresholdPct,
    rows,
    authorizedAt: null,
    authorizedBy: null,
  };
}

export type GracePeriodRecord = {
  id: string;
  scope: string;
  expiresOn: string;
  reason: string;
  grantedBy: string;
  grantedAt: string;
  studentsAffected: number;
  revokedAt: string | null;
};

export type GraceScreen = {
  active: GracePeriodRecord | null;
  history: GracePeriodRecord[];
  /**
   * Students shut out of recording attendance because a registration deadline
   * passed without them confirming. This used to count students locked out by
   * dues; the exception was repointed at registration and the number the HOD
   * decides on had to move with it.
   */
  impact: { shutOut: number; lecturesMissed: number };
  levelCounts: Record<string, number>;
};

function scopeLabel(scope: string, level: number | null): string {
  if (scope === "department") return "The whole department";
  if (scope === "student") return "One student";
  return `Level ${level} only`;
}

export async function loadGraceScreen(): Promise<GraceScreen> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  const [{ data: periods }, { data: students }, { data: closedWindows }, { data: confirmed }] =
    await Promise.all([
      db
        .from("grace_periods")
        .select(
          "id, scope, level, expires_on, reason, granted_at, students_affected, revoked_at, profiles:granted_by(surname, first_name)",
        )
        .eq("academic_session_id", session?.id ?? "")
        .order("granted_at", { ascending: false }),
      db.from("students").select("id, level").neq("status", "deactivated"),
      db
        .from("registration_periods")
        .select("semester")
        .eq("academic_session_id", session?.id ?? "")
        .lt("closes_on", new Date().toISOString().slice(0, 10)),
      db
        .from("course_registrations")
        .select("student_id, semester")
        .eq("academic_session_id", session?.id ?? "")
        .eq("status", "confirmed"),
    ]);

  // A student is shut out when some semester's window has closed and they
  // never confirmed for it. Computed the same way `grace_period_impact()`
  // computes it, because the screen's number and the number stored on the
  // record must be the same number.
  const closedSemesters = (closedWindows ?? []).map((row) => Number(row.semester));
  const confirmedFor = new Set(
    (confirmed ?? []).map((row) => `${row.student_id}:${row.semester}`),
  );

  const shutOutIds = new Set(
    (students ?? [])
      .filter((student) =>
        closedSemesters.some((semester) => !confirmedFor.has(`${student.id}:${semester}`)),
      )
      .map((student) => student.id),
  );

  // Lectures they are being marked absent from while they stay shut out. The
  // number that makes the decision concrete rather than procedural.
  const { data: missed } = shutOutIds.size
    ? await db
        .from("session_scores")
        .select("student_id, score")
        .in("student_id", [...shutOutIds])
    : { data: [] };

  const lecturesMissed = (missed ?? []).filter((row) => Number(row.score) === 0).length;

  const levelCounts: Record<string, number> = { "100": 0, "200": 0, "300": 0, "400": 0 };
  for (const student of students ?? []) {
    if (!shutOutIds.has(student.id)) continue;
    const key = String(student.level ?? "");
    if (key in levelCounts) levelCounts[key] += 1;
  }

  const today = new Date().toISOString().slice(0, 10);

  const records: GracePeriodRecord[] = (periods ?? []).map((row) => {
    const person = one(row.profiles as unknown as { surname: string; first_name: string });
    return {
      id: row.id,
      scope: scopeLabel(row.scope, row.level),
      expiresOn: row.expires_on,
      reason: row.reason,
      grantedBy: person ? `${person.first_name} ${person.surname}` : "—",
      grantedAt: row.granted_at,
      studentsAffected: row.students_affected,
      revokedAt: row.revoked_at,
    };
  });

  const active =
    records.find((record) => !record.revokedAt && record.expiresOn >= today) ?? null;

  return {
    active,
    history: records.filter((record) => record.id !== active?.id),
    impact: { shutOut: shutOutIds.size, lecturesMissed },
    levelCounts,
  };
}

export type AttendanceDispute = {
  id: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  courseCode: string;
  heldOn: string;
  studentNote: string;
  recordedReason: string;
  source: "digital" | "manually_entered";
  status: "open" | "upheld" | "corrected";
};

export async function loadDisputes(): Promise<AttendanceDispute[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: rows } = await db
    .from("attendance_disputes")
    .select(
      "id, student_id, checkpoint_id, student_note, status, raised_at, students(matric_no, profiles(surname, first_name, other_names)), session_instances(held_on, courses(code))",
    )
    .eq("status", "open")
    .order("raised_at", { ascending: false });

  if (!rows || rows.length === 0) return [];

  // What the system actually recorded, which is the first thing the HOD needs
  // — a rejection for being outside the hall reads very differently from one
  // for a code that had already expired.
  const checkpointIds = rows.map((row) => row.checkpoint_id).filter(Boolean) as string[];
  const { data: marks } = checkpointIds.length
    ? await db
        .from("attendance_marks")
        .select("student_id, checkpoint_id, reject_reason")
        .in("checkpoint_id", checkpointIds)
    : { data: [] };

  return rows.map((row) => {
    const student = one(
      row.students as unknown as {
        matric_no: string;
        profiles: { surname: string; first_name: string; other_names: string | null } | null;
      },
    );
    const person = one(student?.profiles);
    const instance = one(
      row.session_instances as unknown as { held_on: string; courses: { code: string } | null },
    );
    const mark = (marks ?? []).find(
      (entry) => entry.student_id === row.student_id && entry.checkpoint_id === row.checkpoint_id,
    );

    return {
      id: row.id,
      matricNo: student?.matric_no ?? "",
      surname: person?.surname ?? "",
      firstName: person?.first_name ?? "",
      otherNames: person?.other_names ?? null,
      courseCode: one(instance?.courses)?.code ?? "",
      heldOn: instance?.held_on ?? "",
      studentNote: row.student_note,
      // No mark at all means they never submitted — itself an answer, and not
      // the same as having been turned away.
      recordedReason: mark?.reject_reason ?? "no_submission",
      source: "digital",
      status: row.status as AttendanceDispute["status"],
    };
  });
}

// ---------------------------------------------------------------------------
// One student, in full
// ---------------------------------------------------------------------------

export type StudentRecord = {
  standing: StudentStanding;
  trail: Array<{
    id: string;
    action: string;
    actor: string;
    reason: string | null;
    createdAt: string;
  }>;
};

/**
 * The HOD's view of a single student.
 *
 * Built from `loadStandings` rather than its own query, so the percentage on
 * this page is the same number the at-risk list and the eligibility list show.
 * Three screens computing the same figure three ways is how they end up
 * disagreeing in front of the student it is about.
 */
export async function loadStudentRecord(matricNo: string): Promise<StudentRecord | null> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const standings = await loadStandings(db);
  const standing = standings.find(
    (student) => student.matricNo.toUpperCase() === matricNo.toUpperCase(),
  );
  if (!standing) return null;

  // Matched on the student's id, not their matric number. Audit rows record
  // whichever key the action was about — a dispute row carries the dispute's id —
  // so the student id in the metadata is the only field common to all of them.
  const { data: rows } = await db
    .from("audit_log")
    .select("id, actor_id, action, reason, created_at, target_id, metadata")
    .order("created_at", { ascending: false })
    .limit(200);

  const mine = (rows ?? []).filter(
    (row) =>
      row.target_id === standing.studentId ||
      (row.metadata as { student_id?: string } | null)?.student_id === standing.studentId,
  );

  const actorIds = [...new Set(mine.map((row) => row.actor_id).filter(Boolean))];
  const { data: people } = actorIds.length
    ? await db.from("profiles").select("id, surname, first_name").in("id", actorIds)
    : { data: [] };

  const nameById = new Map(
    (people ?? []).map((person) => [person.id, `${person.first_name} ${person.surname}`]),
  );

  return {
    standing,
    trail: mine.map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor_id ? (nameById.get(row.actor_id) ?? "Unknown account") : "Scheduled task",
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lecturer oversight
// ---------------------------------------------------------------------------

export type LecturerOversight = {
  lecturerId: string;
  name: string;
  sessionsHeld: number;
  paperBatches: number;
  cancelled: number;
};

/**
 * What turns the paper fallback into a monitored path rather than a silent
 * backdoor.
 *
 * Every number here is a count the screen turns into a rate, because a raw
 * count punishes whoever teaches the most. A lecturer with two paper batches
 * out of forty lectures is not the same as one with two out of four.
 */
export async function loadLecturerOversight(): Promise<LecturerOversight[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: lecturers } = await db
    .from("profiles")
    .select("id, surname, first_name")
    .eq("role", "lecturer")
    .order("surname");

  const lecturerIds = (lecturers ?? []).map((row) => row.id);
  if (lecturerIds.length === 0) return [];

  const { data: courses } = await db
    .from("courses")
    .select("id, lecturer_id")
    .in("lecturer_id", lecturerIds);

  const courseIds = (courses ?? []).map((course) => course.id);
  const lecturerByCourse = new Map(
    (courses ?? []).map((course) => [course.id, course.lecturer_id as string]),
  );

  const [{ data: instances }, { data: batches }] = await Promise.all([
    courseIds.length
      ? db
          .from("session_instances")
          .select("id, course_id, status")
          .in("course_id", courseIds)
      : Promise.resolve({ data: [] }),
    db.from("manual_attendance_batches").select("session_instance_id"),
  ]);

  const batched = new Set((batches ?? []).map((row) => row.session_instance_id));

  const tally = new Map<string, Omit<LecturerOversight, "lecturerId" | "name">>();
  for (const id of lecturerIds) {
    tally.set(id, { sessionsHeld: 0, paperBatches: 0, cancelled: 0 });
  }

  for (const instance of instances ?? []) {
    const lecturerId = lecturerByCourse.get(instance.course_id);
    if (!lecturerId) continue;
    const row = tally.get(lecturerId);
    if (!row) continue;

    if (instance.status === "cancelled") {
      row.cancelled += 1;
      continue;
    }

    // Only closed lectures are counted. One still open is not yet a fact about
    // how it was run, and counting it would move the rate for an hour and then
    // move it back.
    if (instance.status !== "closed") continue;

    row.sessionsHeld += 1;
    if (batched.has(instance.id)) row.paperBatches += 1;
  }

  return (lecturers ?? []).map((lecturer) => ({
    lecturerId: lecturer.id,
    name: `${lecturer.first_name} ${lecturer.surname}`,
    ...(tally.get(lecturer.id) ?? { sessionsHeld: 0, paperBatches: 0, cancelled: 0 }),
  }));
}

/* -------------------------------------------------------------------------
   Messaging (§7.3)

   Three audiences, drawn from the registration data. Everything about how a
   message physically goes out — the channels, the WhatsApp→SMS fallback, the
   delivery record — belongs to `queue_notification()` and is not restated
   here. A second messaging path would be a second thing that can fail to
   deliver and a second set of channel rules to drift.
   ------------------------------------------------------------------------- */

export type MessageScope = "student" | "level" | "course" | "programme_level";

export type SendMessageResult = { messageId: string; recipients: number };

export async function messageAudience(
  scope: MessageScope,
  target: string | null,
  level: number | null,
  programme: string | null = null,
): Promise<number> {
  const db = createServiceClient();
  const { data } = await db.rpc("hod_message_audience", {
    p_scope: scope,
    p_target: target,
    p_level: level,
    p_programme: programme,
  });
  return Number(data ?? 0);
}

export async function sendHodMessage(input: {
  actorId: string;
  scope: MessageScope;
  target: string | null;
  level: number | null;
  programme?: string | null;
  subject: string;
  body: string;
}): Promise<SendMessageResult> {
  const db = createServiceClient();
  const { data, error } = await db.rpc("send_hod_message", {
    p_actor_id: input.actorId,
    p_scope: input.scope,
    p_target: input.target,
    p_level: input.level,
    p_subject: input.subject,
    p_body: input.body,
    p_programme: input.programme ?? null,
  });

  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    messageId: String(row?.message_id ?? ""),
    recipients: Number(row?.recipients ?? 0),
  };
}

export type SentMessage = {
  id: string;
  scope: MessageScope;
  audience: string;
  subject: string;
  body: string;
  recipients: number;
  sentAt: string;
};

export async function loadSentMessages(): Promise<SentMessage[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data } = await db
    .from("hod_messages")
    .select(
      "id, scope, level, programme, subject, body, recipients, sent_at, courses(code), students(matric_no)",
    )
    .order("sent_at", { ascending: false })
    .limit(30);

  return (data ?? []).map((row) => {
    const course = one(row.courses as unknown as { code: string });
    const student = one(row.students as unknown as { matric_no: string });

    return {
      id: row.id,
      scope: row.scope as MessageScope,
      audience:
        row.scope === "course"
          ? (course?.code ?? "a course")
          : row.scope === "programme_level"
            ? programmeLevelLabel(row.programme, row.level)
            : row.scope === "level"
              ? `Level ${row.level}`
              : (student?.matric_no ?? "one student"),
      subject: row.subject,
      body: row.body,
      recipients: row.recipients,
      sentAt: row.sent_at,
    };
  });
}

export type PaymentComplianceRow = {
  level: number;
  students: number;
  paidInFull: number;
  partPaid: number;
  nothingPaid: number;
  outstandingKobo: number;
};

/**
 * §7.2, and it exists BECAUSE payment was decoupled.
 *
 * Dues used to be visible on every attendance screen as a side effect of
 * gating it. They gate nothing now, which means the department's money is
 * invisible unless somebody goes looking — so there is a screen to look at.
 */
export async function loadPaymentCompliance(): Promise<PaymentComplianceRow[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data } = await db.rpc("payment_compliance_report", {
    p_academic_session_id: null,
  });

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    level: Number(row.level ?? 0),
    students: Number(row.students ?? 0),
    paidInFull: Number(row.paid_in_full ?? 0),
    partPaid: Number(row.part_paid ?? 0),
    nothingPaid: Number(row.nothing_paid ?? 0),
    outstandingKobo: Number(row.outstanding_kobo ?? 0),
  }));
}

export type CourseChoice = { courseId: string; code: string; title: string };

/** Every course in the active session, for the audience picker. */
export async function loadCourseChoices(): Promise<CourseChoice[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  const { data } = await db
    .from("courses")
    .select("id, code, title")
    .eq("academic_session_id", session?.id ?? "")
    .order("code");

  return (data ?? []).map((row) => ({
    courseId: row.id,
    code: row.code,
    title: row.title,
  }));
}
