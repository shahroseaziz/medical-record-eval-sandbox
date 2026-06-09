export const dynamic = 'force-static'

import Link from 'next/link'
import { Container, Heading, Stack, Text } from '@/components/ui'
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
          <Heading level={1}>Faithfulness capstone: when there is no answer key</Heading>
          <Text as="p" size="sm" tone="muted">
            The third beat of the guided lesson. Earlier beats graded against an expected list (a
            structured diff) and expected prose (a reference judge). Here the judge has no answer
            key — it only checks whether each claim is grounded in the retrieved context.
            Read-only and deterministic: runs on committed data, no database or model calls.
          </Text>
        </Stack>

        <LessonBeat3 initialThreshold={threshold} />

        <hr className={styles.rule} />

        <div>
          <Link href="/" className={styles.cta}>
            Author your own run →
          </Link>
        </div>
      </Stack>
    </Container>
  )
}
