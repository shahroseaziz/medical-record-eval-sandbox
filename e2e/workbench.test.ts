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

  test('graduation arc (R12): finishing the lesson lands in the bench pre-loaded, not a restart', async ({
    page,
  }) => {
    await mockRun(page)
    await page.goto('/lesson')

    // The win-moment is gated behind finishing — it is not on screen yet.
    await expect(page.getByTestId('lesson-graduation')).toHaveCount(0)

    // The lesson is a stepper journey: exactly one beat is interactive at a
    // time and advancing is gated. Beat 3 only appears after completing Beat 1
    // (run the diff) and crossing Beat 2 (the contrast).
    await expect(page.getByTestId('beat-3-active')).toHaveCount(0)
    await page.getByTestId('beat1-source-summary').click()
    await page.getByTestId('beat1-run').click()
    await page.getByTestId('beat-1-advance').click()
    await page.getByTestId('beat-2-advance').click()
    await expect(page.getByTestId('beat-3-active')).toBeVisible()

    // Leave the lesson on the lenient rubric and a flipped label, then finish.
    await page.getByTestId('beat3-rubric-lenient').click()
    await page.getByTestId('set-intent-fail-beat3-medications-pass').click()
    await page.getByTestId('beat3-finish-btn').click()

    // The "you did it" win-moment appears.
    await expect(page.getByTestId('lesson-graduation')).toBeVisible()
    await expect(page.getByTestId('lesson-graduation')).toContainText('You did it')

    // Crossing the graduation lands in the bench (not a lesson restart)...
    await page.getByTestId('graduation-cta').click()
    await expect(page).toHaveURL(/\/workbench\?/)
    await expect(page.getByTestId('workbench')).toBeVisible()

    // ...pre-loaded with the carried state: the banner, the lenient rubric, and
    // the flipped label all survived the handoff.
    await expect(page.getByTestId('carryover-banner')).toBeVisible()
    await expect(page.getByTestId('rubric-lenient')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId(`disagreement-row-${ALLERGIES}`)).toHaveAttribute(
      'data-disagrees',
      'true',
    )
    await expect(page.getByTestId('disagreement-row-beat3-medications-pass')).toHaveAttribute(
      'data-disagrees',
      'true',
    )
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
