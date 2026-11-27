/**
 * Who this system belongs to, said once.
 *
 * The thesis is "an Examination-Eligibility Alert System for Rev. Fr. Moses
 * Orshio Adasu University, Makurdi", scoped to one department. Every screen
 * that names the university, the faculty, the department or the system reads
 * it from here, so the permit, the landing page and the browser tab cannot
 * drift into three spellings of the same institution.
 *
 * The faculty directory on the landing page is data, in the `faculties` and
 * `departments` tables. These are the names the operational screens need
 * without a query.
 */
export const INSTITUTION = {
  university: "Rev. Fr. Moses Orshio Adasu University, Makurdi",
  faculty: "Faculty of Science",
  department: "Department of Mathematics and Computer Science",
  system: "Examination-Eligibility Alert System",
  /** Where the full name will not fit: the header, the home-screen label. */
  systemShort: "EEAS",
} as const;
