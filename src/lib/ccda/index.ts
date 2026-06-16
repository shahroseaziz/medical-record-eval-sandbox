import { XMLParser } from 'fast-xml-parser';
import type { Chunk, Demographics, ParseResult, PatientSummary, SectionResult } from './types';

export type { Chunk, Demographics, ParseResult, PatientSummary, SectionResult };
export { formatCcdaDate } from './format-date';

/** LOINC code → section name for the 7 coded C-CDA sections */
const LOINC_TO_SECTION: Record<string, string> = {
  '11450-4': 'problems',
  '10160-0': 'medications',
  '48765-2': 'allergies',
  '30954-2': 'results',
  '46240-8': 'encounters',
  '11369-6': 'immunizations',
  '8716-3': 'vitals',
};

/**
 * Approximate token limit per chunk.
 * Estimation: 1 token ≈ 4 characters of plain text.
 * 1500 tokens × 4 = 6000 chars.
 */
const APPROX_MAX_CHARS = 6_000;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits the raw HTML narrative of a section into one or more Chunk objects.
 * Splitting is by <tr> boundaries when the plain-text length exceeds APPROX_MAX_CHARS.
 *
 * `sourceXml` is the raw <section>…</section> substring and is attached identically
 * to every chunk produced from this section (shared, not per-chunk-sliced).
 */
function chunkSection(
  patientId: string,
  section: string,
  rawHtml: string,
  sourceXml: string,
): Chunk[] {
  const fullText = stripHtml(rawHtml);

  if (fullText.length <= APPROX_MAX_CHARS) {
    return [{ patientId, section, ord: 0, text: fullText, sourceXml }];
  }

  // Split by table rows
  const rowMatches = [...rawHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)];
  if (rowMatches.length > 0) {
    const chunks: Chunk[] = [];
    let current = '';
    let ord = 0;

    for (const match of rowMatches) {
      const rowText = stripHtml(match[0]);
      if (!rowText) continue;

      if (current.length > 0 && current.length + rowText.length + 1 > APPROX_MAX_CHARS) {
        chunks.push({ patientId, section, ord: ord++, text: current.trim(), sourceXml });
        current = '';
      }
      current += (current ? '\n' : '') + rowText;
    }

    if (current.trim()) {
      chunks.push({ patientId, section, ord: ord++, text: current.trim(), sourceXml });
    }

    if (chunks.length > 0) return chunks;
  }

  // Fallback: word-based splitting for non-table narratives
  const words = fullText.split(/\s+/).filter(Boolean);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let ord = 0;

  for (const word of words) {
    if (currentLen > 0 && currentLen + word.length + 1 > APPROX_MAX_CHARS) {
      chunks.push({ patientId, section, ord: ord++, text: current.join(' '), sourceXml });
      current = [];
      currentLen = 0;
    }
    current.push(word);
    currentLen += word.length + 1;
  }

  if (current.length > 0) {
    chunks.push({ patientId, section, ord: ord++, text: current.join(' '), sourceXml });
  }

  return chunks.length > 0
    ? chunks
    : [{ patientId, section, ord: 0, text: fullText, sourceXml }];
}

function toStr(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

/**
 * Returns each top-level <section>…</section> substring from the raw C-CDA XML,
 * matched with depth-counting so a nested <component><section> subsection does not
 * truncate its parent. Synthea charts are flat, but the depth guard keeps this
 * robust to the general C-CDA shape. The substring is kept verbatim (this is what
 * the data explorer surfaces as the section's raw XML).
 */
function extractSectionXmls(xml: string): string[] {
  const out: string[] = [];
  // Single tokenizer over both opening and closing <section> tags, ordered by
  // position. Depth-count so a nested subsection closes inner-first.
  const tagRe = /<section(?:\s[^>]*)?>|<\/section>/g;
  let m: RegExpExecArray | null;
  let start = -1;
  let depth = 0;

  while ((m = tagRe.exec(xml)) !== null) {
    const isClose = m[0] === '</section>';
    if (!isClose) {
      if (depth === 0) start = m.index;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        out.push(xml.slice(start, m.index + '</section>'.length));
        start = -1;
      }
    }
  }

  return out;
}

