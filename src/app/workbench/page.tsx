import Link from 'next/link'
import { Card, Container, Heading, Stack, Text } from '@/components/ui'
import { Workbench } from '@/components/Workbench'
import { loadThresholds, type Thresholds } from '@/lib/eval/thresholds'
import { decodeCarryParams } from '@/lib/workbench/carryover'
import styles from './page.module.css'

// Per-scorer acceptance thresholds live in config (evals/thresholds.yaml), read on
// the server and threaded into the client workbench so classification reads config,
// never a hardcoded client value (rule 15).
function loadThresholdsOrNull(): Thresholds | null {
  try {
    return loadThresholds()
  } catch {
    return null
  }
}

// Next 15: searchParams is async. The lesson graduation links here with the
// learner's last state encoded in the query string (R12); decode it server-side
// and thread it into the client bench as initial knob state.
export default async function WorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const thresholds = loadThresholdsOrNull()
  const carry = decodeCarryParams(await searchParams)

  return (
    <Container as="main" data-testid="workbench-page" className={styles.page}>
      <Stack gap={5}>
        <div>
          <Link href="/" className={styles.backLink}>
            ← Medical Record Eval Sandbox
          </Link>
        </div>

        <Stack gap={1}>
          <Heading level={1}>Open workbench</Heading>
          <Text as="p" size="sm" tone="muted">
            The open bench — prompt, cases, and evaluator as free knobs. It lands pre-loaded from
            the lesson&apos;s last state, so there are results on first paint. Switch the evaluator
            to see how faithfulness reshapes the surface, slide the rubric to reproduce the red-cell
            disagreement, or edit the generation prompt to re-run generation live against the model.
          </Text>
        </Stack>

        {carry.fromLesson && (
          <Card tone="success" padding="sm" data-testid="carryover-banner">
            <Text as="p" size="sm">
              <strong>Carried over from the lesson.</strong> This bench opened on exactly where you
              left off — the faithfulness evaluator, the <strong>{carry.rubric ?? 'strict'}</strong>{' '}
              rubric
              {Object.keys(carry.labels).length > 0
                ? `, and ${Object.keys(carry.labels).length} relabeled case${
                    Object.keys(carry.labels).length === 1 ? '' : 's'
                  }`
                : ''}
              . Nothing was reset.
            </Text>
          </Card>
        )}

        <Workbench
          thresholds={thresholds ?? undefined}
          initialEvaluator={carry.evaluator}
          initialRubric={carry.rubric}
          initialLabelOverrides={carry.labels}
        />

        <hr className={styles.rule} />

        <div>
          <Link href="/lesson" className={styles.cta}>
            ← Back to the guided lesson
          </Link>
        </div>
      </Stack>
    </Container>
  )
}
