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

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/**
 * Guided correctness lesson — Beat 1, driven by COMMITTED data (`LessonData` from
 * `loadLesson()`). Renders no inputs, performs no model call, and is fully
 * determined by its props, so the same `data` renders identically on every load.
 * Beat 2 (the prose contrast) and Beat 3 (faithfulness) are separate components
 * rendered after this one on the lesson page.
 */
export function LessonView({ data }: { data: LessonData }) {
  const { beat1 } = data

  return (
    <Stack gap={5} data-testid="lesson-view">
      <Card tone="info" padding="sm" data-testid="lesson-intro">
        <Text as="p" size="sm">
          <strong>Why this is stable:</strong> the model output below is <em>committed</em>, not
          generated on load, and Beat&nbsp;1&apos;s structured diff is deterministic — so it
          produces identical results every time and can never flap on formatting drift.
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
    </Stack>
  )
}
