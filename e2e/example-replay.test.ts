import { test, expect } from '@playwright/test'

// N13b — the `?example=1` worked-example replay. The load-bearing acceptance is the
// ZERO-METERED-CALL contract: replaying the worked example must never hit a metered
// model endpoint (/api/run or /api/score), whether or not the committed artifact has
// landed. (The committed artifact is a maintainer-owned fixture; until it lands the
// surface shows the honest "not published yet" state — still zero metered calls.)

const METERED = ['/api/run', '/api/score']

function isMetered(url: string): boolean {
  return METERED.some((p) => url.includes(p))
}

test.describe('worked-example replay (?example=1)', () => {
  test('replays with ZERO metered model calls', async ({ page }) => {
    const meteredCalls: string[] = []
    page.on('request', (req) => {
      if (isMetered(req.url())) meteredCalls.push(req.url())
    })

    await page.goto('/notebook?example=1')

    // Either the full replay (artifact committed) or the honest unavailable state.
    const replay = page.getByTestId('worked-example-replay')
    const unavailable = page.getByTestId('example-unavailable')
    await expect(replay.or(unavailable)).toBeVisible()

    // When the artifact is present, BOTH legs must render fully.
    if (await replay.isVisible()) {
      await expect(page.getByTestId('example-golden-leg')).toBeVisible()
      await expect(page.getByTestId('example-judge-eval')).toBeVisible()
      // The judge leg replays recorded verdicts — at least one settled or errored row.
      await expect(
        page.getByTestId('judge-verdict').or(page.getByTestId('judge-verdict-errored')).first(),
      ).toBeVisible()
    }

    // The headline contract: nothing metered was spent to replay.
    expect(meteredCalls).toEqual([])
  })

  test('the "Load the worked example" on-ramp is present on a fresh notebook', async ({ page }) => {
    await page.goto('/notebook')
    // The empty-state affordance offering the worked example, before any real run.
    await expect(page.getByTestId('load-example')).toBeVisible()
  })
})
