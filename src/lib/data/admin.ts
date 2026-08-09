import "server-only";

import { redirect } from "next/navigation";
import { createServiceClient, createUserClient } from "@/lib/supabase/client";
import { currentAccessToken, currentUser } from "@/lib/auth/current-user";
import type { SessionClaims } from "@/lib/auth/session";

/**
 * What the administrator sees, read as the administrator.
 *
 * The dividing line against `hod.ts` is deliberate and the database enforces
 * it too: admin gets aggregates and operations — money, the register, the
 * audit trail, configuration — and never an individual student's risk. Risk is
 * a judgement about a person, and the person who runs the payment reconciliation
 * is not the person who should be forming it.
 */

const HOME_FOR_ROLE = {
  student: "/dashboard",
  lecturer: "/lecturer",
  hod: "/hod",
  admin: "/admin",
} as const;

export async function requireAdmin(): Promise<SessionClaims> {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect(HOME_FOR_ROLE[session.role]);
  return session;
}

type Db = ReturnType<typeof createUserClient>;

async function adminDb(): Promise<Db> {
  await requireAdmin();
  return createUserClient(await currentAccessToken());
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type Person = { surname: string; first_name: string; other_names: string | null };

async function activeSessionId(db: Db): Promise<string | null> {
  const { data } = await db.from("academic_sessions").select("id").eq("is_active", true).limit(1);
  return data?.[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type AdminOverview = {
  byLevel: Array<{ level: number; cleared: number; provisional: number; locked: number }>;
  reconciliation: { failedWebhooks: number; unverified: number };
  gpsRejectionRate: { current: number; baseline: number; sampled: boolean };
  registration: { openDisputes: number; unclaimed: number };
  duesWindow: { daysRemaining: number; deadline: string } | null;
};

const RECENT_WINDOW_DAYS = 7;

export async function loadAdminOverview(): Promise<AdminOverview> {
  const db = await adminDb();
  const sessionId = await activeSessionId(db);

  const [{ data: students }, { data: compliance }, { data: payments }, { data: marks }, { data: whitelist }, { data: regDisputes }, { data: duesPeriod }, { data: config }] =
    await Promise.all([
      db.from("students").select("id, level").eq("status", "active"),
      db.from("compliance_statuses").select("student_id, state"),
      db.from("payments").select("status, initialized_at, verified_at"),
      db.from("attendance_marks").select("accepted, reject_reason, submitted_at"),
      db.from("whitelist_entries").select("claimed"),
      db.from("registration_disputes").select("status").eq("status", "open"),
      db.from("dues_periods").select("resumption_date").eq("academic_session_id", sessionId ?? "").limit(1),
      db.from("app_config").select("provisional_window_days").eq("id", 1).limit(1),
    ]);

  const stateByStudent = new Map((compliance ?? []).map((row) => [row.student_id, row.state]));

  const levels = new Map<number, { cleared: number; provisional: number; locked: number }>();
  for (const student of students ?? []) {
    const bucket = levels.get(student.level) ?? { cleared: 0, provisional: 0, locked: 0 };
    const state = stateByStudent.get(student.id) ?? "uncleared";

    // Three buckets, not four: "pending verification" is the last hours of not
    // having paid, and grouping it with `locked` would say a student is shut
    // out when they can still walk into the bursary and fix it.
    if (state === "cleared") bucket.cleared += 1;
    else if (state === "locked") bucket.locked += 1;
    else bucket.provisional += 1;

    levels.set(student.level, bucket);
  }

  const byLevel = [...levels.entries()]
    .map(([level, counts]) => ({ level, ...counts }))
    .sort((a, b) => a.level - b.level);

  // "Failed" is Paystack's answer; "unverified" is our own gap — a payment we
  // started and never heard back about. The second is the one that strands a
  // student who has actually been debited, so the two are counted apart.
  const failedWebhooks = (payments ?? []).filter((row) => row.status === "failed").length;
  const unverified = (payments ?? []).filter(
    (row) => row.status === "pending" && !row.verified_at,
  ).length;

  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
  const rejectionRate = (rows: typeof marks) => {
    if (!rows || rows.length === 0) return null;
    const outside = rows.filter((row) => row.reject_reason === "outside_geofence").length;
    return (outside / rows.length) * 100;
  };

  const recent = (marks ?? []).filter((row) => row.submitted_at >= cutoff);
  const older = (marks ?? []).filter((row) => row.submitted_at < cutoff);
  const current = rejectionRate(recent);
  const baseline = rejectionRate(older);

  let deadline: string | null = null;
  let daysRemaining = 0;
  const resumption = duesPeriod?.[0]?.resumption_date as string | undefined;
  const windowDays = (config?.[0]?.provisional_window_days as number | undefined) ?? 30;
  if (resumption) {
    const end = new Date(resumption);
    end.setDate(end.getDate() + windowDays);
    deadline = end.toISOString();
    daysRemaining = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
  }

  return {
    byLevel,
    reconciliation: { failedWebhooks, unverified },
    // A rate computed from four submissions is noise wearing a percentage.
    // `sampled` lets the screen say so rather than raise an alarm about it.
    gpsRejectionRate: {
      current: current ?? 0,
      baseline: baseline ?? 0,
      sampled: current !== null && baseline !== null && recent.length >= 20 && older.length >= 20,
    },
    registration: {
      openDisputes: regDisputes?.length ?? 0,
      unclaimed: (whitelist ?? []).filter((row) => !row.claimed).length,
    },
    duesWindow: deadline ? { daysRemaining, deadline } : null,
  };
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export type AdminStudent = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  status: "active" | "provisional" | "graduating" | "deactivated";
  compliance: string;
  deactivationReason: string | null;
  deactivationNote: string | null;
};

export async function loadAdminStudents(): Promise<AdminStudent[]> {
  const db = await adminDb();

  const [{ data: students }, { data: compliance }] = await Promise.all([
    db
      .from("students")
      .select(
        "id, matric_no, level, status, deactivation_reason, deactivation_note, profiles(surname, first_name, other_names)",
      )
      .order("matric_no"),
    db.from("compliance_statuses").select("student_id, state"),
  ]);

  const stateByStudent = new Map((compliance ?? []).map((row) => [row.student_id, row.state]));

  return (students ?? []).map((student) => {
    const person = one(student.profiles as unknown as Person);
    return {
      studentId: student.id,
      matricNo: student.matric_no,
      surname: person?.surname ?? "",
      firstName: person?.first_name ?? "",
      otherNames: person?.other_names ?? null,
      level: student.level,
      status: student.status as AdminStudent["status"],
      compliance: stateByStudent.get(student.id) ?? "uncleared",
      deactivationReason: student.deactivation_reason,
      deactivationNote: student.deactivation_note,
    };
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentRow = {
  id: string;
  matricNo: string;
  surname: string;
  amountKobo: number;
  channel: "card" | "transfer" | null;
  status: "pending" | "success" | "failed" | "abandoned" | "reversed";
  reference: string;
  createdAt: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
};

export async function loadPayments(): Promise<PaymentRow[]> {
  const db = await adminDb();

  const { data: payments } = await db
    .from("payments")
    .select(
      "id, paystack_reference, channel, status, amount_kobo, initialized_at, verified_at, last_checked_at, students(matric_no, profiles(surname))",
    )
    .order("initialized_at", { ascending: false })
    .limit(200);

  return (payments ?? []).map((row) => {
    const student = one(
      row.students as unknown as { matric_no: string; profiles: Person | Person[] },
    );
    const person = one(student?.profiles);
    return {
      id: row.id,
      matricNo: student?.matric_no ?? "—",
      surname: person?.surname ?? "",
      amountKobo: row.amount_kobo,
      channel: row.channel as PaymentRow["channel"],
      status: row.status as PaymentRow["status"],
      reference: row.paystack_reference,
      createdAt: row.initialized_at,
      verifiedAt: row.verified_at,
      lastCheckedAt: row.last_checked_at,
    };
  });
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export type WhitelistRow = {
  id: string;
  matricNo: string;
  surname: string;
  level: number;
  claimed: boolean;
  claimedAt: string | null;
};

export async function loadWhitelist(): Promise<WhitelistRow[]> {
  const db = await adminDb();
  const sessionId = await activeSessionId(db);

  const { data } = await db
    .from("whitelist_entries")
    .select("id, matric_no, surname, level, claimed, claimed_at")
    .eq("academic_session_id", sessionId ?? "")
    .order("matric_no");

  return (data ?? []).map((row) => ({
    id: row.id,
    matricNo: row.matric_no,
    surname: row.surname,
    level: row.level,
    claimed: row.claimed,
    claimedAt: row.claimed_at,
  }));
}

// ---------------------------------------------------------------------------
// Registration disputes
// ---------------------------------------------------------------------------

export type RegistrationDispute = {
  id: string;
  matricNo: string;
  claimedAt: string;
  /** Enough to recognise your own number, not enough to learn someone else's. */
  maskedPhone: string;
  /** The same number has reported more than one matric number. */
  repeatReporter: boolean;
  waitingDays: number;
  status: "open" | "upheld" | "corrected";
};

/**
 * Masked here rather than in the component, so a phone number never reaches the
 * browser in full. A screen that receives the whole number and hides four
 * digits with CSS has not hidden anything.
 */
export function maskPhone(phone: string | null): string {
  if (!phone) return "no number given";
  const digits = phone.replace(/[^0-9+]/g, "");
  if (digits.length < 7) return "•••";
  return `${digits.slice(0, 7)} ••• ${digits.slice(-4)}`;
}

export async function loadRegistrationDisputes(): Promise<RegistrationDispute[]> {
  const db = await adminDb();

  const [{ data: open }, { data: all }] = await Promise.all([
    db
      .from("registration_disputes")
      .select("id, matric_no, reported_at, reporter_phone, status")
      .eq("status", "open")
      .order("reported_at"),
    // Across every report, not only the open ones: a number that already had
    // one claim revoked is exactly the number worth noticing on its second.
    db.from("registration_disputes").select("matric_no, reporter_phone"),
  ]);

  const numbersByPhone = new Map<string, Set<string>>();
  for (const row of all ?? []) {
    if (!row.reporter_phone) continue;
    const seen = numbersByPhone.get(row.reporter_phone) ?? new Set<string>();
    seen.add(row.matric_no);
    numbersByPhone.set(row.reporter_phone, seen);
  }

  return (open ?? []).map((row) => ({
    id: row.id,
    matricNo: row.matric_no,
    claimedAt: row.reported_at,
    maskedPhone: maskPhone(row.reporter_phone),
    repeatReporter: (numbersByPhone.get(row.reporter_phone ?? "")?.size ?? 0) > 1,
    waitingDays: Math.floor((Date.now() - new Date(row.reported_at).getTime()) / 86_400_000),
    status: row.status as RegistrationDispute["status"],
  }));
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditEntry = {
  id: string;
  actor: string;
  actorRole: "hod" | "admin" | "lecturer" | "student";
  action: string;
  target: string;
  reason: string | null;
  createdAt: string;
};

export type AuditFilter = { action?: string; actorRole?: string };

export async function loadAuditLog(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const db = await adminDb();

  let query = db
    .from("audit_log")
    .select("id, actor_id, actor_role, action, target_table, target_id, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (filter.action) query = query.eq("action", filter.action);
  if (filter.actorRole) query = query.eq("actor_role", filter.actorRole);

  const { data: rows } = await query;

  // Names in a second pass rather than a join: the actor is nullable — the
  // nightly compliance transition has no person behind it — and an inner join
  // would silently drop exactly those rows.
  const actorIds = [...new Set((rows ?? []).map((row) => row.actor_id).filter(Boolean))];
  const { data: people } = actorIds.length
    ? await db.from("profiles").select("id, surname, first_name").in("id", actorIds)
    : { data: [] };

  const nameById = new Map(
    (people ?? []).map((person) => [person.id, `${person.first_name} ${person.surname}`]),
  );

  return (rows ?? []).map((row) => ({
    id: row.id,
    actor: row.actor_id ? (nameById.get(row.actor_id) ?? "Unknown account") : "Scheduled task",
    actorRole: row.actor_role as AuditEntry["actorRole"],
    target: row.target_id ? `${row.target_table} · ${row.target_id}` : row.target_table,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type SystemConfig = {
  duesAmountKobo: number | null;
  resumptionDate: string | null;
  provisionalWindowDays: number;
  graceWindowDays: number;
  pendingBufferHours: number;
  gpsRetentionDays: number;
  defaultRadiusM: number;
  attendanceThresholdPct: number;
  maxCreditUnits: number;
  tokenTtlSeconds: number;
  timetableToleranceMinutes: number;
  venues: Array<{ id: string; name: string; radiusM: number }>;
};

export async function loadSystemConfig(): Promise<SystemConfig> {
  const db = await adminDb();
  const sessionId = await activeSessionId(db);

  const [{ data: config }, { data: dues }, { data: venues }] = await Promise.all([
    db.from("app_config").select("*").eq("id", 1).limit(1),
    db
      .from("dues_periods")
      .select("dues_amount_kobo, resumption_date")
      .eq("academic_session_id", sessionId ?? "")
      .limit(1),
    db.from("venues").select("id, name, radius_m").order("name"),
  ]);

  const row = config?.[0];

  return {
    duesAmountKobo: dues?.[0]?.dues_amount_kobo ?? null,
    resumptionDate: dues?.[0]?.resumption_date ?? null,
    provisionalWindowDays: row?.provisional_window_days ?? 30,
    graceWindowDays: row?.grace_window_days ?? 30,
    pendingBufferHours: row?.pending_verification_buffer_hours ?? 12,
    gpsRetentionDays: row?.gps_retention_days ?? 14,
    defaultRadiusM: row?.default_geofence_radius_m ?? 40,
    attendanceThresholdPct: row?.attendance_threshold_pct ?? 75,
    maxCreditUnits: row?.max_credit_units_per_semester ?? 24,
    tokenTtlSeconds: row?.checkpoint_token_ttl_seconds ?? 90,
    timetableToleranceMinutes: row?.timetable_tolerance_minutes ?? 15,
    venues: (venues ?? []).map((venue) => ({
      id: venue.id,
      name: venue.name,
      radiusM: venue.radius_m,
    })),
  };
}

// ---------------------------------------------------------------------------
// Level rollover
// ---------------------------------------------------------------------------

export type RolloverPreview = {
  fromSession: string;
  toSession: string | null;
  toSessionId: string | null;
  byLevel: Array<{ from: number; to: number; students: number }>;
  graduating: number;
  alreadyRun: { runAt: string; promoted: number; graduating: number } | null;
};

export async function loadRolloverPreview(): Promise<RolloverPreview | null> {
  const db = await adminDb();

  const { data: sessions } = await db
    .from("academic_sessions")
    .select("id, name, is_active, starts_on")
    .order("starts_on");

  const active = (sessions ?? []).find((row) => row.is_active);
  if (!active) return null;

  const next = (sessions ?? []).find((row) => row.starts_on > active.starts_on);

  const [{ data: students }, { data: rollovers }] = await Promise.all([
    db.from("students").select("level").eq("status", "active"),
    db
      .from("level_rollovers")
      .select("run_at, students_promoted, students_graduating, to_academic_session_id")
      .eq("from_academic_session_id", active.id)
      .limit(1),
  ]);

  const counts = new Map<number, number>();
  for (const student of students ?? []) {
    counts.set(student.level, (counts.get(student.level) ?? 0) + 1);
  }

  const byLevel = [...counts.entries()]
    .filter(([level]) => level < 400)
    .map(([level, count]) => ({ from: level, to: level + 100, students: count }))
    .sort((a, b) => a.from - b.from);

  const previous = rollovers?.[0];

  return {
    fromSession: active.name,
    toSession: next?.name ?? null,
    toSessionId: next?.id ?? null,
    byLevel,
    graduating: counts.get(400) ?? 0,
    alreadyRun: previous
      ? {
          runAt: previous.run_at,
          promoted: previous.students_promoted,
          graduating: previous.students_graduating,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// The timetable
// ---------------------------------------------------------------------------

export type TimetableRow = {
  id: string;
  courseCode: string;
  courseTitle: string;
  level: number;
  dayOfWeek: number;
  startsAt: string;
  endsAt: string;
  venue: string;
  lecturer: string | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayName(dayOfWeek: number): string {
  return WEEKDAYS[dayOfWeek] ?? "—";
}

/**
 * The recurring weekly baseline, not a list of dates.
 *
 * A timetable entry says a class happens every Tuesday at ten. What happened on
 * one particular Tuesday is a `session_instances` row, and belongs on the
 * lecturer's schedule rather than here — confusing the two is how "the
 * timetable" ends up meaning two different things to two roles.
 */
export async function loadTimetable(): Promise<TimetableRow[]> {
  const db = await adminDb();
  const sessionId = await activeSessionId(db);

  const { data: entries } = await db
    .from("timetable_entries")
    .select("id, course_id, day_of_week, start_time, end_time, venue_id")
    .eq("academic_session_id", sessionId ?? "");

  if (!entries?.length) return [];

  const [{ data: courses }, { data: venues }] = await Promise.all([
    db
      .from("courses")
      .select("id, code, title, level, lecturer_id")
      .in("id", [...new Set(entries.map((entry) => entry.course_id))]),
    db.from("venues").select("id, name"),
  ]);

  const lecturerIds = [...new Set((courses ?? []).map((c) => c.lecturer_id).filter(Boolean))];
  const { data: people } = lecturerIds.length
    ? await db.from("profiles").select("id, surname, first_name").in("id", lecturerIds)
    : { data: [] };

  const courseById = new Map((courses ?? []).map((course) => [course.id, course]));
  const venueById = new Map((venues ?? []).map((venue) => [venue.id, venue.name]));
  const nameById = new Map(
    (people ?? []).map((person) => [person.id, `${person.first_name} ${person.surname}`]),
  );

  return entries
    .map((entry) => {
      const course = courseById.get(entry.course_id);
      return {
        id: entry.id,
        courseCode: course?.code ?? "—",
        courseTitle: course?.title ?? "",
        level: course?.level ?? 0,
        dayOfWeek: entry.day_of_week,
        startsAt: String(entry.start_time).slice(0, 5),
        endsAt: String(entry.end_time).slice(0, 5),
        venue: venueById.get(entry.venue_id) ?? "Venue not set",
        lecturer: course?.lecturer_id ? (nameById.get(course.lecturer_id) ?? null) : null,
      };
    })
    .sort((a, b) =>
      a.dayOfWeek === b.dayOfWeek
        ? a.startsAt.localeCompare(b.startsAt)
        : a.dayOfWeek - b.dayOfWeek,
    );
}

// ---------------------------------------------------------------------------
// Uploading the register
// ---------------------------------------------------------------------------

export type RegisterRow = { matricNo: string; surname: string; level: number };

export type RegisterPreview = {
  created: RegisterRow[];
  /** Already on the register, unclaimed, and the upload changes something. */
  changed: Array<RegisterRow & { was: { surname: string; level: number } }>;
  unchanged: number;
  /**
   * On the register, already claimed, and the upload would change it. Reported
   * and never applied — see below.
   */
  claimedConflicts: Array<RegisterRow & { was: { surname: string; level: number } }>;
  /**
   * On the register but absent from the upload. Never deleted, because a
   * truncated paste would otherwise lock out everyone missing from it.
   */
  missing: number;
  rejected: Array<{ line: number; reason: string }>;
};

/**
 * One CSV row: matric number, surname, level.
 *
 * Strict about the prefix. Computer Science is CMP in this department and the
 * database rejects CSC outright, so a silently skipped row is a student who
 * cannot create an account and has no idea why.
 */
function parseRegisterRow(line: string): { row?: RegisterRow; reason?: string } {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 3) return { reason: "needs matric number, surname and level" };

  const [matricText, surname, levelText] = parts;
  const matric = matricText.toUpperCase();

  if (!/^(MTH|CMP|STA)\/[0-9]{4}\/[0-9]{3,4}$/.test(matric)) {
    return {
      reason: matric.startsWith("CSC")
        ? "Computer Science is CMP in this department, not CSC"
        : `"${matricText}" is not a matric number — expected e.g. CMP/2021/047`,
    };
  }
  if (!surname) return { reason: "no surname" };

  const level = Number(levelText);
  if (![100, 200, 300, 400].includes(level)) {
    return { reason: `level "${levelText}" is not 100, 200, 300 or 400` };
  }

  return { row: { matricNo: matric, surname, level } };
}

function parseRegister(csv: string) {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Tolerate a header row, since a spreadsheet export always has one.
    .filter((line, index) => !(index === 0 && /^matric/i.test(line)));

  const rows: RegisterRow[] = [];
  const rejected: RegisterPreview["rejected"] = [];

  lines.forEach((line, index) => {
    const { row, reason } = parseRegisterRow(line);
    if (row) rows.push(row);
    else rejected.push({ line: index + 1, reason: reason ?? "could not read that line" });
  });

  return { rows, rejected };
}

/**
 * What an upload would do, without doing any of it.
 *
 * Not optional, and not a nicety: a column mapped one place to the left turns
 * every surname into a level and locks out an entire year. The diff is the
 * only thing standing between a mis-pasted spreadsheet and a department that
 * cannot register.
 */
export async function previewRegisterUpload(csv: string): Promise<RegisterPreview> {
  const db = await adminDb();
  const sessionId = await activeSessionId(db);
  const { rows, rejected } = parseRegister(csv);

  const { data: existing } = await db
    .from("whitelist_entries")
    .select("matric_no, surname, level, claimed")
    .eq("academic_session_id", sessionId ?? "");

  const byMatric = new Map((existing ?? []).map((row) => [row.matric_no, row]));
  const uploaded = new Set(rows.map((row) => row.matricNo));

  const preview: RegisterPreview = {
    created: [],
    changed: [],
    unchanged: 0,
    claimedConflicts: [],
    missing: (existing ?? []).filter((row) => !uploaded.has(row.matric_no)).length,
    rejected,
  };

  for (const row of rows) {
    const current = byMatric.get(row.matricNo);

    if (!current) {
      preview.created.push(row);
      continue;
    }

    const same = current.surname === row.surname && current.level === row.level;
    if (same) {
      preview.unchanged += 1;
      continue;
    }

    const was = { surname: current.surname, level: current.level };
    if (current.claimed) preview.claimedConflicts.push({ ...row, was });
    else preview.changed.push({ ...row, was });
  }

  return preview;
}

export type RegisterUploadResult = {
  created: number;
  changed: number;
  skippedClaimed: number;
  rejected: RegisterPreview["rejected"];
};

/**
 * Applying it.
 *
 * Two rules that are the whole safety of this operation:
 *
 *   Rows already CLAIMED are never rewritten. A student has registered against
 *   that surname and level; changing them underneath would break the identity
 *   the register exists to establish, and would do it silently.
 *
 *   Rows absent from the upload are never deleted. A paste that lost its last
 *   two hundred lines would otherwise lock those students out of registration
 *   with no trace of what happened.
 */
export async function commitRegisterUpload(csv: string): Promise<RegisterUploadResult> {
  const session = await requireAdmin();
  const db = createServiceClient();

  const { data: active } = await db
    .from("academic_sessions")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (!active) throw new Error("There is no active academic session.");

  const preview = await previewRegisterUpload(csv);
  const writable = [...preview.created, ...preview.changed];

  if (writable.length > 0) {
    const { error } = await db.from("whitelist_entries").upsert(
      writable.map((row) => ({
        academic_session_id: active.id,
        matric_no: row.matricNo,
        surname: row.surname,
        level: row.level,
      })),
      { onConflict: "academic_session_id,matric_no" },
    );

    if (error) throw new Error(`Could not save the register: ${error.message}`);
  }

  await db.rpc("write_audit", {
    p_actor_id: session.profileId,
    p_actor_role: "admin",
    p_action: "register.upload",
    p_target_table: "whitelist_entries",
    p_target_id: active.id,
    p_reason: `Register upload: ${preview.created.length} added, ${preview.changed.length} changed`,
    p_metadata: {
      created: preview.created.length,
      changed: preview.changed.length,
      skipped_claimed: preview.claimedConflicts.length,
      rejected: preview.rejected.length,
      absent_from_upload: preview.missing,
    },
  });

  return {
    created: preview.created.length,
    changed: preview.changed.length,
    skippedClaimed: preview.claimedConflicts.length,
    rejected: preview.rejected,
  };
}
