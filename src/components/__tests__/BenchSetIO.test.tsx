import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BenchSetIO } from '../BenchSetIO'
import { exportBenchSet, type BenchSet, type UserCase } from '@/lib/cases'

function makeSet(complete = true): BenchSet {
  return {
    id: 'set-1',
    name: 'My Set',
    createdAt: 1,
    cases: [
      {
        version: 4,
        id: 'c1',
        taskPrompt: 'List meds.',
        patientId: 'p1',
        ragMode: 'retrieve',
        expectedProse: 'Metformin.',
        fieldScorers: { prose: 'reference-judge' },
        createdAt: 2,
      },
    ],
    labels: {},
    runs: complete
      ? {
          current: {
            genPromptHash: 'g',
            rubricHash: 'r',
            threshold: 0.85,
            scorerAssignments: {},
            outputs: {},
            scores: {
              c1: { caseId: 'c1', fields: [], score: 1, state: 'matched', excluded: false },
            },
            timestamp: 3,
          },
          previous: null,
        }
      : { current: null, previous: null },
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('BenchSetIO', () => {
  it('surfaces a NAMED error on a malformed import (never silent)', async () => {
    const onImport = vi.fn()
    render(<BenchSetIO set={makeSet()} onImport={onImport} />)
    const file = new File(['{ "id": 1 }'], 'bad.json', { type: 'application/json' })
    await userEvent.upload(screen.getByTestId('import-file-input'), file)
    const err = await screen.findByTestId('import-error')
    expect(err.textContent).toMatch(/Invalid BenchSet/)
    expect(onImport).not.toHaveBeenCalled()
  })

  it('imports a valid set and calls onImport with the validated set', async () => {
    const onImport = vi.fn()
    render(<BenchSetIO set={makeSet()} onImport={onImport} />)
    const set = makeSet()
    const file = new File([exportBenchSet(set)], 'good.json', { type: 'application/json' })
    await userEvent.upload(screen.getByTestId('import-file-input'), file)
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledOnce())
    expect(onImport.mock.calls[0][0]).toEqual(set)
  })

  it('shows the D5 legacy banner and migrates non-destructively', async () => {
    const v1: UserCase[] = [{ id: 'v1-a', patientId: 'p', query: 'q', mode: 'stuff', createdAt: 1 }]
    localStorage.setItem('user_cases_v1', JSON.stringify(v1))
    const onMigrated = vi.fn()
    render(<BenchSetIO set={null} onImport={vi.fn()} onMigrated={onMigrated} />)
    const banner = await screen.findByTestId('legacy-migration-banner')
    expect(banner.textContent).toMatch(/1 case/)
    await userEvent.click(screen.getByTestId('legacy-migrate-btn'))
    expect(onMigrated).toHaveBeenCalled()
    // legacy key intact (non-destructive)
    expect(localStorage.getItem('user_cases_v1')).toBe(JSON.stringify(v1))
    // banner gone after migration
    expect(screen.queryByTestId('legacy-migration-banner')).toBeNull()
  })

  it('prompts export at a set-completion moment', () => {
    render(<BenchSetIO set={makeSet(true)} onImport={vi.fn()} />)
    expect(screen.getByTestId('export-prompt')).toBeTruthy()
  })

  it('does not prompt export for an unscored set', () => {
    render(<BenchSetIO set={makeSet(false)} onImport={vi.fn()} />)
    expect(screen.queryByTestId('export-prompt')).toBeNull()
  })
})
