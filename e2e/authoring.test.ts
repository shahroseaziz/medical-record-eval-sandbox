import { test, expect, type Page } from '@playwright/test'

// The composer's guarded sampler is the only backend touch in the authoring flow.
// We mock it so the e2e is deterministic and DB-free: the guard's correctness is
// covered by the composer unit tests; here we drive the authoring UX end-to-end.

interface MockPatient {
  id: string
  name: string
  sections: string[]
  birthDate: string
}

const POOL: MockPatient[] = [
  { id: 'p1', name: 'Agustin Hills', sections: ['medications', 'allergies', 'problems'], birthDate: '19820314' },
  { id: 'p2', name: 'Benally Yazzie', sections: ['medications', 'problems', 'vitals'], birthDate: '19751101' },
  { id: 'p3', name: 'Carla Reyes', sections: ['allergies', 'problems'], birthDate: '19900722' },
  { id: 'p4', name: 'Dion Park', sections: ['medications', 'results'], birthDate: '20010103' },
  { id: 'p5', name: 'Esther Cohen', sections: ['problems', 'encounters', 'vitals'], birthDate: '19680519' },
]

async function mockSample(page: Page) {
  await page.route(/\/api\/patients\/sample.*/, async (route, request) => {
    const url = new URL(request.url())
    const n = Math.min(20, Math.max(1, parseInt(url.searchParams.get('n') ?? '5', 10)))
    const patients = POOL.slice(0, n).map((p) => {
      const [firstName, lastName] = p.name.split(' ')
      return {
        id: p.id,
        name: p.name,
        summary: {
          demographics: { firstName, lastName, gender: 'F', birthDate: p.birthDate },
          sections: p.sections,
        },
        record: p.sections.map((s) => `[${s}]\n${s} narrative for ${p.name}`).join('\n\n---\n\n'),
        recordTokens: 1200,
      }
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        patients,
        requested: n,
        returned: patients.length,
        shortfall: false,
        budgetTokens: 11500,
      }),
    })
  })
}

async function openComposer(page: Page) {
  await page.goto('/workbench')
  await page.getByTestId('open-the-bench-btn').click()
  await page.getByTestId('add-case-toggle').click()
  await expect(page.getByTestId('case-composer')).toBeVisible()
}

test.describe('case composer — authoring flow (S24)', () => {
  test('"Give me 5 random" yields 5 authorable patient cards (D3 guard, none dead-on-arrival)', async ({
    page,
  }) => {
    await mockSample(page)
    await openComposer(page)

    await page.getByTestId('composer-n-input').fill('5')
    await page.getByTestId('give-me-random-btn').click()

    const cards = page.getByTestId('patient-list').locator('[data-testid^="patient-card-"]')
    await expect(cards).toHaveCount(5)

    // Each card is selectable → its record view opens (an authorable skeleton).
    await page.getByTestId('patient-card-p1').click()
    await expect(page.getByTestId('record-view')).toBeVisible()
    // Clinical dates render via the shared C-CDA formatter (SHA-76), not raw TS.
    await expect(page.getByTestId('record-dob')).toContainText('Mar 14, 1982')
  })

  test('section chips (D7) filter the sampled patients', async ({ page }) => {
    await mockSample(page)
    await openComposer(page)
    await page.getByTestId('give-me-random-btn').click()
    await expect(
      page.getByTestId('patient-list').locator('[data-testid^="patient-card-"]'),
    ).toHaveCount(5)

    // allergies → only p1 and p3 carry an allergies section.
    await page.getByTestId('section-chip-allergies').click()
    await expect(page.getByTestId('patient-card-p1')).toBeVisible()
    await expect(page.getByTestId('patient-card-p3')).toBeVisible()
    await expect(page.getByTestId('patient-card-p2')).toHaveCount(0)

    // Stack medications → only p1 has BOTH allergies and medications.
    await page.getByTestId('section-chip-medications').click()
    await expect(page.getByTestId('patient-card-p1')).toBeVisible()
    await expect(page.getByTestId('patient-card-p3')).toHaveCount(0)
  })

  test('field builder (D10) produces a structured-diff-scoreable expectation', async ({ page }) => {
    await mockSample(page)
    await openComposer(page)
    await page.getByTestId('give-me-random-btn').click()
    await page.getByTestId('patient-card-p1').click()

    await page.getByTestId('composer-query').fill('List active medications as { drug, dose }.')
    await page.getByTestId('expected-kind-structured').click()
    await expect(page.getByTestId('field-builder')).toBeVisible()

    // The derived scorer chip reflects E25: structured → structured-diff.
    await expect(page.getByTestId('derived-scorer')).toContainText('Structured diff')

    // Empty/incomplete rows gate the add; completing drug+dose unlocks it.
    await page.getByTestId('field-add-row').click()
    await expect(page.getByTestId('add-case-btn')).toBeDisabled()
    await page.getByTestId('field-row-0-drug').fill('Lisinopril')
    await page.getByTestId('field-row-0-dose').fill('10mg')

    await expect(page.getByTestId('add-case-btn')).toBeEnabled()
    await page.getByTestId('add-case-btn').click()
    await expect(page.getByTestId('composer-saved')).toContainText('My cases')
    // The cases atom count reflects the authored case.
    await expect(page.getByTestId('cases-panel')).toContainText('authored')
  })

  test('an absence case is authorable as a prose reference (→ reference judge)', async ({
    page,
  }) => {
    await mockSample(page)
    await openComposer(page)
    await page.getByTestId('give-me-random-btn').click()
    await page.getByTestId('patient-card-p1').click()

    await page.getByTestId('composer-query').fill('Are any cardiac procedures documented?')

    // The none mode carries the absence-pattern hint...
    await page.getByTestId('expected-kind-none').click()
    await expect(page.getByTestId('absence-hint')).toBeVisible()
    await expect(page.getByTestId('derived-scorer')).toContainText('Faithfulness')

    // ...and the absence is authorable as a prose reference (reference judge).
    await page.getByTestId('expected-kind-prose').click()
    await page.getByTestId('expected-prose').fill('No cardiac procedures are documented.')
    await expect(page.getByTestId('derived-scorer')).toContainText('Reference judge')

    await expect(page.getByTestId('add-case-btn')).toBeEnabled()
    await page.getByTestId('add-case-btn').click()
    await expect(page.getByTestId('composer-saved')).toContainText('My cases')
  })
})
