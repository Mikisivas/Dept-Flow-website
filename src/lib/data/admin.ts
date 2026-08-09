import "server-only";

import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/client";
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
