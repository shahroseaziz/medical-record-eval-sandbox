'use client'

import { useState } from 'react'
import { ExampleHero } from './ExampleHero'
import { Workspace } from './Workspace'
import type { UserRunCaseResult, StoredEvalRun } from '@/lib/eval/user-agreement'
import type { UserCaseV2 } from '@/lib/cases'

interface Props {
  exampleResults: UserRunCaseResult[]
  exampleThreshold: number
  exampleCases: UserCaseV2[]
  exampleEvalRun: StoredEvalRun
}

export function HomeClient({
  exampleResults,
  exampleThreshold,
  exampleCases,
  exampleEvalRun,
}: Props) {
  const [goldenSetResetKey, setGoldenSetResetKey] = useState(0)

  function handleResetToExample() {
    if (typeof window === 'undefined') return
    localStorage.setItem('user_cases_v2', JSON.stringify(exampleCases))
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
      <Workspace goldenSetResetKey={goldenSetResetKey} />
    </>
  )
}
