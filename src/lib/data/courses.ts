import "server-only";

import { createServiceClient, createUserClient } from "@/lib/supabase/client";
import { currentAccessToken } from "@/lib/auth/current-user";

/**
 * The course catalogue, and a student's registration against it.
 *
 * Every rule about what may be added lives in the database — `add_optional_course`
 * and `drop_optional_course` — because the API is not the only thing that will
 * ever write `enrolments`. This module calls them and translates their answers
 * into sentences.
 */

export type CatalogueCourse = {
  courseId: string;
  code: string;
  title: string;
  level: number;
  kind: "core" | "elective";
  creditUnits: number;
  semester: number;
  lecturer: string | null;
  enrolled: number;
};

export type CourseUploadResult = {
  created: number;
  updated: number;
  enrolled: number;
  rejected: Array<{ line: number; reason: string }>;
};

/**
 * One CSV row. Deliberately strict about the course code: the department's
 * prefix for Computer Science is CMP, the database rejects CSC outright, and a
 * silently skipped row is how a course goes untracked for a term.
 */
function parseRow(line: string, index: number): { row?: Omit<CatalogueCourse, "courseId" | "lecturer" | "enrolled">; reason?: string } {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 4) return { reason: "needs at least code, title, level, kind" };

  const [code, title, levelText, kindText, unitsText, semesterText] = parts;
  const upper = code.toUpperCase();

  if (!/^(MTH|CMP|STA) [0-9]{3}$/.test(upper)) {
    return {
      reason: upper.startsWith("CSC")
        ? "Computer Science is CMP in this department, not CSC"
        : `"${code}" is not a course code — expected e.g. CMP 301`,
    };
  }
  if (!title) return { reason: "no title" };

  const level = Number(levelText);
  if (![100, 200, 300, 400].includes(level)) return { reason: `level "${levelText}" is not 100–400` };

  const kind = kindText.toLowerCase();
  if (kind !== "core" && kind !== "elective") return { reason: `kind must be core or elective` };

  const creditUnits = unitsText ? Number(unitsText) : 3;
  if (!Number.isInteger(creditUnits) || creditUnits < 1 || creditUnits > 6) {
    return { reason: `credit units must be 1–6` };
  }

  const semester = semesterText ? Number(semesterText) : 1;
  if (semester !== 1 && semester !== 2) return { reason: `semester must be 1 or 2` };

  void index;
  return { row: { code: upper, title, level, kind, creditUnits, semester } };
}

/**
 * Upload the course list for an academic session.
 *
 * Upserts on (session, code) so re-uploading a corrected list changes the
 * courses rather than duplicating them — and every enrolment, lecture and score
 * already hanging off those course ids survives, which a delete-and-recreate
 * would destroy.
 */
export async function uploadCourses(csv: string): Promise<CourseUploadResult> {
  const db = createServiceClient();

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  if (!session) throw new Error("There is no active academic session.");

  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Tolerate a header row, since a spreadsheet export always has one.
    .filter((line, index) => !(index === 0 && /^code\s*,/i.test(line)));

  const rejected: CourseUploadResult["rejected"] = [];
  const rows: Array<ReturnType<typeof parseRow>["row"] & object> = [];

  lines.forEach((line, index) => {
    const { row, reason } = parseRow(line, index);
    if (row) rows.push(row);
    else rejected.push({ line: index + 1, reason: reason ?? "could not read that line" });
  });

  if (rows.length === 0) return { created: 0, updated: 0, enrolled: 0, rejected };

  const { data: before } = await db
    .from("courses")
    .select("code")
    .eq("academic_session_id", session.id);

  const existing = new Set((before ?? []).map((row) => row.code));

  const { error } = await db.from("courses").upsert(
    rows.map((row) => ({
      academic_session_id: session.id,
      code: row.code,
      title: row.title,
      level: row.level,
      kind: row.kind,
      credit_units: row.creditUnits,
      semester: row.semester,
    })),
    { onConflict: "academic_session_id,code" },
  );

  if (error) throw new Error(`Could not save the courses: ${error.message}`);

  // A newly uploaded core course has to reach the students who are already
  // registered. Without this it exists, holds lectures, and counts for nobody.
  const levels = [...new Set(rows.filter((row) => row.kind === "core").map((row) => row.level))];
  let enrolled = 0;

  if (levels.length > 0) {
    const { data: students } = await db.from("students").select("id").in("level", levels);

    for (const student of students ?? []) {
      const { data: added } = await db.rpc("enrol_in_core_courses", {
        p_student_id: student.id,
        p_academic_session_id: session.id,
      });
      enrolled += typeof added === "number" ? added : 0;
    }
  }

  return {
    created: rows.filter((row) => !existing.has(row.code)).length,
    updated: rows.filter((row) => existing.has(row.code)).length,
    enrolled,
    rejected,
  };
}

