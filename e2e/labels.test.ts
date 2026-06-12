import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O9 — G5 judge-agreement labels (E26). The clinician seat: the user marks their
// OWN pass/fail labels on scored outputs and the agreement metric reports how often
// the judge agrees. The bench renders its scored results offline (no model call),
// so these copy + interaction assertions need no live judge.

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

const MEDS = 'beat3-medications-pass' // strict rubric → judge verdict PASS

async function mockRun(page: Page) {
  await page.route('/api/run', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-vercel-ai-data-stream': 'v1' },
      body: FIXTURE_STREAM,
    })
  })
}

test.describe('clinician labels + agreement (G5 / E26)', () => {
  test('clinician-seat copy and self-preference disclosure ship at the authoring moment', async ({
    page,
  }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    const seat = page.getByTestId('clinician-agreement')
    await expect(seat).toBeVisible()

    // Clinician-seat authoring copy: "does the judge agree with the clinician".
    await expect(page.getByTestId('clinician-authoring-copy')).toContainText(
      'does the judge agree with the clinician',
    )
    await expect(page.getByTestId('clinician-authoring-copy')).toContainText(
      'You define what "correct" means here',
    )

    // Self-preference disclosure (Haiku judges Haiku-generated output).
    const selfPref = page.getByTestId('clinician-self-preference')
    await expect(selfPref).toContainText('Self-preference')
    await expect(selfPref).toContainText('Haiku')
  })

  test('the metric is UNPOPULATED until ≥1 label, then fills in (never a vacuous 100%)', async ({
    page,
  }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // No labels yet → the empty state, NOT a 100% agreement metric.
    await expect(page.getByTestId('clinician-agreement-empty')).toBeVisible()
    await expect(page.getByTestId('clinician-agreement-empty')).toContainText(
      'label at least one output',
    )
    await expect(page.getByTestId('clinician-agreement-metric')).toHaveCount(0)

    // Label the meds output PASS — judge also says PASS → agreement 1/1.
    await page.getByTestId(`clinician-set-pass-${MEDS}`).click()
    const metric = page.getByTestId('clinician-agreement-metric')
    await expect(metric).toBeVisible()
    await expect(page.getByTestId('clinician-agreement-value')).toContainText(
      'agrees with your labels on 1 of 1',
    )
    await expect(page.getByTestId('clinician-agreement-empty')).toHaveCount(0)
  })

  test('disagreeing cases are one click away with the disagreement-moment copy', async ({
    page,
  }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // Label the meds output FAIL — but the judge says PASS → a disagreement.
    await page.getByTestId(`clinician-set-fail-${MEDS}`).click()

    const disagreers = page.getByTestId('clinician-disagreers')
    await expect(disagreers).toBeVisible()
    await expect(disagreers).toContainText('judge disagrees with you')

    // The disagreeing case + its clinician copy are one expand away.
    await disagreers.click() // open the <details>
    await expect(page.getByTestId('clinician-disagreement-copy')).toContainText('both are findings')
    await expect(page.getByTestId(`clinician-disagreer-${MEDS}`)).toBeVisible()

    // The row is flagged as a disagreement.
    await expect(page.getByTestId(`clinician-row-${MEDS}`)).toHaveAttribute('data-disagrees', 'true')
  })

  test('labels persist independently of runs — a reload restores them', async ({ page }) => {
    await mockRun(page)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    await page.getByTestId(`clinician-set-pass-${MEDS}`).click()
    await expect(page.getByTestId(`clinician-set-pass-${MEDS}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Reload — the label set is the user's durable asset; it survives.
    await page.reload()
    await page.getByTestId('open-the-bench-btn').click()
    await expect(page.getByTestId(`clinician-set-pass-${MEDS}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByTestId('clinician-agreement-value')).toContainText('1 of 1')
  })
})

test.describe('seeded surface: designed-label agreement (E26)', () => {
  test('the seeded scorecard reads "designed-label agreement", not clinician copy', async ({
    page,
  }) => {
    await page.goto('/workbench')

    await expect(page.getByTestId('eval-scorecard')).toBeVisible()
    // The seeded set's agreement is agreement-with-the-author's designed labels.
    await expect(page.getByTestId('scorecard-judge-agreement')).toContainText(
      'Designed-label agreement',
    )
    // The self-preference caveat ships here too.
    await expect(page.getByTestId('scorecard-self-preference')).toContainText('Self-preference')
    // The clinician framing is explicitly RESERVED for the user path, not claimed here.
    await expect(page.getByTestId('scorecard-honesty-note')).toContainText(
      'reserved for the user path',
    )
  })
})
