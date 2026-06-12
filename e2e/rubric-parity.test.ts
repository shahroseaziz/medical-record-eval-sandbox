import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O12b/S26 parity: the judge-calibration loop — the one measurable loop that
// worked on production before this cycle — survives retirement, ported onto the
// bench. Free-text rubric + single-case re-score probe (fixtured per D15).
const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

test.describe('bench judge-calibration loop (O12b parity)', () => {
  test('edit rubric → re-score probe returns a verdict for the selected case', async ({ page }) => {
    await page.route('**/api/run', (r) =>
      r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: FIXTURE_STREAM }),
    )
    await page.route('**/api/score', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          score: 0.5,
          zeroClaimFlag: false,
          claims: [{ claim: 'fixtured claim', verdict: 'partial', reason: 'fixtured rationale' }],
        }),
      }),
    )
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // Generate an output for the selected case so the probe has a target.
    await page.getByTestId('regenerate-btn').click()
    await expect(page.getByTestId('regenerate-btn')).toBeEnabled({ timeout: 15000 })

    const editor = page.getByTestId('judge-rubric-input')
    await expect(editor).toBeVisible()
    await editor.fill('- "supported": only verbatim statements.\n- everything else: "unsupported".')
    await page.getByTestId('rescore-btn').click()
    await expect(page.getByTestId('rescore-result')).toContainText('50%', { timeout: 15000 })
  })

  test('bench set IO panel is present (BenchSetIO ported)', async ({ page }) => {
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()
    await expect(page.getByTestId('benchset-io')).toBeVisible()
  })
})
