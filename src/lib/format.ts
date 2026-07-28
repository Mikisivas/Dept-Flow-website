/**
 * Every date, number and name in Dept-Flow is formatted here.
 *
 * Hardcoded formats are a pre-ship rejection, and this product has a hard
 * midnight boundary at Day 30/31 where a hand-rolled date string goes wrong
 * quietly. One module, one set of rules.
 */

const LOCALE = "en-NG";
const TIME_ZONE = "Africa/Lagos";

/* -------------------------------------------------------------------------
   Money
   ------------------------------------------------------------------------- */

/**
 * Amounts are stored in kobo. ₦5,000 is 500000.
 *
 * Kobo are held as floats in the database by project decision, so the value
 * arriving here can carry representation error; rounding on the way in stops
 * "₦4,999.99" ever reaching a student's screen.
 */
export function naira(kobo: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(kobo) / 100);
}

/** Paystack requires an integer kobo amount. This is that boundary cast. */
export function toPaystackAmount(kobo: number): number {
  return Math.round(kobo);
}

/* -------------------------------------------------------------------------
   Dates and times
   ------------------------------------------------------------------------- */

export function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(toDate(value));
}

/** Compact form for table cells and session rows: "16 Sep 2025". */
export function formatDateShort(value: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(toDate(value));
}

export function formatTime(value: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(toDate(value));
}

export function formatDateTime(value: Date | string): string {
  return `${formatDateShort(value)}, ${formatTime(value)}`;
}

/** "Tuesday" — used on timetable rows. */
export function formatWeekday(value: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    timeZone: TIME_ZONE,
  }).format(toDate(value));
}

/**
 * Whole days between now and a deadline, counted in the Lagos calendar rather
 * than in elapsed milliseconds — "6 days left" must not become "5" because the
 * comparison happened at 23:00.
 */
export function daysUntil(value: Date | string, from: Date = new Date()): number {
  const target = startOfLagosDay(toDate(value));
  const start = startOfLagosDay(from);
  return Math.round((target - start) / 86_400_000);
}

/** "6 days left" / "1 day left" / "today". */
export function formatDaysLeft(value: Date | string, from: Date = new Date()): string {
  const days = daysUntil(value, from);
  if (days < 0) return "past";
  if (days === 0) return "today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

/** mm:ss for a token expiry or resend cooldown. */
export function formatCountdown(secondsRemaining: number): string {
  const clamped = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------
   Attendance
   ------------------------------------------------------------------------- */

/**
 * The one formula. Mirrors `attendance_pct()` in the database; the database
 * remains authoritative, this exists so a screen can recompute without a round
 * trip.
 */
export function attendancePct(confirmedScore: number, sessionsHeld: number): number {
  if (sessionsHeld <= 0) return 0;
  return Math.round((confirmedScore / sessionsHeld) * 10_000) / 100;
}

/**
 * How many further full sessions reach the threshold, given that each one adds
 * to both sides of the fraction. This is the number in the AttendanceMeter
 * sentence: "You need 4 more full sessions to reach 75%."
 *
 * Mirrors `full_sessions_needed()` in the database.
 */
export function fullSessionsNeeded(
  confirmedScore: number,
  sessionsHeld: number,
  thresholdPct = 75,
): number {
  const t = thresholdPct / 100;
  if (t >= 1) return Infinity;
  return Math.max(0, Math.ceil((t * sessionsHeld - confirmedScore) / (1 - t)));
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value)}%`;
}

/** "9.5 of 13 sessions" — halves shown, whole numbers left clean. */
export function formatScore(value: number): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/* -------------------------------------------------------------------------
   Names
   ------------------------------------------------------------------------- */

export type PersonName = {
  surname: string;
  firstName: string;
  otherNames?: string | null;
};

/**
 * Register order — "OKONKWO, Chidera Emeka".
 *
 * Used in tables, rosters and the eligibility list, where the surname is what
 * a reader scans and two students may share a first name.
 */
export function displayNameRegister({ surname, firstName, otherNames }: PersonName): string {
  const rest = [firstName, otherNames?.trim()].filter(Boolean).join(" ");
  return `${surname.toUpperCase()}, ${rest}`;
}

/** Conversational order — "Chidera Okonkwo". Greetings and the account menu. */
export function displayNameFamiliar({ surname, firstName }: PersonName): string {
  return `${firstName} ${surname}`;
}

/* -------------------------------------------------------------------------
   Matric numbers
   ------------------------------------------------------------------------- */

const MATRIC_PATTERN = /^(MTH|CMP|STA)\/\d{4}\/\d{3,4}$/;

/**
 * Programme is carried by the prefix and is never asked for at registration —
 * it is read from the number and shown back as confirmation.
 *
 * Computer Science is CMP in this department.
 */
const PROGRAMME_NAMES: Record<string, string> = {
  MTH: "Mathematics",
  CMP: "Computer Science",
  STA: "Statistics",
};

export function isValidMatric(matric: string): boolean {
  return MATRIC_PATTERN.test(matric.trim().toUpperCase());
}

export function normaliseMatric(matric: string): string {
  return matric.trim().toUpperCase();
}

export function programmeFromMatric(matric: string): string | null {
  const prefix = normaliseMatric(matric).split("/")[0];
  return PROGRAMME_NAMES[prefix] ?? null;
}

/* -------------------------------------------------------------------------
   Internals
   ------------------------------------------------------------------------- */

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Midnight in Lagos, as a timestamp, for whole-day arithmetic. */
function startOfLagosDay(value: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).format(value);
  return Date.parse(`${parts}T00:00:00Z`);
}
