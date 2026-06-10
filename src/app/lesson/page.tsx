export const dynamic = 'force-static'

import Link from 'next/link'
import { Container, Heading, Stack, Text } from '@/components/ui'
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
            Every eval is the same three atoms — a <strong>prompt</strong> (the thing tested),{' '}
            <strong>cases</strong> (the golden set you grade), and an <strong>evaluator</strong> (the
            thing that decides pass/fail). Across three beats you meet the three evaluator types in
            turn: a structured diff catches a real extraction error (Beat 1); a prose question
            defeats that diff and a reference judge resolves it (Beat 2); and a faithfulness judge
            grades when there is no answer key at all (Beat 3). Read-only and deterministic — runs on
            committed generation, no database or model calls.
          </Text>
        </Stack>

        {/* Each beat self-frames; the page no longer re-states a "what you just
            learned" panel between them (no doubled payoff). The synthesis — the
            three atoms and the three-evaluator palette — lands once, at graduation. */}

        {/* Beat 1 — the interactive on-ramp (R8): author a key, run the diff, hit
            the reference-was-wrong aha. Runs on the seeded R7 generation. */}
        <LessonBeat1 />

        {/* Beat 2 — prose contrast (R9): the structured diff fails, the reference judge resolves */}
        <LessonBeat2 />

        {/* Beat 3 — faithfulness capstone (R10): no answer key, grounded-claim check.
            Self-frames ("Beat 3 — Faithfulness capstone") and ends in the graduation
            (R12): a "you did it" win-moment whose CTA routes into the open workbench
            pre-loaded with the lesson's last state (rubric + labels), so the bench
            picks up where the lesson left off instead of restarting. */}
        <LessonBeat3 initialThreshold={threshold} />
      </Stack>
    </Container>
  )
}
