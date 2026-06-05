'use client'

import { useState, useEffect } from 'react'
import { PatientBrowser, type PatientRow } from './PatientBrowser'
import { PromptEditor } from './PromptEditor'
import { RagModeToggle } from './RagModeToggle'
import { TransformInspector } from './TransformInspector'
import { Inspector } from './Inspector'
import { UserCaseManager } from './UserCaseManager'
import { GoldenSetBuilder } from './GoldenSetBuilder'
import { ApiKeyInput, getByoHeaders } from './ApiKeyInput'
import { GenerationPromptEditor, DEFAULT_GENERATION_PROMPT } from './GenerationPromptEditor'
import { JudgeRubricEditor, DEFAULT_VERDICT_RUBRIC, type RescoreResult } from './JudgeRubricEditor'
import { EvalLoopDiagram, type EvalStage } from './EvalLoopDiagram'
import { Term } from './Term'
import { useRun } from '@/hooks/useRun'
import { loadUserCasesV2, type UserCase, type UserCaseV2 } from '@/lib/cases'
import type { RunMode } from '@/app/api/run/types'

function EvalBadge({ label, score }: { label: string; score: number | null }) {
  const color = score === null ? '#888' : score >= 0.85 ? '#2a7' : score >= 0.5 ? '#a80' : '#c00'
  const text = score === null ? 'N/A' : (score * 100).toFixed(0) + '%'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: color + '22',
        border: `1px solid ${color}`,
        color,
        borderRadius: 4,
        fontSize: '0.8rem',
        fontWeight: 600,
      }}
    >
      {label}: {text}
    </span>
  )
}

