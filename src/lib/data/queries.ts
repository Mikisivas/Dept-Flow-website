/**
 * Fixtures for the screens that are not wired to Supabase yet.
 *
 * Every function here keeps the signature its real replacement will have — the
 * same arguments, the same return shapes, the same async — so wiring one is a
 * change of import and nothing else.
 *
 * Anything that HAS been wired is gone from this file rather than left behind
 * as a fallback. Two sources for the same screen is how a demo ends up showing
 * fixture data and nobody notices: the student path now lives in
 * `student.ts`, the lecturer path in `lecturer.ts`, and attendance in
 * `attendance.ts`.
 *
 * Reads may go straight to Supabase under RLS. Writes must not: role
 * separation and the audit log live in the API, and a client that can write
 * `compliance_statuses` has defeated both.
 */

import { COMPLIANCE, COURSES, STUDENT } from "@/lib/data/fixtures";
import type { StudentProfile } from "@/lib/data/fixtures";
import type { ComplianceState, CourseAttendance, SubmitRejection } from "@/lib/types";

/**
 * One student's record as the HOD reads it. Still a fixture: the HOD screens
 * are not wired yet. Named for the HOD's use rather than reusing the student's
 * own dashboard loader, because the two answer different questions and will not
 * share an implementation once this is real.
 */
export async function getStudentRecord(matricNo: string): Promise<{
  student: StudentProfile;
  compliance: ComplianceState;
  courses: CourseAttendance[];
}> {
  void matricNo;
  return { student: STUDENT, compliance: COMPLIANCE, courses: COURSES };
}

export type RegisterIdentity = {
  matricNo: string;
  surname: string;
  level: number;
};

export type RegisterMatch =
  | { outcome: "matched"; matricNo: string; surname: string; level: number; programme: string }
  | { outcome: "no_match" }
  | { outcome: "already_claimed" };

/**
 * Matches against an unclaimed register row on matric number + surname +
 * level. First and other names are collected on the next step and stored as
 * account data — they are deliberately not part of this match.
 */
export async function checkRegisterMatch(identity: RegisterIdentity): Promise<RegisterMatch> {
  await pause(600);

  const matric = identity.matricNo.toUpperCase();

  if (matric === "CMP/2021/047") return { outcome: "already_claimed" };

  const register: Record<string, { surname: string; level: number; programme: string }> = {
    "CMP/2021/112": { surname: "Sanusi", level: 400, programme: "Computer Science" },
    "MTH/2022/018": { surname: "Adeyemi", level: 300, programme: "Mathematics" },
    "STA/2022/091": { surname: "Bassey", level: 300, programme: "Statistics" },
  };

  const row = register[matric];
  if (
    !row ||
    row.surname.toLowerCase() !== identity.surname.trim().toLowerCase() ||
    row.level !== identity.level
  ) {
    return { outcome: "no_match" };
  }

  return { outcome: "matched", matricNo: matric, ...row };
}

/**
 * The backend generates the code, stores it hashed, and sends it through
 * `send_otp()`. Nothing is returned here but an expiry — the plaintext code is
 * never in an HTTP response, in any environment.
 */
export async function sendOtp(phone: string): Promise<{ expiresAt: string }> {
  await pause(700);
  void phone;
  return { expiresAt: new Date(Date.now() + 300_000).toISOString() };
}

export type CourseDetail = {
  course: CourseAttendance;
  lecturer: string;
  schedule: string;
  venue: string;
  /** Advisory. Never the eligibility determination. */
  projectedPct: number;
};

