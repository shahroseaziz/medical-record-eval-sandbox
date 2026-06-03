'use client'

interface Props {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}

export function PromptEditor({ value, onChange, disabled }: Props) {
  return (
    <div>
      <label htmlFor="prompt-input" style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: 4 }}>
        Query / Prompt
      </label>
      <textarea
        id="prompt-input"
        data-testid="prompt-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={4}
        placeholder="e.g. What medications is this patient currently taking?"
        style={{
          width: '100%',
          fontFamily: 'inherit',
          fontSize: '0.9rem',
          padding: '0.4rem 0.6rem',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
    </div>
  )
}
