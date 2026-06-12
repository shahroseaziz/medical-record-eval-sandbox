import { test, expect } from '@playwright/test'

// O12b/S26: /workspace is retired — permanent redirect to the bench. Legacy
// localStorage cases stay importable via the bench migration banner (D5).
test('the retired /workspace 301s to /workbench', async ({ page }) => {
  const resp = await page.goto('/workspace')
  expect(page.url()).toContain('/workbench')
  expect(resp?.request().redirectedFrom()?.url() ?? '').toContain('/workspace')
})
