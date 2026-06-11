import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O7a / S22 — the run round-trip write path: a regenerated output is written into
// runs.current.outputs and persisted to localStorage as it lands, so a page reload
// preserves the generated-but-unscored output (generation is the expensive half;
// the walk lost paid generations to a refresh). This e2e is the reload-survival gate.

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

async function mockRun(page: Page) {
  await page.route('/api/run', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'x-vercel-ai-data-stream': 'v1',
      },
      body: FIXTURE_STREAM,
    })
  })
}

test.describe('run round-trip — reload survival (S22 / E27)', () => {
  test('a regenerated output survives a full page reload', async ({ page }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // Regenerate over the golden set under a custom prompt (the one live knob).
    await page.getByTestId('generation-prompt-input').fill('List medications only. Be terse.')
    await page.getByTestId('regenerate-btn').click()

    // The first case streams a live output into the inspector...
    const firstOutput = page.locator('[data-testid^="regenerated-output-"]').first()
    await expect(firstOutput).toContainText('Lisinopril', { timeout: 10000 })
    // ...and the fan-out finishes (the regenerate button re-enables) — every
    // completed output is now persisted into runs.current.outputs.
    await expect(page.getByTestId('regenerate-btn')).toBeEnabled({ timeout: 15000 })

    // RELOAD — the live in-memory stream is gone; only localStorage remains.
    await page.reload()
    await page.getByTestId('open-the-bench-btn').click()

    // The persisted output is rehydrated from runs.current.outputs and rendered as a
    // restored output (no regeneration was triggered after the reload).
    const restored = page.locator('[data-testid^="regenerated-output-"]').first()
    await expect(restored).toBeVisible()
    await expect(restored).toHaveAttribute('data-restored', 'true')
    await expect(restored).toContainText('Lisinopril')
  })
})
