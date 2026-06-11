'use client'

import { useMemo, useState } from 'react'
import { Term } from './Term'
import {
  loadRagBenchCases,
  isBudgetTrimmed,
  ragGrounding,
  ragSectionHit,
  INGEST_CHUNK_HISTOGRAM,
  INGEST_HISTOGRAM_TOTAL,
  RAG_TERMS,
  type RagBenchCase,
} from '@/lib/workbench/rag-cases'
import styles from './RagInspector.module.css'

type RagMode = 'retrieve' | 'stuff'

/**
 * RAG mode in the bench (O10 / G4). The actual C-CDA RAG practice, made part of
 * the bench: a case can be run in `retrieve` (vector search → top-k → budget-fit
 * subset) or `stuff` (the whole record) mode, with retrieval VISIBLE — chunks,
 * distance, similarity — so a retrieval miss is distinguishable from a generation
 * miss (arch SANDBOX-DESIGN G4).
 *
 * Deterministic and offline (rule 20): the retrieval results are committed
 * record-replay fixtures (`rag-cases.ts`). The eval math is the live
 * `scoreSectionHit` scorer computed over the **inBudget subset actually sent**, so
 * a budget-dropped required section is a GENUINE miss (E12/S25), not a number this
 * surface invented. The RAG plumbing terms get the same tooltip treatment the eval
 * terms have — including specialist copy #94, the "section_hit is a coarse,
 * section-level recall signal" line.
 */
