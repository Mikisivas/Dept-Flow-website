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
 * `student.ts`, the lecturer path in `lecturer.ts`, attendance in
 * `attendance.ts`, the HOD's in `hod.ts` and the administrator's in
 * `admin.ts`.
 *
 * Reads may go straight to Supabase under RLS. Writes must not: role
 * separation and the audit log live in the API, and a client that can write
 * `compliance_statuses` has defeated both.
 */

import { COURSES } from "@/lib/data/fixtures";
import type { CourseAttendance } from "@/lib/types";

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

export async function verifyOtp(code: string): Promise<{ ok: boolean; reason?: string }> {
  await pause(700);
  if (code === "000000") return { ok: false, reason: "That code has expired. Send a new one." };
  if (code !== "123456") return { ok: false, reason: "That code isn't right. Check your messages." };
  return { ok: true };
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
