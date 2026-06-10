export const dynamic = 'force-static'

import Link from 'next/link'
import { Container, Heading, Stack, Text } from '@/components/ui'
import { LessonView } from '@/components/LessonView'
import { loadLesson } from '@/lib/lesson'
import { LessonBeat1 } from '@/components/LessonBeat1'
import { LessonBeat2 } from '@/components/LessonBeat2'
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
          <Heading level={1}>Correctness lesson: from a dose error to a judgment call</Heading>
          <Text as="p" size="sm" tone="muted">
            A guided, three-beat walkthrough: a structured diff catches a real extraction error
            (Beat 1); a prose question defeats that diff and a reference judge resolves it (Beat 2);
            and a faithfulness judge grades when there is no answer key at all (Beat 3). Read-only
            and deterministic — runs on committed generation, no database or model calls.
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

        {/* Beat 2 — prose contrast (R9): the structured diff fails, the reference judge resolves */}
        <LessonBeat2 />

        {/* Beat 3 — faithfulness capstone (R10): no answer key, grounded-claim check */}
        <Stack gap={1}>
          <Heading level={2}>Beat 3 — when there is no answer key</Heading>
          <Text as="p" size="sm" tone="muted">
            Earlier beats graded against an expected list (a structured diff) and expected prose (a
            reference judge). Here the judge has no answer key — it only checks whether each claim
            is grounded in the retrieved context.
          </Text>
        </Stack>

        {/* Beat 3 ends in the graduation (R12): a "you did it" win-moment whose CTA
            routes into the open workbench pre-loaded with the lesson's last state
            (rubric + labels), so the bench picks up where the lesson left off
            instead of restarting. */}
        <LessonBeat3 initialThreshold={threshold} />
      </Stack>
    </Container>
  )
}
