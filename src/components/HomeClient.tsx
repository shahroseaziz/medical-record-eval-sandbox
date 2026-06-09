'use client'

import { useState } from 'react'
import { ExampleHero } from './ExampleHero'
import { Workspace } from './Workspace'
import type { UserRunCaseResult, StoredEvalRun } from '@/lib/eval/user-agreement'
import type { Thresholds } from '@/lib/eval/thresholds'
import { migrateUserCasesV2toV3, replaceUserCasesV3, type UserCaseV2 } from '@/lib/cases'

interface Props {
  exampleResults: UserRunCaseResult[]
  exampleThreshold: number
  exampleCases: UserCaseV2[]
  exampleEvalRun: StoredEvalRun
  /** Per-scorer acceptance thresholds (config), threaded down to the workspace. */
  thresholds?: Thresholds
}

export function HomeClient({
  exampleResults,
  exampleThreshold,
  exampleCases,
  exampleEvalRun,
  thresholds,
}: Props) {
  const [goldenSetResetKey, setGoldenSetResetKey] = useState(0)

  function handleResetToExample() {
    if (typeof window === 'undefined') return
    // The example fixtures are v2-shaped — migrate them into the canonical v3 store.
    replaceUserCasesV3(migrateUserCasesV2toV3(exampleCases))
    localStorage.setItem('user_eval_run_v1', JSON.stringify(exampleEvalRun))
    setGoldenSetResetKey((k) => k + 1)
  }

  return (
    <>
      <ExampleHero
        results={exampleResults}
        threshold={exampleThreshold}
        onResetToExample={handleResetToExample}
      />
      <hr style={{ maxWidth: 1100, margin: '1.5rem auto', borderColor: '#eee' }} />
      <Workspace goldenSetResetKey={goldenSetResetKey} thresholds={thresholds} />
    </>
  )
}
