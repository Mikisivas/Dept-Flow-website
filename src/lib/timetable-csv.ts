/**
 * Parsing a pasted timetable.
 *
 * Separated from `admin.ts` because it is pure — no database, no session — and
 * because it is where the mistakes live. A day spelled "Tues", a time written
 * "1000", a venue whose name contains a comma: each is ordinary in a
 * departmental spreadsheet and each would silently drop a row if guessed at.
 * A dropped row is a class the lecturer cannot start.
 */

export type TimetableUploadRow = {
  courseCode: string;
  dayOfWeek: number;
  startsAt: string;
  endsAt: string;
  venue: string;
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Postgres `day_of_week` matches JavaScript's — 0 is Sunday. */
export function parseDay(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;

  const exact = DAY_NAMES.indexOf(text);
  if (exact >= 0) return exact;

  // "Mon", "Tues", "Thurs" — abbreviations are what people actually type.
  if (text.length >= 3) {
    const abbreviated = DAY_NAMES.findIndex((day) => day.startsWith(text.slice(0, 3)));
    if (abbreviated >= 0) return abbreviated;
  }

  const numeric = Number(text);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 6 ? numeric : null;
}

/** "10:00", "10:00:00", "1000" and "9:05" all mean the same slot. */
export function parseTime(value: string): string | null {
  const match = /^([0-9]{1,2}):?([0-9]{2})(?::[0-9]{2})?$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function parseTimetableRow(line: string): { row?: TimetableUploadRow; reason?: string } {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 5) {
    return { reason: "needs course code, day, start, end and venue" };
  }

  const [codeText, dayText, startText, endText, ...venueParts] = parts;
  const code = codeText.toUpperCase();

  if (!/^(MTH|CMP|STA) [0-9]{3}$/.test(code)) {
    return {
      reason: code.startsWith("CSC")
        ? "Computer Science is CMP in this department, not CSC"
        : `"${codeText}" is not a course code — expected e.g. CMP 301`,
    };
  }

  const dayOfWeek = parseDay(dayText);
  if (dayOfWeek === null) return { reason: `"${dayText}" is not a day of the week` };

  const startsAt = parseTime(startText);
  if (!startsAt) return { reason: `"${startText}" is not a time — expected e.g. 10:00` };

  const endsAt = parseTime(endText);
  if (!endsAt) return { reason: `"${endText}" is not a time — expected e.g. 12:00` };
  if (endsAt <= startsAt) return { reason: "the class ends before it starts" };

  // Venue names contain commas often enough — "Maths Block 2, Annexe" — that
  // the rest of the line is the venue rather than the fifth field alone.
  const venue = venueParts.join(", ").trim();
  if (!venue) return { reason: "no venue" };

  return { row: { courseCode: code, dayOfWeek, startsAt, endsAt, venue } };
}

export function parseTimetableCsv(csv: string): {
  rows: TimetableUploadRow[];
  rejected: Array<{ line: number; reason: string }>;
} {
  const rows: TimetableUploadRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];

  // Numbered by PHYSICAL line, blank lines included. Somebody reading "line 7"
  // will count down their spreadsheet to row 7, and an error pointing at a
  // different row than the one that caused it is worse than no line number.
  let seenContent = false;

  csv.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;

    // Tolerate a header row, since a spreadsheet export always has one.
    if (!seenContent && /^course/i.test(line)) {
      seenContent = true;
      return;
    }
    seenContent = true;

    const { row, reason } = parseTimetableRow(line);
    if (row) rows.push(row);
    else rejected.push({ line: index + 1, reason: reason ?? "could not read that line" });
  });

  return { rows, rejected };
}

/** Same slot means same course, same day, same start. */
export function slotKey(row: { courseCode: string; dayOfWeek: number; startsAt: string }) {
  return `${row.courseCode}|${row.dayOfWeek}|${row.startsAt}`;
}
