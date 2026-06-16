import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseCcda } from '../index';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

// Builds a minimal C-CDA document suitable for unit tests.
function makeCcda(opts: {
  patientId?: string;
  sections?: Array<{ loinc: string; text: string }>;
}): string {
  const pid = opts.patientId ?? 'test-patient-001';
  const sectXml = (opts.sections ?? [])
    .map(
      ({ loinc, text }) => `
    <component>
      <section>
        <code code="${loinc}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
        <title>Section</title>
        <text>${text}</text>
      </section>
    </component>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.19.5" extension="${pid}"/>
      <patient>
        <name><given>Test</given><family>Patient</family></name>
        <administrativeGenderCode code="M"/>
        <birthTime value="19800101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>${sectXml}
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

// ── Brenna468 (~580 KB) ──────────────────────────────────────────────────────
describe('fixture: Brenna468', () => {
  const xml = loadFixture('Brenna468_Jung484_Feeney44_7a351fec-de09-1605-7053-5bfb6766dffa.xml');
  let result: ReturnType<typeof parseCcda>;

  beforeAll(() => {
    result = parseCcda(xml);
  });

  it('extracts the correct patientId', () => {
    expect(result.patientId).toBe('7a351fec-de09-1605-7053-5bfb6766dffa');
  });

  it('extracts demographics', () => {
    expect(result.demographics.gender).toBe('F');
    expect(result.demographics.firstName).toBeTruthy();
    expect(result.demographics.birthDate).toBeTruthy();
  });

  it('returns non-empty sections with non-empty narrative', () => {
    expect(result.sections.length).toBeGreaterThan(0);
    for (const s of result.sections) {
      expect(s.text.length, `section "${s.section}" has empty text`).toBeGreaterThan(0);
    }
  });

  it('summary.sections matches sections array', () => {
    expect(result.summary.sections).toEqual(result.sections.map((s) => s.section));
  });

  it('chunks have correct structure', () => {
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      expect(c.patientId).toBe(result.patientId);
      expect(typeof c.section).toBe('string');
      expect(typeof c.ord).toBe('number');
      expect(c.text.length).toBeGreaterThan(0);
    }
  });
});

// ── Marisela850 (~581 KB) ────────────────────────────────────────────────────
describe('fixture: Marisela850', () => {
  const xml = loadFixture(
    'Marisela850_Shanel903_Mayer370_a08c7d55-8400-6d5d-908f-13a33e8214c0.xml',
  );
  let result: ReturnType<typeof parseCcda>;

  beforeAll(() => {
    result = parseCcda(xml);
  });

  it('extracts the correct patientId', () => {
    expect(result.patientId).toBe('a08c7d55-8400-6d5d-908f-13a33e8214c0');
  });

  it('returns non-empty sections and chunks', () => {
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it('all section names are known', () => {
    const known = new Set(['problems', 'medications', 'allergies', 'results', 'encounters', 'immunizations', 'vitals']);
    for (const s of result.sections) {
      expect(known.has(s.section), `unknown section "${s.section}"`).toBe(true);
    }
  });
});

// ── Agustin437 (~6.1 MB) — large-record gate ────────────────────────────────
describe('fixture: Agustin437 (6 MB gate)', () => {
  const xml = loadFixture('Agustin437_Hills818_e0de7b0a-c40b-6467-c099-0f9467be6c0a.xml');
  let result: ReturnType<typeof parseCcda>;

  beforeAll(() => {
    result = parseCcda(xml);
  });

  it('parses without throwing', () => {
    expect(result).toBeDefined();
  });

  it('returns non-empty narrative for every extracted section (gate)', () => {
    expect(result.sections.length).toBeGreaterThan(0);
    for (const s of result.sections) {
      expect(s.text.length, `section "${s.section}" has empty text`).toBeGreaterThan(0);
    }
  });

  it('snapshot: section list (sorted)', () => {
    const sorted = [...result.summary.sections].sort();
    expect(sorted).toMatchSnapshot('agustin-section-list');
  });

  it('snapshot: total chunk count', () => {
    // chunks >= sections because large sections are split
    expect(result.chunks.length).toBeGreaterThanOrEqual(result.sections.length);
    expect(result.chunks.length).toMatchSnapshot('agustin-chunk-count');
  });

  it('chunk ord values are sequential per section', () => {
    const bySection = new Map<string, number[]>();
    for (const c of result.chunks) {
      const ords = bySection.get(c.section) ?? [];
      ords.push(c.ord);
      bySection.set(c.section, ords);
    }
    for (const [, ords] of bySection) {
      const sorted = [...ords].sort((a, b) => a - b);
      expect(sorted).toEqual(ords); // already in order
      expect(sorted[0]).toBe(0); // starts at 0
    }
  });
});

// ── Error paths ──────────────────────────────────────────────────────────────
describe('error paths', () => {
  it('(a) long section narrative splits into >1 chunk with sequential ord', () => {
    // 400 rows × ~90 chars each ≈ 36 000 raw chars >> 6000-char threshold
    const rows = Array.from(
      { length: 400 },
      (_, i) =>
        `<tr><td>2024-01-${String((i % 28) + 1).padStart(2, '0')}</td>` +
        `<td>Medication Entry ${i + 1} - some longer drug description for row ${i + 1}</td></tr>`,
    ).join('\n');

    const xml = makeCcda({
      sections: [
        {
          loinc: '10160-0',
          text: `<table><thead><tr><th>Date</th><th>Medication</th></tr></thead><tbody>${rows}</tbody></table>`,
        },
      ],
    });

    const { chunks } = parseCcda(xml);
    const medChunks = chunks.filter((c) => c.section === 'medications');
    expect(medChunks.length).toBeGreaterThan(1);
    // ord values must be sequential starting from 0
    medChunks.forEach((c, i) => expect(c.ord).toBe(i));
  });

  it('(b) missing section is absent in output — no throw', () => {
    // Only medications is present; problems (11450-4) is not.
    const xml = makeCcda({
      sections: [{ loinc: '10160-0', text: 'Aspirin 81 mg daily.' }],
    });

    const { sections, chunks } = parseCcda(xml);
    expect(sections.map((s) => s.section)).not.toContain('problems');
    expect(sections.map((s) => s.section)).toContain('medications');
    expect(chunks.length).toBe(1);
  });

  it('(c) malformed XML throws a descriptive Error — not an uncaught exception', () => {
    expect(() => parseCcda('<<<not valid xml at all')).toThrow(Error);
    expect(() => parseCcda('<<<not valid xml at all')).toThrow(/C-CDA XML parse failed/);
  });

  it('(c2) valid XML with no ClinicalDocument root throws a descriptive Error', () => {
    expect(() => parseCcda('<root><something>not ccda</something></root>')).toThrow(Error);
    expect(() => parseCcda('<root><something>not ccda</something></root>')).toThrow(
      /ClinicalDocument/,
    );
  });
});

// ── source_xml (section-level raw XML, shared across a section's chunks) ───────
describe('chunk.sourceXml', () => {
  it('attaches the raw <section> substring to every chunk of a section', () => {
    const xml = makeCcda({
      sections: [{ loinc: '10160-0', text: 'Aspirin 81 mg daily.' }],
    });
    const { chunks } = parseCcda(xml);
    expect(chunks).toHaveLength(1);
    const sx = chunks[0].sourceXml;
    expect(sx.startsWith('<section')).toBe(true);
    expect(sx.trimEnd().endsWith('</section>')).toBe(true);
    expect(sx).toContain('code="10160-0"');
    expect(sx).toContain('Aspirin 81 mg daily.');
  });

  it('shares ONE identical source_xml across all chunks split from a section', () => {
    const rows = Array.from(
      { length: 400 },
      (_, i) => `<tr><td>row ${i}</td><td>some longer medication description text ${i}</td></tr>`,
    ).join('\n');
    const xml = makeCcda({
      sections: [
        { loinc: '10160-0', text: `<table><tbody>${rows}</tbody></table>` },
      ],
    });
    const { chunks } = parseCcda(xml);
    expect(chunks.length).toBeGreaterThan(1);
    const distinct = new Set(chunks.map((c) => c.sourceXml));
    expect(distinct.size).toBe(1); // shared, not per-chunk-sliced
  });

  it('every fixture chunk carries a non-empty source_xml (≥95% coverage target)', () => {
    const xml = loadFixture('Brenna468_Jung484_Feeney44_7a351fec-de09-1605-7053-5bfb6766dffa.xml');
    const { chunks } = parseCcda(xml);
    const covered = chunks.filter((c) => c.sourceXml.length > 0).length;
    expect(covered).toBe(chunks.length);
  });
});

// ── summary-v3 (additive explorer fields) ─────────────────────────────────────
describe('summary v3 fields', () => {
  it('keeps demographics + sections (pre-v3 shape) AND adds v3 fields', () => {
    const xml = makeCcda({
      sections: [{ loinc: '10160-0', text: 'Aspirin 81 mg daily.' }],
    });
    const { summary } = parseCcda(xml, new Date('2026-01-01T00:00:00Z'));
    // additive: pre-v3 keys retained
    expect(summary.demographics).toBeDefined();
    expect(summary.sections).toEqual(['medications']);
    // v3 keys present
    expect(summary.sex).toBe('M');
    expect(summary.age).toBe(46); // born 1980-01-01, asOf 2026-01-01
    expect(typeof summary.chartBytes).toBe('number');
    expect(summary.chartBytes).toBeGreaterThan(0);
  });

  it('computes age as whole years, accounting for birthday-not-yet-reached', () => {
    const xml = makeCcda({ sections: [{ loinc: '10160-0', text: 'x' }] });
    // birthTime is 1980-01-01; asOf before that day-of-year in 2026 → still 45
    const before = parseCcda(xml, new Date('2025-12-31T00:00:00Z')).summary.age;
    const after = parseCcda(xml, new Date('2026-01-01T00:00:00Z')).summary.age;
    expect(before).toBe(45);
    expect(after).toBe(46);
  });

  it('counts conditions (problems) and meds (medications) from coded entries', () => {
    const problemEntries = '<entry><act/></entry><entry><act/></entry><entry><act/></entry>';
    const medEntries = '<entry><substanceAdministration/></entry><entry><substanceAdministration/></entry>';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole>
    <id root="r" extension="pt-x"/>
    <patient><name><given>A</given><family>B</family></name>
      <administrativeGenderCode code="F"/><birthTime value="19900615"/></patient>
  </patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
      <text>Problem list narrative.</text>
      ${problemEntries}
    </section></component>
    <component><section>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <text>Medication narrative.</text>
      ${medEntries}
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
    const { summary } = parseCcda(xml, new Date('2026-06-16T00:00:00Z'));
    expect(summary.conditionCount).toBe(3);
    expect(summary.medCount).toBe(2);
    expect(summary.sex).toBe('F');
    expect(summary.age).toBe(36); // 1990-06-15 → 36 on 2026-06-16
  });

  it('age is null when birthDate is absent', () => {
    const xml = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="r" extension="p"/>
    <patient><name><given>A</given><family>B</family></name>
      <administrativeGenderCode code="M"/></patient>
  </patientRole></recordTarget>
  <component><structuredBody>
    <component><section><code code="10160-0"/><text>x</text></section></component>
  </structuredBody></component>
</ClinicalDocument>`;
    expect(parseCcda(xml).summary.age).toBeNull();
  });
});
