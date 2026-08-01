/**
 * The screens' only door to data.
 *
 * Every function here is the signature the real client will keep — the same
 * arguments, the same return shapes, the same async. Today they resolve
 * fixtures; tomorrow they call Supabase for reads and FastAPI for anything
 * that changes a student's standing. No screen changes either way.
 *
 * Reads may go straight to Supabase under RLS. Writes must not: role
 * separation and the audit log live in the API, and a client that can write
 * `compliance_statuses` has defeated both.
 */

import { COMPLIANCE, COURSES, DUES, STUDENT, TODAY } from "@/lib/data/fixtures";
import type { DuesPeriod, StudentProfile, TodayClass } from "@/lib/data/fixtures";
import type { ComplianceState, CourseAttendance, RiskPattern } from "@/lib/types";

export type StudentDashboard = {
  student: StudentProfile;
  compliance: ComplianceState;
  dues: DuesPeriod;
  courses: CourseAttendance[];
  today: TodayClass[];
  risk: { pattern: RiskPattern; courseCode: string } | null;
};

export async function getStudentDashboard(): Promise<StudentDashboard> {
  return {
    student: STUDENT,
    compliance: COMPLIANCE,
    dues: DUES,
    courses: COURSES,
    today: TODAY,
    // Advisory only. The authoritative 75% determination is always computed
    // from confirmed scores, never from this.
    risk: { pattern: "partial_attendance", courseCode: "STA 202" },
  };
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

export type LiveCheckpoint = {
  sessionInstanceId: string;
  checkpointId: string;
  courseCode: string;
  courseTitle: string;
  lecturer: string;
  venue: string;
  index: 1 | 2;
  expiresAt: string;
  /** What the session is already worth to this student. */
  firstCheckpointCaptured: boolean;
};

export type CheckpointOutcome = {
  index: 1 | 2;
  sessionScore: number;
  bothCaptured: boolean;
};

/**
 * Every rejection a student can meet has its own reason, because every one of
 * them gets its own message on screen. A generic failure here generates
 * disputes the HOD then has to resolve by hand.
 */
export type SubmitRejection =
  | "outside_geofence"
  | "invalid_or_expired_token"
  | "wrong_code"
  | "account_locked"
  | "already_submitted"
  | "location_blocked";

export async function getLiveCheckpoint(): Promise<LiveCheckpoint | null> {
  return {
    sessionInstanceId: "cmp301-2026-01-13",
    checkpointId: "cmp301-2026-01-13-cp2",
    courseCode: "CMP 301",
    courseTitle: "Operating Systems",
    lecturer: "Dr Amina Bello",
    venue: "Lecture Theatre A",
    index: 2,
    expiresAt: new Date(Date.now() + 224_000).toISOString(),
    firstCheckpointCaptured: true,
  };
}

export async function submitCheckpoint(payload: {
  checkpointId: string;
  token: string;
  coords: { latitude: number; longitude: number; accuracy: number };
}): Promise<CheckpointOutcome> {
  await pause(900);

  // Stand-in for the server's decision. The real endpoint checks the token,
  // the geo-fence, the anti-spoof heuristics and the lock state, in that
  // order, and the client never second-guesses any of them.
  if (payload.token === "0000") throw new RejectedSubmission("wrong_code");
  if (payload.token === "1111") throw new RejectedSubmission("outside_geofence");
  if (payload.token === "2222") throw new RejectedSubmission("invalid_or_expired_token");
  if (payload.token === "3333") throw new RejectedSubmission("account_locked");
  if (payload.token === "4444") throw new RejectedSubmission("already_submitted");
  if (payload.token === "9999") throw new Error("Network request failed");

  return { index: 2, sessionScore: 1, bothCaptured: true };
}

/** A definitive answer from the server. Retrying it wastes the token window. */
export class RejectedSubmission extends Error {
  constructor(public readonly reason: SubmitRejection) {
    super(reason);
    this.name = "RejectedSubmission";
  }
}

/* ---------------------------------------------------------------------------
   Lecturer
   --------------------------------------------------------------------------- */

export type LecturerClass = {
  sessionInstanceId: string;
  courseCode: string;
  courseTitle: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  enrolled: number;
  status: "scheduled" | "open" | "closed";
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
    /** Set when the lecturer only ever issued one token. */
    singleCheckpoint: boolean;
    fromPaper: boolean;
  }>;
};

export async function getLecturerDashboard(): Promise<LecturerDashboard> {
  return {
    lecturer: { surname: "Bello", firstName: "Amina" },
    today: [
      {
        sessionInstanceId: "cmp301-today",
        courseCode: "CMP 301",
        courseTitle: "Operating Systems",
        venue: "Lecture Theatre A",
        startsAt: "10:00",
        endsAt: "12:00",
        enrolled: 86,
        status: "open",
      },
      {
        sessionInstanceId: "sta202-today",
        courseCode: "STA 202",
        courseTitle: "Probability II",
        venue: "Maths Block 2",
        startsAt: "14:00",
        endsAt: "16:00",
        enrolled: 74,
        status: "scheduled",
      },
    ],
    openSession: {
      sessionInstanceId: "cmp301-today",
      courseCode: "CMP 301",
      courseTitle: "Operating Systems",
      venue: "Lecture Theatre A",
      startsAt: "10:00",
      endsAt: "12:00",
      enrolled: 86,
      status: "open",
    },
    recent: [
      {
        sessionInstanceId: "cmp301-w12",
        courseCode: "CMP 301",
        heldOn: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        full: 61,
        half: 14,
        absent: 11,
        singleCheckpoint: false,
        fromPaper: false,
      },
      {
        sessionInstanceId: "mth205-w12",
        courseCode: "MTH 205",
        heldOn: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        full: 40,
        half: 6,
        absent: 8,
        singleCheckpoint: true,
        fromPaper: false,
      },
      {
        sessionInstanceId: "sta202-w11",
        courseCode: "STA 202",
        heldOn: new Date(Date.now() - 14 * 86_400_000).toISOString(),
        full: 52,
        half: 9,
        absent: 13,
        singleCheckpoint: false,
        fromPaper: true,
      },
    ],
  };
}

export type SessionControl = {
  sessionInstanceId: string;
  courseCode: string;
  courseTitle: string;
  venue: string;
  openedAt: string;
  enrolled: number;
  /**
   * Which checkpoint is still open, decided by the server. The client must not
   * work this out from its own clock: a phone with a skewed clock would either
   * keep a dead code on the board or retire a live one early.
   */
  liveCheckpointIndex: 1 | 2 | null;
  checkpoints: Array<{
    index: 1 | 2;
    token: string;
    expiresAt: string;
    submissions: number;
    rejections: Array<{ reason: SubmitRejection; count: number }>;
  }>;
};

export async function getSessionControl(id: string): Promise<SessionControl> {
  return {
    sessionInstanceId: id,
    courseCode: "CMP 301",
    courseTitle: "Operating Systems",
    venue: "Lecture Theatre A",
    openedAt: new Date(Date.now() - 34 * 60_000).toISOString(),
    enrolled: 86,
    liveCheckpointIndex: null,
    checkpoints: [
      {
        index: 1,
        token: "4821",
        expiresAt: new Date(Date.now() - 28 * 60_000).toISOString(),
        submissions: 74,
        rejections: [
          { reason: "outside_geofence", count: 3 },
          { reason: "invalid_or_expired_token", count: 1 },
        ],
      },
    ],
  };
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
