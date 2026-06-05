import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

const MOCK_PATIENT = {
  id: 'p-smoke-001',
  name: 'Jane Doe',
  summary: {
    demographics: {
      firstName: 'Jane',
      lastName: 'Doe',
      gender: 'F',
      birthDate: '19820314',
    },
    sections: ['medications', 'problems', 'allergies'],
  },
}

const MOCK_CHUNKS = [
  { section: 'medications', ord: 0, text: 'Lisinopril 10mg daily for hypertension' },
  { section: 'problems', ord: 0, text: 'Hypertension (ICD-10: I10)' },
]

test.describe('smoke: browse → pick → prompt → toggle → run (all APIs mocked)', () => {
  test.beforeEach(async ({ page }) => {
    // Mock /api/patients
    await page.route('/api/patients*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ patients: [MOCK_PATIENT] }),
      })
    })

    // Mock /api/patients/[id]/chunks
    await page.route(/\/api\/patients\/.+\/chunks/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chunks: MOCK_CHUNKS }),
      })
    })

    // Mock /api/run — return fixture stream (no live keys needed)
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

    await page.goto('/')
  })

  test('page loads and shows patient browser', async ({ page }) => {
    await expect(page.getByTestId('get-patients-btn')).toBeVisible()
  })

  test('full flow: browse → pick → prompt → toggle → run', async ({ page }) => {
    // 1. Browse: click "Get N Patients"
    await page.getByTestId('get-patients-btn').click()

    // 2. Patient card appears
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await expect(page.getByText('Jane Doe')).toBeVisible()

    // 3. Pick the patient
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()

    // 4. Selected patient banner appears
    await expect(page.getByTestId('selected-patient')).toContainText('Jane Doe')

    // 5. Fill in a prompt
    await page.getByTestId('prompt-input').fill('What medications is this patient taking?')

    // 6. Verify we're in retrieve mode (default)
    await expect(page.getByTestId('mode-toggle')).toContainText('retrieve')

    // 7. Toggle to stuff mode
    await page.getByTestId('mode-toggle').click()
    await expect(page.getByTestId('mode-toggle')).toContainText('stuff')

    // Stuff mode shows record input
    await expect(page.getByTestId('record-input')).toBeVisible()

    // 8. Toggle back to retrieve mode
    await page.getByTestId('mode-toggle').click()
    await expect(page.getByTestId('mode-toggle')).toContainText('retrieve')

    // 9. Run
    await page.getByTestId('run-btn').click()

    // 10. Output should appear (fixture stream text)
    await expect(page.getByTestId('run-output')).toContainText('Lisinopril', { timeout: 5000 })

    // 11. Eval results should appear
    await expect(page.getByTestId('eval-results')).toBeVisible()
  })

  test('run button is disabled without a patient selected', async ({ page }) => {
    await page.getByTestId('prompt-input').fill('Some query')
    // Run button should be disabled (no patient selected)
    const runBtn = page.getByTestId('run-btn')
    await expect(runBtn).toBeDisabled()
  })

  test('run button is disabled without a query', async ({ page }) => {
    // Browse and pick
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    // No query filled in — run should be disabled
    const runBtn = page.getByTestId('run-btn')
    await expect(runBtn).toBeDisabled()
  })

  test('transform inspector loads chunks on demand', async ({ page }) => {
    // Browse and pick
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()

    // Click Inspect
    await page.getByTestId('inspect-btn').click()

    // Chunks should appear
    await expect(page.getByText('medications')).toBeVisible({ timeout: 3000 })
  })

  test('user case can be saved and appears in the list', async ({ page }) => {
    // Browse and pick
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()

    // Enter a query
    await page.getByTestId('prompt-input').fill('Any known allergies?')

    // Save case
    await page.getByTestId('save-case-btn').click()

    // Should show saved feedback briefly (or saved case in list)
    // Check localStorage via page.evaluate
    const cases = await page.evaluate(() => {
      const raw = localStorage.getItem('user_cases_v1')
      return raw ? (JSON.parse(raw) as unknown[]) : []
    })
    expect(cases).toHaveLength(1)
  })
})

