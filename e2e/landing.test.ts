/**
 * SHA-73 R17: the landing front door. `/` routes by persona — "Learn evals"
 * (primary → /lesson) and "Open the workbench" (→ /workbench) — with a quiet
 * link to the re-homed classic workspace (/workspace). Fully static: no DB, no
 * model call, so we assert zero API traffic on cold load.
 */
import { test, expect } from '@playwright/test'

test.describe('landing: persona router at /', () => {
  test('renders without any API calls (static front door)', async ({ page }) => {
    const apiCalls: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiCalls.push(req.url())
    })
    await page.route('/api/**', async (route) => route.abort())

    await page.goto('/')

    await expect(page.getByTestId('landing-page')).toBeVisible()
    // It is NOT the old workspace — the authoring surface no longer lives here.
    await expect(page.getByTestId('golden-set-builder')).toHaveCount(0)
    expect(apiCalls).toHaveLength(0)
  })

  test('offers the two persona routes with the right destinations', async ({ page }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    const lesson = page.getByTestId('route-lesson')
    await expect(lesson).toBeVisible()
    await expect(lesson).toHaveAttribute('href', '/lesson')
    await expect(lesson).toContainText(/learn evals/i)

    const workbench = page.getByTestId('route-workbench')
    await expect(workbench).toBeVisible()
    await expect(workbench).toHaveAttribute('href', '/workbench')
    await expect(workbench).toContainText(/workbench/i)
  })

  test('links quietly to the worked example; the classic workspace is retired (O12b)', async ({ page }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    await expect(page.getByTestId('example-link')).toHaveAttribute('href', '/example')
    await expect(page.getByTestId('workspace-link')).toHaveCount(0)
  })

  test('says what this is — synthetic data, no sign-up', async ({ page }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    // "synthetic" appears in both the lede and the chip — target the chip claim
    // specifically (strict-mode: getByText(/synthetic/i) matches both).
    await expect(page.getByText(/Synthetic records only/)).toBeVisible()
    await expect(page.getByText(/no sign-up/i)).toBeVisible()
  })

  test('the retired /workspace lands on the bench (O12b)', async ({ page }) => {
    await page.goto('/workspace')
    expect(page.url()).toContain('/workbench')

  })
})
