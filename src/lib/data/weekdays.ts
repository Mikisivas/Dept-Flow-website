/**
 * Weekday names, shared between the server and the browser.
 *
 * Not in `admin.ts`: that module is `server-only`, and the timetable upload
 * needs to render a day name in a client component. Postgres `day_of_week`
 * matches JavaScript's — 0 is Sunday.
 */
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function weekdayName(dayOfWeek: number): string {
  return WEEKDAYS[dayOfWeek] ?? "—";
}
