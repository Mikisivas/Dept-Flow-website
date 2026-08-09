import "server-only";

import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/client";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import { attendancePct } from "@/lib/format";
import type { SessionClaims } from "@/lib/auth/session";
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
  pending: { disputes: number; waivers: number };
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
    confirmedScore: number;
    provisionalScore: number;
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
        .select("id, course_id, held_on, checkpoint_mode")
        .eq("status", "closed")
        .order("held_on"),
      db.from("session_scores").select("student_id, session_instance_id, score, status"),
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
      const confirmedScore = relevant
        .filter((score) => score.status === "confirmed")
        .reduce((sum, score) => sum + Number(score.score), 0);
      const provisionalScore = relevant
        .filter((score) => score.status === "provisional")
        .reduce((sum, score) => sum + Number(score.score), 0);

      const scoreByInstance = new Map(relevant.map((score) => [score.session_instance_id, score]));

      const sessions: SessionCell[] = held.map((instance, index) => {
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
          source: "digital",
          score: value,
        };
      });

      return {
        courseId: enrolment.course_id,
        code: course?.code ?? "",
        confirmedScore,
        provisionalScore,
        sessionsHeld: held.length,
        pct: attendancePct(confirmedScore, held.length),
        sessions,
      };
    });

    const totalConfirmed = courses.reduce((sum, course) => sum + course.confirmedScore, 0);
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

  const [{ data: grace }, { count: disputes }, { count: waivers }, { data: predictions }] =
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
      db.from("waivers").select("id", { count: "exact", head: true }).eq("status", "pending"),
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
    pending: { disputes: disputes ?? 0, waivers: waivers ?? 0 },
  };
}

export type AtRiskStudent = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  courseCode: string;
  currentPct: number;
  predictedPct: number;
  pattern: "disengagement" | "partial_attendance";
  sessions: SessionCell[];
};

/**
 * The advisory list. `currentPct` is a determination; `predictedPct` is a
 * guess — they sit in separate columns and the screen says which is which,
 * because a student is never barred from an exam on the strength of a model.
 */
export async function loadAtRiskStudents(): Promise<AtRiskStudent[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const [{ data: predictions }, standings] = await Promise.all([
    db
      .from("risk_predictions")
      .select("student_id, course_id, predicted_pct, pattern, courses(code)")
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
        courseCode: course?.code ?? "",
        currentPct: standing?.pct ?? 0,
        predictedPct: Number(prediction.predicted_pct),
        pattern: prediction.pattern as AtRiskStudent["pattern"],
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
  /** Recorded but uncounted marks. Why a student can be short and disputing it. */
  provisionalScore: number;
};

export type EligibilityList = {
  courses: Array<{ courseId: string; code: string; title: string }>;
  course: { courseId: string; code: string; title: string } | null;
  thresholdPct: number;
  rows: EligibilityRow[];
  authorizedAt: string | null;
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
    return { courses, course: null, thresholdPct: 75, rows: [], authorizedAt: null };
  }

  const { data: list } = await db
    .from("eligibility_lists")
    .select("threshold_pct, status, authorized_at")
    .eq("course_id", chosen.courseId)
    .maybeSingle();

  const thresholdPct = Number(list?.threshold_pct ?? 75);
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
        scoreTotal: course.confirmedScore,
        sessionsHeld: course.sessionsHeld,
        eligible: course.sessionsHeld > 0 && course.pct >= thresholdPct,
        provisionalScore: course.provisionalScore,
      };
    })
    .sort((a, b) => a.matricNo.localeCompare(b.matricNo));

  return {
    courses,
    course: chosen,
    thresholdPct,
    rows,
    authorizedAt: list?.status === "authorized" ? (list.authorized_at ?? null) : null,
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
  impact: { lockedStudents: number; sessionsWaiting: number };
  levelCounts: Record<string, number>;
};

function scopeLabel(scope: string, level: number | null): string {
  return scope === "department" ? "The whole department" : `Level ${level} only`;
}

