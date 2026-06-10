import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LOW_SCORE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream-low-score.txt'), 'utf-8')
const MID_SCORE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream-mid-score.txt'), 'utf-8')

// A designed-pass case that will disagree when judge score is 0.0
const PASS_CASE = {
  id: 'golden-test-001',
  taskPrompt: 'What are the patient allergies?',
  patientId: 'p-test-001',
  ragMode: 'retrieve',
  capturedOutput: 'The patient has penicillin allergy.',
  capturedGrounding: { mode: 'retrieve', chunks: [] },
  referenceOutput: 'The patient has penicillin allergy.',
  intentLabel: 'pass',
  provenance: {
    genPromptHash: 'aabbccdd11223344',
    patientId: 'p-test-001',
    ragMode: 'retrieve',
  },
  createdAt: Date.now() - 1000,
}

// A designed-fail case with mid score (0.5) — used for threshold delta test
const FAIL_CASE_MID = {
  id: 'golden-test-002',
  taskPrompt: 'What medications is this patient on?',
  patientId: 'p-test-002',
  ragMode: 'retrieve',
  capturedOutput: 'The patient takes aspirin.',
  capturedGrounding: { mode: 'retrieve', chunks: [] },
  referenceOutput: undefined,
  intentLabel: 'fail',
  designedFailReason: 'wrong medication listed',
  provenance: {
    genPromptHash: 'aabbccdd11223344',
    patientId: 'p-test-002',
    ragMode: 'retrieve',
  },
  createdAt: Date.now() - 500,
}

const MOCK_PATIENT = {
  id: 'p-test-001',
  name: 'Test Patient',
  summary: {
    demographics: { firstName: 'Test', lastName: 'Patient', gender: 'F', birthDate: '19800101' },
    sections: ['allergies'],
  },
}

async function setupBaseMocks(page: import('@playwright/test').Page, runStream: string) {
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
      body: runStream,
    })
  })
}

test.describe('disagreement table: disagreement highlight', () => {
  test.beforeEach(async ({ page }) => {
    // Seed a designed-pass case — will disagree when judge score is 0.0
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE])

    await setupBaseMocks(page, LOW_SCORE_STREAM)
    await page.goto('/workspace')
  })

  test('disagreement row is highlighted when intentLabel differs from verdict', async ({ page }) => {
    // Find and click the batch eval button
    const batchBtn = page.getByTestId('batch-eval-btn')
    await expect(batchBtn).toBeVisible()
    await expect(batchBtn).toBeEnabled()
    await batchBtn.click()

    // Wait for results — the DisagreementTable should appear
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })

    // The case row should be highlighted (intentLabel='pass', judge verdict=FAIL → disagree)
    const row = page.getByTestId(`disagreement-row-${PASS_CASE.id}`)
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-disagrees', 'true')

    // Intent label shows 'designed-pass'
    await expect(row).toContainText('designed-pass')
    // Judge verdict shows 'FAIL' (score 0.0 < 0.85 threshold)
    await expect(row).toContainText('FAIL')
    // Score shown
    await expect(row).toContainText('0.00')
  })

  test('agreement metric shows n and directional label', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })

    const metric = page.getByTestId('user-agreement-metric')
    await expect(metric).toBeVisible()
    // Shows "Agreement (n=1, directional)" format
    await expect(metric).toContainText('Agreement (n=1, directional)')
    // 0/1 agree (designed-pass but judge FAIL)
    await expect(metric).toContainText('0/1')
  })

  test('calibration note is visible', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('calibration-note')).toBeVisible()
    await expect(page.getByTestId('calibration-note')).toContainText('uncalibrated by construction')
  })
})

