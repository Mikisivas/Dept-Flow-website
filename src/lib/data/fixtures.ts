/**
 * Development fixtures, mirroring `supabase/seed.sql` row for row.
 *
 * These sit behind the function signatures in `queries.ts`, which is what
 * screens import. When the Supabase client and the FastAPI endpoints exist,
 * `queries.ts` changes and nothing else does.
 *
 * The shapes here are the schema's shapes — same field names, same enums, same
 * kobo-as-a-number amounts — so a screen built against a fixture cannot be
 * built against a column that doesn't exist.
 */

import type { ComplianceState, CourseAttendance, SessionCell } from "@/lib/types";

export type StudentProfile = {
  id: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  level: number;
  phone: string;
};

export type DuesPeriod = {
  duesAmountKobo: number;
  resumptionDate: string;
  /** Day 30 of the provisional window — the deadline a student sees. */
  deadline: string;
  gracePeriodEnd: string | null;
};

export type TodayClass = {
  courseId: string;
  code: string;
  title: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  /** A checkpoint is open right now and the student has not submitted it. */
  liveCheckpoint: { index: 1 | 2; expiresAt: string } | null;
};

export const STUDENT: StudentProfile = {
  id: "44444444-4444-4444-4444-444444444401",
  matricNo: "CMP/2021/047",
  surname: "Okonkwo",
  firstName: "Chidera",
  otherNames: "Emeka",
  level: 400,
  phone: "+2348050000001",
};

export const COMPLIANCE: ComplianceState = "uncleared";

export const DUES: DuesPeriod = {
  duesAmountKobo: 500_000,
  resumptionDate: "2025-09-15",
  deadline: "2025-10-15",
  gracePeriodEnd: null,
};

/**
 * Chidera's CMP 301: 10.0 across 13 lectures, catching only one checkpoint in
 * four of them. That pattern — arriving late or leaving early — is what the
 * risk nudge is meant to name.
 */
const CMP301_PATTERN: Array<[boolean, boolean]> = [
  [true, true],
  [true, true],
  [true, false],
  [true, true],
  [false, true],
  [true, true],
  [false, false],
  [true, false],
  [true, true],
  [true, true],
  [true, false],
  [true, true],
  [true, true],
];

function buildSessions(
  courseCode: string,
  pattern: Array<[boolean, boolean]>,
  options: { provisional: boolean; paperWeeks?: number[]; singleWeeks?: number[] } = {
    provisional: true,
  },
): SessionCell[] {
  return pattern.map(([one, two], index) => {
    const week = index + 1;
    const single = options.singleWeeks?.includes(week) ?? false;
    return {
      id: `${courseCode}-w${week}`,
      label: `Week ${week}`,
      heldOn: new Date(Date.UTC(2025, 8, 16 + index * 7)).toISOString(),
      mode: single ? "single" : "pair",
      checkpointOne: one,
      checkpointTwo: single ? false : two,
      status: options.provisional ? "provisional" : "confirmed",
      source: options.paperWeeks?.includes(week) ? "manually_entered" : "digital",
      score: single ? (one ? 1 : 0) : one && two ? 1 : one || two ? 0.5 : 0,
    };
  });
}

function totalScore(sessions: SessionCell[]) {
  return sessions.reduce((sum, session) => sum + session.score, 0);
}

const CMP301_SESSIONS = buildSessions("CMP301", CMP301_PATTERN, {
  provisional: true,
  paperWeeks: [6],
  singleWeeks: [9],
});

const MTH205_SESSIONS = buildSessions(
  "MTH205",
  [
    [true, true],
    [true, false],
    [true, true],
    [false, false],
    [true, true],
    [true, false],
    [false, false],
    [true, true],
    [true, true],
    [false, false],
  ],
  { provisional: true },
);

const STA202_SESSIONS = buildSessions(
  "STA202",
  [
    [true, false],
    [true, false],
    [false, false],
    [true, false],
    [true, true],
    [false, false],
    [true, false],
    [true, false],
    [false, false],
    [true, false],
    [true, true],
    [false, false],
    [true, false],
  ],
  { provisional: true },
);

/**
 * Every score here is provisional, so `confirmedScore` is zero across the
 * board — which is the honest reading for a student who has not cleared, and
 * the reason the dashboard leads with the banner rather than a percentage.
 */
export const COURSES: CourseAttendance[] = [
  {
    courseId: "66666666-6666-6666-6666-666666666601",
    code: "CMP 301",
    title: "Operating Systems",
    confirmedScore: 0,
    provisionalScore: totalScore(CMP301_SESSIONS),
    sessionsHeld: CMP301_SESSIONS.length,
    sessions: CMP301_SESSIONS,
  },
  {
    courseId: "66666666-6666-6666-6666-666666666602",
    code: "MTH 205",
    title: "Linear Algebra",
    confirmedScore: 0,
    provisionalScore: totalScore(MTH205_SESSIONS),
    sessionsHeld: MTH205_SESSIONS.length,
    sessions: MTH205_SESSIONS,
  },
  {
    courseId: "66666666-6666-6666-6666-666666666603",
    code: "STA 202",
    title: "Probability II",
    confirmedScore: 0,
    provisionalScore: totalScore(STA202_SESSIONS),
    sessionsHeld: STA202_SESSIONS.length,
    sessions: STA202_SESSIONS,
  },
];

export const TODAY: TodayClass[] = [
  {
    courseId: "66666666-6666-6666-6666-666666666601",
    code: "CMP 301",
    title: "Operating Systems",
    venue: "Lecture Theatre A",
    startsAt: "10:00",
    endsAt: "12:00",
    liveCheckpoint: { index: 2, expiresAt: new Date(Date.now() + 205_000).toISOString() },
  },
  {
    courseId: "66666666-6666-6666-6666-666666666603",
    code: "STA 202",
    title: "Probability II",
    venue: "Maths Block 2",
    startsAt: "14:00",
    endsAt: "16:00",
    liveCheckpoint: null,
  },
];