export async function getCourseDetail(code: string): Promise<CourseDetail | null> {
  const course = COURSES.find(
    (entry) => entry.code.replace(/\s+/g, "-").toLowerCase() === code.toLowerCase(),
  );
  if (!course) return null;

  const schedules: Record<string, { lecturer: string; schedule: string; venue: string }> = {
    "CMP 301": {
      lecturer: "Dr Amina Bello",
      schedule: "Tuesdays, 10:00–12:00",
      venue: "Lecture Theatre A",
    },
    "MTH 205": {
      lecturer: "Dr Amina Bello",
      schedule: "Thursdays, 08:00–10:00",
      venue: "Maths Block 2",
    },
    "STA 202": {
      lecturer: "Dr Amina Bello",
      schedule: "Mondays, 14:00–16:00",
      venue: "Maths Block 2",
    },
  };

  const recorded = course.confirmedScore + course.provisionalScore;

  return {
    course,
    ...schedules[course.code],
    projectedPct: Math.round((recorded / course.sessionsHeld) * 100),
  };
}

export type NotificationItem = {
  id: string;
  kind: "payment_reminder" | "risk_nudge" | "grace_period" | "schedule_change";
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

export async function getNotifications(): Promise<NotificationItem[]> {
  const now = Date.now();
  return [
    {
      id: "n1",
      kind: "payment_reminder",
      title: "6 days left to clear your dues",
      body: "21.5 sessions are recorded but not yet counted. Clearing counts all of them at once.",
      createdAt: new Date(now - 2 * 3_600_000).toISOString(),
      readAt: null,
    },
    {
      id: "n2",
      kind: "schedule_change",
      title: "CMP 301 moved to Lecture Theatre A",
      body: "Tuesday's lecture is in Lecture Theatre A instead of Maths Block 2.",
      createdAt: new Date(now - 26 * 3_600_000).toISOString(),
      readAt: null,
    },
    {
      id: "n3",
      kind: "risk_nudge",
      title: "You're catching only one checkpoint in STA 202",
      body: "Staying until the second checkpoint would put you back on track for 75%.",
      createdAt: new Date(now - 4 * 86_400_000).toISOString(),
      readAt: new Date(now - 3 * 86_400_000).toISOString(),
    },
  ];
}

/* ---------------------------------------------------------------------------
   Attendance
   --------------------------------------------------------------------------- */

export type AdminOverview = {
  byLevel: Array<{ level: number; cleared: number; provisional: number; locked: number }>;
  reconciliation: { failedWebhooks: number; unverified: number };
  gpsRejectionRate: { current: number; baseline: number };
  registration: { openDisputes: number; unclaimed: number };
  duesWindow: { daysRemaining: number; deadline: string };
};

export async function getAdminOverview(): Promise<AdminOverview> {
  return {
    byLevel: [
      { level: 100, cleared: 82, provisional: 24, locked: 18 },
      { level: 200, cleared: 71, provisional: 22, locked: 27 },
      { level: 300, cleared: 78, provisional: 26, locked: 34 },
      { level: 400, cleared: 70, provisional: 24, locked: 64 },
    ],
    reconciliation: { failedWebhooks: 2, unverified: 5 },
    // A spike is the signal that matters here — a steady rate is just GPS.
    gpsRejectionRate: { current: 11.4, baseline: 3.2 },
    registration: { openDisputes: 3, unclaimed: 41 },
    duesWindow: { daysRemaining: 6, deadline: new Date(Date.now() + 6 * 86_400_000).toISOString() },
  };
}

export type AdminStudent = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  status: "active" | "graduating" | "deactivated";
  compliance: ComplianceState;
};

export async function getAdminStudents(): Promise<AdminStudent[]> {
  const rows: Array<[string, string, string, string | null, number, AdminStudent["status"], ComplianceState]> = [
    ["CMP/2021/047", "Okonkwo", "Chidera", "Emeka", 400, "active", "uncleared"],
    ["CMP/2021/112", "Sanusi", "Halima", null, 400, "active", "cleared"],
    ["CMP/2021/158", "Adebayo", "Folake", "Ronke", 400, "active", "cleared"],
    ["CMP/2021/203", "Nwachukwu", "Emeka", null, 400, "active", "locked"],
    ["MTH/2022/018", "Adeyemi", "Tunde", "Ola", 300, "active", "locked"],
    ["STA/2022/091", "Bassey", "Idara", "Grace", 300, "active", "pending_verification"],
    ["CMP/2019/004", "Lawal", "Bilikisu", null, 400, "graduating", "cleared"],
  ];

  return rows.map(([matricNo, surname, firstName, otherNames, level, status, compliance], index) => ({
    studentId: `a${index}`,
    matricNo,
    surname,
    firstName,
    otherNames,
    level,
    status,
    compliance,
  }));
}

