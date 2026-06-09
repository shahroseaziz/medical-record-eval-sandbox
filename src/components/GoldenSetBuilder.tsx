'use client'

import { useState, useEffect } from 'react'
import type { UserCaseV3, CapturedGrounding } from '@/lib/cases'
import {
  loadUserCasesV3,
  saveUserCaseV3,
  deleteUserCaseV3,
  isCaseStale,
  genPromptHash,
} from '@/lib/cases'
import type { RetrievalData } from '@/hooks/useRun'
import { useGenerationRun, type GenerationCase } from '@/hooks/useGenerationRun'
import type { RunMode } from '@/app/api/run/types'
import { DisagreementTable } from './DisagreementTable'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'
import {
  loadStoredEvalRun,
  saveEvalRun,
  DEFAULT_PASS_THRESHOLD,
} from '@/lib/eval/user-agreement'
import { getByoHeaders } from './ApiKeyInput'
import { Term } from './Term'

// ── Score API response shape ──────────────────────────────────────────────────

interface ScoreAPIResponse {
  score: number | null
  zeroClaimFlag?: boolean
  claims: Array<{
    claim: string
    verdict: 'supported' | 'unsupported' | 'partial'
    reason: string
  }>
  errored?: boolean
  errorMessage?: string
}

// ── Grounding assembly ────────────────────────────────────────────────────────

function assembleGrounding(cg: CapturedGrounding): string {
  if (cg.mode === 'retrieve' && cg.chunks) {
    return cg.chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
  }
  return cg.record ?? ''
}

// ── Per-case scorer (POST /api/score with captured output + grounding) ────────

const SCORE_TIMEOUT_MS = 30_000

async function scoreOneCase(
  uc: UserCaseV3,
): Promise<{ data: ScoreAPIResponse | null; rateLimited: boolean }> {
  const grounding = assembleGrounding(uc.capturedGrounding)
  if (!grounding || !uc.capturedOutput) return { data: null, rateLimited: false }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS)

  try {
    const res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getByoHeaders() },
      body: JSON.stringify({
        source: 'captured',
        capturedOutput: uc.capturedOutput,
        capturedGrounding: grounding,
      }),
      signal: controller.signal,
    })

    if (res.status === 429) return { data: null, rateLimited: true }
    if (!res.ok) return { data: null, rateLimited: false }

    const data = (await res.json()) as ScoreAPIResponse
    return { data, rateLimited: false }
  } catch {
    return { data: null, rateLimited: false }
  } finally {
    clearTimeout(timeoutId)
  }
}

// Patterns that signal a fail reason is out-of-scope for a grounding judge
// (completeness, style, formatting concerns rather than factual faithfulness)
const OUT_OF_SCOPE_PATTERNS = [
  /complet/i,
  /style/i,
  /format/i,
  /length/i,
  /verbo/i,
  /concis/i,
  /structur/i,
  /order/i,
  /organiz/i,
  /presentat/i,
  /tone/i,
]

function isOutOfScopeForGrounding(reason: string): boolean {
  return reason.length > 0 && OUT_OF_SCOPE_PATTERNS.some((p) => p.test(reason))
}

type CaptureMode = 'promote' | 'edit' | 'scratch'

interface Props {
  runOutput: string
  retrieval: RetrievalData | null
  currentPatientId: string | null
  currentQuery: string
  currentMode: RunMode
  currentRecord: string
  currentGenPrompt: string
  /** Gen prompt snapshotted at run() invocation — used for provenance hash. */
  runGenPrompt: string
  /** True while a run is in progress; blocks mid-stream captures. */
  loading: boolean
  onRunCase: (uc: UserCaseV3) => void
  /** Called after a case is successfully saved — receives the new case count. */
  onCaseSaved?: (count: number) => void
  /** Called when a batch eval completes. */
  onEvalComplete?: () => void
  /** Called when the capture panel opens or closes — lets the parent light the label stage. */
  onCapturePanelChange?: (isOpen: boolean) => void
}

