import { Badge, Card, Heading, Stack, Text } from './ui'
import type { BadgeTone } from './ui'
import { Term } from './Term'
import { loadLessonBeat2 } from '@/lib/lesson/beat2'
import styles from './LessonBeat2.module.css'

const VERDICT_TONE: Record<string, BadgeTone> = {
  equivalent: 'success',
  partial: 'warning',
  divergent: 'danger',
}

/**
 * Beat 2 — the prose contrast.
 *
 * A server component, fully determined by the committed Beat-2 fixture
 * (`loadLessonBeat2()`): renders no inputs and performs no model call, so it shows
 * identically on every load. The narrative is the payoff of pointing two different
 * instruments at the SAME prose answer:
 *
 *   1. Beat 1's structured diff ERRORS — prose has no fields to align (score = —).
 *   2. The reference judge RESOLVES it — same meaning as the expected prose
 *      ("equivalent"), so the prose answer is graded fairly.
 *   3. A judge-fallibility seed — the judge is a second fallible opinion, not an
 *      oracle (no oracle framing) — which Beat 3 pays off.
 */
export function LessonBeat2() {
  const { taskPrompt, output, expectedProse, diff, judge, fallibilitySeed } = loadLessonBeat2()
  const verdict = judge.verdict ?? 'errored'

  return (
    <Stack gap={5} data-testid="lesson-beat-2">
      {/* Framing — what makes Beat 2 different: the answer is prose, not fields */}
      <Card tone="info" padding="sm" data-testid="beat2-framing">
        <Stack gap={1}>
          <Heading level={2}>Beat 2 — A question with no field answer</Heading>
          <Text as="p" size="sm">
            Beat 1&apos;s question (&quot;what are the medications?&quot;) had a{' '}
            <strong>structured</strong> answer, and the structured diff graded it perfectly. This
            question — <em>is the patient&apos;s diabetes under control?</em> — has a{' '}
            <strong>prose</strong> answer: a clinical judgment, not a list of fields. Watch what
            happens when we point the same diff at it, then reach for a different instrument.
          </Text>
        </Stack>
      </Card>

      <Stack gap={2} data-testid="beat2-query">
        <Badge tone="neutral">The query</Badge>
        <Text as="p" size="sm" data-testid="beat2-task-prompt">
          {taskPrompt}
        </Text>
        <Badge tone="neutral">Committed model output (synthetic patient)</Badge>
        <Text as="p" size="sm" data-testid="beat2-output">
          {output}
        </Text>
      </Stack>

      {/* ── Move 1: Beat 1's instrument fails on prose ─────────────────────────── */}
      <section data-testid="beat2-diff-fails">
        <Stack gap={2}>
          <Stack gap={1}>
            <Heading level={3}>1. The structured diff can&apos;t grade prose</Heading>
            <Text as="p" size="sm" tone="muted">
              The structured diff aligns <code>{'{ name, dose }'}</code> fields. A prose answer has
              none to align — it isn&apos;t even valid JSON — so the diff doesn&apos;t score it low,
              it can&apos;t run at all. That is the failure, not a low number: it&apos;s the wrong
              instrument for this answer.
            </Text>
          </Stack>

          <Card tone="danger" padding="sm" data-testid="beat2-diff-failed">
            <Stack gap={1}>
              <div className={styles.metrics}>
                <span data-testid="beat2-diff-status">
                  structured diff: <Badge tone="danger">errored — not scoreable</Badge>
                </span>
                <span data-testid="beat2-diff-score">
                  score: <strong>{diff.score == null ? '—' : diff.score.toFixed(2)}</strong>
                </span>
              </div>
              <Text as="p" size="sm" data-testid="beat2-diff-error-message">
                {diff.errorMessage ?? 'no structured fields to compare'}
              </Text>
            </Stack>
          </Card>
        </Stack>
      </section>

      {/* ── Move 2: the reference judge resolves it ────────────────────────────── */}
      <section data-testid="beat2-judge-resolves">
        <Stack gap={2}>
          <Stack gap={1}>
            <Heading level={3}>2. Reach for the reference judge</Heading>
            <Text as="p" size="sm" tone="muted">
              The{' '}
              <Term
                term="reference judge"
                definition="An LLM judge that compares an answer's MEANING against a hand-authored expected answer (the reference), not its surface wording. Unlike the structured diff, it has no fields to align — it reads both as prose and decides equivalent / partial / divergent."
              />{' '}
              compares the answer&apos;s <strong>meaning</strong> against the expected prose. Wording
              differs; the meaning is the same — so it grades the prose answer fairly where the diff
              could not.
            </Text>
          </Stack>

          <div className={styles.metrics} data-testid="beat2-judge-metrics">
            <span data-testid="beat2-verdict">
              Verdict: <Badge tone={VERDICT_TONE[verdict] ?? 'neutral'}>{verdict}</Badge>
            </span>
            <span data-testid="beat2-judge-score">
              score: <strong>{judge.score == null ? '—' : judge.score.toFixed(2)}</strong>
            </span>
          </div>

          <Card padding="sm" tone="neutral">
            <Stack gap={2}>
              <Stack gap={1}>
                <Badge tone="neutral">Judge reason</Badge>
                <Text as="p" size="sm" data-testid="beat2-judge-reason">
                  {judge.reason}
                </Text>
              </Stack>
              <Stack gap={1}>
                <Badge tone="neutral">Expected prose (the answer key it compared against)</Badge>
                <Text as="p" size="sm" data-testid="beat2-expected-prose">
                  {expectedProse}
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
            <pre className={styles.pre} data-testid="beat2-judge-prompt">
              {judge.judgePrompt}
            </pre>
          </details>
        </Stack>
      </section>

      {/* ── Seed: this judge can be wrong too (no oracle framing) ──────────────── */}
      <Card tone="warning" padding="sm" data-testid="beat2-fallibility-seed">
        <Stack gap={1}>
          <Heading level={3}>3. This judge can be wrong too</Heading>
          <Text as="p" size="sm">
            {fallibilitySeed}
          </Text>
        </Stack>
      </Card>
    </Stack>
  )
}
