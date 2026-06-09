export const dynamic = 'force-static'

import Link from 'next/link'
import { Container, Heading, Stack, Text } from '@/components/ui'
import { LessonView } from '@/components/LessonView'
import { loadLesson } from '@/lib/lesson'
import styles from './page.module.css'

export default function LessonPage() {
  const lesson = loadLesson()

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
            A guided, two-beat walkthrough of how a structured diff and a reference judge surface a
            real extraction error. Read-only — runs on committed generation, no database or model
            calls.
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
