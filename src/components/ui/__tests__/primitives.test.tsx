import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, Badge, Heading, Input, Textarea } from '..'

describe('Button', () => {
  it('renders a native button defaulting to type="button"', () => {
    render(<Button>Click</Button>)
    const btn = screen.getByRole('button', { name: 'Click' })
    expect(btn).toHaveAttribute('type', 'button')
  })

  it('fires onClick and forwards arbitrary props', async () => {
    const onClick = vi.fn()
    render(
      <Button onClick={onClick} aria-label="save" data-testid="b">
        Save
      </Button>,
    )
    await userEvent.click(screen.getByTestId('b'))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByTestId('b')).toHaveAttribute('aria-label', 'save')
  })

  it('does not fire onClick when disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button onClick={onClick} disabled>
        Nope
      </Button>,
    )
    await userEvent.click(screen.getByRole('button')).catch(() => {})
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('honors an explicit submit type', () => {
    render(<Button type="submit">Go</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
  })
})

describe('Heading', () => {
  it('renders the requested semantic level', () => {
    render(<Heading level={1}>Title</Heading>)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
  })
})

describe('Badge', () => {
  it('renders its text content', () => {
    render(<Badge tone="success">PASS</Badge>)
    expect(screen.getByText('PASS')).toBeInTheDocument()
  })
})

describe('Input', () => {
  it('associates the label with the control', () => {
    render(<Input label="Patient name" />)
    expect(screen.getByLabelText('Patient name')).toBeInTheDocument()
  })

  it('wires aria-describedby to the hint', () => {
    render(<Input label="Key" hint="Stored locally only" />)
    const input = screen.getByLabelText('Key')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent('Stored locally only')
  })

  it('marks the control invalid and surfaces the error via role=alert', () => {
    render(<Input label="Score" error="Out of range" />)
    const input = screen.getByLabelText('Score')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Out of range')
  })

  it('accepts an explicit id', () => {
    render(<Input id="my-id" label="Labeled" />)
    expect(screen.getByLabelText('Labeled')).toHaveAttribute('id', 'my-id')
  })
})

describe('Textarea', () => {
  it('associates the label and accepts typed input', async () => {
    render(<Textarea label="Rubric" />)
    const ta = screen.getByLabelText('Rubric')
    await userEvent.type(ta, 'hello')
    expect(ta).toHaveValue('hello')
  })
})
