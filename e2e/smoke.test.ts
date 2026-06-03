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
