/**
 * SHA-173 N18 cutover: `/` now serves the notebook FRONT PAGE (authored at
 * /notebook/start in N6). The product surface is /notebook, reached from here via
 * two co-equal actions ("Open the sandbox" → /notebook, "Load the worked example"
 * → /notebook?example=1). The classic persona front door is retired from `/`, and
 * the legacy workbench surface is GONE (deleted in N19) — `/` links only into the
 * notebook. Fully static: no DB, no model call, so we assert zero API traffic on cold load.
 */
import { test, expect } from '@playwright/test'

test.describe('landing: notebook front page at / (N18 cutover)', () => {
  test('renders the notebook front page without any API calls (static)', async ({ page }) => {
    const apiCalls: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiCalls.push(req.url())
    })
    await page.route('/api/**', async (route) => route.abort())

    await page.goto('/')

    await expect(page.getByTestId('notebook-front-page')).toBeVisible()
    // It is the cutover front page, NOT the retired persona router.
    await expect(page.getByTestId('landing-page')).toHaveCount(0)
    await expect(page.getByTestId('route-workbench')).toHaveCount(0)
    expect(apiCalls).toHaveLength(0)
  })

  test('offers two co-equal actions into the product (sandbox + worked example)', async ({
    page,
  }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    const sandbox = page.getByTestId('action-open-sandbox')
    await expect(sandbox).toBeVisible()
    await expect(sandbox).toHaveAttribute('href', '/notebook')

    const example = page.getByTestId('action-worked-example')
    await expect(example).toBeVisible()
    await expect(example).toHaveAttribute('href', '/notebook?example=1')
  })

  test('says what this is — synthetic data, no real PHI', async ({ page }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    const honesty = page.getByTestId('front-honesty')
    await expect(honesty).toContainText(/synthetic/i)
    await expect(honesty).toContainText(/no real PHI/i)
  })
})