test.describe('golden set builder: capture, label, provenance', () => {
  test.beforeEach(async ({ page }) => {
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
        body: JSON.stringify({ chunks: MOCK_CHUNKS }),
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
    await page.goto('/')
  })

  async function runQuery(page: import('@playwright/test').Page, query = 'What medications?') {
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill(query)
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toContainText('Lisinopril', { timeout: 5000 })
  }

  test('capture panel opens after a run and saves a designed-pass case', async ({ page }) => {
    await runQuery(page)

    // Capture button should be enabled after run
    const captureBtn = page.getByTestId('capture-from-run-btn')
    await expect(captureBtn).toBeEnabled()
    await captureBtn.click()

    // Capture panel appears
    await expect(page.getByTestId('capture-panel')).toBeVisible()

    // Default mode is "promote" — no textarea visible
    await expect(page.getByTestId('reference-output-input')).not.toBeVisible()

    // Switch to "edit" mode — textarea pre-filled with model output
    await page.getByTestId('capture-mode-edit').click()
    const refOutput = page.getByTestId('reference-output-input')
    await expect(refOutput).toBeVisible()
    await expect(refOutput).toContainText('Lisinopril')

    // Edit the output
    await refOutput.fill('Lisinopril 10mg daily.')

    // Guided path: first case defaults to 'fail' (trap-first guidance).
    // Explicitly switch to designed-pass to test saving a pass case.
    await page.getByTestId('intent-label-pass').click()
    await expect(page.getByTestId('intent-label-pass')).toBeChecked()

    // Save
    await page.getByTestId('save-capture-btn').click()
    await expect(page.getByTestId('capture-panel')).not.toBeVisible()

    // Case appears in list with designed-pass badge
    const cases = await page.evaluate(() => {
      const raw = localStorage.getItem('user_cases_v2')
      return raw ? (JSON.parse(raw) as unknown[]) : []
    })
    expect(cases).toHaveLength(1)
    const savedCase = cases[0] as Record<string, unknown>
    expect(savedCase.intentLabel).toBe('pass')
    expect(savedCase.referenceOutput).toBe('Lisinopril 10mg daily.')
    expect(savedCase.capturedOutput).toContain('Lisinopril')

    // Intent badge visible in list
    await expect(page.getByText('designed-pass')).toBeVisible()
  })

  test('designed-fail with completeness reason shows out-of-scope warning', async ({ page }) => {
    await runQuery(page)

    await page.getByTestId('capture-from-run-btn').click()
    await expect(page.getByTestId('capture-panel')).toBeVisible()

    // Select designed-fail
    await page.getByTestId('intent-label-fail').click()
    await expect(page.getByTestId('fail-reason-input')).toBeVisible()

    // Enter a non-completeness reason — no warning
    await page.getByTestId('fail-reason-input').fill('wrong section retrieved')
    await expect(page.getByTestId('out-of-scope-warning')).not.toBeVisible()

    // Clear and enter a completeness reason — warning fires
    await page.getByTestId('fail-reason-input').fill('missing completeness of medication list')
    await expect(page.getByTestId('out-of-scope-warning')).toBeVisible()
    await expect(page.getByTestId('out-of-scope-warning')).toContainText(
      'completeness or style concern',
    )

    // Style reason also triggers warning
    await page.getByTestId('fail-reason-input').fill('output style is too verbose')
    await expect(page.getByTestId('out-of-scope-warning')).toBeVisible()
  })

  test('scratch mode lets user write reference from scratch', async ({ page }) => {
    await runQuery(page)

    await page.getByTestId('capture-from-run-btn').click()
    await page.getByTestId('capture-mode-scratch').click()

    const refOutput = page.getByTestId('reference-output-input')
    await expect(refOutput).toBeVisible()
    await expect(refOutput).toHaveValue('')

    await refOutput.fill('The patient is on Lisinopril 10mg for hypertension (ICD-10 I10).')
    await page.getByTestId('save-capture-btn').click()

    const cases = await page.evaluate(() => {
      const raw = localStorage.getItem('user_cases_v2')
      return raw ? (JSON.parse(raw) as unknown[]) : []
    })
    expect(cases).toHaveLength(1)
    const savedCase = cases[0] as Record<string, unknown>
    expect(savedCase.referenceOutput).toContain('ICD-10 I10')
    // capturedOutput is always the verbatim model output, not the edited reference
    expect(savedCase.capturedOutput).toContain('Lisinopril')
  })

  test('provenance is rendered per case', async ({ page }) => {
    await runQuery(page)
    await page.getByTestId('capture-from-run-btn').click()
    await page.getByTestId('save-capture-btn').click()

    // Wait for case to appear — find provenance element
    const cases = await page.evaluate(() => {
      const raw = localStorage.getItem('user_cases_v2')
      return raw ? (JSON.parse(raw) as unknown[]) : []
    })
    expect(cases).toHaveLength(1)
    const uc = cases[0] as Record<string, unknown>
    const caseId = uc.id as string

    const provEl = page.getByTestId(`provenance-${caseId}`)
    await expect(provEl).toBeVisible()
    await expect(provEl).toContainText('mode:retrieve')
    await expect(provEl).toContainText('hash:')
  })

  test('STALE flag appears when gen prompt changes after capture', async ({ page }) => {
    // Browse and select a patient, fill the prompt
    await page.getByTestId('get-patients-btn').click()
    await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
    await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
    await page.getByTestId('prompt-input').fill('What medications?')

    // Set the gen prompt BEFORE running so the run captures the right hash
    await page.locator('details:has(textarea[data-testid="gen-prompt-input"])').click()
    await page.getByTestId('gen-prompt-input').fill('You are a medical assistant v1.')

    // Run — provenance will hash the gen prompt active at this moment (v1)
    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toContainText('Lisinopril', { timeout: 5000 })

    // Capture a case (provenance records hash of v1)
    await page.getByTestId('capture-from-run-btn').click()
    await page.getByTestId('save-capture-btn').click()

    // Find the saved case ID
    const cases = await page.evaluate(() => {
      const raw = localStorage.getItem('user_cases_v2')
      return raw ? (JSON.parse(raw) as unknown[]) : []
    })
    expect(cases).toHaveLength(1)
    const caseId = (cases[0] as Record<string, unknown>).id as string

    // No STALE flag yet — gen prompt matches
    await expect(page.getByTestId(`stale-flag-${caseId}`)).not.toBeVisible()

    // Change the gen prompt
    await page.getByTestId('gen-prompt-input').fill('You are a medical assistant v2 — different.')

    // STALE flag should now appear
    await expect(page.getByTestId(`stale-flag-${caseId}`)).toBeVisible()
    await expect(page.getByTestId(`stale-flag-${caseId}`)).toContainText('STALE')
  })
})