test.describe('disagreement table: threshold controls', () => {
  test.beforeEach(async ({ page }) => {
    // Seed a designed-fail case with mid-score (0.5)
    // At threshold=0.85: judge FAIL (0.5 < 0.85) → matches intentLabel='fail' → agree
    // At threshold=0.3: judge PASS (0.5 >= 0.3) → doesn't match intentLabel='fail' → disagree
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [FAIL_CASE_MID])

    await setupBaseMocks(page, MID_SCORE_STREAM)
    await page.goto('/workspace')
  })

  test('threshold-move shows delta text and non-validating warning', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })

    // At default threshold 0.85: no delta, no warning
    await expect(page.getByTestId('threshold-delta')).not.toBeVisible()
    await expect(page.getByTestId('threshold-warning')).not.toBeVisible()

    // Move threshold slider to 0.3 — JS-set the value and fire input event
    const slider = page.getByTestId('threshold-slider')
    await slider.evaluate((el) => {
      const input = el as HTMLInputElement
      input.value = '0.3'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Delta should now appear: "at 0.30: X/N · at 0.85: Y/N"
    await expect(page.getByTestId('threshold-delta')).toBeVisible()
    await expect(page.getByTestId('threshold-delta')).toContainText('at 0.30')
    await expect(page.getByTestId('threshold-delta')).toContainText('at 0.85')

    // Non-validating warning must appear
    await expect(page.getByTestId('threshold-warning')).toBeVisible()
    await expect(page.getByTestId('threshold-warning')).toContainText(
      'Fitting the threshold to your own labels is not validation.',
    )
  })

  test('threshold value updates displayed label', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })

    const slider = page.getByTestId('threshold-slider')
    await slider.evaluate((el) => {
      const input = el as HTMLInputElement
      input.value = '0.60'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await expect(page.getByTestId('threshold-value')).toContainText('0.60')
  })
})

test.describe('disagreement table: no kappa label', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE])

    await setupBaseMocks(page, LOW_SCORE_STREAM)
    await page.goto('/workspace')
  })

  test('kappa and κ never appear in the disagreement table', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })

    // Scope check to the disagreement table only — don't check the full body
    // because the seeded baseline EvalScorecard uses "kappa" in test-id attributes
    // (but not in visible text). We verify the new table has no kappa text.
    const table = page.getByTestId('disagreement-table')
    await expect(table).not.toContainText('kappa')
    await expect(table).not.toContainText('κ')
  })
})

test.describe('disagreement table: zero-claim exclusion', () => {
  test('zero-claim cases excluded from denominator, shown in table', async ({ page }) => {
    const ZERO_CLAIM_STREAM = [
      '2:[{"type":"retrieval","chunks":[],"groundingContext":""}]',
      '0:"No claims."',
      'd:{"finishReason":"stop","usage":{"promptTokens":50,"completionTokens":3}}',
      '2:[{"type":"eval","faithfulness":{"scorer":"faithfulness","score":1.0,"claims":[],"zeroClaimFlag":true,"extractPrompt":"...","verdictPrompt":"..."},"sectionHit":{"scorer":"section-hit","score":null,"requiredSections":[],"retrievedSections":[],"missingSections":[]}}]',
      '2:[{"type":"trace","trace":{"caseId":"zero-claim","ragMode":"retrieve","grounding":"","generationPromptIsUserAuthored":false,"sectionHit":{"scorer":"section-hit","score":null,"requiredSections":[],"retrievedSections":[],"missingSections":[]},"output":"No claims.","scorerResults":[],"generationModel":"claude-haiku-4-5-20251001","judgeModel":"claude-haiku-4-5-20251001","embeddingModel":"voyage-3.5-instruct","inputType":"query","tokens":{"input":50,"output":3,"estCostUsd":0.00001},"claimCount":0,"outputLength":9,"judgeUsesByo":false}}]',
    ].join('\n')

    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE])

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
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-vercel-ai-data-stream': 'v1' },
        body: ZERO_CLAIM_STREAM,
      })
    })

    await page.goto('/workspace')
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 10000 })

    // n=0 (zero-claim excluded), agreement=N/A
    const metric = page.getByTestId('agreement-value')
    await expect(metric).toContainText('N/A')

    // Row shows 'zero-claim' label in verdict column
    const row = page.getByTestId(`disagreement-row-${PASS_CASE.id}`)
    await expect(row).toContainText('zero-claim')

    // Row should NOT be highlighted as a disagreement (excluded cases don't disagree)
    await expect(row).toHaveAttribute('data-disagrees', 'false')
  })
})
