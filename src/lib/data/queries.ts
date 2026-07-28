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
export async function sendOtp(_phone: string): Promise<{ expiresAt: string }> {
  await pause(700);
  return { expiresAt: new Date(Date.now() + 300_000).toISOString() };
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
