'use client'

import { useState } from 'react'
import Link from 'next/link'
import { modelDisplayName } from '@/lib/models'
import { OutputCell } from './OutputCell'
import { JudgeResults } from './EvalCell'
import type { JudgeVerdict } from './useNotebookJudge'
import type { AgreeMark } from './judgeAgreement'
import {
  replayExample,
  type ReplayedExample,
  type ReplayedGoldenRow,
} from './exampleReplay'
import type { NotebookExampleArtifact } from './example-artifact'
import type { WorkedExampleStatus } from './useWorkedExample'
import styles from './notebook.module.css'

/**
 * Worked-example REPLAY surface (N13b) — rendered on `?example=1`. It replays the
 * committed artifact's BOTH legs CLIENT-SIDE with ZERO metered calls: the golden
 * grade is recomputed deterministically and the judge verdict is the recorded
 * single-call criteria verdict replayed verbatim (errored verdicts render the
 * "couldn't grade" state, never a fabricated ruling).
 *
 * It reuses the live cells — `OutputCell` for the model outputs and `JudgeResults`
 * for the judge verdicts — so the replay looks exactly like a real run, just
 * sourced from the committed recording instead of the engine.
 */

/** Read-only golden grade rows — the golden leg's verdict + failing-field diff. */
function GoldenReplayRows({ rows }: { rows: ReplayedGoldenRow[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return (
    <div className={styles.goldenRows} data-testid="example-golden-rows">
      {rows.map((r) => {
        const { state, fails, error } = r.grade
        const open = Boolean(expanded[r.patientId])
        return (
          <div
            className={styles.goldenRow}
            key={r.patientId}
            data-testid="example-golden-row"
            data-patient-id={r.patientId}
            data-verdict={state}
          >
            <div className={styles.grSide}>
              <span className={styles.grName}>{r.patientName}</span>
              {state === 'pass' && (
                <span
                  className={`${styles.goldenVerdict} ${styles.gvPass}`}
                  data-testid="example-golden-verdict"
                  data-verdict="pass"
                >
                  pass
                </span>
              )}
              {state === 'fail' && (
                <button
                  type="button"
                  className={styles.failChip}
                  data-testid="example-golden-fail-chip"
                  data-verdict="fail"
                  aria-expanded={open}
                  onClick={() => setExpanded((e) => ({ ...e, [r.patientId]: !e[r.patientId] }))}
                >
                  ≠ {fails.map((f) => f.field).join(', ')}
                  <span className={styles.chev} aria-hidden="true">
                    {open ? '▴' : '▾'}
                  </span>
                </button>
              )}
              {state === 'invalid' && <span className={styles.grNote}>{error}</span>}
            </div>

            {/* The hand-authored golden, read-only (the replay never edits it). */}
            <pre className={styles.ocJson}>
              <code>{r.golden}</code>
            </pre>

            {state === 'fail' && open && (
              <div className={styles.goldenDiff} data-testid="example-golden-diff">
                <div className={styles.gdHead}>
                  <span>field</span>
                  <span>expected (golden)</span>
                  <span>got (model)</span>
                </div>
                {fails.map((f) => (
                  <div className={styles.gdRow} key={f.field}>
                    <span className={styles.gdField}>{f.field}</span>
                    <span className={styles.gdExp}>{f.expected}</span>
                    <span className={styles.gdGot}>{f.got}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ReplayBody({ replay }: { replay: ReplayedExample }) {
  const [agree, setAgree] = useState<Record<string, AgreeMark>>({})
  const noop = () => {}

  // Build the judge leg's verdicts in the live `JudgeVerdict` shape so the existing
  // JudgeResults renders the replay identically to a real judge run (incl. errored).
  const verdicts: Record<string, JudgeVerdict> = {}
  for (const r of replay.judge.rows) {
    verdicts[r.patientId] = r.verdict.errored
      ? { patientId: r.patientId, status: 'errored', pass: null, reason: null, model: r.judgeModel }
      : {
          patientId: r.patientId,
          status: 'done',
          pass: r.verdict.pass,
          reason: r.verdict.reason,
          model: r.judgeModel,
        }
  }

  return (
    <>
      {/* ── GOLDEN leg ──────────────────────────────────────────────── */}
      <section className={styles.cell} data-testid="example-golden-leg" aria-label="Worked example — golden leg">
        <span className={styles.cellLabel}>Prompt · golden eval</span>
        <pre className={styles.ocJson}>
          <code>{replay.golden.prompt}</code>
        </pre>
      </section>

      <OutputCell
        order={replay.golden.order}
        results={replay.golden.results}
        patientsById={replay.golden.patientsById}
        onViewChart={noop}
      />

      <section className={styles.cell} data-testid="example-golden-eval" aria-label="Golden grade">
        <span className={styles.cellLabel}>Golden grade</span>
        <p className={styles.goldenNudge}>
          The grade is deterministic — recomputed client-side from the committed output and golden,
          no model call. A mismatch is a lead: the model got a field wrong on at least one patient.
        </p>
        <GoldenReplayRows rows={replay.golden.rows} />
      </section>

      {/* ── JUDGE leg ───────────────────────────────────────────────── */}
      <section className={styles.cell} data-testid="example-judge-leg" aria-label="Worked example — judge leg">
        <span className={styles.cellLabel}>Prompt · LLM judge</span>
        <pre className={styles.ocJson}>
          <code>{replay.judge.prompt}</code>
        </pre>
      </section>

      <OutputCell
        order={replay.judge.order}
        results={replay.judge.results}
        patientsById={replay.judge.patientsById}
        onViewChart={noop}
      />

      <section className={styles.cell} data-testid="example-judge-eval" aria-label="Judge verdicts">
        <span className={styles.cellLabel}>LLM judge · criteria verdict</span>
        <p className={styles.goldenNudge} data-testid="example-judge-criteria">
          {replay.criteria}
        </p>
        <JudgeResults
          order={replay.judge.order}
          verdicts={verdicts}
          patientsById={replay.judge.patientsById}
          agree={agree}
          onToggleAgree={(patientId, mark) =>
            setAgree((prev) => {
              const next = { ...prev }
              if (next[patientId] === mark) delete next[patientId]
              else next[patientId] = mark
              return next
            })
          }
          goldenScores={null}
        />
      </section>
    </>
  )
}

export interface WorkedExampleReplayProps {
  artifact: NotebookExampleArtifact
}

/** The replay surface for a successfully-loaded artifact. */
export function WorkedExampleReplay({ artifact }: WorkedExampleReplayProps) {
  const replay = replayExample(artifact)

  return (
    <div data-testid="worked-example-replay">
      <div className={styles.exampleBanner} data-testid="example-banner">
        <div className={styles.exBannerMain}>
          <span className={styles.exBadge}>worked example</span>
          Replayed from a committed run — <b>no API calls</b>. Both legs below are real recorded
          output: a golden eval that catches a wrong field, and an LLM judge whose call errored on
          one patient.
        </div>
        <div className={styles.exBannerSub}>
          generated {replay.generatedAt} · generation {modelDisplayName(replay.models.generation)} ·
          judge {modelDisplayName(replay.models.judge)}
          <Link href="/notebook" className={styles.exStartLink} data-testid="example-start-own">
            Start your own run →
          </Link>
        </div>
      </div>

      <ReplayBody replay={replay} />
    </div>
  )
}

export interface WorkedExampleSectionProps {
  status: WorkedExampleStatus
  artifact: NotebookExampleArtifact | null
  message: string | null
}

/**
 * The full `?example=1` surface across every loader state. Renders the replay once
 * the artifact is ready, and an honest empty/loading/error state otherwise —
 * notably the "not committed yet" state, since the artifact is a maintainer-owned
 * fixture that may not have landed (example/README.md).
 */
export function WorkedExampleSection({ status, artifact, message }: WorkedExampleSectionProps) {
  if (status === 'ready' && artifact) {
    return <WorkedExampleReplay artifact={artifact} />
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <section className={styles.cell} data-testid="example-loading" aria-label="Loading worked example">
        <span className={styles.cellLabel}>Worked example</span>
        <p className={styles.cellPlaceholder}>Loading the worked example…</p>
      </section>
    )
  }

  // unavailable | error — honest about why there is nothing to replay, with the
  // path back to authoring your own run.
  return (
    <section className={styles.cell} data-testid="example-unavailable" aria-label="Worked example unavailable">
      <span className={styles.cellLabel}>Worked example</span>
      <p className={styles.cellPlaceholder}>
        {status === 'unavailable'
          ? 'The worked example has not been published yet.'
          : (message ?? 'The worked example could not be loaded.')}{' '}
        <Link href="/notebook" className={styles.exStartLink} data-testid="example-start-own">
          Start your own run →
        </Link>
      </p>
    </section>
  )
}