export type RegistrationDispute = {
  id: string;
  matricNo: string;
  claimedAt: string;
  /** Enough to recognise your own number, not enough to learn someone else's. */
  maskedPhone: string;
  autoFlagged: boolean;
};

export async function getRegistrationDisputes(): Promise<RegistrationDispute[]> {
  const now = Date.now();
  return [
    {
      id: "rd1",
      matricNo: "CMP/2021/047",
      claimedAt: new Date(now - 12 * 86_400_000).toISOString(),
      maskedPhone: "+234 803 *** 1188",
      autoFlagged: true,
    },
    {
      id: "rd2",
      matricNo: "STA/2022/091",
      claimedAt: new Date(now - 30 * 86_400_000).toISOString(),
      maskedPhone: "+234 806 *** 4402",
      autoFlagged: false,
    },
  ];
}

export type PaymentRow = {
  id: string;
  matricNo: string;
  surname: string;
  amountKobo: number;
  channel: "card" | "transfer";
  status: "pending" | "success" | "failed" | "abandoned";
  reference: string;
  createdAt: string;
};

export async function getPayments(): Promise<PaymentRow[]> {
  const now = Date.now();
  const rows: Array<[string, string, PaymentRow["channel"], PaymentRow["status"], string, number]> = [
    ["CMP/2021/112", "Sanusi", "transfer", "success", "DF-TEST-000112", 2],
    ["CMP/2021/158", "Adebayo", "card", "success", "DF-TEST-000158", 6],
    ["STA/2022/091", "Bassey", "transfer", "pending", "DF-TEST-000091", 9],
    ["CMP/2021/203", "Nwachukwu", "card", "failed", "DF-TEST-000203", 26],
    ["MTH/2022/018", "Adeyemi", "transfer", "abandoned", "DF-TEST-000018", 50],
  ];
  return rows.map(([matricNo, surname, channel, status, reference, hoursAgo], index) => ({
    id: `p${index}`,
    matricNo,
    surname,
    amountKobo: 500_000,
    channel,
    status,
    reference,
    createdAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
  }));
}

export type WhitelistRow = {
  id: string;
  matricNo: string;
  surname: string;
  level: number;
  claimed: boolean;
};

export async function getWhitelist(): Promise<WhitelistRow[]> {
  const rows: Array<[string, string, number, boolean]> = [
    ["CMP/2021/047", "Okonkwo", 400, true],
    ["CMP/2021/112", "Sanusi", 400, true],
    ["CMP/2021/158", "Adebayo", 400, true],
    ["CMP/2021/203", "Nwachukwu", 400, true],
    ["CMP/2021/241", "Ibrahim", 400, false],
    ["MTH/2022/018", "Adeyemi", 300, true],
    ["STA/2022/091", "Bassey", 300, false],
  ];
  return rows.map(([matricNo, surname, level, claimed], index) => ({
    id: `wl${index}`,
    matricNo,
    surname,
    level,
    claimed,
  }));
}

export type RolloverPreview = {
  fromSession: string;
  toSession: string;
  byLevel: Array<{ from: number; to: number; students: number }>;
  graduating: number;
};

export async function getRolloverPreview(): Promise<RolloverPreview> {
  return {
    fromSession: "2025/2026",
    toSession: "2026/2027",
    byLevel: [
      { from: 100, to: 200, students: 124 },
      { from: 200, to: 300, students: 120 },
      { from: 300, to: 400, students: 138 },
    ],
    graduating: 104,
  };
}

