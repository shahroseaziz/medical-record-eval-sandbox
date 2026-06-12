import { test, expect, type Page } from '@playwright/test'

// SHA-76 / O12b-retargeted: patient-facing dates render clinically on the BENCH
// composer (the workspace patient browser retired with /workspace; the composer
// picker is the surviving date surface and consumes the shared C-CDA formatter).
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


test.describe('SHA-76: patient-facing dates render clinically', () => {
  test('composer picker renders human DOBs, never raw timestamps', async ({ page }) => {
    await mockSample(page)
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()
    await page.getByTestId('add-case-toggle').click()
    await expect(page.getByTestId('case-composer')).toBeVisible()
    await page.getByTestId('composer-n-input').fill('3')
    await page.getByTestId('give-me-random-btn').click()
    const list = page.getByTestId('patient-list')
    await expect(list.locator('[data-testid^="patient-card-"]').first()).toBeVisible()
    const text = await list.innerText()
    expect(text).toMatch(/DOB [A-Z][a-z]{2} \d{1,2}, \d{4}/)
    expect(text).not.toMatch(/\d{8,}/)
  })
})
