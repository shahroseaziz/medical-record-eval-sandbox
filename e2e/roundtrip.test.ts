import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O7b / S22 / E27 / E28b — the round-trip e2e, the spine gate.
//
// author → generate → score → edit prompt → regenerate → re-score, asserting the
// bench scores FRESH outputs (runs.current.outputs) on every pass — there is no
// display-only regeneration anywhere (E28b). The model seams are fixtured per D15
// (record-replay): /api/run streams a committed fixture and /api/score returns a
// committed verdict, so the round-trip runs offline, free, and deterministically in
// CI — no live calls (rule 20).
//
// "Round-trip half-ships (regen scores sometimes)" is the motivating defect this
// gate forbids: a score must always reflect the run it was computed over, so after a
// prompt edit + regenerate the prior score is CLEARED (new run, no scores yet) and a
// re-score recomputes it over the freshly generated outputs.

const FIXTURE_STREAM = readFileSync(join(__dirname, 'fixtures/run-stream.txt'), 'utf-8')

async function mockRun(page: Page) {
  await page.route('/api/run', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'x-vercel-ai-data-stream': 'v1',
      },
      body: FIXTURE_STREAM,
    })
  })
}

// Fixtured faithfulness verdict — a single supported claim → score = `score`.
function scoreBody(score: number) {
  return JSON.stringify({
    score,
    groundingSource: 'captured',
    claims: [
      {
        claim: 'The patient takes Lisinopril 10mg daily for hypertension.',
        verdict: score >= 0.85 ? 'supported' : 'partial',
        reason: 'fixtured verdict',
      },
    ],
  })
}

// Re-routable /api/score seam: later page.route registrations take precedence, so a
// second call rebinds the verdict for the re-score pass — the two passes return
// distinct scores, which is how we prove the displayed score tracks the live run.
async function mockScore(page: Page, score: number) {
  await page.route('/api/score', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: scoreBody(score),
    })
  })
}

test.describe('run round-trip — score consumes fresh outputs (E28b spine gate)', () => {
  test('author → generate → score → edit prompt → regenerate → re-score', async ({ page }) => {
    await mockRun(page)
    await mockScore(page, 1.0)

    // ── author: the bench lands pre-loaded with the lesson's golden set ───────
    await page.goto('/workbench')
    await page.getByTestId('open-the-bench-btn').click()

    // ── generate: regenerate every case under a custom prompt (the live knob) ──
    await page.getByTestId('generation-prompt-input').fill('List medications only. Be terse.')
    await page.getByTestId('regenerate-btn').click()
    const firstOutput = page.locator('[data-testid^="regenerated-output-"]').first()
    await expect(firstOutput).toContainText('Lisinopril', { timeout: 10000 })
    await expect(page.getByTestId('regenerate-btn')).toBeEnabled({ timeout: 15000 })

    // Before scoring there is no score on the surface (nothing graded yet).
    await expect(page.locator('[data-testid^="run-score-"]').first()).toHaveCount(0)

    // ── score: grade runs.current.outputs (the fresh text, via /api/score) ────
    await page.getByTestId('score-run-btn').click()
    const score = page.locator('[data-testid^="run-score-"]').first()
    await expect(score).toBeVisible({ timeout: 15000 })
    // First pass verdict = 1.00 → matched (>= faithfulness threshold).
    await expect(score).toContainText('1.00')
    await expect(score).toHaveAttribute('data-score-state', 'matched')

    // ── edit prompt + regenerate: a fresh run; the prior score must CLEAR ─────
    // (no display-only carry-over — the score belonged to the previous outputs).
    await page.getByTestId('generation-prompt-input').fill('Summarize the record in one line.')
    await page.getByTestId('regenerate-btn').click()
    await expect(page.locator('[data-testid^="run-score-"]').first()).toHaveCount(0)
    await expect(page.getByTestId('regenerate-btn')).toBeEnabled({ timeout: 15000 })
    // Fresh outputs streamed again.
    await expect(firstOutput).toContainText('Lisinopril')

    // ── re-score: recompute over the FRESH outputs (distinct fixtured verdict) ─
    await mockScore(page, 0.5)
    await page.getByTestId('score-run-btn').click()
    const rescore = page.locator('[data-testid^="run-score-"]').first()
    await expect(rescore).toBeVisible({ timeout: 15000 })
    // Second pass verdict = 0.50 → mismatched: the displayed score tracks the live
    // run, never a stale display-only value.
    await expect(rescore).toContainText('0.50')
    await expect(rescore).toHaveAttribute('data-score-state', 'mismatched')
  })
})
