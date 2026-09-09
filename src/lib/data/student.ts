import "server-only";

import { createUserClient } from "@/lib/supabase/client";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import { loadLiveCheckpoint } from "@/lib/data/attendance";
import { lagosToday } from "@/lib/format";
import { permitQr, permitVerifyUrl } from "@/lib/permit-qr";
import type {
  ComplianceState,
  CourseAttendance,
  CourseForecast,
  RiskPattern,
  RiskTier,
  SessionCell,
} from "@/lib/types";
import type { DuesPeriod, StudentProfile, TodayClass } from "@/lib/data/fixtures";
import { allOk, ok } from "@/lib/supabase/result";

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
   * session — once the window closes, paying is shut. It no longer has
   * anything to do with recording attendance, which continues either way.
   */
  paymentOpen: boolean;
  dues: DuesPeriod;
  courses: CourseAttendance[];
  today: TodayClass[];
  /** One per course the student is registered for, worst first. */
  forecasts: CourseForecast[];
  /**
   * The single worst course. Kept for the one place with room for one
   * sentence; anything with room for more reads `forecasts`.
   */
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

  const { data: entries } = ok(await db
    .from("timetable_entries")
    .select("course_id, start_time, end_time, venue_id")
    .in(
      "course_id",
      courses.map((course) => course.courseId),
    )
    .eq("day_of_week", dayOfWeek), "entries");

  if (!entries || entries.length === 0) return [];

  const { data: venues } = ok(await db
    .from("venue_directory")
    .select("id, name")
    .in("id", [...new Set(entries.map((entry) => entry.venue_id))]), "venues");

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
          live && live.courseCode === course?.code ? { expiresAt: live.expiresAt } : null,
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
  const [instanceRead, scoreRead] = courseIds.length
    ? await Promise.all([
        db
          .from("session_instances")
          .select("id, course_id, held_on, status")
          .in("course_id", courseIds)
          .eq("status", "closed")
          .order("held_on"),
        db
          .from("session_scores")
          .select("session_instance_id, score, source")
          .eq("student_id", session.profileId),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  // Checked, not shrugged off.
  //
  // A failed read and a student with no lectures both arrive here as an empty
  // array, and they mean opposite things: one is "nothing happened yet", the
  // other is "we cannot see what happened". Swallowing the error renders a
  // confident, wrong dashboard — 0% attendance for a student who attended ten
  // lectures — with nothing anywhere to say so.
  //
  // This is not hypothetical. `checkpoint_mode` was dropped by the trust-based
  // migration and left behind in this select; PostgREST rejected the query,
  // the error went in the bin, and every student read zero for three courses
  // while the database held the right answer all along.
  if (instanceRead.error) {
    throw new DashboardUnavailable("session_instances", instanceRead.error.message);
  }
  if (scoreRead.error) {
    throw new DashboardUnavailable("session_scores", scoreRead.error.message);
  }

  const instances = instanceRead.data;
  const scores = scoreRead.data;

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

      return {
        id: instance.id,
        label: `Week ${index + 1}`,
        heldOn: instance.held_on,
        // The stored score is the source of truth; the cell is drawn from it
        // rather than from a second read of attendance_marks.
        attended: value > 0,
        source: score?.source === "manually_entered" ? "manually_entered" : "digital",
        score: value,
      };
    });

    const attendedCount = sessions.reduce((sum, s) => sum + s.score, 0);

    return {
      courseId: course.id,
      code: course.code,
      title: course.title,
      attendedCount,
      sessionsHeld: held.length,
      sessions,
    };
  });

  // The grace period the HOD actually opened, not the static column on
  // dues_periods. Without this the HOD unlocks a level and the students it
  // covers see nothing on the screen that told them they were locked.
  const { data: grace } = ok(await db
    .from("grace_periods")
    .select("expires_on, scope, level")
    .eq("academic_session_id", activeSession.id)
    .is("revoked_at", null)
    .gte("expires_on", new Date().toISOString().slice(0, 10))
    .order("expires_on", { ascending: false }), "grace");

  const covering = (grace ?? []).find(
    (row) => row.scope === "department" || row.level === student.level,
  );

  const today = await loadToday(db, session.profileId, courses);

  // Every course, not just the worst one. The dashboard used to show a single
  // nudge about whichever course had the lowest number, which meant a student
  // in trouble on two courses heard about one of them — and the whole claim
  // this system makes is that it tells you what to do, per course.
  const { data: forecasts } = ok(await db
    .from("risk_predictions")
    .select(
      "course_id, predicted_pct, tier, trend, lectures_held, lectures_expected, must_attend, can_still_miss, pattern, courses(code)",
    )
    .eq("student_id", session.profileId)
    .order("predicted_pct"), "forecasts");

  const resumption = dues?.resumption_date ?? new Date().toISOString();

  // Instalments, summed by the database rather than here: dues_balance_kobo()
  // is what apply_payment() uses to decide whether a payment clears a student,
  // and a screen that added up the payments itself would eventually disagree
  // with the decision that was actually made.
  const { data: paid } = ok(await db.rpc("dues_paid_kobo", {
    p_student_id: session.profileId,
    p_academic_session_id: activeSession.id,
  }), "paid");
  const { data: balance } = ok(await db.rpc("dues_balance_kobo", {
    p_student_id: session.profileId,
    p_academic_session_id: activeSession.id,
  }), "balance");

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
      paidKobo: Number(paid ?? 0),
      balanceKobo: Number(balance ?? 0),
      resumptionDate: resumption,
      // Day 30 of the payment window, counted from resumption.
      deadline: new Date(new Date(resumption).getTime() + 30 * 86_400_000).toISOString(),
      gracePeriodEnd: covering?.expires_on ?? dues?.grace_period_end ?? null,
    },
    courses,
    today,
    forecasts: (forecasts ?? []).map((row) => ({
      courseId: row.course_id as string,
      courseCode: one(row.courses as unknown as { code: string })?.code ?? "",
      tier: (row.tier ?? "safe") as RiskTier,
      projectedPct: Number(row.predicted_pct ?? 0),
      trend: Number(row.trend ?? 0),
      lecturesHeld: Number(row.lectures_held ?? 0),
      lecturesExpected: Number(row.lectures_expected ?? 0),
      mustAttend: Number(row.must_attend ?? 0),
      canStillMiss: Number(row.can_still_miss ?? 0),
      pattern: (row.pattern ?? null) as RiskPattern | null,
    })),
    risk: forecasts?.[0]
      ? {
          pattern: forecasts[0].pattern as RiskPattern,
          courseCode: one(forecasts[0].courses as unknown as { code: string })?.code ?? "",
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

  const { data: enrolments } = ok(await db
    .from("enrolments")
    .select("course_id, enrolled_on, courses(id, code, title, lecturer_id)")
    .eq("student_id", session.profileId)
    .is("dropped_at", null), "enrolments");

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

  const [{ data: instances }, { data: scores }, { data: entry }] = allOk(await Promise.all([
    db
      .from("session_instances")
      .select("id, held_on")
      .eq("course_id", course.id)
      .eq("status", "closed")
      .gte("held_on", enrolment.enrolled_on)
      .order("held_on"),
    db
      .from("session_scores")
      .select("session_instance_id, score, source")
      .eq("student_id", session.profileId),
    db
      .from("timetable_entries")
      .select("day_of_week, start_time, end_time, venue_id")
      .eq("course_id", course.id)
      .maybeSingle(),
  ]), "instances, scores, entry");

  const scoreByInstance = new Map((scores ?? []).map((row) => [row.session_instance_id, row]));

  const sessions: SessionCell[] = (instances ?? []).map((instance, index) => {
    const score = scoreByInstance.get(instance.id);
    const value = Number(score?.score ?? 0);

    return {
      id: instance.id,
      label: `Week ${index + 1}`,
      heldOn: instance.held_on,
      attended: value > 0,
      source: score?.source === "manually_entered" ? "manually_entered" : "digital",
      score: value,
    };
  });

  const [{ data: lecturer }, { data: venue }, { data: risk }] = allOk(await Promise.all([
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
  ]), "lecturer, venue, risk");

  return {
    course: {
      courseId: course.id,
      code: course.code,
      title: course.title,
      attendedCount: sessions.reduce((sum, s) => sum + s.score, 0),
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
  const { data } = ok(await db
    .from("notifications")
    .select("id, kind, title, body, link, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100), "the student's notifications");

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

  const { data } = ok(await db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null)
    .select("id"), "marking notifications read");

  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// The exam permit
// ---------------------------------------------------------------------------

export type ExamPermit = {
  reference: string;
  issuedAt: string;
  session: string;
  student: { matricNo: string; name: string; level: number };
  courses: Array<{ code: string; title: string; attendancePct: number }>;
  /** Authorized lists that decided against them. Shown, never hidden. */
  refused: Array<{ code: string; title: string; attendancePct: number }>;
  /** Where the QR on the document points. Absolute — it is scanned off paper. */
  verifyUrl: string;
  /** The QR itself, as an inline SVG. See `permitQr()` for why it is a string. */
  qrSvg: string;
};

/** One course on the live panel: where the student stands and what would fix it. */
export type PermitOutstanding = {
  courseId: string;
  code: string;
  title: string;
  attendancePct: number;
  lecturesHeld: number;
  attended: number;
  lecturesRemaining: number;
  /** Of the lectures still to come, how many they must attend. Capped at what exists. */
  mustAttend: number;
  /** False when even attending every remaining lecture finishes below the line. */
  reachable: boolean;
  eligible: boolean;
};

/**
 * §9.2 — what is outstanding, per student, instead of a flat yes/no.
 *
 * Shown in every state including the good one. A student who has met both
 * conditions still wants to see that they have, and a panel that only appears
 * when something is wrong is one students learn to dread and then avoid.
 */
export type PermitPanel = {
  courses: PermitOutstanding[];
  thresholdPct: number;
  duesTotalKobo: number;
  duesPaidKobo: number;
  duesOutstandingKobo: number;
};

export type PermitStatus = { panel: PermitPanel } & (
  | { state: "issued"; permit: ExamPermit }
  /** Cleared for at least one paper, but no reference allocated yet. */
  | { state: "needs_issue"; eligibleCourses: string[] }
  /** §9.1 — the attendance half is met and the dues half is not. */
  | { state: "dues_outstanding"; eligibleCourses: string[] }
  /** Authorized, and it decided against them everywhere. */
  | { state: "not_eligible"; refused: Array<{ code: string; title: string; attendancePct: number }> }
  /** The HOD has not authorized any list this student is on. */
  | { state: "not_authorized"; pendingCourses: string[] }
);

/**
 * The student's own exam permit, and the panel of what is still outstanding.
 *
 * Two figures for the same courses, and the difference between them is the
 * point rather than a bug:
 *
 *   * The PANEL is live. It answers "what do I still have to do", and a stale
 *     answer to that is useless — the student is asking so they can act today.
 *
 *   * The DOCUMENT comes from AUTHORIZED eligibility lists, never from live
 *     attendance. A permit computed from current figures could contradict the
 *     list the exam board sat with, and the system would have forged it
 *     itself.
 *
 * The screen labels which is which. A student comparing the two is entitled to
 * know that one is the department's decision and the other is where they stand
 * this morning.
 */
export async function loadExamPermit(): Promise<PermitStatus> {
  const session = await currentUser();
  if (!session) throw new DashboardUnavailable("Not signed in");

  const db = createUserClient(await currentAccessToken());

  const { data: activeSession } = ok(await db
    .from("academic_sessions")
    .select("id, name")
    .eq("is_active", true)
    .maybeSingle(), "activeSession");

  if (!activeSession) throw new DashboardUnavailable("academic_sessions");

  const [{ data: student }, { data: profile }, { data: enrolments }] = allOk(await Promise.all([
    db.from("students").select("matric_no, level").eq("id", session.profileId).maybeSingle(),
    db
      .from("profiles")
      .select("surname, first_name, other_names")
      .eq("id", session.profileId)
      .maybeSingle(),
    db
      .from("enrolments")
      .select("course_id, courses(code, title)")
      .eq("student_id", session.profileId)
      .is("dropped_at", null),
  ]), "student, profile, enrolments");

  const courseInfo = new Map(
    (enrolments ?? []).map((row) => {
      const course = one(row.courses as unknown as { code: string; title: string });
      return [row.course_id, { code: course?.code ?? "", title: course?.title ?? "" }];
    }),
  );

  const { data: entries } = ok(await db
    .from("eligibility_entries")
    .select("attendance_pct, eligible, eligibility_lists(course_id, status, academic_session_id)")
    .eq("student_id", session.profileId), "entries");

  const decided = (entries ?? [])
    .map((entry) => {
      const list = one(
        entry.eligibility_lists as unknown as {
          course_id: string;
          status: string;
          academic_session_id: string;
        },
      );
      return { entry, list };
    })
    .filter(
      (row) =>
        row.list?.status === "authorized" && row.list.academic_session_id === activeSession.id,
    );

  const toRow = (row: (typeof decided)[number]) => ({
    code: courseInfo.get(row.list!.course_id)?.code ?? "",
    title: courseInfo.get(row.list!.course_id)?.title ?? "",
    attendancePct: Number(row.entry.attendance_pct),
  });

  const eligible = decided.filter((row) => row.entry.eligible).map(toRow);
  const refused = decided.filter((row) => !row.entry.eligible).map(toRow);

  const panel = await loadPermitPanel(db, session.profileId, activeSession.id);

  if (decided.length === 0) {
    return {
      panel,
      state: "not_authorized",
      pendingCourses: [...courseInfo.values()].map((course) => course.code).sort(),
    };
  }

  if (eligible.length === 0) return { panel, state: "not_eligible", refused };

  const eligibleCourses = eligible.map((course) => course.code).sort();

  // §9.1, the dues half, applied to the DOCUMENT.
  //
  // Checked before the issued state rather than only at issue, so that a
  // reversed payment takes the permit back. Without this, a student could pay,
  // print, charge back, and still be holding a rendered permit — and §8 says a
  // reversal re-locks, which has to mean something here too.
  if (panel.duesOutstandingKobo > 0) {
    return { panel, state: "dues_outstanding", eligibleCourses };
  }

  // Issuing needs to write, so it goes through the API rather than here. The
  // page asks for the permit; the route allocates the reference.
  const { data: existing } = ok(await db
    .from("exam_permits")
    .select("reference, issued_at")
    .eq("student_id", session.profileId)
    .eq("academic_session_id", activeSession.id)
    .maybeSingle(), "existing");

  // Eligible, but nobody has asked for the document yet. Allocating the
  // reference is a write, so it goes through the API rather than a page load —
  // opening a screen should not create a record.
  if (!existing) {
    return { panel, state: "needs_issue", eligibleCourses };
  }

  const verifyUrl = permitVerifyUrl(existing.reference);

  return {
    panel,
    state: "issued",
    permit: {
      reference: existing.reference,
      issuedAt: existing.issued_at,
      session: activeSession.name,
      student: {
        matricNo: student?.matric_no ?? "",
        name: profile
          ? [profile.surname?.toUpperCase(), profile.first_name, profile.other_names]
              .filter(Boolean)
              .join(", ")
              .replace(",", ",")
          : "",
        level: student?.level ?? 0,
      },
      courses: eligible.sort((a, b) => a.code.localeCompare(b.code)),
      refused: refused.sort((a, b) => a.code.localeCompare(b.code)),
      verifyUrl,
      qrSvg: await permitQr(verifyUrl),
    },
  };
}

/**
 * The live panel (§9.2).
 *
 * `permit_eligibility()` is built on `student_semester_report()`, which is
 * what §6.3 asks for: the permit and the semester report are one generator.
 * Two functions computing the same percentage would eventually disagree, and
 * they would disagree in front of the student they are about.
 */
async function loadPermitPanel(
  db: ReturnType<typeof createUserClient>,
  studentId: string,
  academicSessionId: string,
): Promise<PermitPanel> {
  const [{ data: rows }, { data: config }, { data: dues }, { data: paid }, { data: balance }] =
    allOk(await Promise.all([
      db.rpc("permit_eligibility", {
        p_student_id: studentId,
        p_academic_session_id: academicSessionId,
      }),
      db.from("app_config").select("attendance_threshold_pct").eq("id", 1).maybeSingle(),
      db
        .from("dues_periods")
        .select("dues_amount_kobo")
        .eq("academic_session_id", academicSessionId)
        .maybeSingle(),
      db.rpc("dues_paid_kobo", {
        p_student_id: studentId,
        p_academic_session_id: academicSessionId,
      }),
      db.rpc("dues_balance_kobo", {
        p_student_id: studentId,
        p_academic_session_id: academicSessionId,
      }),
    ]), "rows, config, dues, paid, balance");

  return {
    courses: ((rows ?? []) as Record<string, unknown>[]).map((row) => ({
      courseId: String(row.course_id ?? ""),
      code: String(row.course_code ?? ""),
      title: String(row.course_title ?? ""),
      attendancePct: Number(row.attendance_pct ?? 0),
      lecturesHeld: Number(row.lectures_held ?? 0),
      attended: Number(row.attended ?? 0),
      lecturesRemaining: Number(row.lectures_remaining ?? 0),
      mustAttend: Number(row.must_attend ?? 0),
      reachable: Boolean(row.reachable),
      eligible: Boolean(row.eligible),
    })),
    thresholdPct: Number(config?.attendance_threshold_pct ?? 75),
    duesTotalKobo: Number(dues?.dues_amount_kobo ?? 0),
    duesPaidKobo: Number(paid ?? 0),
    duesOutstandingKobo: Number(balance ?? 0),
  };
}

/* -------------------------------------------------------------------------
   Reports (§6)

   Three windows on the same term. The computation is in the database, in
   `student_period_report()` and `student_semester_report()` — the second of
   which the exam permit also reads, so the report and the permit cannot
   disagree about who may sit.
   ------------------------------------------------------------------------- */

export type PeriodReport = {
  lecturesHeld: number;
  attended: number;
  /** Null when no lecture fell in the window — not zero, which is a claim. */
  periodPct: number | null;
  previousPct: number | null;
  delta: number | null;
  overallPct: number;
};

export type SemesterReportRow = {
  courseId: string;
  courseCode: string;
  courseTitle: string;
  lecturesHeld: number;
  attended: number;
  attendancePct: number;
  eligible: boolean;
  mustAttend: number;
  projectedPct: number | null;
};

export type StudentReports = {
  weekly: PeriodReport;
  monthly: PeriodReport;
  semester: SemesterReportRow[];
  thresholdPct: number;
};

export async function loadStudentReports(): Promise<StudentReports> {
  const session = await currentUser();
  if (!session) throw new Error("Not signed in.");

  const db = createUserClient(await currentAccessToken());

  const [{ data: weekly }, { data: monthly }, { data: semester }, { data: config }] =
    allOk(await Promise.all([
      db.rpc("student_period_report", { p_student_id: session.profileId, p_days: 7 }),
      db.rpc("student_period_report", { p_student_id: session.profileId, p_days: 30 }),
      db.rpc("student_semester_report", { p_student_id: session.profileId }),
      db.from("app_config").select("attendance_threshold_pct").eq("id", 1).maybeSingle(),
    ]), "weekly, monthly, semester, config");

  return {
    weekly: periodOf(weekly),
    monthly: periodOf(monthly),
    semester: (semester ?? []).map((row: Record<string, unknown>) => ({
      courseId: String(row.course_id),
      courseCode: String(row.course_code ?? ""),
      courseTitle: String(row.course_title ?? ""),
      lecturesHeld: Number(row.lectures_held ?? 0),
      attended: Number(row.attended ?? 0),
      attendancePct: Number(row.attendance_pct ?? 0),
      eligible: Boolean(row.eligible),
      mustAttend: Number(row.must_attend ?? 0),
      projectedPct: row.projected_pct === null ? null : Number(row.projected_pct),
    })),
    thresholdPct: Number(config?.attendance_threshold_pct ?? 75),
  };
}

function periodOf(data: unknown): PeriodReport {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

  return {
    lecturesHeld: Number(row?.lectures_held ?? 0),
    attended: Number(row?.attended ?? 0),
    // Null is preserved rather than coalesced to zero. "0%" and "no lectures
    // were held" are different sentences, and only one of them is about the
    // student.
    periodPct: row?.period_pct == null ? null : Number(row.period_pct),
    previousPct: row?.previous_pct == null ? null : Number(row.previous_pct),
    delta: row?.delta == null ? null : Number(row.delta),
    overallPct: Number(row?.overall_pct ?? 0),
  };
}
