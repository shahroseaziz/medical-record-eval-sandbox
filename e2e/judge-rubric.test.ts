import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

const DEFAULT_VERDICT_RUBRIC = `For each claim assign:
- "supported": directly and explicitly supported by the context
- "unsupported": contradicted by the context, or not present at all
- "partial": mentioned but with caveats, hedging, or incomplete coverage

Evaluate strictly. A claim is NOT supported unless the context explicitly backs it.`

const MOCK_PATIENT = {
  id: 'p-rubric-001',
  name: 'Dana Reyes',
  summary: {
    demographics: {
      firstName: 'Dana',
      lastName: 'Reyes',
      gender: 'F',
      birthDate: '19900415',
    },
    sections: ['medications'],
  },
}

const MOCK_SCORE_RESPONSE = {
  score: 0.5,
  claims: [
    {
      claim: 'The patient takes Lisinopril 10mg daily for hypertension',
      verdict: 'partial',
      reason: 'dose mentioned but indication only partially supported',
    },
  ],
  groundingSource: 'captured',
}

async function setupBaseMocks(page: Page) {
  await page.route('/api/patients*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patients: [MOCK_PATIENT] }),
    })
  })
  await page.route(/\/api\/patients\/.+\/chunks/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chunks: [] }),
    })
  })
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

async function selectPatientAndRun(page: Page) {
  await page.getByTestId('get-patients-btn').click()
  await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
  await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
  await page.getByTestId('prompt-input').fill('What medications is this patient taking?')
  await page.getByTestId('run-btn').click()
  await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })
}

test.describe('judge rubric editor', () => {
  test('rubric editor is visible with label and warning on page load', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/workspace')

    await expect(page.getByTestId('judge-rubric-editor')).toBeVisible()
    await expect(page.getByTestId('judge-rubric-warning')).toBeVisible()
    await expect(page.getByTestId('judge-rubric-warning')).toContainText('real patient data')
    await expect(page.getByTestId('judge-rubric-editor')).toContainText(
      'verdict rubric (applied per-claim)',
    )
  })

  test('pre-filled with the default verdict rubric', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/workspace')

    await expect(page.getByTestId('judge-rubric-input')).toHaveValue(DEFAULT_VERDICT_RUBRIC)
  })

  test('re-score button is disabled before a run', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/workspace')

    await expect(page.getByTestId('rescore-btn')).toBeDisabled()
    await expect(page.getByTestId('judge-rubric-editor')).toContainText('Run first to enable')
  })

  test('reset restores the default rubric after editing', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/workspace')

    await page.getByTestId('judge-rubric-input').fill('A custom rubric text')
    await expect(page.getByTestId('judge-rubric-input')).toHaveValue('A custom rubric text')

    await page.getByTestId('reset-judge-rubric-btn').click()
    await expect(page.getByTestId('judge-rubric-input')).toHaveValue(DEFAULT_VERDICT_RUBRIC)
  })

  test('rubric edit → re-score sends custom rubric to /api/score and shows result', async ({
    page,
  }) => {
    let capturedScoreBody: Record<string, unknown> | null = null

    await setupBaseMocks(page)
    await page.route('/api/score', async (route) => {
      capturedScoreBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SCORE_RESPONSE),
      })
    })

    await page.goto('/workspace')
    await selectPatientAndRun(page)

    // Re-score button should now be enabled (trace available)
    await expect(page.getByTestId('rescore-btn')).toBeEnabled({ timeout: 3000 })

    // Edit the rubric
    const customRubric = 'Strict: only mark supported when verbatim match found.'
    await page.getByTestId('judge-rubric-input').fill(customRubric)

    // Click re-score
    await page.getByTestId('rescore-btn').click()

    // Result should appear
    await expect(page.getByTestId('rescore-result')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('rescore-result')).toContainText('50%')
    await expect(page.getByTestId('rescore-claim-0')).toContainText('[partial]')

    // Verify the custom rubric was sent in the request body
    expect(capturedScoreBody).not.toBeNull()
    const body = capturedScoreBody as unknown as Record<string, unknown>
    expect(body.source).toBe('captured')
    expect(body.userVerdictRubric).toBe(customRubric)
    expect(body.capturedOutput).toBeTruthy()
    expect(body.capturedGrounding).toBeTruthy()
  })

  test('re-score with default rubric omits userVerdictRubric from request', async ({ page }) => {
    let capturedScoreBody: Record<string, unknown> | null = null

    await setupBaseMocks(page)
    await page.route('/api/score', async (route) => {
      capturedScoreBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SCORE_RESPONSE),
      })
    })

    await page.goto('/workspace')
    await selectPatientAndRun(page)

    await expect(page.getByTestId('rescore-btn')).toBeEnabled({ timeout: 3000 })
    await page.getByTestId('rescore-btn').click()

    await expect(page.getByTestId('rescore-result')).toBeVisible({ timeout: 5000 })

    // Default rubric → no userVerdictRubric in body
    const defaultBody = capturedScoreBody as unknown as Record<string, unknown>
    expect(defaultBody.userVerdictRubric).toBeUndefined()
  })

  test('extracted claims artifact renders in Inspector after run', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/workspace')
    await selectPatientAndRun(page)

    // Inspector should render with the extracted claims section
    await expect(page.getByTestId('inspector')).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('extracted-claims')).toBeVisible()

    // The artifact banner explains the two-call split
    await expect(page.getByTestId('extracted-claims')).toContainText(
      'the judge checks each against the record',
    )

    // The claim from the fixture is listed
    await expect(page.getByTestId('extracted-claim-0')).toContainText(
      'The patient takes Lisinopril',
    )
  })

  test('kappa and κ are never shown anywhere on the user path', async ({ page }) => {
    await setupBaseMocks(page)
    await page.route('/api/score', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SCORE_RESPONSE),
      })
    })

    await page.goto('/workspace')
    await selectPatientAndRun(page)

    // Let everything render
    await expect(page.getByTestId('inspector')).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('rescore-btn')).toBeEnabled()
    await page.getByTestId('rescore-btn').click()
    await expect(page.getByTestId('rescore-result')).toBeVisible({ timeout: 5000 })

    // Verify kappa / κ never appears in any visible text
    await expect(page.locator('body')).not.toContainText('kappa')
    await expect(page.locator('body')).not.toContainText('κ')
  })
})