/** The catalogue as the admin sees it, with enrolment counts. */
export async function loadCatalogue(): Promise<CatalogueCourse[]> {
  const db = createUserClient(await currentAccessToken());

  const { data: session } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .single();

  if (!session) return [];

  const { data: courses } = await db
    .from("courses")
    .select("id, code, title, level, kind, credit_units, semester, profiles:lecturer_id(surname, first_name)")
    .eq("academic_session_id", session.id)
    .order("level")
    .order("code");

  const ids = (courses ?? []).map((course) => course.id);
  const { data: enrolments } = ids.length
    ? await db.from("enrolments").select("course_id").in("course_id", ids).is("dropped_at", null)
    : { data: [] };

  const countByCourse = new Map<string, number>();
  for (const row of enrolments ?? []) {
    countByCourse.set(row.course_id, (countByCourse.get(row.course_id) ?? 0) + 1);
  }

  return (courses ?? []).map((course) => {
    const person = Array.isArray(course.profiles) ? course.profiles[0] : course.profiles;
    return {
      courseId: course.id,
      code: course.code,
      title: course.title,
      level: course.level,
      kind: course.kind as "core" | "elective",
      creditUnits: course.credit_units,
      semester: course.semester,
      lecturer: person ? `${person.first_name} ${person.surname}` : null,
      enrolled: countByCourse.get(course.id) ?? 0,
    };
  });
}

export type RegistrationOption = CatalogueCourse & {
  /** Whether this is a choice at their level or a course they are repeating. */
  addsAs: "elective" | "carry_over";
  enrolledAlready: boolean;
  /**
   * The session they last took this course in, or null if they never have.
   *
   * The department keeps no grade record, so nothing in this system knows
   * which courses a student FAILED — and neither does the admin, which is
   * why carry-overs could never really be "auto-flagged from the academic
   * record" the way the flow document imagines. What the system does know is
   * what each student was enrolled in, and the student knows which of those
   * they have to repeat. So this marks the candidates and leaves the choice
   * where the knowledge actually is.
   */
  takenBefore: string | null;
};

/** A course they took before that this session does not offer at all. */
export type UnofferedPriorCourse = {
  code: string;
  takenBefore: string;
};

export type StudentRegistration = {
  level: number;
  semester: number;
  creditCap: number;
  unitsUsed: number;
  registered: Array<
    CatalogueCourse & { source: "core" | "elective" | "carry_over"; canDrop: boolean }
  >;
  available: RegistrationOption[];
  /**
   * Previously taken, and not in this session's catalogue at all. A student
   * repeating one of these cannot register it here however long they look,
   * and finding that out in week eight is the failure worth preventing.
   */
  unoffered: UnofferedPriorCourse[];
  /**
   * Registration is a deliberate, final action rather than the accumulation of
   * clicks it used to be. Until it is confirmed there is no moment at which a
   * student has finished, and after the deadline an unconfirmed student cannot
   * record attendance at all — so the screen has to say where they stand.
   */
  confirmation: {
    status: "draft" | "confirmed";
    confirmedAt: string | null;
    /** Null when the department has not configured a window for this semester. */
    deadline: string | null;
    open: boolean;
    /** Whole days until the deadline. Negative once it has passed. */
    daysLeft: number | null;
  };
};

/**
 * What a student is registered for, and what they may add.
 *
 * The available list excludes core courses at their own level — those are
 * compulsory and already theirs, so offering them as a choice would be a
 * button that can only ever return an error.
 */
