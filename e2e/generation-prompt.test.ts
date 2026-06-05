import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

const DEFAULT_GENERATION_PROMPT =
  'You are a medical record analyst. Answer the question based ONLY on the provided medical record context. Do not use outside knowledge or make assumptions beyond what is stated.'

const MOCK_PATIENT = {
  id: 'p-gpe-001',
  name: 'Alex Smith',
  summary: {
    demographics: {
      firstName: 'Alex',
      lastName: 'Smith',
      gender: 'M',
      birthDate: '19750601',
    },
    sections: ['medications', 'problems'],
  },
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

async function selectPatientAndFillQuery(page: Page) {
  await page.getByTestId('get-patients-btn').click()
  await expect(page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeVisible()
  await page.getByTestId(`patient-card-${MOCK_PATIENT.id}`).click()
  await page.getByTestId('prompt-input').fill('What medications is this patient taking?')
}

test.describe('generation prompt editor', () => {
  test('warning is visible on page load', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/')
    await expect(page.getByTestId('generation-prompt-warning')).toBeVisible()
    await expect(page.getByTestId('generation-prompt-warning')).toContainText('real patient data')
  })

  test('pre-filled with the example default prompt', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/')
    await expect(page.getByTestId('generation-prompt-input')).toHaveValue(DEFAULT_GENERATION_PROMPT)
  })

  test('reset restores default after editing', async ({ page }) => {
    await setupBaseMocks(page)
    await page.goto('/')

    const customPrompt = 'You are a custom assistant. Use only what is provided.'
    await page.getByTestId('generation-prompt-input').fill(customPrompt)
    await expect(page.getByTestId('generation-prompt-input')).toHaveValue(customPrompt)

    await page.getByTestId('reset-generation-prompt-btn').click()
    await expect(page.getByTestId('generation-prompt-input')).toHaveValue(DEFAULT_GENERATION_PROMPT)
  })

  test('edit → run includes the custom prompt in the request body', async ({ page }) => {
    let capturedBody: Record<string, unknown> | null = null

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
      capturedBody = route.request().postDataJSON() as Record<string, unknown>
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
    await selectPatientAndFillQuery(page)

    const customPrompt = 'You are a clinical assistant. Only cite the provided context.'
    await page.getByTestId('generation-prompt-input').fill(customPrompt)

    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    expect(capturedBody).not.toBeNull()
    expect((capturedBody as Record<string, unknown> | null)?.generationPrompt).toBe(customPrompt)
  })

  test('reset → run omits generationPrompt from the request body', async ({ page }) => {
    let capturedBody: Record<string, unknown> | null = null

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
      capturedBody = route.request().postDataJSON() as Record<string, unknown>
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
    await selectPatientAndFillQuery(page)

    // Edit then reset
    await page.getByTestId('generation-prompt-input').fill('Temporary custom prompt')
    await page.getByTestId('reset-generation-prompt-btn').click()
    await expect(page.getByTestId('generation-prompt-input')).toHaveValue(DEFAULT_GENERATION_PROMPT)

    await page.getByTestId('run-btn').click()
    await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 5000 })

    expect((capturedBody as Record<string, unknown> | null)?.generationPrompt).toBeUndefined()
  })
})
