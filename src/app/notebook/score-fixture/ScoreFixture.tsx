'use client'

import { ScoreLine } from '../ScoreLine'
import { createEmptyState, type NotebookState } from '@/lib/notebook/state'

// N15c — the deterministic render seam behind the 1×1 IDENTITY TEST. The acceptance
// is OBSERVABLE: a committed Playwright screenshot of the 1×1 score state must diff
// pixel-clean against the N11 score-line snapshot. To make that diff meaningful it
// has to be deterministic — no model call, no generated text — so we mount the real
// `ScoreLine` with a hand-fixed 1×1 cube. The 1×1 case renders the unchanged N11
// trail; if any future change perturbs that path, the committed pixels move and the
// test fails. This fixture is gated off the product (see ./page.tsx) — it exists
// only so the test seam is free, offline, and reproducible (domain rule 20).
const ONE_BY_ONE: NotebookState = {
  ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
  runs: [
    {
      id: 'run-1',
      version: 1,
      promptText: 'Summarize the active medications for this patient.',
      promptHash: 'fixture-hash',
      createdAt: '2026-06-01T00:00:00.000Z',
      outputs: {
        'patient-a': {
          text: 'out',
          model: 'claude-opus-4-8',
          contextMode: 'full',
          sections: ['medications'],
          status: 'ok',
        },
      },
    },
  ],
  evals: [
    {
      key: 'golden',
      label: 'Golden set',
      version: 1,
      criteriaOrGolden: '{}',
      history: [{ version: 1, contentHash: 'fixture-hash' }],
    },
  ],
  scores: { golden: { 'run-1': { frac: '1/1', per: [{ patientId: 'patient-a', state: 'pass', fails: [] }] } } },
}

export function ScoreFixture() {
  // A fixed-width frame so the screenshot target has a stable layout box,
  // independent of viewport chrome.
  return (
    <main style={{ padding: 24 }}>
      <div data-testid="score-fixture-frame" style={{ width: 480 }}>
        <ScoreLine state={ONE_BY_ONE} />
      </div>
    </main>
  )
}