export async function loadStudentRegistration(
  studentId: string,
  semester?: number,
): Promise<StudentRegistration> {
  const db = createUserClient(await currentAccessToken());

  const [{ data: student }, { data: config }, { data: session }] = await Promise.all([
    db.from("students").select("level").eq("id", studentId).single(),
    db.from("app_config").select("max_credit_units_per_semester").eq("id", 1).single(),
    db
      .from("academic_sessions")
      .select("id, starts_on, ends_on")
      .eq("is_active", true)
      .single(),
  ]);

  // Defaulting to 1 would show a student their first-semester courses in
  // March. The schema has no "current semester" field to read, so it is
  // derived from where today falls in the session — and the switcher is there
  // because a derived answer should never be the only answer.
  const resolved = semester ?? currentSemester(session?.starts_on, session?.ends_on);
  const level = student?.level ?? 0;
  const creditCap = config?.max_credit_units_per_semester ?? 24;
  const catalogue = await loadCatalogue();

  const { data: mine } = await db
    .from("enrolments")
    .select("course_id, source")
    .eq("student_id", studentId)
    .is("dropped_at", null);

  const sourceByCourse = new Map((mine ?? []).map((row) => [row.course_id, row.source]));

  /**
   * What they took in EARLIER sessions, by course code.
   *
   * Courses are per session, so last year's MTH 201 is a different row from
   * this year's with the same code. The code is what carries across, and it is
   * what a student recognises — nobody repeating a course thinks of it by its
   * row id.
   */
  const [{ data: history }, { data: sessions }] = await Promise.all([
    db
      .from("enrolments")
      .select("courses(code, academic_session_id)")
      .eq("student_id", studentId),
    db.from("academic_sessions").select("id, name, starts_on"),
  ]);

  const sessionById = new Map(
    (sessions ?? []).map((row) => [row.id, { name: row.name, startsOn: row.starts_on }]),
  );

  // The most recent time they took it, when there is more than one. A student
  // on a third attempt is told about the second, not the first.
  const takenBefore = new Map<string, { name: string; startsOn: string }>();
  for (const row of history ?? []) {
    const course = Array.isArray(row.courses) ? row.courses[0] : row.courses;
    if (!course || course.academic_session_id === session?.id) continue;
    const when = sessionById.get(course.academic_session_id);
    if (!when) continue;
    const seen = takenBefore.get(course.code);
    if (!seen || seen.startsOn < when.startsOn) takenBefore.set(course.code, when);
  }

  const registered = catalogue
    .filter((course) => sourceByCourse.has(course.courseId) && course.semester === resolved)
    .map((course) => {
      const source = sourceByCourse.get(course.courseId) as "core" | "elective" | "carry_over";
      return { ...course, source, canDrop: source !== "core" };
    });

  const unitsUsed = registered.reduce((sum, course) => sum + course.creditUnits, 0);

  const available: RegistrationOption[] = catalogue
    .filter((course) => {
      if (course.semester !== resolved) return false;
      if (sourceByCourse.has(course.courseId)) return false;
      if (course.level > level) return false;
      // Compulsory and already theirs — not a choice.
      if (course.level === level && course.kind === "core") return false;
      return true;
    })
    .map((course) => ({
      ...course,
      addsAs: (course.level < level ? "carry_over" : "elective") as "carry_over" | "elective",
      enrolledAlready: false,
      takenBefore: takenBefore.get(course.code)?.name ?? null,
    }))
    // Courses they have actually sat first. The catalogue is already ordered by
    // level then code, and this sort is stable, so the rest keeps that order —
    // a 300-level student is otherwise shown every 100- and 200-level course in
    // the department with nothing to say which of them is theirs.
    .sort((a, b) => Number(b.takenBefore !== null) - Number(a.takenBefore !== null));

  // Taken before, and not offered this session under any level. There is no
  // row to add, so the screen has to say so rather than let a student conclude
  // from an absence that they have nothing to repeat.
  const offeredCodes = new Set(catalogue.map((course) => course.code));
  const unoffered: UnofferedPriorCourse[] = [...takenBefore.entries()]
    .filter(([code]) => !offeredCodes.has(code))
    .map(([code, when]) => ({ code, takenBefore: when.name }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const [{ data: period }, { data: confirmation }] = await Promise.all([
    session?.id
      ? db
          .from("registration_periods")
          .select("closes_on")
          .eq("academic_session_id", session.id)
          .eq("semester", resolved)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    session?.id
      ? db
          .from("course_registrations")
          .select("status, registered_at")
          .eq("student_id", studentId)
          .eq("academic_session_id", session.id)
          .eq("semester", resolved)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const deadline = (period?.closes_on as string | undefined) ?? null;

  return {
    level,
    semester: resolved,
    creditCap,
    unitsUsed,
    registered,
    available,
    unoffered,
    confirmation: {
      status: confirmation?.status === "confirmed" ? "confirmed" : "draft",
      confirmedAt: (confirmation?.registered_at as string | null) ?? null,
      deadline,
      // No window configured is OPEN, matching is_registration_open(). An
      // absent deadline is not a deadline that has passed, and showing it as
      // one would tell a whole department they had missed something that was
      // never set.
      open: deadline === null || daysUntil(deadline) >= 0,
      daysLeft: deadline === null ? null : daysUntil(deadline),
    },
  };
}

/**
 * Whole days from today to a date, counted in dates rather than in elapsed
 * milliseconds. A deadline of "today" is 0 whether it is read at 9am or at
 * 11pm; dividing a duration would make the same day read as -1 after noon.
 */
function daysUntil(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

/**
 * Which semester today falls in, from the session's own dates.
 *
 * Split at the midpoint rather than at a fixed month: sessions do not start in
 * the same week every year, and a hardcoded "January onwards is semester 2"
 * goes wrong the first time resumption slips.
 */
function currentSemester(startsOn?: string | null, endsOn?: string | null): number {
  if (!startsOn || !endsOn) return 1;

  const start = Date.parse(startsOn);
  const end = Date.parse(endsOn);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;

  return Date.now() >= start + (end - start) / 2 ? 2 : 1;
}

/** Translates the database's one-word answers into something a student reads. */
export const REGISTRATION_MESSAGES: Record<string, string> = {
  added: "Added.",
  dropped: "Removed.",
  already_enrolled: "You're already registered for that course.",
  core_not_optional: "That course is compulsory at your level, so it can't be changed here.",
  above_level: "That course is above your level.",
  over_credit_limit: "That would take you over the credit unit limit for the semester.",
  not_found: "We couldn't find that course.",
};

export async function addCourse(studentId: string, courseId: string): Promise<string> {
  const db = createServiceClient();
  const { data, error } = await db.rpc("add_optional_course", {
    p_student_id: studentId,
    p_course_id: courseId,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export type ConfirmRegistrationResult = {
  status: "confirmed" | "confirmed_late" | "already_confirmed" | "no_courses" | "no_such_student";
  coursesRegistered: number;
  absencesBackfilled: number;
};

/**
 * Ending registration for a semester.
 *
 * Everything that makes this more than a status flip — the server-stamped
 * time, the back-dated join dates, the absences for lectures missed since the
 * deadline — happens inside `confirm_registration()`. It has to: those three
 * are only correct together, and a partial failure leaves a percentage that is
 * wrong in whichever direction it stopped.
 */
export async function confirmRegistration(
  studentId: string,
  academicSessionId: string,
  semester: number,
): Promise<ConfirmRegistrationResult> {
  const db = createServiceClient();
  const { data, error } = await db.rpc("confirm_registration", {
    p_student_id: studentId,
    p_academic_session_id: academicSessionId,
    p_semester: semester,
  });
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    status: (row?.status ?? "no_such_student") as ConfirmRegistrationResult["status"],
    coursesRegistered: Number(row?.courses_registered ?? 0),
    absencesBackfilled: Number(row?.absences_backfilled ?? 0),
  };
}

export async function dropCourse(studentId: string, courseId: string): Promise<string> {
  const db = createServiceClient();
  const { data, error } = await db.rpc("drop_optional_course", {
    p_student_id: studentId,
    p_course_id: courseId,
  });
  if (error) throw new Error(error.message);
  return String(data);
}
