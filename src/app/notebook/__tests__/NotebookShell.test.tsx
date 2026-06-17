import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotebookShell } from '../NotebookShell'
import { BYO_MODEL, GENERATION_MODEL, modelDisplayName } from '@/lib/models'

describe('NotebookShell (SHA-156 N6)', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    // The N8a prompt cell loads a patient roster on mount; stub it so the
    // async effect resolves cleanly inside these (N6) shell tests.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ patients: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the header: wordmark, BYO-key slot, and a model label', () => {
    render(<NotebookShell patientCount={111} />)
    expect(screen.getByTestId('notebook-wordmark')).toBeInTheDocument()
    expect(screen.getByTestId('byo-key-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('model-label')).toBeInTheDocument()
  })

  it('renders the data strip: realism line with the count + an Explore button', () => {
    render(<NotebookShell patientCount={111} />)
    const line = screen.getByTestId('realism-line')
    expect(line).toHaveTextContent('111')
    expect(line).toHaveTextContent(/synthetic/i)
    expect(line).toHaveTextContent(/no real PHI/i)
    expect(screen.getByTestId('explore-button')).toBeInTheDocument()
  })

  it('drops the count gracefully when the corpus size is unknown', () => {
    render(<NotebookShell patientCount={null} />)
    const line = screen.getByTestId('realism-line')
    expect(line).toHaveTextContent(/synthetic/i)
    expect(line.textContent).not.toMatch(/\d/)
  })

  it('renders the empty section scaffolding in document order', () => {
    render(<NotebookShell patientCount={111} />)
    const order = ['section-prompt', 'section-output', 'section-eval', 'section-score']
    const positions = order.map((id) =>
      screen.getByTestId(id).compareDocumentPosition(document.body),
    )
    // each section exists; verify DOM order via getAllByTestId positions
    const all = order.map((id) => screen.getByTestId(id))
    for (let i = 1; i < all.length; i++) {
      expect(
        all[i - 1].compareDocumentPosition(all[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    expect(positions).toHaveLength(4)
  })

  it('NO key → ACTIVE model is the free GENERATION_MODEL and caps are ON', () => {
    render(<NotebookShell patientCount={111} />)
    const label = screen.getByTestId('model-label')
    expect(label).toHaveAttribute('data-active-model', GENERATION_MODEL)
    expect(label).toHaveAttribute('data-caps-active', 'true')
    expect(label).toHaveTextContent(`${modelDisplayName(GENERATION_MODEL)} · free tier`)
    // sanity: the free tier truthfully shows Haiku
    expect(modelDisplayName(GENERATION_MODEL)).toBe('Haiku 4.5')
  })

  it('a stored key → ACTIVE model switches to BYO_MODEL and caps are LIFTED', async () => {
    const user = userEvent.setup()
    render(<NotebookShell patientCount={111} />)

    await user.click(screen.getByTestId('byo-key-toggle'))
    await user.type(screen.getByTestId('byo-key-input'), 'sk-ant-test-key')

    const label = screen.getByTestId('model-label')
    expect(label).toHaveAttribute('data-active-model', BYO_MODEL)
    expect(label).toHaveAttribute('data-caps-active', 'false')
    expect(label).toHaveTextContent(`${modelDisplayName(BYO_MODEL)} · your key`)
    // sanity: a key truthfully shows Sonnet
    expect(modelDisplayName(BYO_MODEL)).toBe('Sonnet 4.6')
    // the key is persisted to sessionStorage only (never to localStorage)
    expect(window.sessionStorage.getItem('mres.nb.byokey')).toBe('sk-ant-test-key')
    expect(window.localStorage.getItem('mres.nb.byokey')).toBeNull()
  })

  it('hydrates the BYO state from a key already in sessionStorage', () => {
    window.sessionStorage.setItem('mres.nb.byokey', 'sk-ant-existing')
    render(<NotebookShell patientCount={111} />)
    const label = screen.getByTestId('model-label')
    expect(label).toHaveAttribute('data-active-model', BYO_MODEL)
    expect(label).toHaveAttribute('data-caps-active', 'false')
  })

  it('does NOT show "+ Add another eval" until the first eval exists (1×1 unchanged)', () => {
    // Fresh shell, nothing scored → the add-eval on-ramp is absent, and there is
    // no added judge cell. The simple 1×1 path is unchanged until a 2nd eval.
    render(<NotebookShell patientCount={111} />)
    expect(screen.queryByTestId('add-eval')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-eval-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('judge-cell')).not.toBeInTheDocument()
  })

  it('the Explore button has a live stub target (not a dead control)', async () => {
    const user = userEvent.setup()
    render(<NotebookShell patientCount={111} />)
    expect(screen.queryByTestId('data-explorer-stub')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('explore-button'))
    const stub = screen.getByTestId('data-explorer-stub')
    expect(stub).toBeInTheDocument()
    await user.click(within(stub).getByTestId('data-explorer-stub-close'))
    expect(screen.queryByTestId('data-explorer-stub')).not.toBeInTheDocument()
  })
})
