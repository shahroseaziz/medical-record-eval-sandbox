'use client'

export type EvalStage = 'data' | 'prompt' | 'output' | 'label' | 'judge' | 'agreement'

interface StageSpec {
  key: EvalStage
  label: string
  desc: string
}

const STAGES: StageSpec[] = [
  {
    key: 'data',
    label: 'Data',
    desc: 'Synthetic patient records — the grounding context your model answers from',
  },
  {
    key: 'prompt',
    label: 'Gen Prompt',
    desc: 'Instructions that shape how the model turns the record into an answer',
  },
  {
    key: 'output',
    label: 'Output',
    desc: "The model's response — ready to inspect and capture as a test case",
  },
  {
    key: 'label',
    label: 'Capture + Label',
    desc: "You save the output and declare whether it should pass or fail — your claim about what the judge ought to do",
  },
  {
    key: 'judge',
    label: 'Judge',
    desc: 'A faithfulness scorer checks each captured output against the grounding context, claim by claim',
  },
  {
    key: 'agreement',
    label: 'Agreement',
    desc: "How often does the judge's verdict match the label you assigned? Low agreement means the rubric, threshold, or your label needs work",
  },
]

const STAGE_ORDER: EvalStage[] = STAGES.map((s) => s.key)

interface Props {
  currentStage: EvalStage
}

export function EvalLoopDiagram({ currentStage }: Props) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage)

  return (
    <div
      data-testid="eval-loop-diagram"
      style={{
        padding: '0.55rem 0.75rem',
        background: '#f7f9ff',
        border: '1px solid #c8d4f0',
        borderRadius: 6,
        marginBottom: '1rem',
      }}
    >
      <div
        style={{
          fontSize: '0.68rem',
          color: '#556',
          marginBottom: '0.4rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        Where you are in the eval loop
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '2px',
        }}
      >
        {STAGES.map((stage, i) => {
          const isActive = i === currentIdx
          const isPast = i < currentIdx

          return (
            <div key={stage.key} style={{ display: 'flex', alignItems: 'center' }}>
              <span
                data-testid={`loop-stage-${stage.key}`}
                data-active={isActive ? 'true' : undefined}
                title={stage.desc}
                style={{
                  padding: '3px 9px',
                  borderRadius: 12,
                  border: `1.5px solid ${isActive ? '#0070f3' : isPast ? '#2a7' : '#ccc'}`,
                  background: isActive ? '#e0ecff' : isPast ? '#e6f9ee' : '#f5f5f5',
                  color: isActive ? '#003eb3' : isPast ? '#1a5' : '#bbb',
                  fontWeight: isActive ? 700 : isPast ? 600 : 400,
                  fontSize: '0.72rem',
                  cursor: 'help',
                  whiteSpace: 'nowrap',
                }}
              >
                {isPast && '✓ '}
                {stage.label}
              </span>
              {i < STAGES.length - 1 && (
                <span
                  style={{
                    color: i < currentIdx ? '#8aa' : '#ddd',
                    margin: '0 2px',
                    fontSize: '0.7rem',
                  }}
                >
                  →
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
