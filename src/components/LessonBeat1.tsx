'use client'

import { useMemo, useState } from 'react'
import { Badge, Button, Card, Heading, Stack, Text } from './ui'
import type { BadgeTone } from './ui'
import { Term } from './Term'
import { diffForSource, loadLessonBeat1, type SourcePath } from '@/lib/lesson/beat1'
import type { StructuredFieldDiff } from '@/lib/eval/types'
import styles from './LessonBeat1.module.css'

const STATUS_TONE: Record<StructuredFieldDiff['status'], BadgeTone> = {
  match: 'success',
  mismatch: 'danger',
  missing: 'warning',
  extra: 'warning',
}

const SOURCE_LABEL: Record<SourcePath, string> = {
  summary: 'Author from the summary',
  record: 'Author from the full record',
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/**
 * Beat 1 — correctness with a diff (the intuitive on-ramp of the guided lesson).
 *
 * Four moves, all on committed data (no model call):
 *  1. See the exact generation prompt that produced the SEEDED (R7) output.
 *  2. Author an answer key — choose your source: the visit summary, or the full
 *     record one click away. AUTHORING PRECEDES THE RUN: the diff stays hidden
 *     until you pick a source and press Run.
 *  3. Run the deterministic structured diff (the real production scorer) of the
 *     seeded output against the key you authored.
 *  4. Land the honest payoff. Author from the summary → a green diff against a
 *     WRONG reference ("you trusted an untested key"). Author from the record →
 *     the model's dose error is caught ("that's the discipline").
 *
 * The surface is fully determined by `source` + the committed fixture, so it
 * renders identically on every load (rule 20).
 */
interface Beat1Props {
  /**
   * Fired when the learner runs the diff — the journey shell latches this as
   * Beat 1's completion gate (advancing to Beat 2 is blocked until it fires).
   * Optional so the component still renders standalone (tests, storybook).
   */
  onRun?: () => void
  /**
   * Optional CONTROLLED authoring state. When the journey shell passes these,
   * Beat 1's `source`/`hasRun` live in the parent, so collapsing the beat to a
   * summary and reopening it later is a real REVIEW (the authored key and run
   * result survive) rather than a fresh remount. Omitted in standalone renders
   * (tests, storybook), where the component owns the state internally.
   */
  source?: SourcePath | null
  onSourceChange?: (next: SourcePath | null) => void
  hasRun?: boolean
  onHasRunChange?: (next: boolean) => void
}

export function LessonBeat1({
  onRun,
  source: sourceProp,
  onSourceChange,
  hasRun: hasRunProp,
  onHasRunChange,
}: Beat1Props = {}) {
  const data = loadLessonBeat1()
  // Control-props pattern: use the parent's value when provided, else local state.
  const [sourceLocal, setSourceLocal] = useState<SourcePath | null>(null)
  const [hasRunLocal, setHasRunLocal] = useState(false)
  const source = sourceProp !== undefined ? sourceProp : sourceLocal
  const hasRun = hasRunProp !== undefined ? hasRunProp : hasRunLocal
  const setSource = onSourceChange ?? setSourceLocal
  const setHasRun = onHasRunChange ?? setHasRunLocal

  // The diff is recomputed from the committed fixture for whichever source the
  // learner authored from — never a stored number.
  const diff = useMemo(() => (source ? diffForSource(source) : null), [source])
  const outcome = source ? data.outcomes[source] : null

  function chooseSource(next: SourcePath) {
    setSource(next)
    // Re-authoring resets the run: authoring always precedes a fresh diff.
    setHasRun(false)
  }

  return (
    <Stack gap={5} data-testid="lesson-beat-1-interactive">
      {/* Framing — what Beat 1 teaches */}
      <Card tone="info" padding="sm" data-testid="beat1-framing">
        <Stack gap={1}>
          <Heading level={2}>Beat 1 — Correctness with a diff</Heading>
          <Text as="p" size="sm">
            The intuitive on-ramp. A{' '}
            <Term
              term="structured diff"
              definition="A deterministic, field-by-field comparison of a structured output against a hand-authored answer key — match / mismatch / missing / extra per field. No model call, so it never flaps."
            />{' '}
            grades a model&apos;s extraction against an <strong>answer key</strong> you author. But
            the diff is only ever as trustworthy as that key — so where you author it from is the
            whole game. Author a key, run the diff, and watch what happens when the{' '}
            <strong>reference itself was wrong</strong>.
          </Text>
        </Stack>
      </Card>

      {/* ── Move 1: the generation prompt is visible and inspectable ─────────── */}
      <section data-testid="beat1-prompt-section">
        <Stack gap={2}>
          <Stack gap={1}>
            <Heading level={3}>1. The generation prompt (visible)</Heading>
            <Text as="p" size="sm" tone="muted">
              This is the exact prompt that produced the output below — the committed, seeded
              generation from the R7 baseline. Nothing is generated on load; you are grading a
              fixed artifact for <strong>{data.patientLabel}</strong>.
            </Text>
          </Stack>
          <Stack gap={1}>
            <Badge tone="neutral">Generation prompt</Badge>
            <pre className={styles.pre} data-testid="beat1-generation-prompt">
              {data.generationPrompt}
            </pre>
          </Stack>
          <Stack gap={1}>
            <Badge tone="neutral">Seeded model output (synthetic patient)</Badge>
            <pre className={styles.pre} data-testid="beat1-model-output">
              {data.modelOutput}
            </pre>
          </Stack>
        </Stack>
      </section>

      {/* ── Move 2: author the answer key — choose your source ───────────────── */}
      <section data-testid="beat1-author-section">
        <Stack gap={2}>
          <Stack gap={1}>
            <Heading level={3}>2. Author the answer key — pick your source</Heading>
            <Text as="p" size="sm" tone="muted">
              An answer key does not come from nowhere — you author it. Author from the visit
              summary, or open the full record first. The diff is gated behind this choice:{' '}
              <strong>authoring precedes the run</strong>.
            </Text>
          </Stack>

          <Stack gap={1}>
            <Badge tone="neutral">Visit summary</Badge>
            <pre className={styles.pre} data-testid="beat1-summary">
              {data.summary}
            </pre>
          </Stack>

          <details className={styles.record} data-testid="beat1-full-record">
            <summary className={styles.summary}>
              <Text size="sm" weight="semibold">
                Open the full record (the source of truth) — one click away
              </Text>
            </summary>
            <pre className={styles.pre} data-testid="beat1-full-record-text">
              {data.fullRecord}
            </pre>
          </details>

          <div
            className={styles.segmented}
            role="group"
            aria-label="Answer-key source"
            data-testid="beat1-source-toggle"
          >
            {(['summary', 'record'] as const).map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`beat1-source-${s}`}
                aria-pressed={source === s}
                className={`${styles.segment} ${source === s ? styles.segmentActive : ''}`}
                onClick={() => chooseSource(s)}
              >
                {SOURCE_LABEL[s]}
              </button>
            ))}
          </div>

          {source && (
            <Card padding="sm" tone="neutral" data-testid="beat1-authored-key">
              <Stack gap={1}>
                <Text size="sm" weight="semibold">
                  Answer key you authored ({source === 'summary' ? 'from the summary' : 'from the record'})
                </Text>
                <table className={styles.keyTable}>
                  <thead>
                    <tr>
                      <th>Medication</th>
                      <th>Dose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.answerKeys[source].medications.map((m, i) => (
                      <tr key={`${m.name}-${i}`}>
                        <td>{m.name}</td>
                        <td>{m.dose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Stack>
            </Card>
          )}

          <div>
            <Button
              data-testid="beat1-run"
              disabled={!source}
              onClick={() => {
                setHasRun(true)
                onRun?.()
              }}
            >
              Run the diff
            </Button>
          </div>
        </Stack>
      </section>

      {/* ── Move 3 + 4: the diff and the honest outcome ──────────────────────── */}
      {hasRun && source && diff && (
        <section data-testid="beat1-result-section">
          <Stack gap={3}>
            <Stack gap={1}>
              <Heading level={3}>3. The diff — and what it really tells you</Heading>
              <Text as="p" size="sm" tone="muted">
                The seeded output graded against the key you authored. Casing and unit-case
                differences are absorbed by normalization; a genuine dose change is not.
              </Text>
            </Stack>

            <div className={styles.metrics} data-testid="beat1-metrics">
              <span data-testid="beat1-f1">
                F1: <strong>{pct(diff.score ?? 0)}</strong>
              </span>
              <span>
                precision: <strong>{pct(diff.precision)}</strong>
              </span>
              <span>
                recall: <strong>{pct(diff.recall)}</strong>
              </span>
              <span>
                match {diff.matchCount} · mismatch {diff.mismatchCount} · missing{' '}
                {diff.missingCount} · extra {diff.extraCount}
              </span>
            </div>

            <table className={styles.table} data-testid="beat1-diff-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Field</th>
                  <th>Status</th>
                  <th>Expected (your key)</th>
                  <th>Actual (model)</th>
                </tr>
              </thead>
              <tbody>
                {diff.fields.map((f, i) => (
                  <tr
                    key={`${f.item}-${f.field}-${i}`}
                    data-testid={`beat1-diff-row-${f.status}`}
                    className={f.status === 'match' ? '' : styles.rowFlag}
                  >
                    <td>{f.item}</td>
                    <td>{f.field}</td>
                    <td>
                      <Badge tone={STATUS_TONE[f.status]}>{f.status}</Badge>
                    </td>
                    <td>{f.expected ?? '—'}</td>
                    <td>{f.actual ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {outcome && (
              <Card
                tone={outcome.tone === 'danger' ? 'danger' : 'success'}
                padding="sm"
                data-testid="beat1-outcome"
                data-source={source}
              >
                <Stack gap={1}>
                  <Heading level={4} data-testid="beat1-outcome-headline">
                    {outcome.headline}
                  </Heading>
                  <Text as="p" size="sm">
                    {outcome.body}
                  </Text>
                </Stack>
              </Card>
            )}
          </Stack>
        </section>
      )}
    </Stack>
  )
}
