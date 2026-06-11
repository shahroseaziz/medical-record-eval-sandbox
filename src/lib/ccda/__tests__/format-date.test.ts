import { describe, it, expect } from 'vitest';
import { formatCcdaDate } from '../format-date';

describe('formatCcdaDate (SHA-76 shared date formatter)', () => {
  it('formats an 8-digit DOB TS as a clinical date', () => {
    expect(formatCcdaDate('19820314')).toBe('Mar 14, 1982');
  });

  it('drops the time component of a full YYYYMMDDHHMMSS TS', () => {
    expect(formatCcdaDate('19820314120000')).toBe('Mar 14, 1982');
  });

  it('drops a trailing timezone offset', () => {
    expect(formatCcdaDate('20090601-0500')).toBe('Jun 1, 2009');
    expect(formatCcdaDate('200906011230+0100')).toBe('Jun 1, 2009');
  });

  it('honours month precision when the day is absent', () => {
    expect(formatCcdaDate('198203')).toBe('Mar 1982');
  });

  it('honours year precision when month/day are absent', () => {
    expect(formatCcdaDate('1982')).toBe('1982');
  });

  it('never emits the raw 14-digit string for a valid TS', () => {
    const out = formatCcdaDate('19820314120000');
    expect(out).not.toMatch(/^\d{8,}$/);
  });

  it('returns an empty string for empty/nullish input', () => {
    expect(formatCcdaDate('')).toBe('');
    expect(formatCcdaDate(null)).toBe('');
    expect(formatCcdaDate(undefined)).toBe('');
  });

  it('falls back to the raw value for unrecognisable input rather than throwing', () => {
    expect(formatCcdaDate('not-a-date')).toBe('not-a-date');
  });

  it('falls back to raw for an out-of-range month or day', () => {
    expect(formatCcdaDate('19821399')).toBe('19821399');
    expect(formatCcdaDate('19820399')).toBe('19820399');
  });
});
