import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O8 / E27 / design G3 — the iteration-delta e2e. This is the COPY-REVIEW gate:
// the G3 acceptance copy ("k case(s) flipped (n=m)", the across-prompts annotation,
// the ≥100-case-floor caveat, and the two distinct suppression banners) is asserted
// against the live surface, so a copy regression that softens the n-honesty fails CI.
//
// The model seams are fixtured per D15 (record-replay): /api/run streams a committed
// fixture and /api/score returns a committed verdict, so the round-trip runs offline,
// free, and deterministically (rule 20) — no live calls.
//
// The bench's golden set is the lesson's four capstone cases, so a full flip lands on
// exactly the design's worked example — "4 cases flipped (n=4)" — and the n=4 < 100
// floor caveat is the named tension the surface must not hide.

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

async function mockRun(page: Page) {
  await page.route('/api/run', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-vercel-ai-data-stream': 'v1' },
      body: FIXTURE_STREAM,
    })
  })
}

// Fixtured faithfulness verdict — one supported/partial claim → score = `score`.
// (Mirrors e2e/roundtrip.test.ts so the two gates agree on the seam.)
function scoreBody(score: number) {
  return JSON.stringify({
    score,
    groundingSource: 'captured',
    claims: [
      {
        claim: 'The patient takes Lisinopril 10mg daily for hypertension.',
        verdict: score >= 0.85 ? 'supported' : 'partial',
        reason: 'fixtured verdict',
      },
    ],
  })
}

// Re-routable /api/score: later registrations take precedence, so a second call
// rebinds the verdict for the re-score pass — the two passes return distinct scores.
async function mockScore(page: Page, score: number) {
  await page.route('/api/score', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: scoreBody(score) })
  })
}

// Score the whole current run and wait for every case to land a score.
async function scoreAll(page: Page) {
  await page.getByTestId('score-run-btn').click()
  // The progress chip settles when scoring is no longer in progress.
  await expect(page.getByTestId('score-progress')).not.toContainText('in progress', { timeout: 20000 })
}

async function regenerateAll(page: Page) {
  await page.getByTestId('regenerate-btn').click()
  await expect(page.locator('[data-testid^="regenerated-output-"]').first()).toContainText('Lisinopril', {
    timeout: 15000,
  })
  await expect(page.getByTestId('regenerate-btn')).toBeEnabled({ timeout: 15000 })
}

test.describe('O8 iteration delta — G3 copy acceptance (E27)', () => {
  test('a full verdict flip renders "4 cases flipped (n=4)" with the n-honesty caveat', async ({
    page,
  }) => {
    await mockRun(page)
    await mockScore(page, 1.0)

    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // ── run 1: generate under prompt A, score every case matched (1.00) ───────
    await page.getByTestId('generation-prompt-input').fill('List medications only. Be terse.')
    await regenerateAll(page)
    await scoreAll(page)
    // No baseline yet — the first scored run has nothing to compare against.
    await expect(page.getByTestId('delta-panel')).toHaveCount(0)

    // ── run 2: edit the prompt, regenerate (rotates run 1 → baseline), re-score
    //          every case mismatched (0.50) → all four verdicts flip ───────────
    await page.getByTestId('generation-prompt-input').fill('Summarize the record in one line.')
    await regenerateAll(page)
    await mockScore(page, 0.5)
    await scoreAll(page)

    // The delta number renders (rubric/threshold/scorer unchanged across the runs).
    const delta = page.getByTestId('delta-panel')
    await expect(delta).toBeVisible({ timeout: 20000 })
    // G3 worked example — flips counted, n carried, never a "75% → 100%" celebration.
    await expect(page.getByTestId('delta-copy')).toHaveText('4 cases flipped (n=4)')
    // Aggregate move shown as raw pass counts over the same n (all four fell from pass).
    await expect(page.getByTestId('delta-aggregate')).toHaveText('pass: 4/4 → 0/4')

    // The gen-prompt axis ANNOTATES (the prompt edit IS the measured change, G3) —
    // it never suppresses the number.
    await expect(page.getByTestId('delta-across-prompts-note')).toContainText(
      'different generation prompts',
    )

    // n-honesty: the ≥100-case-floor tension is named in-surface, not hidden.
    const caveat = page.getByTestId('delta-floor-caveat')
    await expect(caveat).toContainText('100-case floor')
    await expect(caveat).toContainText('not proof')

    // The comparability / mixed-prompt banners do NOT fire — this is a clean delta.
    await expect(page.getByTestId('delta-incomparable-banner')).toHaveCount(0)
    await expect(page.getByTestId('delta-mixed-prompt-banner')).toHaveCount(0)
  })

  test('a moved rubric suppresses the number with the E27 comparability banner', async ({ page }) => {
    await mockRun(page)
    await mockScore(page, 1.0)

    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // ── run 1: rubric = strict (the bench default) ────────────────────────────
    await page.getByTestId('generation-prompt-input').fill('List medications only.')
    await regenerateAll(page)
    await scoreAll(page)

    // ── run 2: move the judge rubric to lenient, then regenerate + re-score ────
    // A moved rubric is the rubric/threshold/scorer axis — it SUPPRESSES the number
    // (you can't read a delta across a moved judge), distinct from the gen-prompt axis.
    await page.getByTestId('rubric-lenient').click()
    await regenerateAll(page)
    await scoreAll(page)

    const banner = page.getByTestId('delta-incomparable-banner')
    await expect(banner).toBeVisible({ timeout: 20000 })
    await expect(banner).toContainText('judge rubric')
    // The number is replaced, not shown alongside (axes never conflated, E27).
    await expect(page.getByTestId('delta-panel')).toHaveCount(0)
  })
})
