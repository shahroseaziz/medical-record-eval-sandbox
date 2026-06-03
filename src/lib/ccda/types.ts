/**
 * A single retrievable text chunk from a C-CDA section.
 *
 * patientId  – stable patient identifier (recordTarget/patientRole/id@extension)
 * section    – human-readable section name derived from the section's LOINC code
 * ord        – zero-based chunk index within the section (>0 only when the
 *              section narrative exceeds the ~1500-token split threshold)
 * text       – plain-text narrative, HTML tags and entities stripped
 */
export type Chunk = { patientId: string; section: string; ord: number; text: string };

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
  summary: {
    demographics: Demographics;
    /** Names of sections that were found and have non-empty narratives */
    sections: string[];
  };
}
