export const dynamic = 'force-static'

import Link from 'next/link'
import { DisagreementTable } from '@/components/DisagreementTable'
import { Badge, Card, Container, Heading, Stack, Text } from '@/components/ui'
import exampleData from '@/example/eval-example.json'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'
import styles from './page.module.css'

export default function ExamplePage() {
  const results = exampleData.results as UserRunCaseResult[]
  const threshold = exampleData.threshold

  return (
    <Container as="main" data-testid="example-permalink-page" className={styles.page}>
      <Stack gap={5}>
        <div>
          <Link href="/" className={styles.backLink}>
            ← Medical Record Eval Sandbox
          </Link>
        </div>

        <Stack gap={1}>
          <Heading level={1}>Worked Example Run</Heading>
          <Text as="p" size="sm" tone="muted">
            Read-only snapshot — produced once by a maintainer. No database or model calls.
            Generated: {exampleData.generatedAt}
          </Text>
        </Stack>

        <Card data-testid="example-static-note" tone="info" padding="sm">
          <Text as="p" size="sm">
            <strong>Teaching moment:</strong> the highlighted row shows a case where the judge
            scored a hallucination as faithful. The human annotator caught the error — this is why
            judges are validated, not trusted.
          </Text>
        </Card>

        <DisagreementTable results={results} initialThreshold={threshold} />

        <hr className={styles.rule} />

        <details className={styles.prompts}>
          <summary className={styles.summary}>
            <Text size="sm" weight="semibold">
              Prompts used
            </Text>
          </summary>
          <Stack gap={4} className={styles.promptsBody}>
            <Stack gap={2}>
              <Badge tone="neutral">Generation prompt</Badge>
              <pre className={styles.pre}>{exampleData.generationPrompt}</pre>
            </Stack>
            <Stack gap={2}>
              <Badge tone="neutral">Judge rubric</Badge>
              <pre className={styles.pre}>{exampleData.judgeRubric}</pre>
            </Stack>
          </Stack>
        </details>

        <div>
          <Link href="/" className={styles.cta}>
            Author your own run →
          </Link>
        </div>
      </Stack>
    </Container>
  )
}