/** Whole-years age from an HL7 v3 date string (YYYYMMDD…) as of `asOf`; null if unparseable. */
function computeAge(birthDate: string, asOf: Date): number | null {
  const m = /^(\d{4})(\d{2})?(\d{2})?/.exec(birthDate);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = m[2] ? parseInt(m[2], 10) - 1 : 0;
  const day = m[3] ? parseInt(m[3], 10) : 1;
  let age = asOf.getUTCFullYear() - year;
  const beforeBirthday =
    asOf.getUTCMonth() < month ||
    (asOf.getUTCMonth() === month && asOf.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

/** Count of coded <entry> elements inside a raw section XML substring. */
function countEntries(sectionXml: string): number {
  return (sectionXml.match(/<entry(?:\s[^>]*)?>/g) ?? []).length;
}

/**
 * Parses a Synthea C-CDA R2.1 XML string and extracts the 7 LOINC-coded sections
 * plus demographics from <recordTarget>.
 *
 * Throws a descriptive Error on malformed XML or a missing ClinicalDocument root.
 * Missing sections are silently absent (no throw).
 *
 * `asOf` is the reference date for the computed age in the summary (defaults to
 * now); pass an explicit date for deterministic tests.
 */
export function parseCcda(xml: string, asOf: Date = new Date()): ParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    textNodeName: '#text',
    // Treat <text> element content as a raw HTML string; do not descend into it.
    stopNodes: ['*.text'],
    // Force <component> to always be an array — both the outer wrapper and
    // each section component inside <structuredBody>.
    isArray: (name: string) => name === 'component',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`C-CDA XML parse failed: ${(err as Error).message}`);
  }

  const doc = parsed?.ClinicalDocument;
  if (!doc) {
    throw new Error('Invalid C-CDA document: missing <ClinicalDocument> root element');
  }

  // ── Demographics ──────────────────────────────────────────────────────────
  const patientRole = doc?.recordTarget?.patientRole;
  const idEl = patientRole?.id;
  const patientId = toStr(idEl?.['@_extension']) || toStr(idEl?.['@_root']) || 'unknown';

  const patient = patientRole?.patient;
  const nameEl = patient?.name;
  const demographics: Demographics = {
    firstName: toStr(nameEl?.given),
    lastName: toStr(nameEl?.family),
    gender: toStr(patient?.administrativeGenderCode?.['@_code']),
    birthDate: toStr(patient?.birthTime?.['@_value']),
  };

  // ── Section extraction ────────────────────────────────────────────────────
  // doc.component → [{ structuredBody: { component: [...sections] } }]
  const outerComponents: unknown[] = Array.isArray(doc.component)
    ? doc.component
    : doc.component
      ? [doc.component]
      : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = (outerComponents[0] as any)?.structuredBody;
  const sectionComponents: unknown[] = Array.isArray(body?.component)
    ? body.component
    : body?.component
      ? [body.component]
      : [];

  // Raw <section> substrings keyed by their own LOINC code, taken verbatim from the
  // original XML (the parsed tree drops formatting we want to preserve for the
  // explorer's raw-XML toggle). The first code="…" inside a section block is the
  // section code; entry-level codes appear later and are ignored by first-wins.
  const xmlByLoinc = new Map<string, string>();
  for (const sx of extractSectionXmls(xml)) {
    const cm = /<code\b[^>]*\bcode="([^"]+)"/.exec(sx);
    if (cm && !xmlByLoinc.has(cm[1])) xmlByLoinc.set(cm[1], sx);
  }

  const sections: SectionResult[] = [];
  const chunks: Chunk[] = [];
  let conditionCount = 0;
  let medCount = 0;

  for (const comp of sectionComponents) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sec = (comp as any)?.section;
    if (!sec) continue;

    const loincCode = toStr(sec?.code?.['@_code']);
    const sectionName = LOINC_TO_SECTION[loincCode];
    if (!sectionName) continue;

    const rawText = toStr(sec.text);
    const narrativeText = stripHtml(rawText);
    if (!narrativeText) continue;

    const sectionXml = xmlByLoinc.get(loincCode) ?? '';
    if (sectionName === 'problems') conditionCount = countEntries(sectionXml);
    if (sectionName === 'medications') medCount = countEntries(sectionXml);

    sections.push({ section: sectionName, text: narrativeText });
    chunks.push(...chunkSection(patientId, sectionName, rawText, sectionXml));
  }

  const summary: PatientSummary = {
    demographics,
    sections: sections.map((s) => s.section),
    age: computeAge(demographics.birthDate, asOf),
    sex: demographics.gender,
    conditionCount,
    medCount,
    chartBytes: new TextEncoder().encode(xml).length,
  };

  return {
    patientId,
    demographics,
    sections,
    chunks,
    summary,
  };
}
