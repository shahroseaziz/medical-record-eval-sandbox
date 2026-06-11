/**
 * Shared C-CDA date formatter (SHA-76).
 *
 * The single render path for turning HL7 v3 timestamp (TS) strings — as they
 * arrive from Synthea C-CDA documents — into human-readable clinical dates.
 *
 * Every patient-facing surface that renders a date (record viewer DOB,
 * encounter dates, composer/delta surfaces) MUST route through this module so
 * raw `YYYYMMDDHHMMSS` strings never leak into the UI and the rendering stays
 * consistent as new surfaces are added.
 *
 * HL7 v3 TS grammar (the parts we honour):
 *   YYYY[MM[DD[HH[MM[SS]]]]][.ffff][(+|-)ZZZZ]
 * Anything past the day component (time, fractional seconds, timezone offset)
 * is intentionally dropped — clinical record views show calendar dates, not
 * wall-clock instants, and dropping the offset keeps rendering deterministic
 * (no locale/timezone drift between server and browser).
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Formats a C-CDA / HL7 v3 TS string as a human-readable clinical date.
 *
 * Examples:
 *   "19820314"        → "Mar 14, 1982"
 *   "19820314120000"  → "Mar 14, 1982"   (time dropped)
 *   "20090601-0500"   → "Jun 1, 2009"    (tz offset dropped)
 *   "198203"          → "Mar 1982"       (day-precision absent)
 *   "1982"            → "1982"           (year-precision only)
 *
 * Returns an empty string for empty input, and returns the original value
 * unchanged when it is not a recognisable TS (graceful, non-throwing — a
 * malformed date should never blank out or crash a record view).
 */
export function formatCcdaDate(ts: string | null | undefined): string {
  if (ts == null) return '';
  const raw = String(ts).trim();
  if (!raw) return '';

  const m = /^(\d{4})(\d{2})?(\d{2})?/.exec(raw);
  if (!m) return raw;

  const [, yyyy, mm, dd] = m;
  const year = Number(yyyy);
  if (!year) return raw;

  if (!mm) return yyyy;
  const monthIdx = Number(mm) - 1;
  if (monthIdx < 0 || monthIdx > 11) return raw;
  const month = MONTHS[monthIdx];

  if (!dd) return `${month} ${year}`;
  const day = Number(dd);
  if (day < 1 || day > 31) return raw;

  return `${month} ${day}, ${year}`;
}
