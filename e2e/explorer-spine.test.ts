import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Explorer spine (N7a/N7b wire-in) — the END-TO-END regression journey for the
 * data-explorer subsystem, driven against the REAL /notebook shell.
 *
 * WHY THIS EXISTS: N7a (drawer + sortable patient table) and N7b (chart detail +
 * Parsed/Raw-XML toggle) shipped as fully-tested components under
 * src/components/explorer/ but were never imported into NotebookShell — the app
 * rendered placeholder stubs while the real drawer/chart sat as orphaned dead code.
 * The per-PR tests passed because they mounted a test-harness shell, not the real
 * notebook. This journey closes that gap by asserting what the USER SEES in the
 * actual route, so a silent un-wiring can never ship green again.
 *
 * No DB / keys needed: every /api/* route the journey touches is mocked with
 * realistic shapes (the run stream reuses the shared fixture). Patient ids are kept
 * consistent across /api/patients/sample, /api/patients?all=1, and the chunks route
 * so the output-card "view chart" → drawer-focus handoff resolves to one patient.
 */

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

// The notebook roster (/api/patients/sample) — one pre-selected patient is enough
// to author a prompt and Run. `summary` carries the chip framing fields.
const SAMPLE = [
  {
    id: 'p1',
    name: 'Espinoza, Marco',
    summary: { age: 58, sex: 'M', conditionCount: 4 },
    record: '[problems]\nType 2 diabetes mellitus\n\n[medications]\nMetformin 500mg twice daily',
    recordTokens: 40,
  },
]

// The full corpus (/api/patients?all=1) — the explorer table. Multiple rows so the
// six-column sort is exercisable; p1 is shared with the roster so a "view chart"
// from an output card resolves into this list.
const CORPUS = [
  { id: 'p1', name: 'Espinoza, Marco', summary: {}, age: 58, sex: 'M', conditionCount: 4, medCount: 6, chartBytes: 48000 },
  { id: 'p2', name: 'Adams, Carol', summary: {}, age: 71, sex: 'F', conditionCount: 7, medCount: 3, chartBytes: 120000 },
  { id: 'p3', name: 'Brown, Alan', summary: {}, age: 33, sex: 'M', conditionCount: 1, medCount: 1, chartBytes: 9000 },
]

// Section-level chunks (/api/patients/[id]/chunks) — both a parsed narrative and a
// non-null source_xml so the Parsed / Raw-XML toggle has something to show.
const CHUNKS = [
  {
    section: 'problems',
    ord: 0,
    text: 'Type 2 diabetes mellitus',
    source_xml: '<section><title>Problems</title><text>Type 2 diabetes mellitus</text></section>',
  },
  {
    section: 'medications',
    ord: 0,
    text: 'Metformin 500mg twice daily',
    source_xml: '<section><title>Medications</title><text>Metformin 500mg twice daily</text></section>',
  },
]

/** Mock every /api/* route the journey touches with realistic shapes. */
async function mockApis(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === '/api/patients/sample') {
      return route.fulfill({
        json: { patients: SAMPLE, requested: 1, returned: SAMPLE.length, shortfall: false },
      })
    }
    if (path === '/api/patients' && url.searchParams.get('all') === '1') {
      return route.fulfill({ json: { patients: CORPUS, count: CORPUS.length } })
    }
    if (/^\/api\/patients\/[^/]+\/chunks$/.test(path)) {
      return route.fulfill({ json: { chunks: CHUNKS } })
    }
    if (path === '/api/run') {
      return route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: FIXTURE_STREAM,
      })
    }
    // Any other API call (e.g. /api/score) is not part of this journey.
    return route.fulfill({ json: {} })
  })
}

test.describe('explorer spine — the wired data drawer (N7a/N7b)', () => {
  test('Explore opens the REAL drawer: sortable 6-column table → chart detail → raw XML → close preserves prompt text', async ({
    page,
  }) => {
    await mockApis(page)

    // Front page (N18 cutover) → into the sandbox.
    await page.goto('/')
    await page.getByTestId('action-open-sandbox').click()
    await expect(page).toHaveURL(/\/notebook$/)

    // Author an in-progress prompt FIRST — it is the state-survival subject below.
    const prompt = page.getByTestId('prompt-input')
    await prompt.fill('Summarize this patient diabetes meds.')

    // The orphaned-component stub is gone, and the real drawer opens.
    await expect(page.getByTestId('data-explorer-stub')).toHaveCount(0)
    const drawer = page.getByTestId('explorer-drawer')
    await expect(drawer).toHaveAttribute('aria-hidden', 'true')
    await page.getByTestId('explore-button').click()
    await expect(drawer).toHaveAttribute('aria-hidden', 'false')

    // The sortable all-patients table: six columns, default name-ascending.
    await expect(drawer.locator('table')).toBeVisible()
    for (const key of ['name', 'age', 'sex', 'conditionCount', 'medCount', 'chartBytes']) {
      await expect(drawer.getByTestId(`sort-${key}`)).toBeVisible()
    }
    await expect(drawer.locator('tbody tr').first()).toContainText('Adams') // name asc

    // Sorting is live: by meds (numeric → descending) Espinoza (6) leads.
    await drawer.getByTestId('sort-medCount').click()
    await expect(drawer.locator('tbody tr').first()).toContainText('Espinoza')

    // Row click → the per-patient chart detail (N7b), parsed narrative first.
    await drawer.getByTestId('patient-row-p1').click()
    await expect(drawer.getByTestId('patient-chart-detail')).toBeVisible()
    await expect(drawer.getByTestId('patient-chart-detail')).toContainText('Espinoza')
    await expect(drawer.getByTestId('section-problems')).toContainText('diabetes')

    // Parsed / Raw-XML toggle shows the section-level source_xml, then back.
    await drawer.getByTestId('view-raw').click()
    await expect(drawer.getByTestId('raw-section-problems')).toContainText('<section>')
    await drawer.getByTestId('view-parsed').click()
    await expect(drawer.getByTestId('section-problems')).toBeVisible()

    // Close — the notebook was a fixed-overlay sibling, never unmounted, so the
    // in-progress prompt text survives the whole open/close cycle.
    await drawer.getByRole('button', { name: 'Close' }).click()
    await expect(drawer).toHaveAttribute('aria-hidden', 'true')
    await expect(prompt).toHaveValue('Summarize this patient diabetes meds.')
  })

  test('an output card "view chart" link opens the drawer onto THAT patient chart', async ({
    page,
  }) => {
    await mockApis(page)
    await page.goto('/notebook')

    // Author + Run against the pre-selected patient → one streamed output card.
    await page.getByTestId('prompt-input').fill('List the medications.')
    await page.getByTestId('run-button').click()

    const card = page.getByTestId('output-card').first()
    await expect(card).toHaveAttribute('data-status', 'done', { timeout: 15000 })

    // "view chart" → the real drawer, focused on this patient's chart detail.
    await card.getByTestId('view-chart').click()
    const drawer = page.getByTestId('explorer-drawer')
    await expect(drawer).toHaveAttribute('aria-hidden', 'false')
    await expect(drawer.getByTestId('patient-chart-detail')).toBeVisible()
    await expect(drawer.getByTestId('patient-chart-detail')).toContainText('Espinoza')
    await expect(drawer.getByTestId('section-medications')).toContainText('Metformin')
  })
})
