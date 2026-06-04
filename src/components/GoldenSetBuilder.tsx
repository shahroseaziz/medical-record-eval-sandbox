'use client'

import { useState, useEffect } from 'react'
import type { UserCaseV2 } from '@/lib/cases'
import {
  loadUserCasesV2,
  saveUserCaseV2,
  deleteUserCaseV2,
  isCaseStale,
  genPromptHash,
} from '@/lib/cases'
import type { RetrievalData } from '@/hooks/useRun'
import type { RunMode } from '@/app/api/run/types'

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
  onRunCase: (uc: UserCaseV2) => void
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
}: Props) {
  const [cases, setCases] = useState<UserCaseV2[]>([])
  const [showCapture, setShowCapture] = useState(false)
  const [captureMode, setCaptureMode] = useState<CaptureMode>('promote')
  const [editedOutput, setEditedOutput] = useState('')
  const [intentLabel, setIntentLabel] = useState<'pass' | 'fail'>('pass')
  const [failReason, setFailReason] = useState('')
  const [savedFeedback, setSavedFeedback] = useState(false)

  useEffect(() => {
    setCases(loadUserCasesV2())
  }, [])

  function refresh() {
    setCases(loadUserCasesV2())
  }

  function openCapture() {
    setEditedOutput(runOutput)
    setCaptureMode('promote')
    setIntentLabel('pass')
    setFailReason('')
    setShowCapture(true)
  }

  function handleCapture() {
    if (!currentPatientId) return

    const referenceOutput = captureMode === 'promote' ? runOutput : editedOutput

    const capturedGrounding =
      currentMode === 'retrieve' && retrieval != null
        ? { mode: 'retrieve' as RunMode, chunks: retrieval.chunks }
        : { mode: 'stuff' as RunMode, record: currentRecord }

    const uc: UserCaseV2 = {
      id: `golden-${Date.now()}`,
      taskPrompt: currentQuery,
      patientId: currentPatientId,
      ragMode: currentMode,
      capturedOutput: runOutput,
      capturedGrounding,
      referenceOutput: referenceOutput || undefined,
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
    saveUserCaseV2(uc)
    refresh()
    setShowCapture(false)
    setSavedFeedback(true)
    setTimeout(() => setSavedFeedback(false), 2000)
  }

  function handleDelete(id: string) {
    deleteUserCaseV2(id)
    refresh()
  }

  const canCapture = Boolean(runOutput && currentPatientId && !loading)
  const outOfScope = intentLabel === 'fail' && isOutOfScopeForGrounding(failReason)

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
      <p style={{ fontSize: '0.78rem', color: '#666', margin: '0 0 0.75rem' }}>
        Capture run outputs as hand-labeled golden cases (
        <code>localStorage</code>, never included in seeded metrics).
      </p>

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
          {/* Reference output source */}
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.4rem' }}>
            Reference output source
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
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.4rem' }}>
            Intent label
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
              designed-pass
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
              designed-fail
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
                  This looks like a completeness or style concern — a grounding judge won&apos;t catch it.
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
              onClick={() => setShowCapture(false)}
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
    </section>
  )
}
