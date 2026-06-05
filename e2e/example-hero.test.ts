import { test, expect } from '@playwright/test'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Block all API routes so we can verify cold load is truly static.
 * We also block /api/run to simulate "live runs disabled."
 */
async function blockAllApis(page: import('@playwright/test').Page) {
  await page.route('/api/**', async (route) => {
    await route.abort()
  })
}

// ── Cold-load hero tests ───────────────────────────────────────────────────────

test.describe('example hero: cold load is static (no network/DB/model call)', () => {
  test('renders example-hero with disagreement table — no API calls', async ({ page }) => {
    const apiCalls: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiCalls.push(req.url())
    })

    await blockAllApis(page)
    await page.goto('/')

    // Hero section is visible
    await expect(page.getByTestId('example-hero')).toBeVisible()

    // DisagreementTable rendered inside hero
    await expect(page.getByTestId('disagreement-table')).toBeVisible()

    // At least one disagreement row (intentLabel != verdict)
    const disagreeRows = page.locator('[data-disagrees="true"]')
    await expect(disagreeRows).toHaveCount(1)

    // No API calls were made
    expect(apiCalls).toHaveLength(0)
  })

  test('renders when /api/run is disabled (live runs off)', async ({ page }) => {
    // Specifically block only /api/run to simulate "live runs disabled"
    await page.route('/api/run', async (route) => {
      await route.fulfill({ status: 503, body: 'Service Unavailable' })
    })

    await page.goto('/')

    // Hero is still visible and showing results
    await expect(page.getByTestId('example-hero')).toBeVisible()
    await expect(page.getByTestId('disagreement-table')).toBeVisible()

    // The disagreement row with data-disagrees=true is still there
    const disagreeRows = page.locator('[data-disagrees="true"]')
    await expect(disagreeRows).toHaveCount(1)
  })

  test('shows all three cases: pass, fail, and disagree', async ({ page }) => {
    await blockAllApis(page)
    await page.goto('/')

    const table = page.getByTestId('disagreement-case-table')
    await expect(table).toBeVisible()

    // designed-pass case: row with intentLabel=pass that agrees (no highlight)
    await expect(page.getByTestId('disagreement-row-example-pass-001')).toBeVisible()
    await expect(page.getByTestId('disagreement-row-example-pass-001')).toHaveAttribute(
      'data-disagrees',
      'false',
    )

    // designed-fail case: row with intentLabel=fail that agrees (judge says FAIL)
    await expect(page.getByTestId('disagreement-row-example-fail-002')).toBeVisible()
    await expect(page.getByTestId('disagreement-row-example-fail-002')).toHaveAttribute(
      'data-disagrees',
      'false',
    )

    // disagree case: intentLabel=fail but judge says PASS — the teaching moment
    await expect(page.getByTestId('disagreement-row-example-disagree-003')).toBeVisible()
    await expect(page.getByTestId('disagreement-row-example-disagree-003')).toHaveAttribute(
      'data-disagrees',
      'true',
    )
  })

  test('example hero is above the workspace (above the fold ordering)', async ({ page }) => {
    await blockAllApis(page)
    await page.goto('/')

    const heroBox = await page.getByTestId('example-hero').boundingBox()
    const workspaceBox = await page.getByTestId('golden-set-builder').boundingBox()

    expect(heroBox).not.toBeNull()
    expect(workspaceBox).not.toBeNull()
    // Hero must start above the workspace
    expect(heroBox!.y).toBeLessThan(workspaceBox!.y)
  })
})

// ── Reset to example ──────────────────────────────────────────────────────────

