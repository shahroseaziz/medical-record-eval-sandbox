import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

const ALLERGIES = 'beat3-allergies-rubric-sensitive-fail'

async function mockRun(page: Page, onBody?: (body: Record<string, unknown>) => void) {
  await page.route('/api/run', async (route) => {
    onBody?.(route.request().postDataJSON() as Record<string, unknown>)
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

test.describe('open workbench (R11)', () => {
  test('lands pre-loaded with results on first paint', async ({ page }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await expect(page.getByTestId('workbench')).toBeVisible()
    await expect(page.getByTestId('disagreement-table')).toBeVisible()
    await expect(page.getByTestId(`disagreement-row-${ALLERGIES}`)).toBeVisible()
  })

  test('the red-cell aha reproduces on the rubric knob', async ({ page }) => {
    await mockRun(page)
    await page.goto('/workbench')
    // Strict (default): the allergies case agrees with its designed-fail label.
    await expect(page.getByTestId(`disagreement-row-${ALLERGIES}`)).toHaveAttribute(
      'data-disagrees',
      'false',
    )
    // Lenient: the judge is fooled by the plausible aspirin claim → disagreement.
    await page.getByTestId('rubric-lenient').click()
    await expect(page.getByTestId(`disagreement-row-${ALLERGIES}`)).toHaveAttribute(
      'data-disagrees',
      'true',
    )
  })

  test('faithfulness reshapes the surface — switching evaluators toggles the expected column', async ({
    page,
  }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await expect(page.getByTestId('expected-column-header')).toHaveCount(0)

    await page.getByTestId('evaluator-option-reference-judge').click()
    await expect(page.getByTestId('expected-column-header')).toBeVisible()
    await expect(page.getByTestId('disagreement-table')).toHaveCount(0)

    await page.getByTestId('evaluator-option-faithfulness').click()
    await expect(page.getByTestId('expected-column-header')).toHaveCount(0)
    await expect(page.getByTestId('disagreement-table')).toBeVisible()
  })

  test('the prompt knob is live: regenerate fires /api/run with the custom prompt and streams output', async ({
    page,
  }) => {
    const bodies: Record<string, unknown>[] = []
    await mockRun(page, (b) => bodies.push(b))
    await page.goto('/workbench')

    const custom = 'Be extremely terse. List medications only.'
    await page.getByTestId('generation-prompt-input').fill(custom)
    await expect(page.getByTestId('prompt-stale-note')).toBeVisible()

    await page.getByTestId('regenerate-btn').click()

    // The regenerated output streams into the record inspector.
    await expect(page.getByTestId('regenerate-progress')).toBeVisible({ timeout: 10000 })
    await expect
      .poll(() => bodies.length, { timeout: 10000 })
      .toBeGreaterThan(0)

    // The live call carried the custom prompt and grounded in stuff mode (generate-only).
    const first = bodies[0]
    expect(first.generationPrompt).toBe(custom)
    expect(first.mode).toBe('stuff')
    expect(first.generateOnly).toBe(true)
    expect(typeof first.record).toBe('string')
  })
})
