import { Badge, Card, Heading, Stack, Text } from './ui'
import type { BadgeTone } from './ui'
import type { LessonData } from '@/lib/lesson'
import type { StructuredFieldDiff } from '@/lib/eval/types'
import styles from './LessonView.module.css'

const STATUS_TONE: Record<StructuredFieldDiff['status'], BadgeTone> = {
  match: 'success',
  mismatch: 'danger',
  missing: 'warning',
  extra: 'warning',
}

const VERDICT_TONE: Record<string, BadgeTone> = {
  equivalent: 'success',
  partial: 'warning',
  divergent: 'danger',
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/**
 * Guided correctness lesson — two beats, both driven by COMMITTED data
 * (`LessonData` from `loadLesson()`). Renders no inputs, performs no model call,
 * and is fully determined by its props, so the same `data` renders identically on
 * every load. This is the surface that makes the acceptance criterion verifiable.
 */
export function LessonView({ data }: { data: LessonData }) {
  const { beat1, beat2 } = data

  return (
    <Stack gap={5} data-testid="lesson-view">
      <Card tone="info" padding="sm" data-testid="lesson-intro">
        <Text as="p" size="sm">
          <strong>Why this is stable:</strong> the model output below is <em>committed</em>, not
          generated on load. Beat-1&apos;s structured diff is deterministic and Beat-2&apos;s
          reference-judge verdict is replayed from a committed fixture — so both beats produce
          identical results every time, and the diff can never flap on formatting drift.
        </Text>
      </Card>

      <Stack gap={2} data-testid="lesson-output">
        <Badge tone="neutral">Committed model output (synthetic patient)</Badge>
        <pre className={styles.pre}>{data.output}</pre>
      </Stack>

      {/* ── Beat 1 — deterministic structured diff ─────────────────────────── */}
      <section data-testid="lesson-beat-1">
        <Stack gap={3}>
          <Stack gap={1}>
            <Heading level={2}>Beat 1 — Structured diff (deterministic)</Heading>
            <Text as="p" size="sm" tone="muted">
              Each medication field is aligned by canonical name and compared after normalization.
              Casing differences are absorbed; a genuine dose error is not.
            </Text>
          </Stack>

          <div className={styles.metrics} data-testid="lesson-beat-1-metrics">
            <span data-testid="lesson-f1">
              F1: <strong>{pct(beat1.score)}</strong>
            </span>
            <span>
              precision: <strong>{pct(beat1.precision)}</strong>
            </span>
            <span>
              recall: <strong>{pct(beat1.recall)}</strong>
            </span>
            <span>
              match {beat1.matchCount} · mismatch {beat1.mismatchCount} · missing{' '}
              {beat1.missingCount} · extra {beat1.extraCount}
            </span>
          </div>

          <table className={styles.table} data-testid="lesson-diff-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Field</th>
                <th>Status</th>
                <th>Expected</th>
                <th>Actual</th>
              </tr>
            </thead>
            <tbody>
              {beat1.fields.map((f, i) => (
                <tr
                  key={`${f.item}-${f.field}-${i}`}
                  data-testid={`lesson-diff-row-${f.status}`}
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

          {beat1.blindSpots.length > 0 && (
            <Card tone="warning" padding="sm" data-testid="lesson-blind-spots">
              <Stack gap={1}>
                <Text size="sm" weight="semibold">
                  Normalization blind spots on this case
                </Text>
                <ul className={styles.blindSpots}>
                  {beat1.blindSpots.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </Stack>
            </Card>
          )}
        </Stack>
      </section>

      {/* ── Beat 2 — reference-judge verdict (committed / replayed) ─────────── */}
      <section data-testid="lesson-beat-2">
        <Stack gap={3}>
          <Stack gap={1}>
            <Heading level={2}>Beat 2 — Reference judge (committed verdict)</Heading>
            <Text as="p" size="sm" tone="muted">
              The same output, compared in meaning against the expected prose. The verdict is a
              committed record-replay fixture — never re-judged live.
            </Text>
          </Stack>

          <div className={styles.metrics} data-testid="lesson-beat-2-metrics">
            <span data-testid="lesson-verdict">
              Verdict:{' '}
              <Badge tone={VERDICT_TONE[beat2.verdict] ?? 'neutral'}>{beat2.verdict}</Badge>
            </span>
            <span>
              score: <strong>{beat2.score.toFixed(2)}</strong>
            </span>
          </div>

          <Card padding="sm" tone="neutral">
            <Stack gap={2}>
              <Stack gap={1}>
                <Badge tone="neutral">Judge reason</Badge>
                <Text as="p" size="sm" data-testid="lesson-judge-reason">
                  {beat2.reason}
                </Text>
              </Stack>
              <Stack gap={1}>
                <Badge tone="neutral">Expected prose</Badge>
                <Text as="p" size="sm" data-testid="lesson-expected-prose">
                  {beat2.expectedProse}
                </Text>
              </Stack>
            </Stack>
          </Card>

          <details className={styles.prompt}>
            <summary className={styles.summary}>
              <Text size="sm" weight="semibold">
                Redacted judge prompt (no PHI/PII persisted)
              </Text>
            </summary>
            <pre className={styles.pre} data-testid="lesson-judge-prompt">
              {beat2.judgePrompt}
            </pre>
          </details>
        </Stack>
      </section>
    </Stack>
  )
}
