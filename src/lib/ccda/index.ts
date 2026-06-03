import { XMLParser } from 'fast-xml-parser';
import type { Chunk, Demographics, ParseResult, SectionResult } from './types';

export type { Chunk, Demographics, ParseResult, SectionResult };

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
 */
function chunkSection(patientId: string, section: string, rawHtml: string): Chunk[] {
  const fullText = stripHtml(rawHtml);

  if (fullText.length <= APPROX_MAX_CHARS) {
    return [{ patientId, section, ord: 0, text: fullText }];
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
        chunks.push({ patientId, section, ord: ord++, text: current.trim() });
        current = '';
      }
      current += (current ? '\n' : '') + rowText;
    }

    if (current.trim()) {
      chunks.push({ patientId, section, ord: ord++, text: current.trim() });
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
      chunks.push({ patientId, section, ord: ord++, text: current.join(' ') });
      current = [];
      currentLen = 0;
    }
    current.push(word);
    currentLen += word.length + 1;
  }

  if (current.length > 0) {
    chunks.push({ patientId, section, ord: ord++, text: current.join(' ') });
  }

  return chunks.length > 0 ? chunks : [{ patientId, section, ord: 0, text: fullText }];
}

function toStr(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

/**
 * Parses a Synthea C-CDA R2.1 XML string and extracts the 7 LOINC-coded sections
 * plus demographics from <recordTarget>.
 *
 * Throws a descriptive Error on malformed XML or a missing ClinicalDocument root.
 * Missing sections are silently absent (no throw).
 */
export function parseCcda(xml: string): ParseResult {
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

  const sections: SectionResult[] = [];
  const chunks: Chunk[] = [];

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

    sections.push({ section: sectionName, text: narrativeText });
    chunks.push(...chunkSection(patientId, sectionName, rawText));
  }

  return {
    patientId,
    demographics,
    sections,
    chunks,
    summary: {
      demographics,
      sections: sections.map((s) => s.section),
    },
  };
}
