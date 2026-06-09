'use client'

import { useMemo, useState } from 'react'
import { DisagreementTable } from './DisagreementTable'
import { Term } from './Term'
import { Badge, Card, Heading, Stack, Text } from './ui'
import {
  buildBeat3Results,
  loadLessonBeat3,
  meanBeat3Score,
  type RubricVariant,
} from '@/lib/lesson/beat3'
import styles from './LessonBeat3.module.css'

interface Props {
  /** Pass threshold, read from config (evals/thresholds.yaml) by the page. */
  initialThreshold: number
}

const RUBRIC_LABEL: Record<RubricVariant, string> = {
  strict: 'Strict — explicit support only',
  lenient: 'Lenient — plausible inference counts',
}

/**
 * Beat 3 — the faithfulness capstone of the guided lesson.
 *
 * Three moves, all on committed data (no model call):
 *  1. Edit the rubric (strict ⇄ lenient) and watch the faithfulness score move.
 *  2. Label each case pass/fail and see exactly where the judge disagrees with YOU.
 *  3. Read why the 0.85 threshold is a config knob, not a magic constant — and why
 *     fitting it to your own labels is not validation at this sample size.
 *
 * The whole surface is deterministic: it is fully determined by `rubric`, the
 * learner's `labels`, and the committed fixture, so it renders identically every
 * load (rule 20). The DisagreementTable does the you-vs-judge roll-up (R6 result
 * type); this component supplies the rubric knob and the editable labels.
 */
