export const dynamic = 'force-static'

import Link from 'next/link'
import { Container, Heading, Stack, Text } from '@/components/ui'
import { LessonView } from '@/components/LessonView'
import { loadLesson } from '@/lib/lesson'
import { LessonBeat1 } from '@/components/LessonBeat1'
import { LessonBeat3 } from '@/components/LessonBeat3'
import { loadThresholds } from '@/lib/eval/thresholds'
import { DEFAULT_PASS_THRESHOLD } from '@/lib/eval/user-agreement'
import styles from './page.module.css'

// Pass threshold lives in config (evals/thresholds.yaml), never hardcoded in the
// page (rule 15). Fall back to the documented default only if config is missing.
function faithfulnessThreshold(): number {
  try {
    return loadThresholds().faithfulness
  } catch {
    return DEFAULT_PASS_THRESHOLD
  }
}

export default function LessonPage() {
  const lesson = loadLesson()
  const threshold = faithfulnessThreshold()

  return (
    <Container as="main" data-testid="lesson-page" className={styles.page}>
      <Stack gap={5}>
        <div>
          <Link href="/" className={styles.backLink}>
            ← Medical Record Eval Sandbox
          </Link>
        </div>

        <Stack gap={1}>
          <Heading level={1}>Correctness lesson: catching a dose error</Heading>
          <Text as="p" size="sm" tone="muted">
            A guided, three-beat walkthrough of how a structured diff and a reference judge surface
            a real extraction error, then how a faithfulness judge grades when there is no answer
            key. Read-only and deterministic — runs on committed generation, no database or model
            calls.
          </Text>
        </Stack>

        {/* Beat 1 — the interactive on-ramp (R8): author a key, run the diff, hit
            the reference-was-wrong aha. Runs on the seeded R7 generation. */}
        <LessonBeat1 />

        {/* The same committed case, scored end-to-end and under the hood — the
            deterministic structured diff (Beat 1) plus the reference judge (Beat 2). */}
        <Stack gap={1}>
          <Heading level={2}>Under the hood — the committed scorecard</Heading>
          <Text as="p" size="sm" tone="muted">
            The interactive beat above let you author the key. Here is the same case scored against
            the committed answer key end-to-end: the deterministic structured diff and the reference
            judge, replayed from a fixture so they never re-call a model.
          </Text>
        </Stack>

        {lesson ? (
          <LessonView data={lesson} />
        ) : (
          <Text as="p" size="sm" tone="muted" data-testid="lesson-unavailable">
            The lesson baseline has not been generated yet. Run{' '}
            <code>npm run generate:baseline:replay</code> to produce it.
          </Text>
        )}

        {/* Beat 3 — faithfulness capstone (R10): no answer key, grounded-claim check */}
        <Stack gap={1}>
          <Heading level={2}>Beat 3 — when there is no answer key</Heading>
          <Text as="p" size="sm" tone="muted">
            Earlier beats graded against an expected list (a structured diff) and expected prose (a
            reference judge). Here the judge has no answer key — it only checks whether each claim
            is grounded in the retrieved context.
          </Text>
        </Stack>

        <LessonBeat3 initialThreshold={threshold} />

        <hr className={styles.rule} />

        <div>
          <Link href="/workbench" className={styles.cta} data-testid="workbench-link">
            Open the workbench — pre-loaded from this lesson →
          </Link>
        </div>
      </Stack>
    </Container>
  )
}
