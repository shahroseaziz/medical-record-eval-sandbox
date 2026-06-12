import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O12b: the v1 workspace smoke retired with its surface. This is the BENCH smoke —
// the minimal end-to-end "is the deployed thing alive" pass (fixtured per D15):
// load → open bench → generate (mocked) → output lands → prompt-edit shows the
// stale signal. Deep behaviors live in their own specs (authoring, roundtrip,
// fanout, labels, delta, ragmode, rubric-parity).
const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

test.describe('bench smoke', () => {
  test('loads, generates against the mocked model, and flags a stale prompt', async ({ page }) => {
    await page.route('**/api/run', (r) =>
      r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: FIXTURE_STREAM }),
    )
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // The staleness signal is real (copy-truth): editing the prompt BEFORE
    // regenerating flags the committed results as stale…
    await page.getByTestId('generation-prompt-input').fill('Changed prompt — flag me stale.')
    await expect(page.getByTestId('prompt-stale-note')).toBeVisible()

    // …and regenerating clears the flag (the live run replaces the stale view).
    await page.getByTestId('regenerate-btn').click()
    await expect(page.getByTestId('regenerate-btn')).toBeEnabled({ timeout: 15000 })
    await expect(page.getByTestId('prompt-stale-note')).toHaveCount(0)
  })

  test('the seeded scorecard renders on the bench (parity port)', async ({ page }) => {
    await page.goto('/workbench')
    await expect(page.getByTestId('scorecard-judge-agreement')).toBeVisible()
    await expect(page.getByTestId('scorecard-judge-agreement')).toContainText('Designed-label agreement')
  })
})
