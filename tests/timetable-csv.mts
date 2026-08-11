/**
 * Parsing a pasted timetable.
 *
 * A rejected row is a class the lecturer cannot start, so what matters most
 * here is that ordinary spreadsheet spellings are accepted and genuinely
 * malformed ones are named rather than skipped.
 *
 *   npm run test:timetable
 */

import { parseDay, parseTime, parseTimetableCsv, parseTimetableRow } from "../src/lib/timetable-csv.ts";

let failed = 0;
function check(what: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} — ${what}`);
  if (!ok) failed++;
}

// --- days -------------------------------------------------------------------

check("a full day name is read", parseDay("Tuesday") === 2);
check("case does not matter", parseDay("TUESDAY") === 2 && parseDay("tuesday") === 2);
check("the abbreviations people actually type are read", parseDay("Tues") === 2 && parseDay("Thurs") === 4);
check("three letters are enough", parseDay("Mon") === 1 && parseDay("Sat") === 6);
check("Sunday is 0, matching Postgres and JavaScript", parseDay("Sunday") === 0);
check("a bare number is accepted", parseDay("3") === 3);
check("a number outside the week is refused", parseDay("7") === null && parseDay("-1") === null);
check("a word that is not a day is refused", parseDay("Someday") === null);
check("an empty day is refused rather than defaulting to Sunday", parseDay("") === null);

// --- times ------------------------------------------------------------------

check("HH:MM is read", parseTime("10:00") === "10:00");
check("seconds are tolerated", parseTime("10:00:00") === "10:00");
check("a missing colon is tolerated", parseTime("1000") === "10:00");
check("a single-digit hour is padded", parseTime("9:05") === "09:05");
check("an impossible hour is refused", parseTime("25:00") === null);
check("an impossible minute is refused", parseTime("10:75") === null);
check("words are refused", parseTime("morning") === null);

// --- rows -------------------------------------------------------------------

const good = parseTimetableRow("CMP 301, Tuesday, 10:00, 12:00, Lecture Theatre A");
check(
  "a well-formed row is read whole",
  good.row?.courseCode === "CMP 301" &&
    good.row?.dayOfWeek === 2 &&
    good.row?.startsAt === "10:00" &&
    good.row?.endsAt === "12:00" &&
    good.row?.venue === "Lecture Theatre A",
);

const commaVenue = parseTimetableRow("MTH 205, Thu, 08:00, 10:00, Maths Block 2, Annexe");
check(
  "a venue containing a comma survives — the rest of the line is the venue",
  commaVenue.row?.venue === "Maths Block 2, Annexe",
);

const lower = parseTimetableRow("cmp 301, tue, 1000, 1200, Lecture Theatre A");
check("a lower-case course code is upper-cased, not rejected", lower.row?.courseCode === "CMP 301");

const csc = parseTimetableRow("CSC 301, Tuesday, 10:00, 12:00, Lecture Theatre A");
check(
  "CSC is refused by name — this department's prefix is CMP",
  csc.row === undefined && /CMP in this department/.test(csc.reason ?? ""),
);

const backwards = parseTimetableRow("CMP 301, Tuesday, 12:00, 10:00, Lecture Theatre A");
check(
  "a class that ends before it starts is refused",
  backwards.row === undefined && /ends before it starts/.test(backwards.reason ?? ""),
);

const short = parseTimetableRow("CMP 301, Tuesday, 10:00");
check("a row missing fields says which are needed", /needs course code/.test(short.reason ?? ""));

const noVenue = parseTimetableRow("CMP 301, Tuesday, 10:00, 12:00,");
check("a row with no venue is refused", /no venue/.test(noVenue.reason ?? ""));

// --- whole files ------------------------------------------------------------

const withHeader = parseTimetableCsv(
  "course_code,day,start,end,venue\nCMP 301, Tuesday, 10:00, 12:00, Lecture Theatre A",
);
check(
  "a header row is ignored rather than reported as a bad line",
  withHeader.rows.length === 1 && withHeader.rejected.length === 0,
);

const mixed = parseTimetableCsv(
  [
    "CMP 301, Tuesday, 10:00, 12:00, Lecture Theatre A",
    "",
    "GARBAGE",
    "MTH 205, Thursday, 08:00, 10:00, Maths Block 2",
  ].join("\n"),
);
check("good rows survive a bad one beside them", mixed.rows.length === 2);
check("and the bad one is reported, never silently skipped", mixed.rejected.length === 1);
check(
  "the line number points at the physical line, so counting down the paste finds it",
  mixed.rejected[0].line === 3,
);

const crlf = parseTimetableCsv("CMP 301, Tuesday, 10:00, 12:00, Lecture Theatre A\r\nMTH 205, Thu, 08:00, 10:00, Maths Block 2\r\n");
check("Windows line endings are handled — the paste usually comes from Excel", crlf.rows.length === 2);

console.log(failed === 0 ? "\nALL TIMETABLE PARSING CHECKS PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
