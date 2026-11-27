/**
 * The product's vocabulary, mirroring the database enums.
 *
 * These five compliance states are the whole set. Never add "partial",
 * "warning" or "review" — if a screen seems to need a sixth state, the screen
 * is wrong.
 */

export type ComplianceState = "uncleared" | "cleared" | "pending_verification" | "locked";

export type ScoreSource = "digital" | "manually_entered";

/**
 * What a student actually sees on a badge.
 *
 * `provisional` is gone with the state it named. It meant "recorded but not
 * counted until you pay", and payment no longer decides whether a lecture
 * counts — so a badge saying it would be describing a condition the system
 * cannot produce.
 *
 * `unpaid` is a different thing and not its replacement: it describes the dues
 * a student owes while the window is still open, never a lecture. It is here
 * because the compliance screens were borrowing `pending` for it, and `pending`
 * reads "Checking payment…" — a claim about a payment nobody has made.
 */
export type StatusVariant = "counted" | "unpaid" | "pending" | "locked" | "atRisk";

export type AppRole = "student" | "lecturer" | "hod" | "admin";

export type RiskPattern = "disengagement" | "partial_attendance";

/**
 * §5.2, and the three bands are not arbitrary. 75% is the eligibility rule, so
 * Watch is where a student is projected to land ON the line with nothing
 * spare — one illness from ineligible. Safe means there is room for something
 * to go wrong.
 */
export type RiskTier = "safe" | "watch" | "critical";

/**
 * What the warning system knows about one student on one course.
 *
 * `currentPct` and `projectedPct` are different numbers and the gap between
 * them is the product: a student at 77% heading for 66% is the case a
 * scoreboard shows green and says nothing about.
 */
export type CourseForecast = {
  courseId: string;
  courseCode: string;
  tier: RiskTier;
  projectedPct: number;
  /** Percentage points per lecture. Negative is a student falling away. */
  trend: number;
  lecturesHeld: number;
  lecturesExpected: number;
  /** Of the lectures still to come, how many are needed to reach the line. */
  mustAttend: number;
  /** And how many can be missed. The number a student on track actually reads. */
  canStillMiss: number;
  pattern: RiskPattern | null;
};

export type ProgrammeCode = "MTH" | "CMP" | "STA";

/** One lecture, as the AttendanceStrip draws it. */
export type SessionCell = {
  id: string;
  /** Shown in the accessible label: "Week 4". */
  label: string;
  heldOn: string;
  /** Present or absent. There is no third thing a lecture can be. */
  attended: boolean;
  source: ScoreSource;
  score: number;
};

/* -------------------------------------------------------------------------
   The three programmes

   Computer Science is CMP in this department, never CSC, and the database
   rejects the wrong prefix in both matric numbers and course codes. The
   prefix is what `students.programme` holds, generated from the matric
   number; the name is what a person reads.

   Here rather than in the HOD's data module because the composer that offers
   these is a client component, and that module is server-only.
   ------------------------------------------------------------------------- */

export type Programme = "MTH" | "CMP" | "STA";

export const PROGRAMMES: { code: Programme; name: string }[] = [
  { code: "MTH", name: "Mathematics" },
  { code: "CMP", name: "Computer Science" },
  { code: "STA", name: "Statistics" },
];

/**
 * "300 level Computer Science", not "CMP 300".
 *
 * The HOD names this audience in words, and a screen that answers in matric
 * prefixes makes them translate their own intent back before they can check
 * it against what they meant.
 */
export function programmeLevelLabel(programme: string | null, level: number | null): string {
  const named = PROGRAMMES.find((entry) => entry.code === programme);
  return `${level ?? "?"} level ${named?.name ?? programme ?? "unknown programme"}`;
}

/* -------------------------------------------------------------------------
   The attendance code

   Shared between the server that decides and the client that renders the
   decision, so they live here rather than in a server-only module.
   ------------------------------------------------------------------------- */

/**
 * The live code as the student is allowed to see it.
 *
 * There is no `token` field, and there must never be one: the code is on the
 * board, and being in the room to read it is what attendance now rests on. It
 * is the only thing that does — there is no second check behind it.
 */
export type LiveCheckpoint = {
  sessionInstanceId: string;
  checkpointId: string;
  courseCode: string;
  courseTitle: string;
  lecturer: string;
  venue: string;
  expiresAt: string;
};

/**
 * Every rejection a student can meet has its own reason, because every one of
 * them gets its own message on screen. A generic failure here generates
 * disputes the HOD then has to resolve by hand.
 *
 * `not_registered` is the one that carries weight now: after the registration
 * deadline, a student who never confirmed cannot record attendance at all, and
 * telling them "wrong code" would send them back to the board to retype a code
 * that was never going to work.
 */
export type SubmitRejection =
  | "invalid_or_expired_token"
  | "wrong_code"
  | "not_registered"
  | "account_locked"
  | "already_submitted";

export type CheckpointOutcome = {
  /** The lecture, recorded. Final scoring happens when the lecturer closes it. */
  sessionScore: number;
};

/** Card and Pay with Transfer only. Dedicated virtual accounts were dropped. */
export type PaymentChannel = "card" | "transfer";

/** A dues payment as the student sees it in their own history. */
export type PaymentRecord = {
  reference: string;
  amountKobo: number;
  status: "pending" | "success" | "failed" | "abandoned" | "reversed";
  channel: "card" | "transfer" | null;
  paidAt: string | null;
  startedAt: string;
};

export type LecturerClassStatus = "scheduled" | "open" | "closed" | "cancelled";

/** One student on a lecture's roster, as captured rather than as scored. */
export type RosterEntry = {
  studentId: string;
  matricNo: string;
  surname: string;
  firstName: string;
  otherNames: string | null;
  present: boolean;
};

/** One lecture as the lecturer's control panel operates it. */
export type SessionControl = {
  sessionInstanceId: string;
  courseCode: string;
  courseTitle: string;
  venue: string;
  status: LecturerClassStatus;
  openedAt: string;
  enrolled: number;
  /**
   * The lecture's code, or null once it has lapsed. Whether it is still live is
   * decided by the server: a phone with a skewed clock would either keep a dead
   * code on the board or retire a live one early.
   */
  code: {
    token: string;
    expiresAt: string;
    submissions: number;
    rejections: Array<{ reason: string; count: number }>;
  } | null;
};

export type CourseAttendance = {
  courseId: string;
  code: string;
  title: string;
  /** Lectures attended — the numerator of the one formula. */
  attendedCount: number;
  sessionsHeld: number;
  sessions: SessionCell[];
};