export function GoldenSetBuilder({
  runOutput,
  retrieval,
  currentPatientId,
  currentQuery,
  currentMode,
  currentRecord,
  currentGenPrompt,
  runGenPrompt,
  loading,
  onRunCase,
  onCaseSaved,
  onEvalComplete,
  onCapturePanelChange,
}: Props) {
  const [cases, setCases] = useState<UserCaseV3[]>([])
  const [showCapture, setShowCapture] = useState(false)
  const [captureMode, setCaptureMode] = useState<CaptureMode>('promote')
  const [editedOutput, setEditedOutput] = useState('')
  const [intentLabel, setIntentLabel] = useState<'pass' | 'fail'>('pass')
  const [failReason, setFailReason] = useState('')
  const [savedFeedback, setSavedFeedback] = useState(false)
  const [batchResults, setBatchResults] = useState<UserRunCaseResult[] | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState('')
  const [batchThreshold, setBatchThreshold] = useState(DEFAULT_PASS_THRESHOLD)
  const [evalPartial, setEvalPartial] = useState<{
    scored: number
    total: number
    rateLimited: boolean
  } | null>(null)

  // Live-generation fan-out: re-run the current prompt across every golden case.
  const gen = useGenerationRun()

  useEffect(() => {
    setCases(loadUserCasesV3())
    const stored = loadStoredEvalRun()
    if (stored) {
      setBatchResults(stored.results)
      setBatchThreshold(stored.threshold)
      if (stored.partial) setEvalPartial(stored.partial)
    }
  }, [])

  function refresh() {
    const updated = loadUserCasesV3()
    setCases(updated)
    return updated
  }

  async function runEval() {
    if (batchRunning || cases.length === 0) return
    setBatchRunning(true)

    // Resume from a prior partial run, or start fresh
    const stored = loadStoredEvalRun()
    const existingResults: UserRunCaseResult[] = stored?.partial ? stored.results : []
    const scoredIds = new Set(existingResults.map((r) => r.caseId))
    const pending = cases.filter((c) => !scoredIds.has(c.id))
    const totalCases = cases.length
    let scored = existingResults.length

    const results: UserRunCaseResult[] = [...existingResults]
    setEvalPartial(null)
    setBatchProgress(`${scored} / ${totalCases}`)

    for (let i = 0; i < pending.length; i++) {
      const uc = pending[i]
      setBatchProgress(
        `Scoring ${scored + 1} / ${totalCases}: ${uc.taskPrompt.slice(0, 40)}${uc.taskPrompt.length > 40 ? '…' : ''}`,
      )

      const { data, rateLimited } = await scoreOneCase(uc)

      if (rateLimited) {
        // Stop gracefully — save partial results so the run is resumable
        const partialInfo = { scored, total: totalCases, rateLimited: true }
        saveEvalRun({ timestamp: Date.now(), threshold: DEFAULT_PASS_THRESHOLD, results, partial: partialInfo })
        setBatchResults(results.length > 0 ? results : null)
        setBatchThreshold(DEFAULT_PASS_THRESHOLD)
        setEvalPartial(partialInfo)
        setBatchRunning(false)
        setBatchProgress('')
        return
      }

      results.push({
        caseId: uc.id,
        intentLabel: uc.intentLabel,
        faithfulnessScore: data?.score ?? null,
        zeroClaimFlag: data?.zeroClaimFlag ?? false,
        claims: (data?.claims ?? []).map((c) => ({
          claim: c.claim,
          verdict: c.verdict,
          rationale: c.reason,
        })),
        output: uc.capturedOutput,
        taskPrompt: uc.taskPrompt,
      })
      scored++

      // Save after every case — partial until all done
      saveEvalRun({
        timestamp: Date.now(),
        threshold: DEFAULT_PASS_THRESHOLD,
        results,
        partial: scored < totalCases ? { scored, total: totalCases, rateLimited: false } : undefined,
      })
    }

    setBatchResults(results)
    setBatchThreshold(DEFAULT_PASS_THRESHOLD)
    setEvalPartial(null)
    setBatchRunning(false)
    setBatchProgress('')
    onEvalComplete?.()
  }

  // Map golden cases → generation-fan-out inputs. Each case re-runs generation
  // against its own patient/mode/grounding using the *current* (possibly edited)
  // generation prompt — this is the keystone round-trip.
  function toGenerationCases(): GenerationCase[] {
    return cases.map((uc) => ({
      id: uc.id,
      patientId: uc.patientId,
      query: uc.taskPrompt,
      mode: uc.ragMode,
      record: uc.ragMode === 'stuff' ? uc.capturedGrounding.record : undefined,
      k: uc.provenance.k,
    }))
  }

  function regenerate() {
    if (gen.running || cases.length === 0) return
    gen.run(toGenerationCases(), currentGenPrompt)
  }

  function resumeRegenerate() {
    if (gen.running || cases.length === 0) return
    gen.resume(toGenerationCases(), currentGenPrompt)
  }

  function openCapture() {
    setEditedOutput(runOutput)
    setCaptureMode('promote')
    // Default to 'fail' on the first case — the guided path starts with a trap
    setIntentLabel(cases.length === 0 ? 'fail' : 'pass')
    setFailReason('')
    setShowCapture(true)
    onCapturePanelChange?.(true)
  }

  function handleCapture() {
    if (!currentPatientId) return

    const referenceOutput = captureMode === 'promote' ? runOutput : editedOutput
    const expectedProse = referenceOutput || undefined

    const capturedGrounding =
      currentMode === 'retrieve' && retrieval != null
        ? { mode: 'retrieve' as RunMode, chunks: retrieval.chunks }
        : { mode: 'stuff' as RunMode, record: currentRecord }

    const uc: UserCaseV3 = {
      version: 3,
      id: `golden-${Date.now()}`,
      taskPrompt: currentQuery,
      patientId: currentPatientId,
      ragMode: currentMode,
      capturedOutput: runOutput,
      capturedGrounding,
      expectedStructured: undefined,
      // The hand-authored prose reference; faithfulness grades it when present.
      expectedProse,
      fieldScorers: expectedProse !== undefined ? { prose: 'faithfulness' } : {},
      intentLabel,
      designedFailReason: intentLabel === 'fail' && failReason ? failReason : undefined,
      provenance: {
        genPromptHash: genPromptHash(runGenPrompt),
        patientId: currentPatientId,
        ragMode: currentMode,
        k: retrieval?.chunks.length,
      },
      createdAt: Date.now(),
    }
    saveUserCaseV3(uc)
    const updated = refresh()
    setShowCapture(false)
    onCapturePanelChange?.(false)
    setSavedFeedback(true)
    setTimeout(() => setSavedFeedback(false), 2000)
    onCaseSaved?.(updated.length)
  }

  function handleDelete(id: string) {
    deleteUserCaseV3(id)
    const updated = refresh()
    onCaseSaved?.(updated.length)
  }

  const canCapture = Boolean(runOutput && currentPatientId && !loading)
  const outOfScope = intentLabel === 'fail' && isOutOfScopeForGrounding(failReason)
  const isFirstCase = cases.length === 0

  return (
    <section
      data-testid="golden-set-builder"
      style={{
        marginTop: '1rem',
        padding: '0.75rem',
        border: '1px solid #c8e6c9',
        borderRadius: 6,
        background: '#fafff9',
      }}
    >
      <h3 style={{ fontSize: '0.95rem', marginTop: 0, marginBottom: '0.25rem' }}>
        Golden Set Builder
      </h3>

      {/* What a golden set is */}
      <p style={{ fontSize: '0.8rem', color: '#555', margin: '0 0 0.6rem' }}>
        A{' '}
        <Term
          term="golden set"
          definition="A small collection of hand-labeled test cases. Each case is a (query, grounding context, output) triple plus your declaration of whether the judge ought to pass or fail it. Running the batch eval shows you how often the judge agrees."
        />{' '}
        is your benchmark for the judge. Build it by running queries, capturing the outputs, and
        labeling each one. Then run batch eval — if the judge disagrees with your labels, something
        needs tuning: the rubric, the threshold, or the label itself. Cases live in{' '}
        <code>localStorage</code> — they are never included in the seeded aggregate metrics.
      </p>

      {/* First-case trap guidance */}
      {isFirstCase && !showCapture && (
        <div
          data-testid="first-case-trap-guidance"
          style={{
            padding: '0.5rem 0.75rem',
            background: '#fff8e8',
            border: '1px solid #e8b800',
            borderRadius: 4,
            fontSize: '0.82rem',
            color: '#5c3c00',
            marginBottom: '0.6rem',
          }}
        >
          <strong>Start with a trap.</strong> Run a query that asks about something not in the
          record — a medication the patient doesn&apos;t take, a condition not documented — then
          capture the output as <strong>designed-fail</strong>. A judge that can&apos;t catch an
          obvious failure isn&apos;t ready to gate anything.
        </div>
      )}

      <button
        data-testid="capture-from-run-btn"
        onClick={openCapture}
        disabled={!canCapture}
        style={{
          padding: '0.3rem 0.7rem',
          fontSize: '0.85rem',
          marginBottom: '0.5rem',
          opacity: canCapture ? 1 : 0.5,
        }}
      >
        {savedFeedback ? 'Saved!' : 'Capture from run…'}
      </button>

      {' '}
      <button
        data-testid="batch-eval-btn"
        onClick={runEval}
        disabled={cases.length === 0 || batchRunning}
        style={{
          padding: '0.3rem 0.7rem',
          fontSize: '0.85rem',
          marginBottom: '0.5rem',
          opacity: cases.length === 0 || batchRunning ? 0.5 : 1,
        }}
      >
        {batchRunning
          ? 'Running…'
          : evalPartial
            ? `Resume eval (${evalPartial.scored}/${evalPartial.total})`
            : `Run eval (${cases.length})`}
      </button>

      {batchRunning && batchProgress && (
        <div
          data-testid="batch-progress"
          style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}
        >
          {batchProgress}
        </div>
      )}

      {/* ── Live-generation fan-out ──────────────────────────────────────────
          Edit the generation prompt above, then regenerate every case to see
          what the new prompt produces — the round-trip the prototype faked. */}
      <div style={{ marginBottom: '0.5rem' }}>
        <button
          data-testid="regenerate-btn"
          onClick={regenerate}
          disabled={cases.length === 0 || gen.running}
          style={{
            padding: '0.3rem 0.7rem',
            fontSize: '0.85rem',
            opacity: cases.length === 0 || gen.running ? 0.5 : 1,
          }}
        >
          {gen.running ? 'Regenerating…' : `Regenerate with current prompt (${cases.length})`}
        </button>

        {gen.running && (
          <>
            {' '}
            <button
              data-testid="abort-regenerate-btn"
              onClick={gen.abort}
              style={{ padding: '0.3rem 0.7rem', fontSize: '0.85rem', color: '#c00' }}
            >
              Abort
            </button>
          </>
        )}

        {!gen.running && gen.rateLimited && (
          <>
            {' '}
            <button
              data-testid="resume-regenerate-btn"
              onClick={resumeRegenerate}
              disabled={cases.length === 0}
              style={{ padding: '0.3rem 0.7rem', fontSize: '0.85rem' }}
            >
              Resume regeneration ({gen.completed}/{gen.total})
            </button>
          </>
        )}
      </div>

      {(gen.running || gen.completed > 0) && gen.total > 0 && (
        <div
          data-testid="regenerate-progress"
          style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}
        >
          Regenerated {gen.completed} / {gen.total}
          {gen.running && gen.activeCaseId ? ' (in progress…)' : ''}
        </div>
      )}

      {gen.rateLimited && !gen.running && (
        <div
          data-testid="regenerate-rate-limit-banner"
          style={{
            padding: '0.4rem 0.6rem',
            background: '#fff3cd',
            border: '1px solid #e8a000',
            borderRadius: 4,
            fontSize: '0.8rem',
            color: '#5c3c00',
            marginBottom: '0.5rem',
          }}
        >
          {`Rate-limited — ${gen.completed} of ${gen.total} regenerated. Click "Resume regeneration" when the rate-limit window resets.`}
        </div>
      )}

      {/* Standalone rate-limit banner — shown when rate-limited before any results exist */}
      {evalPartial?.rateLimited && (!batchResults || batchResults.length === 0) && (
        <div
          data-testid="partial-run-banner"
          style={{
            padding: '0.4rem 0.6rem',
            background: '#fff3cd',
            border: '1px solid #e8a000',
            borderRadius: 4,
            fontSize: '0.8rem',
            color: '#5c3c00',
            marginBottom: '0.5rem',
          }}
        >
          {`Rate-limited — ${evalPartial.scored} of ${evalPartial.total} scored. Click "Resume eval" to continue when the rate-limit window resets.`}
        </div>
      )}

      {showCapture && (
        <div
          data-testid="capture-panel"
          style={{
            margin: '0.5rem 0 0.75rem',
            padding: '0.75rem',
            border: '1px solid #aaccff',
            borderRadius: 4,
            background: '#f0f7ff',
          }}
        >
          {/* First-case reminder inside capture panel */}
          {isFirstCase && (
            <div
              data-testid="capture-first-case-hint"
              style={{
                padding: '0.4rem 0.6rem',
                background: '#fff8e8',
                border: '1px solid #e8b800',
                borderRadius: 3,
                fontSize: '0.78rem',
                color: '#5c3c00',
                marginBottom: '0.6rem',
              }}
            >
              First case — consider keeping it as <strong>designed-fail</strong> to build a
              trap for your judge.
            </div>
          )}

          {/* Reference output source */}
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.4rem' }}>
            <Term
              term="reference label"
              definition="The ideal output you declare for this query — either the model output promoted verbatim, a corrected version, or something written from scratch. The judge compares its verdict to this when you run batch eval."
            />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginBottom: '0.75rem',
              fontSize: '0.85rem',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="capture-mode"
                value="promote"
                checked={captureMode === 'promote'}
                onChange={() => {
                  setCaptureMode('promote')
                  setEditedOutput(runOutput)
                }}
                data-testid="capture-mode-promote"
              />
              Promote model output verbatim
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="capture-mode"
                value="edit"
                checked={captureMode === 'edit'}
                onChange={() => {
                  setCaptureMode('edit')
                  setEditedOutput(runOutput)
                }}
                data-testid="capture-mode-edit"
              />
              Edit model output
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="capture-mode"
                value="scratch"
                checked={captureMode === 'scratch'}
                onChange={() => {
                  setCaptureMode('scratch')
                  setEditedOutput('')
                }}
                data-testid="capture-mode-scratch"
              />
              Write reference from scratch
            </label>
          </div>

          {(captureMode === 'edit' || captureMode === 'scratch') && (
            <textarea
              data-testid="reference-output-input"
              value={editedOutput}
              onChange={(e) => setEditedOutput(e.target.value)}
              rows={4}
              placeholder={
                captureMode === 'scratch'
                  ? 'Write the ideal reference output…'
                  : 'Edit the model output…'
              }
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                fontSize: '0.85rem',
                padding: '0.3rem 0.5rem',
                marginBottom: '0.75rem',
                resize: 'vertical',
              }}
            />
          )}

          {/* Intent label */}
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.2rem' }}>
            <Term
              term="Intent label"
              definition="Your declaration of what the judge ought to decide. Designed-pass: the output is faithful and the judge should pass it. Designed-fail: the output contains something wrong or you deliberately constructed a trap."
            />
          </div>
          <div
            style={{
              display: 'flex',
              gap: '1.5rem',
              marginBottom: '0.5rem',
              fontSize: '0.85rem',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="intent-label"
                value="pass"
                checked={intentLabel === 'pass'}
                onChange={() => setIntentLabel('pass')}
                data-testid="intent-label-pass"
              />
              <Term
                term="designed-pass"
                definition="You declare this output faithful — the judge should pass it. If the judge fails it instead, your rubric may be too strict or your threshold too low."
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="intent-label"
                value="fail"
                checked={intentLabel === 'fail'}
                onChange={() => setIntentLabel('fail')}
                data-testid="intent-label-fail"
              />
              <Term
                term="designed-fail"
                definition="You deliberately chose an output with a faithfulness error or built a trap. If the judge passes it, your rubric isn't strict enough or your threshold is too high."
              />
            </label>
          </div>

          {intentLabel === 'fail' && (
            <div style={{ marginBottom: '0.5rem' }}>
              <input
                type="text"
                data-testid="fail-reason-input"
                value={failReason}
                onChange={(e) => setFailReason(e.target.value)}
                placeholder="Why should this fail? (e.g. wrong section, hallucinated dosage)"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.3rem 0.5rem',
                  fontSize: '0.85rem',
                  marginBottom: '0.4rem',
                }}
              />
              {outOfScope && (
                <div
                  data-testid="out-of-scope-warning"
                  style={{
                    padding: '0.4rem 0.6rem',
                    background: '#fffbe6',
                    border: '1px solid #f5c542',
                    borderRadius: 4,
                    fontSize: '0.8rem',
                    color: '#7a5a00',
                  }}
                >
                  This looks like a completeness or style concern — a{' '}
                  <Term
                    term="grounding judge"
                    definition="A faithfulness judge checks whether what was stated is supported by the grounding context. It doesn't check whether enough was stated, or whether the style was correct."
                  />{' '}
                  won&apos;t catch it.
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              data-testid="save-capture-btn"
              onClick={handleCapture}
              style={{ padding: '0.3rem 0.7rem', fontSize: '0.85rem' }}
            >
              Save case
            </button>
            <button
              data-testid="cancel-capture-btn"
              onClick={() => { setShowCapture(false); onCapturePanelChange?.(false) }}
              style={{ padding: '0.3rem 0.7rem', fontSize: '0.85rem', color: '#666' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Cases list */}
      {cases.length === 0 && !showCapture && (
        <p style={{ fontSize: '0.82rem', color: '#999', margin: 0 }}>No golden cases yet.</p>
      )}

      {cases.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {cases.map((uc) => {
            const stale = isCaseStale(uc, currentGenPrompt)
            return (
              <li
                key={uc.id}
                data-testid={`golden-case-${uc.id}`}
                style={{
                  padding: '0.5rem',
                  border: `1px solid ${stale ? '#f5c542' : '#e0e0e0'}`,
                  borderRadius: 4,
                  background: stale ? '#fffbe6' : '#fafafa',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div style={{ flex: 1, fontSize: '0.82rem' }}>
                    {/* Badges row */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 5,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        marginBottom: 4,
                      }}
                    >
                      <span
                        data-testid={`case-intent-${uc.id}`}
                        style={{
                          padding: '1px 6px',
                          borderRadius: 3,
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          background: uc.intentLabel === 'pass' ? '#e6f9ee' : '#fde8e8',
                          border: `1px solid ${uc.intentLabel === 'pass' ? '#2a7' : '#c00'}`,
                          color: uc.intentLabel === 'pass' ? '#1a5' : '#c00',
                        }}
                      >
                        {uc.intentLabel === 'pass' ? 'designed-pass' : 'designed-fail'}
                      </span>
                      {stale && (
                        <span
                          data-testid={`stale-flag-${uc.id}`}
                          style={{
                            padding: '1px 6px',
                            borderRadius: 3,
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            background: '#fffbe6',
                            border: '1px solid #f5c542',
                            color: '#7a5a00',
                          }}
                        >
                          STALE
                        </span>
                      )}
                    </div>

                    {/* Task prompt */}
                    <div style={{ color: '#333', wordBreak: 'break-word' }}>
                      {uc.taskPrompt.slice(0, 100)}
                      {uc.taskPrompt.length > 100 ? '…' : ''}
                    </div>

                    {/* Fail reason */}
                    {uc.designedFailReason && (
                      <div style={{ color: '#c00', fontSize: '0.75rem', marginTop: 2 }}>
                        Fail reason: {uc.designedFailReason}
                      </div>
                    )}

                    {/* Provenance */}
                    <div
                      data-testid={`provenance-${uc.id}`}
                      style={{
                        color: '#888',
                        fontSize: '0.72rem',
                        marginTop: 4,
                        fontFamily: 'monospace',
                      }}
                    >
                      patient:{uc.provenance.patientId.slice(0, 12)}
                      {' · '}mode:{uc.provenance.ragMode}
                      {uc.provenance.k != null ? ` · k:${uc.provenance.k}` : ''}
                      {' · '}hash:{uc.provenance.genPromptHash.slice(0, 8)}
                    </div>

                    <div style={{ color: '#bbb', fontSize: '0.70rem', marginTop: 2 }}>
                      {new Date(uc.createdAt).toLocaleString()}
                    </div>

                    {/* Regenerated output for this case (live-generation fan-out) */}
                    {(() => {
                      const r = gen.results[uc.id]
                      if (!r || r.status === 'pending') return null
                      return (
                        <div
                          data-testid={`regenerated-output-${uc.id}`}
                          style={{
                            marginTop: 6,
                            padding: '0.4rem 0.5rem',
                            background: '#fff',
                            border: '1px solid #d7e3ff',
                            borderRadius: 4,
                            fontSize: '0.78rem',
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 600,
                              color: '#0057c2',
                              marginBottom: 3,
                              fontSize: '0.72rem',
                            }}
                          >
                            Regenerated output
                            {r.status === 'running' ? ' (streaming…)' : ''}
                            {r.status === 'error' ? ' — failed' : ''}
                          </div>
                          {r.status === 'error' ? (
                            <div style={{ color: '#c00' }}>{r.error ?? 'Generation failed'}</div>
                          ) : (
                            <div style={{ color: '#333', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {r.output || (r.status === 'running' ? '…' : '')}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <button
                      onClick={() => onRunCase(uc)}
                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                      data-testid={`run-golden-${uc.id}`}
                    >
                      Run
                    </button>
                    <button
                      onClick={() => handleDelete(uc.id)}
                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem', color: '#c00' }}
                      data-testid={`delete-golden-${uc.id}`}
                    >
                      Del
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {batchResults && batchResults.length > 0 && (
        <>
          <hr style={{ margin: '1rem 0', borderColor: '#e0e0e0' }} />
          <DisagreementTable
            results={batchResults}
            initialThreshold={batchThreshold}
            partial={evalPartial ?? undefined}
            onThresholdChange={(t) => {
              setBatchThreshold(t)
              const stored = loadStoredEvalRun()
              if (stored) saveEvalRun({ ...stored, threshold: t })
            }}
          />
        </>
      )}
    </section>
  )
}