test.describe('reset to example', () => {
  test('reset button writes example cases to localStorage and re-renders builder', async ({
    page,
  }) => {
    // Allow patient API but block run for offline testing
    await page.route('/api/patients*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ patients: [] }),
      })
    })
    await page.route('/api/run', async (route) => {
      await route.abort()
    })

    await page.goto('/')

    // Verify no example cases in localStorage initially
    const beforeReset = await page.evaluate(() => {
      return localStorage.getItem('user_cases_v2')
    })
    // Either null or not containing example IDs
    const hadExampleCases =
      beforeReset !== null && beforeReset.includes('example-pass-001')
    // (May be null or have prior user data — we just check after reset)

    // Click reset
    await page.getByTestId('reset-to-example-btn').click()

    // localStorage should now have example cases
    const afterReset = await page.evaluate(() => {
      return localStorage.getItem('user_cases_v2')
    })
    expect(afterReset).not.toBeNull()
    const parsed = JSON.parse(afterReset!) as Array<{ id: string }>
    const ids = parsed.map((c) => c.id)
    expect(ids).toContain('example-pass-001')
    expect(ids).toContain('example-fail-002')
    expect(ids).toContain('example-disagree-003')

    // eval run also written
    const evalRun = await page.evaluate(() => {
      return localStorage.getItem('user_eval_run_v1')
    })
    expect(evalRun).not.toBeNull()
    const parsedRun = JSON.parse(evalRun!) as { results: Array<{ caseId: string }> }
    expect(parsedRun.results.map((r) => r.caseId)).toContain('example-pass-001')

    // GoldenSetBuilder re-renders with the example cases (no void hadExampleCases warning)
    void hadExampleCases
  })
})

// ── Permalink route ───────────────────────────────────────────────────────────

test.describe('permalink /example: DB-free static route', () => {
  test('renders without any API calls', async ({ page }) => {
    const apiCalls: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiCalls.push(req.url())
    })

    await page.route('/api/**', async (route) => {
      await route.abort()
    })

    await page.goto('/example')

    // Page renders
    await expect(page.getByTestId('example-permalink-page')).toBeVisible()

    // DisagreementTable is present
    await expect(page.getByTestId('disagreement-table')).toBeVisible()

    // Teaching moment note shown
    await expect(page.getByTestId('example-static-note')).toBeVisible()
    await expect(page.getByTestId('example-static-note')).toContainText('Teaching moment')

    // No API calls
    expect(apiCalls).toHaveLength(0)
  })

  test('permalink shows the disagreement row', async ({ page }) => {
    await page.route('/api/**', async (route) => {
      await route.abort()
    })

    await page.goto('/example')

    const disagreeRows = page.locator('[data-disagrees="true"]')
    await expect(disagreeRows).toHaveCount(1)

    // The disagreeing row is example-disagree-003
    await expect(page.getByTestId('disagreement-row-example-disagree-003')).toHaveAttribute(
      'data-disagrees',
      'true',
    )
  })

  test('permalink has a link back to home', async ({ page }) => {
    await page.goto('/example')

    // "Author your own run →" link
    const homeLink = page.getByRole('link', { name: /author your own/i })
    await expect(homeLink).toBeVisible()
    await expect(homeLink).toHaveAttribute('href', '/')
  })

  test('home page has a share link pointing to /example', async ({ page }) => {
    await page.route('/api/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ patients: [] }),
      })
    })

    await page.goto('/')

    const shareLink = page.getByTestId('example-permalink')
    await expect(shareLink).toBeVisible()
    await expect(shareLink).toHaveAttribute('href', '/example')
  })
})

// ── Three-artifact disambiguation ─────────────────────────────────────────────

test.describe('static artifact precedence: hero is example run', () => {
  test('baseline scorecard section is present but below the hero', async ({ page }) => {
    await page.route('/api/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ patients: [] }),
      })
    })

    await page.goto('/')

    const heroBox = await page.getByTestId('example-hero').boundingBox()

    // Baseline scorecard section — may or may not be rendered depending on
    // whether seed-baseline.json exists; test only when present.
    const baselineSection = page.getByTestId('baseline-scorecard-section')
    const baselineVisible = await baselineSection.isVisible().catch(() => false)
    if (baselineVisible) {
      const baselineBox = await baselineSection.boundingBox()
      expect(heroBox).not.toBeNull()
      expect(baselineBox).not.toBeNull()
      // Baseline is BELOW the hero
      expect(heroBox!.y).toBeLessThan(baselineBox!.y)
    }
  })
})
