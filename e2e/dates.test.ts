import { test, expect } from '@playwright/test'

/**
 * SHA-76 — DOB / record-viewer date craft.
 *
 * Guards that every patient-facing date on the record-viewer surface renders
 * through the shared C-CDA date formatter, so a raw HL7 v3 timestamp
 * (`YYYYMMDDHHMMSS`) can never leak into the UI. The mock patient carries a
 * full-precision birth TS (with a time component) to prove the time is dropped
 * and the date renders clinically.
 */

const MOCK_PATIENT = {
  id: 'p-dates-001',
  name: 'Dorothy Vance',
  summary: {
    demographics: {
      firstName: 'Dorothy',
      lastName: 'Vance',
      // Full HL7 v3 TS: date + time. Must render as "Mar 14, 1982".
      birthDate: '19820314120000',
      gender: 'F',
    },
    sections: ['encounters', 'problems', 'medications'],
  },
}

test.describe('SHA-76: patient-facing dates render clinically', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('/api/patients*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ patients: [MOCK_PATIENT] }),
      })
    })
    await page.goto('/workspace')
  })

  test('DOB renders as a human date, never a raw timestamp', async ({ page }) => {
    await page.getByTestId('get-patients-btn').click()

    const card = page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)
    await expect(card).toBeVisible()

    // The clinical, human-readable form is shown…
    await expect(card).toContainText('DOB: Mar 14, 1982')

    // …and the raw TS string is nowhere on the surface.
    await expect(card).not.toContainText('19820314')
  })

  test('no raw YYYYMMDD(HHMMSS) timestamp renders on the record-viewer card', async ({ page }) => {
    await page.getByTestId('get-patients-btn').click()
    const card = page.getByTestId(`patient-card-${MOCK_PATIENT.id}`)
    await expect(card).toBeVisible()

    // Scan the card's rendered text for an 8+ digit run (a raw HL7 TS). The
    // shared formatter guarantees none survives to the DOM.
    const cardText = await card.innerText()
    expect(cardText).not.toMatch(/\d{8,}/)
  })
})
