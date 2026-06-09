'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Badge, Card, Heading, Stack, Text } from './ui'
import { buildBeat3Results, type RubricVariant } from '@/lib/lesson/beat3'
import { computeUserAgreement } from '@/lib/eval/user-agreement'
import { benchHrefFromLesson } from '@/lib/workbench/carryover'
import styles from './LessonGraduation.module.css'

interface Props {
  /** The rubric the learner left Beat 3 on — carried into the bench. */
  rubric: RubricVariant
  /** The intent labels the learner flipped — carried into the bench. */
  labels: Record<string, 'pass' | 'fail'>
  /** Faithfulness pass threshold (config), used for the agreement recap. */
  threshold: number
}

/**
 * The graduation — the "you did it" win-moment that closes the lesson and routes
 * into the open workbench (R12).
 *
 * This is the join the prototype was missing: Beat 3 ended and the only way on
 * was a generic link that dropped everything and restarted the lesson. Here the
 * learner gets an earned moment — a recap of what they actually did (the rubric
 * they settled on, how often they and the judge agreed) — and a CTA that carries
 * that exact state into the bench, so the bench opens on the surface they just
 * built, not a cold default. The carry-over is encoded in the link href
 * (`benchHrefFromLesson`); the bench page decodes it server-side.
 */
export function LessonGraduation({ rubric, labels, threshold }: Props) {
  // Recap the learner's own run: agreement between their labels and the judge
  // under the rubric they settled on. Deterministic — committed fixtures only.
  const agreement = useMemo(() => {
    const results = buildBeat3Results(rubric, labels)
    return computeUserAgreement(results, threshold)
  }, [rubric, labels, threshold])

  const href = benchHrefFromLesson({ evaluator: 'faithfulness', rubric, labels })
  const relabeled = Object.keys(labels).length

  return (
    <Card tone="success" padding="lg" data-testid="lesson-graduation">
      <Stack gap={3}>
        <Stack gap={1}>
          <Badge tone="success">🎓 You did it</Badge>
          <Heading level={2}>Lesson complete — you ran a real eval loop</Heading>
          <Text as="p" size="sm">
            You authored an answer key and caught a dose error (Beat 1), watched a reference judge
            confirm it (Beat 2), and graded a faithfulness capstone with{' '}
            <strong>no answer key</strong> — moving the rubric, labeling cases, and seeing exactly
            where you and the judge disagreed (Beat 3). That is the whole loop:{' '}
            <em>generate → evaluate → label → measure agreement</em>.
          </Text>
        </Stack>

        {/* Recap — make the win concrete with the learner's own numbers. */}
        <div className={styles.recap} data-testid="graduation-recap">
          <span className={styles.recapItem}>
            Final rubric: <strong data-testid="graduation-rubric">{rubric}</strong>
          </span>
          <span className={styles.recapItem}>
            Cases you relabeled: <strong data-testid="graduation-relabeled">{relabeled}</strong>
          </span>
          <span className={styles.recapItem}>
            You ⇄ judge agreement:{' '}
            <strong data-testid="graduation-agreement">
              {agreement.agreement === null
                ? '—'
                : `${agreement.agreeCount}/${agreement.n} (${(agreement.agreement * 100).toFixed(0)}%)`}
            </strong>
          </span>
        </div>

        <Text as="p" size="sm" tone="muted">
          Now take the knobs off the rails. The open workbench opens{' '}
          <strong>pre-loaded with this exact state</strong> — the faithfulness evaluator, the{' '}
          <strong>{rubric}</strong> rubric, and your labels — so you pick up where you left off
          instead of starting over. There you can switch evaluators, edit the generation prompt, and
          re-run live against the model.
        </Text>

        <div>
          <Link href={href} className={styles.cta} data-testid="graduation-cta">
            Enter the open workbench → carries your state
          </Link>
        </div>
      </Stack>
    </Card>
  )
}
