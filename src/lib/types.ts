/**
 * The product's vocabulary, mirroring the database enums.
 *
 * These five compliance states are the whole set. Never add "partial",
 * "warning" or "review" — if a screen seems to need a sixth state, the screen
 * is wrong.
 */

export type ComplianceState = "uncleared" | "cleared" | "pending_verification" | "locked";

export type ScoreStatus = "provisional" | "confirmed";

export type ScoreSource = "digital" | "manually_entered";

/** The five StatusBadge variants, which are what a student actually sees. */
export type StatusVariant = "confirmed" | "provisional" | "pending" | "locked" | "atRisk";

export type AppRole = "student" | "lecturer" | "hod" | "admin";

export type RiskPattern = "disengagement" | "partial_attendance";

export type ProgrammeCode = "MTH" | "CMP" | "STA";

/** One lecture, as the CheckpointStrip draws it. */
export type SessionCell = {
  id: string;
  /** Shown in the accessible label: "Week 4". */
  label: string;
  heldOn: string;
  /** Two checkpoints unless the lecturer only ever issued one. */
  mode: "pair" | "single";
  checkpointOne: boolean;
  checkpointTwo: boolean;
  status: ScoreStatus;
  source: ScoreSource;
  score: number;
};

/* -------------------------------------------------------------------------
   Checkpoints

   Shared between the server that decides and the client that renders the
   decision, so they live here rather than in a server-only module.
   ------------------------------------------------------------------------- */

/**
 * A checkpoint as the student is allowed to see it.
 *
 * There is no `token` field, and there must never be one: the code is on the
 * board, and being in the room to read it is the whole mechanism.
 */
export type LiveCheckpoint = {
  sessionInstanceId: string;
  checkpointId: string;
  courseCode: string;
  courseTitle: string;
  lecturer: string;
  venue: string;
  index: 1 | 2;
  expiresAt: string;
  /** What this lecture is already worth to this student. */
  firstCheckpointCaptured: boolean;
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

export type CheckpointOutcome = {
  index: 1 | 2;
  /** What the lecture is worth so far. Final scoring happens when it closes. */
  sessionScore: number;
  bothCaptured: boolean;
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
  checkpointOne: boolean;
  checkpointTwo: boolean;
  flagged: boolean;
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
    rejections: Array<{ reason: string; count: number }>;
  }>;
};

export type CourseAttendance = {
  courseId: string;
  code: string;
  title: string;
  /** Sum of confirmed scores — the numerator of the one formula. */
  confirmedScore: number;
  /** Sum of scores recorded but not yet counted. */
  provisionalScore: number;
  sessionsHeld: number;
  sessions: SessionCell[];
};
