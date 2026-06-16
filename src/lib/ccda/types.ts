/**
 * A single retrievable text chunk from a C-CDA section.
 *
 * patientId  – stable patient identifier (recordTarget/patientRole/id@extension)
 * section    – human-readable section name derived from the section's LOINC code
 * ord        – zero-based chunk index within the section (>0 only when the
 *              section narrative exceeds the ~1500-token split threshold)
 * text       – plain-text narrative, HTML tags and entities stripped
 * sourceXml  – the raw <section>…</section> substring from the original C-CDA,
 *              SHARED verbatim across every chunk split from that section. Lets the
 *              explorer toggle the section-level raw XML behind a chunk. Empty string
 *              only if the source substring could not be located (stored as NULL).
 */
export type Chunk = {
  patientId: string;
  section: string;
  ord: number;
  text: string;
  sourceXml: string;
};

export interface Demographics {
  firstName: string;
  lastName: string;
  gender: string;
  /** HL7 v3 date string, e.g. "19800101" */
  birthDate: string;
}

export interface SectionResult {
  section: string;
  text: string;
}

export interface ParseResult {
  /** Stable patient identifier (recordTarget/patientRole/id@extension or @root) */
  patientId: string;
  demographics: Demographics;
  /** One entry per section present in the document (narrative non-empty) */
  sections: SectionResult[];
  /** One or more chunks per section; split by table row when narrative > ~1500 tokens */
  chunks: Chunk[];
  summary: PatientSummary;
}

/**
 * The per-patient summary persisted to `patients.summary` (jsonb).
 *
 * v3 is ADDITIVE: `demographics` and `sections` are retained verbatim (the data
 * explorer's parsed/raw card depends on them) and the explorer-table fields below
 * are added alongside. Computed at ingest from the parsed C-CDA.
 */
export interface PatientSummary {
  demographics: Demographics;
  /** Names of sections that were found and have non-empty narratives */
  sections: string[];
  /** Whole-years age at ingest, derived from birthDate; null if birthDate absent. */
  age: number | null;
  /** Administrative gender code (e.g. "M", "F"); empty string if absent. */
  sex: string;
  /** Number of coded entries in the problems section (0 if section absent). */
  conditionCount: number;
  /** Number of coded entries in the medications section (0 if section absent). */
  medCount: number;
  /** UTF-8 byte length of the raw C-CDA chart. */
  chartBytes: number;
}
