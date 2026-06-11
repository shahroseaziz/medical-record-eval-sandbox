import { test, expect, type Page } from '@playwright/test'

// O12a / S27 / G7 — the copy-truth audit, asserted on the live surfaces.
//
// `evals/copy-truth.md` maps every capability claim in app copy → the proof that
// makes it true. This spec is the executable half of that audit: each block asserts
// that a G7-listed claim is actually present on the rendered surface (and, where the
// claim is conditional, that it only appears when the backing behavior is real —
// e.g. the "metered" badge follows the actually-metered evaluator). Deterministic
// and offline (rule 20): no /api round-trips, the bench opens pre-loaded.
//
// Verify: pnpm test:e2e -- copytruth

const REPO_HREF = 'github.com/shahroseaziz/medical-record-eval-sandbox'
const MISS_CASE = 'rag-agustin-specialist-retrieve-miss'

async function openBench(page: Page) {
  await page.goto('/workbench')
  await page.getByTestId('open-the-bench-btn').click()
  await expect(page.getByTestId('prompt-panel')).toBeVisible()
}

async function openRagMode(page: Page) {
  await openBench(page)
  await page.getByTestId('rag-mode-toggle').click()
  await expect(page.getByTestId('rag-inspector')).toBeVisible()
}

test.describe('copytruth (O12a / S27 / G7)', () => {
  test('landing: cases-as-free-knobs copy and an in-app GitHub repo link', async ({ page }) => {
    await page.goto('/')
    // "free knobs" landing claim (true via S24 — the workbench is the real bench).
    await expect(page.getByTestId('route-workbench')).toContainText('free knobs')
    // The "visible in the open source" claim now has a home: a real repo link.
    const repo = page.getByTestId('repo-link')
    await expect(repo).toBeVisible()
    await expect(repo).toHaveAttribute('href', new RegExp(REPO_HREF))
  })

  test('bench: the re-grade promise is on the live bench surface', async ({ page }) => {
    await openBench(page)
    // The "change a knob → re-grade" claim (true via S22 round-trip — regeneration
    // streams into the run, scoring re-grades; it is not a display-only side panel).
    await expect(page.getByTestId('workbench')).toContainText('re-grade')
  })

  test('the "metered" badge follows the actually-metered evaluator, not every interaction', async ({
    page,
  }) => {
    await openBench(page)
    const cost = page.getByTestId('cost-strip')

    // Faithfulness is an LLM judge → metered.
    await page.getByTestId('evaluator-option-faithfulness').click()
    await expect(cost).toHaveAttribute('data-metered', 'true')
    await expect(cost).toContainText('metered')

    // Structured-diff is deterministic + client-side → free, never "metered".
    await page.getByTestId('evaluator-option-structured-diff').click()
    await expect(cost).toHaveAttribute('data-metered', 'false')
    await expect(cost).toContainText('free')
    await expect(cost).not.toContainText('metered')
  })

  test('"agrees with the clinician" framing attaches to the user path only', async ({ page }) => {
    await openBench(page)
    // The clinician-seat (user-path) agreement copy — the E26 rename keeps
    // "agrees with the clinician" off the seeded designed-label metric.
    await expect(page.getByTestId('clinician-authoring-copy')).toContainText(
      'does the judge agree with the clinician',
    )
  })

  test('RAG inspector: stuff-mode grounding is bounded to narrative-only extraction', async ({
    page,
  }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${MISS_CASE}`).click()
    await page.getByTestId('rag-mode-stuff').click()

    const bound = page.getByTestId('rag-stuff-narrative-bound')
    await expect(bound).toBeVisible()
    await expect(bound).toContainText('narrative text only')
    await expect(bound).toContainText('unsupported')
  })

  test('RAG inspector: the embedding-model rationale and cross-generation space caveat ship', async ({
    page,
  }) => {
    await openRagMode(page)

    const rationale = page.getByTestId('rag-embedding-rationale')
    await expect(rationale).toBeVisible()
    // No clinical-specific Voyage model; the chosen model is named from the live constant.
    await expect(rationale).toContainText('no clinical-specific Voyage model')
    await expect(rationale).toContainText('voyage-3.5')

    // Voyage-space teaching copy is scoped to cross-generation bumps (not within-family).
    const space = page.getByTestId('rag-embedding-space')
    await expect(space).toContainText('cross-generation')
    await expect(space).toContainText('silently different space')
  })

  test('RAG inspector: the grounding tooltip names the captured inBudget context', async ({
    page,
  }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${MISS_CASE}`).click()
    await page.getByTestId('rag-mode-retrieve').click()

    // The capture-time grounding claim (true via E19): grounding is the inBudget
    // subset actually sent, not the full record.
    const groundingTerm = page.getByTestId('term-grounding').first()
    await groundingTerm.hover()
    await expect(page.getByRole('tooltip')).toContainText('inBudget chunk subset')
  })
})
