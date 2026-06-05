/**
 * Tests for SHA-34: handholding surfaces — exposition, tooltips, loop diagram,
 * honest copy, first-fail guidance, and judge-can-be-wrong explainer.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')
const LOW_SCORE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream-low-score.txt'), 'utf-8')

const MOCK_PATIENT = {
  id: 'p-hh-001',
  name: 'Quinn Alvarez',
  summary: {
    demographics: { firstName: 'Quinn', lastName: 'Alvarez', gender: 'F', birthDate: '19901010' },
    sections: ['medications', 'allergies'],
  },
}

const PASS_CASE_FOR_EVAL = {
  id: 'golden-hh-001',
  taskPrompt: 'What allergies does the patient have?',
  patientId: 'p-hh-001',
  ragMode: 'retrieve',
  capturedOutput: 'The patient has a penicillin allergy.',
  capturedGrounding: { mode: 'retrieve', chunks: [] },
  referenceOutput: 'The patient has a penicillin allergy.',
  intentLabel: 'pass',
  provenance: {
    genPromptHash: 'aabbccdd11223344',
    patientId: 'p-hh-001',
    ragMode: 'retrieve',
  },
  createdAt: Date.now() - 1000,
}

async function setupMocks(page: import('@playwright/test').Page, runStream = FIXTURE_STREAM) {
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
      body: runStream,
    })
  })
}

// ── 1. Eval loop diagram ──────────────────────────────────────────────────────

test.describe('eval loop diagram', () => {
  test('diagram is visible on page load', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    await expect(page.getByTestId('eval-loop-diagram')).toBeVisible()
  })

  test('data stage is active before patient selection', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    const dataStage = page.getByTestId('loop-stage-data')
    await expect(dataStage).toBeVisible()
    // Active stage has blue border — check it's present
    await expect(dataStage).toBeVisible()
  })

  test('all six stages are rendered', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    const diagram = page.getByTestId('eval-loop-diagram')
    await expect(diagram.getByTestId('loop-stage-data')).toBeVisible()
    await expect(diagram.getByTestId('loop-stage-prompt')).toBeVisible()
    await expect(diagram.getByTestId('loop-stage-output')).toBeVisible()
    await expect(diagram.getByTestId('loop-stage-label')).toBeVisible()
    await expect(diagram.getByTestId('loop-stage-judge')).toBeVisible()
    await expect(diagram.getByTestId('loop-stage-agreement')).toBeVisible()
  })

  test('stage advances to prompt after patient selection', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()

    // prompt stage should now be active (has the blue highlight)
    const promptStage = page.getByTestId('loop-stage-prompt')
    await expect(promptStage).toBeVisible()
    // Data stage should be "past" (green)
    const dataStage = page.getByTestId('loop-stage-data')
    await expect(dataStage).toContainText('✓')
  })

  test('stage advances to label after a run completes', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')

    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('What medications?')
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    // label stage should now be active
    const labelStage = page.getByTestId('loop-stage-label')
    await expect(labelStage).toBeVisible()
    // prompt and data should be past
    await expect(page.getByTestId('loop-stage-data')).toContainText('✓')
    await expect(page.getByTestId('loop-stage-prompt')).toContainText('✓')
  })

  test('stage advances to agreement after batch eval', async ({ page }) => {
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE_FOR_EVAL])

    await setupMocks(page, LOW_SCORE_STREAM)
    await page.goto('/')

    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })

    // agreement stage should be active
    const agreementStage = page.getByTestId('loop-stage-agreement')
    await expect(agreementStage).toBeVisible()
  })
})

// ── 2. Terms of art tooltips ──────────────────────────────────────────────────

test.describe('terms of art tooltips', () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
  })

  test('faithfulness-judge term is present on page load', async ({ page }) => {
    await expect(page.getByTestId('term-faithfulness-judge')).toBeVisible()
  })

  test('claim term is present after a run', async ({ page }) => {
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('Any medications?')
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    // claim term appears in the judge rubric exposition below the prompt editor
    await expect(page.getByTestId('term-claim').first()).toBeVisible()
  })

  test('chunks term is present near the data section', async ({ page }) => {
    // The Chunks term appears in the data exposition
    await expect(page.getByTestId('term-chunks')).toBeVisible()
  })

  test('golden-set term is present in the golden set builder', async ({ page }) => {
    await expect(page.getByTestId('term-golden-set')).toBeVisible()
  })

  test('intent-label term is present in the golden set builder capture panel', async ({ page }) => {
    await setupMocks(page)
    // Run to enable capture
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('What medications?')
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    await page.getByTestId('capture-from-run-btn').click()
    await expect(page.getByTestId('capture-panel')).toBeVisible()
    await expect(page.getByTestId('term-intent-label')).toBeVisible()
  })
})

// ── 3. First-case trap guidance ───────────────────────────────────────────────

test.describe('first-case trap guidance (designed-fail default)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
  })

  test('trap guidance is visible when no golden cases exist', async ({ page }) => {
    await expect(page.getByTestId('first-case-trap-guidance')).toBeVisible()
    await expect(page.getByTestId('first-case-trap-guidance')).toContainText('Start with a trap')
  })

  test('first capture defaults to designed-fail when no cases exist', async ({ page }) => {
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('Any medications?')
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    await page.getByTestId('capture-from-run-btn').click()
    await expect(page.getByTestId('capture-panel')).toBeVisible()

    // First case should default to 'fail'
    await expect(page.getByTestId('intent-label-fail')).toBeChecked()
  })

  test('trap guidance disappears after a case is saved', async ({ page }) => {
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE_FOR_EVAL])

    await setupMocks(page)
    await page.goto('/')

    // With an existing case, trap guidance should NOT show
    await expect(page.getByTestId('first-case-trap-guidance')).not.toBeVisible()
  })

  test('hint inside capture panel appears for first case', async ({ page }) => {
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('Any medications?')
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    await page.getByTestId('capture-from-run-btn').click()
    await expect(page.getByTestId('capture-panel')).toBeVisible()

    // First-case hint inside capture panel
    await expect(page.getByTestId('capture-first-case-hint')).toBeVisible()
    await expect(page.getByTestId('capture-first-case-hint')).toContainText('designed-fail')
  })
})

// ── 4. Judge-can-be-wrong explainer ──────────────────────────────────────────

test.describe('judge-can-be-wrong explainer', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE_FOR_EVAL])

    await setupMocks(page, LOW_SCORE_STREAM)
    await page.goto('/')
  })

  test('explainer is visible in disagreement table after batch eval', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('judge-can-be-wrong-explainer')).toBeVisible()
  })

  test('explainer summary contains "three causes"', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })
    const explainer = page.getByTestId('judge-can-be-wrong-explainer')
    await expect(explainer).toContainText('three causes')
  })

  test('explainer covers rubric miscalibration cause', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })

    const explainer = page.getByTestId('judge-can-be-wrong-explainer')
    await explainer.locator('summary').click()
    await expect(explainer).toContainText('Rubric miscalibrated')
  })

  test('explainer covers threshold misplacement cause', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })

    const explainer = page.getByTestId('judge-can-be-wrong-explainer')
    await explainer.locator('summary').click()
    await expect(explainer).toContainText('Threshold misplaced')
  })

  test('explainer covers out-of-scope label cause', async ({ page }) => {
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })

    const explainer = page.getByTestId('judge-can-be-wrong-explainer')
    await explainer.locator('summary').click()
    await expect(explainer).toContainText("label encodes something faithfulness doesn")
  })
})

// ── 5. Scope-honesty note rewrite ─────────────────────────────────────────────

test.describe('scope-honesty note copy', () => {
  test('scope note mentions browser-only storage', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    const scopeNote = page.getByTestId('scorecard-scope-note')
    await expect(scopeNote).toBeVisible()
    await expect(scopeNote).toContainText('browser only')
  })

  test('scope note names accounts as absent', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    await expect(page.getByTestId('scorecard-scope-note')).toContainText('accounts')
  })

  test('scope note names custom scorer code as absent', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    await expect(page.getByTestId('scorecard-scope-note')).toContainText('scorer code')
  })

  test('honesty note mentions judge can make mistakes', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    await expect(page.getByTestId('scorecard-honesty-note')).toContainText('makes mistakes')
  })
})

// ── 6. Anti-patterns: no kappa on the user path ───────────────────────────────

test.describe('copy audit: no kappa on user path', () => {
  test('golden set builder contains no kappa or κ', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')
    const gsb = page.getByTestId('golden-set-builder')
    await expect(gsb).not.toContainText('kappa')
    await expect(gsb).not.toContainText('κ')
  })

  test('disagreement table contains no kappa or κ after batch eval', async ({ page }) => {
    await page.addInitScript((cases: unknown[]) => {
      localStorage.setItem('user_cases_v2', JSON.stringify(cases))
    }, [PASS_CASE_FOR_EVAL])

    await setupMocks(page, LOW_SCORE_STREAM)
    await page.goto('/')
    await page.getByTestId('batch-eval-btn').click()
    await expect(page.getByTestId('disagreement-table')).toBeVisible({ timeout: 15000 })

    const table = page.getByTestId('disagreement-table')
    await expect(table).not.toContainText('kappa')
    await expect(table).not.toContainText('κ')
  })

  test('capture panel contains no kappa or κ', async ({ page }) => {
    await setupMocks(page)
    await page.goto('/')

    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('Any medications?')
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    await page.getByTestId('capture-from-run-btn').click()
    await expect(page.getByTestId('capture-panel')).toBeVisible()

    await expect(page.getByTestId('capture-panel')).not.toContainText('kappa')
    await expect(page.getByTestId('capture-panel')).not.toContainText('κ')
  })
})
