import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O6b/S23 — selective fan-out: generation books EXACTLY the checked cases, the
// buttons carry honest counts, and the cost preview shows before any booking.
// Model seams are fixtured per D15 (record-replay) — zero live calls in CI.

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

async function mockRunCounting(page: Page, counter: { runs: number }) {
  await page.route('**/api/run', async (route) => {
    counter.runs++
    await route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: FIXTURE_STREAM,
    })
  })
}

test.describe('selective fan-out (O6b)', () => {
  test('unchecking cases shrinks the booking: k checked → exactly k /api/run calls', async ({
    page,
  }) => {
    const counter = { runs: 0 }
    await mockRunCounting(page, counter)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    const checks = page.locator('[data-testid^="case-check-"]')
    const total = await checks.count()
    expect(total).toBeGreaterThanOrEqual(3)

    // Uncheck all but the first.
    for (let i = 1; i < total; i++) await checks.nth(i).uncheck()

    const genBtn = page.getByTestId('regenerate-btn')
    await expect(genBtn).toContainText('Generate selected (1)')
    await genBtn.click()
    await expect(genBtn).toBeEnabled({ timeout: 15000 })
    expect(counter.runs).toBe(1)
  })

  test('score button carries the metered-call count and the cost preview renders', async ({
    page,
  }) => {
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    const scoreBtn = page.getByTestId('score-run-btn')
    await expect(scoreBtn).toContainText(/Score selected \(\d+ · ~\d+ metered calls\)/)
    // Default evaluator surface includes metered scorers → preview is visible
    // with a dollar figure computed at runtime (D9 — never hardcoded copy).
    const preview = page.getByTestId('cost-preview')
    await expect(preview).toBeVisible()
    await expect(preview).toContainText(/est\. ~\$\d+\.\d{4}/)
  })

  test('empty selection disables the fan-out: Generate selected (0) books nothing', async ({
    page,
  }) => {
    const counter = { runs: 0 }
    await mockRunCounting(page, counter)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    const checks = page.locator('[data-testid^="case-check-"]')
    const total = await checks.count()
    for (let i = 0; i < total; i++) await checks.nth(i).uncheck()

    const genBtn = page.getByTestId('regenerate-btn')
    await expect(genBtn).toContainText('Generate selected (0)')
    await genBtn.click()
    // Guarded no-op — nothing booked.
    expect(counter.runs).toBe(0)
  })
})