export function LessonBeat3({ initialThreshold }: Props) {
  const data = loadLessonBeat3()
  const [rubric, setRubric] = useState<RubricVariant>('strict')
  const [labels, setLabels] = useState<Record<string, 'pass' | 'fail'>>({})

  const results = useMemo(() => buildBeat3Results(rubric, labels), [rubric, labels])
  const meanScore = meanBeat3Score(rubric)

  function handleIntentLabelChange(caseId: string, label: 'pass' | 'fail') {
    setLabels((prev) => ({ ...prev, [caseId]: label }))
  }

  return (
    <Stack gap={5} data-testid="lesson-beat-3">
      {/* Framing — what makes Beat 3 different: no answer key */}
      <Card tone="info" padding="sm" data-testid="beat3-no-answer-key">
        <Stack gap={1}>
          <Heading level={2}>Beat 3 — Faithfulness capstone</Heading>
          <Text as="p" size="sm">
            Beats 1 and 2 had an <strong>answer key</strong>: the structured diff compared
            against an expected medication list, and the reference judge compared against expected
            prose. Beat 3 has <strong>no answer key</strong>. The{' '}
            <Term
              term="faithfulness"
              definition="A check that every atomic claim in the output is grounded in the provided context — not whether it matches a gold answer. It catches things the model asserted beyond the evidence."
            />{' '}
            judge only checks whether each claim is grounded in the retrieved context. That is
            also why it can be fooled: a plausible-sounding hallucination is still ungrounded.
          </Text>
        </Stack>
      </Card>

      {/* ── Move 1: edit the rubric, watch the score move ──────────────────── */}
      <section data-testid="beat3-rubric-knob">
        <Stack gap={2}>
          <Stack gap={1}>
            <Heading level={3}>1. Edit the rubric — the score moves</Heading>
            <Text as="p" size="sm" tone="muted">
              The rubric is the knob that decides how strictly &quot;grounded&quot; is read. The
              same committed outputs are re-scored against each variant — no model call. Watch the
              mean faithfulness score change as you switch.
            </Text>
          </Stack>

          <div
            className={styles.segmented}
            role="group"
            aria-label="Rubric strictness"
            data-testid="beat3-rubric-toggle"
          >
            {(['strict', 'lenient'] as const).map((r) => (
              <button
                key={r}
                type="button"
                data-testid={`beat3-rubric-${r}`}
                aria-pressed={rubric === r}
                className={`${styles.segment} ${rubric === r ? styles.segmentActive : ''}`}
                onClick={() => setRubric(r)}
              >
                {RUBRIC_LABEL[r]}
              </button>
            ))}
          </div>

          <Card padding="sm" tone="neutral">
            <Stack gap={2}>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}>
                <Text size="sm" weight="semibold">
                  Mean faithfulness score:
                </Text>
                <span className={styles.meanScore} data-testid="beat3-mean-score">
                  {(meanScore * 100).toFixed(1)}%
                </span>
              </div>
              <Stack gap={1}>
                <Badge tone="neutral">Active rubric ({rubric})</Badge>
                <pre className={styles.rubricText} data-testid="beat3-active-rubric">
                  {data.rubrics[rubric]}
                </pre>
              </Stack>
              <Text as="p" size="xs" tone="muted">
                In the live workspace you can edit this rubric freely and re-score against the real
                judge. Here it is fixed to two committed variants so the lesson stays offline and
                deterministic.
              </Text>
            </Stack>
          </Card>
        </Stack>
      </section>

      {/* ── Move 2: label the cases, see where the judge disagrees with you ── */}
      <section data-testid="beat3-label-and-disagree">
        <Stack gap={2}>
          <Stack gap={1}>
            <Heading level={3}>2. You label it — the judge disagrees with you</Heading>
            <Text as="p" size="sm" tone="muted">
              Each row is a case you labeled <strong>designed-pass</strong> or{' '}
              <strong>designed-fail</strong> before the judge ran. Flip a label and watch the
              yellow disagreement rows update. The judge is not the authority here — you are
              comparing two fallible opinions.
            </Text>
          </Stack>

          <DisagreementTable
            results={results}
            initialThreshold={initialThreshold}
            onIntentLabelChange={handleIntentLabelChange}
          />
        </Stack>
      </section>

      {/* ── Move 3: the threshold is a knob, not magic ─────────────────────── */}
      <section data-testid="beat3-threshold-explainer">
        <Card tone="warning" padding="sm">
          <Stack gap={1}>
            <Heading level={3}>3. The 0.85 threshold is a config knob, not magic</Heading>
            <Text as="p" size="sm">
              The pass cutoff above defaults to{' '}
              <strong data-testid="beat3-threshold-value">{initialThreshold.toFixed(2)}</strong>,
              read from <code>evals/thresholds.yaml</code> — not hardcoded in the page (rule 15).
              It was chosen against the seeded set, not a powered calibration. Slide it and watch
              agreement shift: the strict-rubric problem-list case fails at 0.85 but passes at
              0.75 because its one interpretive claim is grounded yet not explicit — a{' '}
              <strong>threshold</strong> problem, not a rubric one.
            </Text>
            <Text as="p" size="sm">
              But moving the cutoff to maximize agreement on these few cases is{' '}
              <strong>not validation</strong> — at this sample size it just memorizes your set.
              Real calibration measures the judge against a held-out, human-labeled subset
              (Cohen&apos;s κ), which a handful of cases cannot support.
            </Text>
          </Stack>
        </Card>
      </section>

      {/* Grounding — reinforce "no answer key": this is all the judge sees */}
      <details data-testid="beat3-grounding">
        <summary className={styles.summary}>
          <Text size="sm" weight="semibold">
            What the judge grounds against (its only source — there is no answer key)
          </Text>
        </summary>
        <Stack gap={3} style={{ marginTop: 'var(--space-3)' }}>
          {data.cases.map((c) => (
            <Stack gap={1} key={c.caseId} data-testid={`beat3-grounding-${c.caseId}`}>
              <Badge tone="neutral">{c.taskPrompt}</Badge>
              <Text as="p" size="xs" tone="muted">
                {c.designedReason}
              </Text>
              <ul className={styles.groundingList}>
                {c.grounding.map((g, i) => (
                  <li key={i}>
                    <strong>[{g.section}]</strong> {g.text}
                  </li>
                ))}
              </ul>
            </Stack>
          ))}
        </Stack>
      </details>
    </Stack>
  )
}