export type SystemConfig = {
  duesAmountKobo: number;
  resumptionDate: string;
  provisionalWindowDays: number;
  graceWindowDays: number;
  pendingBufferHours: number;
  gpsRetentionDays: number;
  defaultRadiusM: number;
  venues: Array<{ id: string; name: string; radiusM: number }>;
};

export async function getSystemConfig(): Promise<SystemConfig> {
  return {
    duesAmountKobo: 500_000,
    resumptionDate: "2025-09-15",
    provisionalWindowDays: 30,
    graceWindowDays: 30,
    pendingBufferHours: 12,
    gpsRetentionDays: 14,
    defaultRadiusM: 40,
    venues: [
      { id: "v1", name: "Lecture Theatre A", radiusM: 40 },
      { id: "v2", name: "Maths Block 2", radiusM: 35 },
    ],
  };
}

export type AuditEntry = {
  id: string;
  actor: string;
  actorRole: "hod" | "admin" | "lecturer";
  action: string;
  target: string;
  reason: string | null;
  createdAt: string;
};

export async function getAuditLog(): Promise<AuditEntry[]> {
  const now = Date.now();
  return [
    {
      id: "1",
      actor: "Dr Nnamdi Eze",
      actorRole: "hod",
      action: "grace_period.open",
      target: "Level 400",
      reason: "Payment portal was unreachable for four days during the deadline week.",
      createdAt: new Date(now - 3 * 3_600_000).toISOString(),
    },
    {
      id: "2",
      actor: "Dr Amina Bello",
      actorRole: "lecturer",
      action: "manual_batch.submit",
      target: "CMP 301 · 21 July",
      reason: "Network was down in Lecture Theatre A for the whole hour.",
      createdAt: new Date(now - 26 * 3_600_000).toISOString(),
    },
    {
      id: "3",
      actor: "Ibrahim Yusuf",
      actorRole: "admin",
      action: "registration.revoke",
      target: "CMP/2021/047",
      reason: "Impostor claim confirmed at the department office with student ID.",
      createdAt: new Date(now - 3 * 86_400_000).toISOString(),
    },
    {
      id: "4",
      actor: "Dr Nnamdi Eze",
      actorRole: "hod",
      action: "eligibility.authorize",
      target: "CMP 301",
      reason: "Final list for the 2025/2026 first semester.",
      createdAt: new Date(now - 5 * 86_400_000).toISOString(),
    },
  ];
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
  provisionalScore: number;
  status: "pending" | "granted" | "declined";
};

export async function getWaivers(): Promise<WaiverRequest[]> {
  const now = Date.now();
  return [
    {
      id: "w1",
      matricNo: "CMP/2021/203",
      surname: "Nwachukwu",
      firstName: "Emeka",
      otherNames: null,
      level: 400,
      requestNote:
        "My father was hospitalised in October and the family covered the bills. I can pay in January.",
      requestedAt: new Date(now - 2 * 86_400_000).toISOString(),
      provisionalScore: 9,
      status: "pending",
    },
    {
      id: "w2",
      matricNo: "STA/2022/091",
      surname: "Bassey",
      firstName: "Idara",
      otherNames: "Grace",
      level: 300,
      requestNote: "I am on the departmental hardship list for this session.",
      requestedAt: new Date(now - 5 * 86_400_000).toISOString(),
      provisionalScore: 6.5,
      status: "pending",
    },
  ];
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
  recordedReason: SubmitRejection;
  source: "digital" | "manually_entered";
  status: "open" | "upheld" | "corrected";
};

