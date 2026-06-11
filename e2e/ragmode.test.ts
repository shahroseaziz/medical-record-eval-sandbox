import { test, expect, type Page } from '@playwright/test'

// O10 / G4 — RAG mode in the bench. The RAG inspector is deterministic and offline
// (rule 20): no /api/run round-trip, so no stream fixture is needed. These assert
// the G4 acceptance directly on the rendered surface.

const MISS_CASE = 'rag-agustin-specialist-retrieve-miss'
const HIT_CASE = 'rag-brenna-allergies-retrieve-hit'

async function openRagMode(page: Page) {
  await page.goto('/workbench')
  await page.getByTestId('open-the-bench-btn').click()
  await page.getByTestId('rag-mode-toggle').click()
  await expect(page.getByTestId('rag-inspector')).toBeVisible()
}

test.describe('ragmode (O10 / G4)', () => {
  test('the same case shows a grounding difference between retrieve and stuff', async ({ page }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${MISS_CASE}`).click()

    // Retrieve mode: grounding is the inBudget subset.
    await page.getByTestId('rag-mode-retrieve').click()
    await expect(page.getByTestId('rag-current-mode')).toHaveAttribute('data-mode', 'retrieve')
    const retrieveGrounding = (await page.getByTestId('rag-grounding').textContent()) ?? ''

    // Stuff mode: grounding is the WHOLE record.
    await page.getByTestId('rag-mode-stuff').click()
    await expect(page.getByTestId('rag-current-mode')).toHaveAttribute('data-mode', 'stuff')
    const stuffGrounding = (await page.getByTestId('rag-grounding').textContent()) ?? ''

    expect(stuffGrounding).not.toEqual(retrieveGrounding)
    // Stuff sends more (the full record); the budget-dropped section only appears in stuff.
    expect(stuffGrounding.length).toBeGreaterThan(retrieveGrounding.length)
    expect(retrieveGrounding).not.toContain('[specialist]')
    expect(stuffGrounding).toContain('[specialist]')
  })

  test('the miss case demonstrably fires section_hit=false over the inBudget subset', async ({
    page,
  }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${MISS_CASE}`).click()
    await page.getByTestId('rag-mode-retrieve').click()

    // The required `specialist` chunk WAS retrieved but budget-dropped.
    await expect(page.getByTestId('rag-chunks-summary')).toContainText('6')
    await expect(page.getByTestId('rag-chunks-summary')).toContainText('4 fit budget')
    await expect(page.getByTestId('rag-chunk-5')).toHaveAttribute('data-dropped', 'true')

    // section_hit is a genuine miss (score 0), not N/A and not a config error.
    await expect(page.getByTestId('rag-section-hit')).toHaveAttribute('data-hit', '0')
    await expect(page.getByTestId('rag-section-hit-missing')).toContainText('specialist')
    await expect(page.getByTestId('rag-budget-miss-note')).toBeVisible()

    // Chunk cards surface BOTH distance and similarity (arch S6 / E16).
    await expect(page.getByTestId('rag-chunk-0-distance')).toContainText('dist')
    await expect(page.getByTestId('rag-chunk-0-similarity')).toContainText('sim')
  })

  test('stuff mode reports section_hit as N/A (no retrieval step)', async ({ page }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${MISS_CASE}`).click()
    await page.getByTestId('rag-mode-stuff').click()
    await expect(page.getByTestId('rag-stuff-note')).toContainText('N/A')
    await expect(page.getByTestId('rag-section-hit')).toHaveCount(0)
  })

  test('the small-patient case carries the non-selective honesty note and still hits', async ({
    page,
  }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${HIT_CASE}`).click()
    await page.getByTestId('rag-mode-retrieve').click()

    await expect(page.getByTestId('rag-section-hit')).toHaveAttribute('data-hit', '1')
    await expect(page.getByTestId('rag-nonselective-note')).toBeVisible()
    await expect(page.getByTestId('rag-nonselective-note')).toContainText('non-selective')
  })

  test('RAG-term tooltips include the specialist section_hit copy (#94)', async ({ page }) => {
    await openRagMode(page)
    await page.getByTestId(`rag-case-select-${MISS_CASE}`).click()
    await page.getByTestId('rag-mode-retrieve').click()

    // The eval-term tooltip treatment extends to the RAG plumbing terms.
    await expect(page.getByTestId('term-distance').first()).toBeVisible()
    await expect(page.getByTestId('term-similarity').first()).toBeVisible()
    await expect(page.getByTestId('term-k').first()).toBeVisible()
    await expect(page.getByTestId('term-stuff').first()).toBeVisible()

    // section_hit gloss carries specialist copy #94 verbatim — assert via the
    // accessible label, then reveal the tooltip itself.
    const sectionHitTerm = page.getByTestId('term-section-hit').first()
    await expect(sectionHitTerm).toHaveAttribute(
      'aria-label',
      /section_hit is a coarse, section-level recall signal/,
    )
    await sectionHitTerm.hover()
    await expect(page.getByRole('tooltip')).toContainText(
      'section_hit is a coarse, section-level recall signal',
    )
  })

  test('the ingest chunk-count histogram is shown (distribution, not an asserted 6–9)', async ({
    page,
  }) => {
    await openRagMode(page)
    await expect(page.getByTestId('rag-histogram')).toBeVisible()
    await expect(page.getByTestId('rag-histogram')).toContainText('Chunks per patient at ingest')
    // The 6 MB outlier bucket is present.
    await expect(page.getByTestId('rag-histogram-bar-33+')).toBeVisible()
  })
})
