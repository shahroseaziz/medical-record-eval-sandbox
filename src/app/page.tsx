import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Workspace } from '@/components/Workspace'
import { EvalScorecard } from '@/components/EvalScorecard'
import type { ScorecardAggregate, ScorecardCase } from '@/components/EvalScorecard'
import { loadThresholds } from '@/lib/eval/thresholds'

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

export default function Home() {
  const scorecard = loadScorecard()

  return (
    <>
      <Workspace />
      {scorecard && (
        <div
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            padding: '0 1.5rem 2rem',
            fontFamily: 'sans-serif',
          }}
        >
          <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />
          <EvalScorecard aggregate={scorecard.aggregate} cases={scorecard.cases} />
        </div>
      )}
    </>
  )
}
