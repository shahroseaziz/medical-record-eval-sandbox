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

  test('permalink links to the workspace to author your own run', async ({ page }) => {
    await page.goto('/example')

    // "Author your own run →" link — authoring lives on the bench (O12b retirement)
    const homeLink = page.getByRole('link', { name: /author your own/i })
    await expect(homeLink).toBeVisible()
    await expect(homeLink).toHaveAttribute('href', '/workbench')
  })

  })

// ── Three-artifact disambiguation ─────────────────────────────────────────────

test.describe('static artifact precedence: hero is example run', () => {
  })
