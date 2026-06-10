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

  test('links quietly to the classic workspace and the worked example', async ({ page }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    await expect(page.getByTestId('workspace-link')).toHaveAttribute('href', '/workspace')
    await expect(page.getByTestId('example-link')).toHaveAttribute('href', '/example')
  })

  test('says what this is — synthetic data, no sign-up', async ({ page }) => {
    await page.route('/api/**', async (route) => route.abort())
    await page.goto('/')

    await expect(page.getByText(/synthetic/i)).toBeVisible()
    await expect(page.getByText(/no sign-up/i)).toBeVisible()
  })

  test('the re-homed workspace still carries the v1 authoring surface', async ({ page }) => {
    await page.route('/api/patients*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ patients: [] }),
      })
    })
    await page.route('/api/run', async (route) => route.abort())

    await page.goto('/workspace')

    await expect(page.getByTestId('example-hero')).toBeVisible()
    await expect(page.getByTestId('golden-set-builder')).toBeVisible()
    // and a quiet way back to the front door
    await expect(page.getByTestId('workspace-home-link')).toHaveAttribute('href', '/')
  })
})
