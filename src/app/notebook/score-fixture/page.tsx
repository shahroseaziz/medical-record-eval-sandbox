import { notFound } from 'next/navigation'
import { ScoreFixture } from './ScoreFixture'

// A TEST-ONLY render seam for the N15c 1×1 identity screenshot. It is gated OFF the
// product: unless `E2E_FIXTURES=1` is set on the server it 404s, so it never ships
// as a reachable surface. The Playwright webServer sets that env (playwright.config),
// and the identity spec hits `/notebook/score-fixture` to capture the 1×1 state.
export const dynamic = 'force-dynamic'

export default function ScoreFixturePage() {
  if (process.env.E2E_FIXTURES !== '1') notFound()
  return <ScoreFixture />
}
