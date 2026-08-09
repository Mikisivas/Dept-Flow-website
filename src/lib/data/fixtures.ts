/**
 * Shapes the student screens are built against.
 *
 * This file held the development fixtures the screens were first built on —
 * a whole invented student, their courses and their thirteen weeks of
 * attendance. Every one of those screens now reads Supabase, so the data is
 * gone and only the shapes remain.
 *
 * They are the schema's shapes: same field names, same enums, same
 * kobo-as-a-number amounts. Keeping them means a screen cannot be built
 * against a column that does not exist.
 */


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
