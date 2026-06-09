import Link from 'next/link'
import { Container, Heading, Stack, Text } from '@/components/ui'
import { Workbench } from '@/components/Workbench'
import { loadThresholds, type Thresholds } from '@/lib/eval/thresholds'
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

export default function WorkbenchPage() {
  const thresholds = loadThresholdsOrNull()

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

        <Workbench thresholds={thresholds ?? undefined} />

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
