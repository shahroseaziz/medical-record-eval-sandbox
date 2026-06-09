import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Link from 'next/link'
import { HomeClient } from '@/components/HomeClient'
import { EvalScorecard } from '@/components/EvalScorecard'
import type { ScorecardAggregate, ScorecardCase } from '@/components/EvalScorecard'
import { loadThresholds } from '@/lib/eval/thresholds'
import type { Thresholds } from '@/lib/eval/thresholds'
import exampleData from '@/example/eval-example.json'
import type { UserRunCaseResult, StoredEvalRun } from '@/lib/eval/user-agreement'
import type { UserCaseV2 } from '@/lib/cases'

interface BaselineCase {
  caseId: string
  meanScore: number | null
}

interface BaselineFile {
  aggregate: {
    passRate: number | null
    judgeReferenceAgreement: number | null
    judgeHumanKappa?: number | null
    interHumanKappa?: number | null
    n: number
  }
  cases: BaselineCase[]
}

function loadScorecard(): { aggregate: ScorecardAggregate; cases: ScorecardCase[] } | null {
  try {
    const raw = readFileSync(join(process.cwd(), 'evals/results/seed-baseline.json'), 'utf8')
    const data: BaselineFile = JSON.parse(raw)
    const agg = data.aggregate
    if (agg.passRate === null || agg.judgeReferenceAgreement === null) return null

    const { faithfulness: passThreshold } = loadThresholds()

    const aggregate: ScorecardAggregate = {
      passRate: agg.passRate,
      judgeReferenceAgreement: agg.judgeReferenceAgreement,
      judgeHumanKappa: agg.judgeHumanKappa ?? null,
      interHumanKappa: agg.interHumanKappa ?? null,
      n: agg.n,
    }
    const cases: ScorecardCase[] = (data.cases ?? [])
      .filter((c) => c.meanScore !== null && c.meanScore !== undefined)
      .map((c) => ({
        id: c.caseId,
        label: c.caseId,
        faithfulnessScore: c.meanScore as number,
        pass: (c.meanScore as number) >= passThreshold,
      }))

    return { aggregate, cases }
  } catch {
    return null
  }
}

// Per-scorer acceptance thresholds, read from config (evals/thresholds.yaml) on
// the server and threaded into the client authoring workspace so the per-field
// scorer classification reads config, never a hardcoded client value (rule 15).
function loadThresholdsOrNull(): Thresholds | null {
  try {
    return loadThresholds()
  } catch {
    return null
  }
}

export default function Home() {
  const scorecard = loadScorecard()
  const thresholds = loadThresholdsOrNull()

  const exampleResults = exampleData.results as UserRunCaseResult[]
  const exampleCases = exampleData.cases as unknown as UserCaseV2[]
  const exampleEvalRun: StoredEvalRun = {
    timestamp: new Date(exampleData.generatedAt).getTime(),
    threshold: exampleData.threshold,
    results: exampleResults,
  }

  return (
    <>
      {/* Hero: example run — static, no network/DB/model call */}
      <HomeClient
        exampleResults={exampleResults}
        exampleThreshold={exampleData.threshold}
        exampleCases={exampleCases}
        exampleEvalRun={exampleEvalRun}
        thresholds={thresholds ?? undefined}
      />

      {/* Seeded baseline — Inspector-reachable, below the authoring workspace */}
      {scorecard && (
        <div
          data-testid="baseline-scorecard-section"
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            padding: '0 1.5rem 2rem',
            fontFamily: 'sans-serif',
          }}
        >
          <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />
          <div
            style={{
              fontSize: '0.78rem',
              color: '#888',
              marginBottom: '0.5rem',
              fontStyle: 'italic',
            }}
          >
            Seeded baseline — maintained by project author, produced by the live judge
          </div>
          <EvalScorecard aggregate={scorecard.aggregate} cases={scorecard.cases} />
          <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
            <Link href="/lesson" data-testid="lesson-link">
              Walk through the correctness lesson: catching a dose error →
            </Link>
          </div>
        </div>
      )}
    </>
  )
}