export function RagInspector() {
  const cases = useMemo(() => loadRagBenchCases(), [])
  const [caseId, setCaseId] = useState(cases[0]?.caseId ?? '')
  const [mode, setMode] = useState<RagMode>('retrieve')

  const active: RagBenchCase = cases.find((c) => c.caseId === caseId) ?? cases[0]
  const sectionHit = ragSectionHit(active, mode)
  const grounding = ragGrounding(active, mode)
  const trimmed = isBudgetTrimmed(active)
  const histMax = Math.max(...INGEST_CHUNK_HISTOGRAM.map((b) => b.patients))

  return (
    <div className={styles.root} data-testid="rag-inspector">
      <p className={styles.intro}>
        Run the same case in{' '}
        <Term term="retrieve" definition={RAG_TERMS.retrieve}>
          retrieve
        </Term>{' '}
        or{' '}
        <Term term="stuff" definition={RAG_TERMS.stuff}>
          stuff
        </Term>{' '}
        mode and watch the grounding change. Retrieve sends only the chunks that fit the{' '}
        <Term term="inBudget" definition={RAG_TERMS.inBudget}>
          token budget
        </Term>
        ; stuff sends the whole record.
      </p>

      {/* ── Case picker ── */}
      <div className={styles.caseTabs} role="group" aria-label="RAG case">
        {cases.map((c) => (
          <button
            key={c.caseId}
            type="button"
            data-testid={`rag-case-select-${c.caseId}`}
            aria-pressed={c.caseId === active.caseId}
            className={`${styles.caseTab} ${c.caseId === active.caseId ? styles.caseTabActive : ''}`}
            onClick={() => setCaseId(c.caseId)}
          >
            {c.patientName}
          </button>
        ))}
      </div>

      {/* ── Mode toggle with explicit current-mode labeling ── */}
      <div className={styles.modeRow}>
        <span className={styles.modeLabel}>
          <Term term="RAG mode" definition={RAG_TERMS.retrieve}>
            RAG mode
          </Term>
        </span>
        <div className={styles.segmented} role="group" aria-label="RAG mode">
          {(['retrieve', 'stuff'] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`rag-mode-${m}`}
              aria-pressed={mode === m}
              className={`${styles.segment} ${mode === m ? styles.segmentActive : ''}`}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <span className={styles.currentMode} data-testid="rag-current-mode" data-mode={mode}>
          current mode: <strong>{mode}</strong>
        </span>
      </div>

      <p className={styles.intro}>{active.designedReason}</p>

      {/* ── Retrieve mode: chunk view ── */}
      {mode === 'retrieve' ? (
        <>
          <div className={styles.chunksSummary} data-testid="rag-chunks-summary">
            {active.retrievedChunks.length}{' '}
            <Term term="retrieved" definition={RAG_TERMS.retrieve}>
              retrieved
            </Term>{' '}
            · {active.inBudgetCount} fit budget
            {' '}(<Term term="k" definition={RAG_TERMS.k}>k</Term>={active.k})
          </div>

          <div className={styles.chunkList}>
            {active.retrievedChunks.map((chunk, i) => {
              const dropped = i >= active.inBudgetCount
              return (
                <div
                  key={i}
                  data-testid={`rag-chunk-${i}`}
                  data-dropped={dropped ? 'true' : 'false'}
                  className={`${styles.chunkCard} ${dropped ? styles.chunkCardDropped : ''}`}
                >
                  <div className={styles.chunkHead}>
                    <span className={styles.chunkSection}>
                      {chunk.section}
                      {dropped && (
                        <span className={styles.droppedTag} data-testid={`rag-chunk-${i}-dropped`}>
                          budget-dropped
                        </span>
                      )}
                    </span>
                    <span className={styles.chunkMetrics}>
                      <span data-testid={`rag-chunk-${i}-distance`}>
                        <Term term="distance" definition={RAG_TERMS.distance}>
                          dist
                        </Term>{' '}
                        {chunk.distance.toFixed(4)}
                      </span>
                      <span data-testid={`rag-chunk-${i}-similarity`}>
                        <Term term="similarity" definition={RAG_TERMS.similarity}>
                          sim
                        </Term>{' '}
                        {chunk.similarity.toFixed(4)}
                      </span>
                    </span>
                  </div>
                  <div className={styles.chunkText}>{chunk.text}</div>
                </div>
              )
            })}
          </div>

          {/* ── section_hit over the inBudget subset (E12 / S25) ── */}
          <div className={styles.sectionHit} data-testid="rag-section-hit" data-hit={String(sectionHit.score)}>
            <Term term="section_hit" definition={RAG_TERMS['section_hit']}>
              section_hit
            </Term>
            :{' '}
            {sectionHit.score === 1 ? (
              <span className={`${styles.hitMark} ${styles.hitPass}`}>✓ required sections sent</span>
            ) : (
              <span className={`${styles.hitMark} ${styles.hitFail}`}>✗ missing</span>
            )}
            {sectionHit.missingSections.length > 0 && (
              <span className={styles.hitMissing} data-testid="rag-section-hit-missing">
                {sectionHit.missingSections.join(', ')}
              </span>
            )}
          </div>

          {/* The budget-miss vs config-error distinction, made explicit. */}
          {sectionHit.score === 0 && trimmed && (
            <div className={`${styles.note} ${styles.noteInfo}`} data-testid="rag-budget-miss-note">
              A required section was retrieved inside the top-{active.k} but dropped by the token
              budget, so it was never sent — a <strong>genuine retrieval miss</strong>, computed over
              the {active.inBudgetCount} chunks actually sent. This is distinct from a config error
              (requiring more sections than <Term term="k" definition={RAG_TERMS.k}>k</Term>), which
              the seed-authoring gate rejects.
            </div>
          )}

          {/* Honesty note: retrieval is non-selective on a small record. */}
          {active.nonSelective && (
            <div className={`${styles.note} ${styles.noteHonesty}`} data-testid="rag-nonselective-note">
              Honesty note: this patient&apos;s record is small ({active.fullRecord.length} sections),
              so retrieval with <Term term="k" definition={RAG_TERMS.k}>k</Term>={active.k} returns
              essentially the whole record — <strong>retrieve is non-selective here</strong>. It
              isn&apos;t a real ranking demonstration; the large (6 MB) patient is.
            </div>
          )}
        </>
      ) : (
        <div className={`${styles.note} ${styles.noteInfo}`} data-testid="rag-stuff-note">
          <Term term="stuff" definition={RAG_TERMS.stuff}>
            Stuff
          </Term>{' '}
          mode has no retrieval step, so{' '}
          <Term term="section_hit" definition={RAG_TERMS['section_hit']}>
            section_hit
          </Term>{' '}
          is <strong>N/A</strong> — there are no chunks to hit or miss. The whole record (
          {active.fullRecord.length} sections) goes into the prompt.
        </div>
      )}

      {/* ── Grounding string — the visible retrieve-vs-stuff difference ── */}
      <div>
        <div className={styles.chunksSummary}>
          <Term
            term="grounding"
            definition="The context actually sent to generation (and to the faithfulness judge). In retrieve mode this is the inBudget chunk subset, not the full record."
          >
            Grounding sent ({mode})
          </Term>
        </div>
        <pre className={styles.grounding} data-testid="rag-grounding">
          {grounding}
        </pre>
      </div>

      {/* ── Ingest chunk-count histogram ── */}
      <div className={styles.histogram} data-testid="rag-histogram">
        <div className={styles.histTitle}>Chunks per patient at ingest</div>
        <div className={styles.histCaption}>
          Measured over the {INGEST_HISTOGRAM_TOTAL} committed C-CDA fixtures by the same parser
          ingest runs — not an asserted &ldquo;6–9.&rdquo; Most patients are small (7–9 chunks); the
          6 MB patient (Agustin437, 33 chunks) is the lone snapshot-verified outlier that makes
          ranking matter. A full ingest emits the same histogram over the whole corpus.
        </div>
        {INGEST_CHUNK_HISTOGRAM.map((b) => {
          const outlier = b.range === '33+'
          return (
            <div className={styles.histRow} key={b.range} data-testid={`rag-histogram-bar-${b.range}`}>
              <span className={styles.histRange}>{b.range}</span>
              <span className={styles.histBarTrack}>
                <span
                  className={`${styles.histBar} ${outlier ? styles.histBarOutlier : ''}`}
                  style={{ width: `${(b.patients / histMax) * 100}%` }}
                />
              </span>
              <span className={styles.histCount}>{b.patients}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