export async function getDisputes(): Promise<AttendanceDispute[]> {
  const now = Date.now();
  return [
    {
      id: "d1",
      matricNo: "CMP/2021/158",
      surname: "Adebayo",
      firstName: "Folake",
      otherNames: "Ronke",
      courseCode: "CMP 301",
      heldOn: new Date(now - 6 * 86_400_000).toISOString(),
      studentNote: "I was in the back row of the hall the whole lecture but it said I was outside.",
      recordedReason: "outside_geofence",
      source: "digital",
      status: "open",
    },
    {
      id: "d2",
      matricNo: "CMP/2022/018",
      surname: "Eze",
      firstName: "Chukwudi",
      otherNames: null,
      courseCode: "MTH 205",
      heldOn: new Date(now - 9 * 86_400_000).toISOString(),
      studentNote: "I signed the paper sheet but my name is not on the record.",
      recordedReason: "already_submitted",
      source: "manually_entered",
      status: "open",
    },
  ];
}

export type LecturerOversight = {
  lecturerId: string;
  name: string;
  sessionsHeld: number;
  paperBatches: number;
  singleCheckpoint: number;
  cancelled: number;
};

export async function getLecturerOversight(): Promise<LecturerOversight[]> {
  return [
    { lecturerId: "l1", name: "Dr Amina Bello", sessionsHeld: 36, paperBatches: 2, singleCheckpoint: 3, cancelled: 1 },
    { lecturerId: "l2", name: "Dr Segun Afolabi", sessionsHeld: 24, paperBatches: 9, singleCheckpoint: 7, cancelled: 4 },
    { lecturerId: "l3", name: "Mrs Ngozi Obi", sessionsHeld: 30, paperBatches: 0, singleCheckpoint: 1, cancelled: 0 },
  ];
}

export type EligibilityEntry = {
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

export type ScheduledSession = {
  sessionInstanceId: string;
  courseCode: string;
  heldOn: string;
  startsAt: string;
  endsAt: string;
  venue: string;
  type: "recurring" | "makeup" | "reschedule";
};

export async function getLecturerSchedule(): Promise<ScheduledSession[]> {
  const day = 86_400_000;
  return [
    {
      sessionInstanceId: "s1",
      courseCode: "CMP 301",
      heldOn: new Date(Date.now() + day).toISOString(),
      startsAt: "10:00",
      endsAt: "12:00",
      venue: "Lecture Theatre A",
      type: "recurring",
    },
    {
      sessionInstanceId: "s2",
      courseCode: "MTH 205",
      heldOn: new Date(Date.now() + 3 * day).toISOString(),
      startsAt: "08:00",
      endsAt: "10:00",
      venue: "Maths Block 2",
      type: "recurring",
    },
    {
      sessionInstanceId: "s3",
      courseCode: "STA 202",
      heldOn: new Date(Date.now() + 5 * day).toISOString(),
      startsAt: "15:00",
      endsAt: "17:00",
      venue: "Maths Block 2",
      type: "makeup",
    },
  ];
}

export type LecturerCourse = {
  courseId: string;
  code: string;
  title: string;
  enrolled: number;
  sessionsHeld: number;
  averagePct: number;
};

export async function getLecturerCourses(): Promise<LecturerCourse[]> {
  return [
    {
      courseId: "c1",
      code: "CMP 301",
      title: "Operating Systems",
      enrolled: 86,
      sessionsHeld: 13,
      averagePct: 71,
    },
    {
      courseId: "c2",
      code: "MTH 205",
      title: "Linear Algebra",
      enrolled: 54,
      sessionsHeld: 10,
      averagePct: 78,
    },
    {
      courseId: "c3",
      code: "STA 202",
      title: "Probability II",
      enrolled: 74,
      sessionsHeld: 13,
      averagePct: 64,
    },
  ];
}

export async function verifyOtp(code: string): Promise<{ ok: boolean; reason?: string }> {
  await pause(700);
  if (code === "000000") return { ok: false, reason: "That code has expired. Send a new one." };
  if (code !== "123456") return { ok: false, reason: "That code isn't right. Check your messages." };
  return { ok: true };
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
