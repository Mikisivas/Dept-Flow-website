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