export function Workspace() {
  const [selectedPatient, setSelectedPatient] = useState<PatientRow | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<RunMode>('retrieve')
  const [record, setRecord] = useState('')
  const [generationPrompt, setGenerationPrompt] = useState(DEFAULT_GENERATION_PROMPT)
  const [judgeRubric, setJudgeRubric] = useState(DEFAULT_VERDICT_RUBRIC)
  const [rescoring, setRescoring] = useState(false)
  const [rescoreResult, setRescoreResult] = useState<RescoreResult | null>(null)
  const [rescoreError, setRescoreError] = useState<string | null>(null)
  // Snapshot the patient id, gen-prompt, query, mode, and record at the moment
  // run() is invoked so GoldenSetBuilder always sees the values that produced
  // the last output — never live UI state that may have changed since.
  const [runPatientId, setRunPatientId] = useState<string | null>(null)
  const [runGenPrompt, setRunGenPrompt] = useState('')
  const [runQuery, setRunQuery] = useState('')
  const [runMode, setRunMode] = useState<RunMode>('retrieve')
  const [runRecord, setRunRecord] = useState('')
  // Stage tracking for the loop diagram
  const [goldenCaseCount, setGoldenCaseCount] = useState(0)
  const [hasEvalRun, setHasEvalRun] = useState(false)

  // Seed count from localStorage so the diagram reflects prior work on reload
  useEffect(() => {
    setGoldenCaseCount(loadUserCasesV2().length)
  }, [])

  const { text, retrieval, evalResult, trace, loading, error, run } = useRun()

  const customGenerationPrompt =
    generationPrompt !== DEFAULT_GENERATION_PROMPT ? generationPrompt : undefined

  function computeCurrentStage(): EvalStage {
    if (hasEvalRun) return 'agreement'
    if (goldenCaseCount > 0) return 'judge'
    if (trace != null || text.length > 0) return 'output'
    if (selectedPatient != null) return 'prompt'
    return 'data'
  }

  function handleRun() {
    if (!selectedPatient || !query.trim()) return
    setRescoreResult(null)
    setRescoreError(null)
    setRunPatientId(selectedPatient.id)
    setRunGenPrompt(generationPrompt)
    setRunQuery(query)
    setRunMode(mode)
    setRunRecord(record)
    run({
      patientId: selectedPatient.id,
      query,
      mode,
      record: mode === 'stuff' ? record : undefined,
      generationPrompt: customGenerationPrompt,
    })
  }

  function handleRunCase(uc: UserCase) {
    setQuery(uc.query)
    setMode(uc.mode)
    if (uc.record) setRecord(uc.record)
    setRescoreResult(null)
    setRescoreError(null)
    setRunPatientId(uc.patientId)
    setRunGenPrompt(generationPrompt)
    setRunQuery(uc.query)
    setRunMode(uc.mode)
    setRunRecord(uc.mode === 'stuff' ? (uc.record ?? '') : '')
    run({
      patientId: uc.patientId,
      query: uc.query,
      mode: uc.mode,
      record: uc.mode === 'stuff' ? uc.record : undefined,
      generationPrompt: customGenerationPrompt,
    })
  }

  async function handleRescore() {
    if (!trace) return
    setRescoring(true)
    setRescoreError(null)
    setRescoreResult(null)
    try {
      const customRubric =
        judgeRubric !== DEFAULT_VERDICT_RUBRIC ? judgeRubric : undefined
      const res = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getByoHeaders() },
        body: JSON.stringify({
          source: 'captured',
          capturedOutput: trace.output,
          capturedGrounding: trace.grounding,
          ...(customRubric ? { userVerdictRubric: customRubric } : {}),
        }),
      })
      const data = (await res.json()) as RescoreResult & { error?: string }
      if (!res.ok) {
        setRescoreError(data.error ?? 'Re-score failed')
        return
      }
      setRescoreResult(data)
    } catch (e) {
      setRescoreError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setRescoring(false)
    }
  }

  function handleRunGoldenCase(uc: UserCaseV2) {
    setQuery(uc.taskPrompt)
    setMode(uc.ragMode)
    if (uc.capturedGrounding.record) setRecord(uc.capturedGrounding.record)
    setRunPatientId(uc.patientId)
    setRunGenPrompt(generationPrompt)
    setRunQuery(uc.taskPrompt)
    setRunMode(uc.ragMode)
    setRunRecord(uc.ragMode === 'stuff' ? (uc.capturedGrounding.record ?? '') : '')
    run({
      patientId: uc.patientId,
      query: uc.taskPrompt,
      mode: uc.ragMode,
      record: uc.ragMode === 'stuff' ? uc.capturedGrounding.record : undefined,
      generationPrompt: customGenerationPrompt,
    })
  }

  const canRun = Boolean(selectedPatient && query.trim() && !loading)

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>Medical Record Eval Sandbox</h1>
      <p style={{ color: '#555', marginBottom: '0.75rem', fontSize: '0.9rem' }}>
        Build and calibrate a{' '}
        <Term
          term="faithfulness judge"
          definition="A second model call that checks every factual claim in the generation against the grounding context — the patient record that was actually retrieved. Faithfulness is not the same as correctness: it only checks whether what was said is backed by the provided context."
        />{' '}
        for medical-record question answering. All data is synthetic.
      </p>

      {/* Persistent eval loop diagram */}
      <EvalLoopDiagram currentStage={computeCurrentStage()} />

      <ApiKeyInput />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Patient browser */}
      <div style={{ marginBottom: '0.4rem' }}>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.25rem' }}>Data</h2>
        <p style={{ fontSize: '0.8rem', color: '#666', margin: '0 0 0.5rem' }}>
          These are synthetic C-CDA records generated from fictional demographics. No real patient
          data.{' '}
          <Term
            term="Chunks"
            definition="Sections of the C-CDA record split into smaller pieces and embedded as vectors. In retrieve mode, the k most similar chunks to your query are fetched and used as the grounding context."
          />{' '}
          are the unit the retriever returns; in stuff mode you provide the full record text
          directly.
        </p>
      </div>
      <PatientBrowser
        selectedId={selectedPatient?.id ?? null}
        onSelect={(p) => setSelectedPatient(p)}
      />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Workspace pane */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* Left: controls */}
        <div>
          {selectedPatient && (
            <div
              data-testid="selected-patient"
              style={{
                marginBottom: '0.75rem',
                padding: '0.5rem 0.75rem',
                background: '#f0f7ff',
                border: '1px solid #aaccff',
                borderRadius: 4,
                fontSize: '0.9rem',
              }}
            >
              Selected:{' '}
              <strong>
                {selectedPatient.summary.demographics.firstName}{' '}
                {selectedPatient.summary.demographics.lastName}
              </strong>{' '}
              <span style={{ color: '#666', fontSize: '0.8rem' }}>
                ({selectedPatient.id.slice(0, 12)}…)
              </span>
            </div>
          )}

          <PromptEditor value={query} onChange={setQuery} disabled={loading} />

          {/* Generation prompt exposition */}
          <div
            style={{
              fontSize: '0.78rem',
              color: '#666',
              margin: '0.4rem 0 0',
              paddingLeft: '2px',
            }}
          >
            The{' '}
            <Term
              term="generation prompt"
              definition="The system-level instruction given to the model before every query. It shapes how the model reads the record and formats its answer. Treat it as the job description for your analyst: change it, run it, see what breaks."
            />{' '}
            is the instruction your model follows for every query. Edit it to explore different
            analyst behaviors.
          </div>

          <GenerationPromptEditor
            value={generationPrompt}
            onChange={setGenerationPrompt}
            disabled={loading}
          />

          {/* Judge rubric exposition */}
          <div
            style={{
              fontSize: '0.78rem',
              color: '#666',
              margin: '0.75rem 0 0',
              paddingLeft: '2px',
            }}
          >
            The{' '}
            <Term
              term="judge rubric"
              definition="Plain-text instructions that tell the judge how to classify each extracted claim: supported, unsupported, or partial. The rubric is the knob you turn when the judge is too strict or too lenient."
            />{' '}
            controls how the judge classifies each{' '}
            <Term
              term="claim"
              definition="An atomic factual assertion extracted from the model's output. For example, 'The patient takes lisinopril 10mg' is one claim. Each claim is independently checked against the grounding context."
            />{' '}
            in the output — change it to recalibrate without re-running the generation.
          </div>

          <JudgeRubricEditor
            value={judgeRubric}
            onChange={setJudgeRubric}
            disabled={loading}
            canRescore={Boolean(trace)}
            onRescore={handleRescore}
            rescoring={rescoring}
            rescoreResult={rescoreResult}
            rescoreError={rescoreError}
          />

          <div style={{ marginTop: '0.75rem' }}>
            <RagModeToggle
              mode={mode}
              onChange={setMode}
              record={record}
              onRecordChange={setRecord}
              disabled={loading}
            />
          </div>

          <div
            style={{
              marginTop: '0.75rem',
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'center',
            }}
          >
            <button
              data-testid="run-btn"
              onClick={handleRun}
              disabled={!canRun}
              style={{
                padding: '0.45rem 1.2rem',
                fontSize: '1rem',
                background: canRun ? '#0070f3' : '#ccc',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: canRun ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? 'Running…' : 'Run'}
            </button>

            {!selectedPatient && (
              <span style={{ fontSize: '0.8rem', color: '#888' }}>Select a patient first</span>
            )}
          </div>
        </div>

        {/* Right: results */}
        <div>
          {error && (
            <div
              data-testid="run-error"
              style={{
                padding: '0.5rem 0.75rem',
                background: '#fff0f0',
                border: '1px solid #f5a',
                borderRadius: 4,
                color: '#c00',
                fontSize: '0.85rem',
                marginBottom: '0.75rem',
              }}
            >
              {error}
            </div>
          )}

          {(text || loading) && (
            <div
              data-testid="run-output"
              style={{
                padding: '0.75rem',
                background: '#f9f9f9',
                border: '1px solid #ddd',
                borderRadius: 6,
                minHeight: 80,
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                lineHeight: 1.6,
                marginBottom: '0.75rem',
                whiteSpace: 'pre-wrap',
              }}
            >
              {text || (loading ? '…' : '')}
            </div>
          )}

          {evalResult && (
            <div data-testid="eval-results" style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 }}>
                Eval scores:
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <EvalBadge label="faithfulness" score={evalResult.faithfulness.score} />
                <EvalBadge label="section-hit" score={evalResult.sectionHit.score} />
              </div>
              {evalResult.faithfulness.claims.length > 0 && (
                <details style={{ marginTop: 8, fontSize: '0.8rem' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    {evalResult.faithfulness.claims.length} claim(s)
                  </summary>
                  <ul style={{ marginTop: 4, paddingLeft: 16 }}>
                    {evalResult.faithfulness.claims.map((c, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <span
                          style={{
                            color:
                              c.verdict === 'supported'
                                ? '#2a7'
                                : c.verdict === 'unsupported'
                                  ? '#c00'
                                  : '#a80',
                          }}
                        >
                          [{c.verdict}]
                        </span>{' '}
                        {c.claim}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {retrieval && retrieval.chunks.length > 0 && (
            <details data-testid="retrieval-details" style={{ fontSize: '0.82rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Retrieved {retrieval.chunks.length} chunk(s)
              </summary>
              <ul style={{ paddingLeft: 16, marginTop: 4 }}>
                {retrieval.chunks.map((c, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <strong>{c.section}</strong>{' '}
                    (
                    <Term
                      term="sim"
                      definition="Cosine similarity between the query embedding and the chunk embedding. Ranges 0–1; higher means more semantically similar. The retriever returns the k chunks with the highest similarity."
                    />
                    : {c.similarity.toFixed(3)})
                    <div style={{ color: '#555', marginTop: 2 }}>{c.text.slice(0, 120)}…</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {trace && (
        <>
          <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />
          <Inspector trace={trace} />
        </>
      )}

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Transform inspector */}
      <TransformInspector
        patientId={selectedPatient?.id ?? null}
        onLoadRecord={setRecord}
      />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* User case manager (V1) */}
      <UserCaseManager
        currentPatientId={selectedPatient?.id ?? null}
        currentQuery={query}
        currentMode={mode}
        currentRecord={record}
        onRunCase={handleRunCase}
      />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Golden set builder (V2) */}
      <GoldenSetBuilder
        runOutput={text}
        retrieval={retrieval}
        currentPatientId={runPatientId}
        currentQuery={runQuery}
        currentMode={runMode}
        currentRecord={runRecord}
        currentGenPrompt={generationPrompt}
        runGenPrompt={runGenPrompt}
        loading={loading}
        onRunCase={handleRunGoldenCase}
        onCaseSaved={(count) => setGoldenCaseCount(count)}
        onEvalComplete={() => setHasEvalRun(true)}
      />
    </div>
  )
}
