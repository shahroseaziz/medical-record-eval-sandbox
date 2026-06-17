import { test, expect } from '@playwright/test'

// N15c — the 1×1 IDENTITY TEST, verified OBSERVABLY (by pixels, not by arithmetic
// over injected data). N15a promised the 1×1 score state stays the pixel-identical
// N11 trail when the grid landed; this pins that promise to a committed screenshot.
//
// The committed baseline (`score-identity.test.ts-snapshots/...`) IS the N11
// score-line look. The fixture (`/notebook/score-fixture`) renders the real
// `ScoreLine` at the 1×1 cardinality with a fixed cube — no model call, fully
// deterministic. If any change perturbs the 1×1 path (e.g. routes it through the
// grid), the live render diverges from the baseline and this diff fails.

test.describe('1×1 score identity (N15c)', () => {
  test('the 1×1 state is pixel-identical to the committed N11 score-line snapshot', async ({
    page,
  }) => {
    await page.goto('/notebook/score-fixture')

    const score = page.getByTestId('section-score')
    await expect(score).toBeVisible()
    // It is the unchanged 1×1 trail — never the grid.
    await expect(page.getByTestId('score-trail')).toBeVisible()
    await expect(page.getByTestId('score-grid')).toHaveCount(0)

    // Observable identity: diff the rendered 1×1 score area against the committed
    // baseline. Clipped to the score section so surrounding chrome cannot drift it.
    await expect(score).toHaveScreenshot('score-line-1x1.png')
  })
})