export async function loadGraceScreen(): Promise<GraceScreen> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  const [{ data: periods }, { data: locked }, { data: waiting }] = await Promise.all([
    db
      .from("grace_periods")
      .select(
        "id, scope, level, expires_on, reason, granted_at, students_affected, revoked_at, profiles:granted_by(surname, first_name)",
      )
      .eq("academic_session_id", session?.id ?? "")
      .order("granted_at", { ascending: false }),
    db
      .from("compliance_statuses")
      .select("student_id, students(level)")
      .eq("academic_session_id", session?.id ?? "")
      .eq("state", "locked"),
    db.from("session_scores").select("student_id, score").eq("status", "provisional"),
  ]);

  const lockedIds = new Set((locked ?? []).map((row) => row.student_id));

  // Only the marks belonging to locked students. The total across everyone
  // would be a bigger, more persuasive number and would not be the one the
  // HOD is deciding about.
  const sessionsWaiting = (waiting ?? [])
    .filter((row) => lockedIds.has(row.student_id))
    .reduce((sum, row) => sum + Number(row.score), 0);

  const levelCounts: Record<string, number> = { "100": 0, "200": 0, "300": 0, "400": 0 };
  for (const row of locked ?? []) {
    const student = one(row.students as unknown as { level: number });
    const key = String(student?.level ?? "");
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
    impact: { lockedStudents: lockedIds.size, sessionsWaiting: Math.round(sessionsWaiting) },
    levelCounts,
  };
}

export type WaiverRequest = {
  id: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  requestNote: string;
  requestedAt: string;
  /** What granting would immediately confirm. The thing being decided about. */
  provisionalScore: number;
  status: "pending" | "granted" | "declined";
};

export async function loadWaivers(): Promise<WaiverRequest[]> {
  await requireHod();
  const db = createUserClient(await currentAccessToken());

  const { data: rows } = await db
    .from("waivers")
    .select(
      "id, student_id, request_note, created_at, status, students(matric_no, level, profiles(surname, first_name, other_names))",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (!rows || rows.length === 0) return [];

  // The waiting marks, per student. Granting confirms exactly these, so the
  // figure on the card is the consequence rather than a decoration.
  const { data: scores } = await db
    .from("session_scores")
    .select("student_id, score")
    .eq("status", "provisional")
    .in(
      "student_id",
      rows.map((row) => row.student_id),
    );

  const waitingByStudent = new Map<string, number>();
  for (const score of scores ?? []) {
    waitingByStudent.set(
      score.student_id,
      (waitingByStudent.get(score.student_id) ?? 0) + Number(score.score),
    );
  }

  return rows.map((row) => {
    const student = one(
      row.students as unknown as {
        matric_no: string;
        level: number;
        profiles: { surname: string; first_name: string; other_names: string | null } | null;
      },
    );
    const person = one(student?.profiles);

    return {
      id: row.id,
      matricNo: student?.matric_no ?? "",
      surname: person?.surname ?? "",
      firstName: person?.first_name ?? "",
      otherNames: person?.other_names ?? null,
      level: student?.level ?? 0,
      requestNote: row.request_note ?? "",
      requestedAt: row.created_at,
      provisionalScore: waitingByStudent.get(row.student_id) ?? 0,
      status: row.status as WaiverRequest["status"],
    };
  });
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
  // whichever key the action was about — a waiver row carries the waiver's id —
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
  singleCheckpoint: number;
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
          .select("id, course_id, status, checkpoint_mode")
          .in("course_id", courseIds)
      : Promise.resolve({ data: [] }),
    db.from("manual_attendance_batches").select("session_instance_id"),
  ]);

  const batched = new Set((batches ?? []).map((row) => row.session_instance_id));

  const tally = new Map<string, Omit<LecturerOversight, "lecturerId" | "name">>();
  for (const id of lecturerIds) {
    tally.set(id, { sessionsHeld: 0, paperBatches: 0, singleCheckpoint: 0, cancelled: 0 });
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
    if (instance.checkpoint_mode === "single") row.singleCheckpoint += 1;
    if (batched.has(instance.id)) row.paperBatches += 1;
  }

  return (lecturers ?? []).map((lecturer) => ({
    lecturerId: lecturer.id,
    name: `${lecturer.first_name} ${lecturer.surname}`,
    ...(tally.get(lecturer.id) ?? {
      sessionsHeld: 0,
      paperBatches: 0,
      singleCheckpoint: 0,
      cancelled: 0,
    }),
  }));
}
