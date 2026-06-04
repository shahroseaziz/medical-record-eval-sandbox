'use client'

export const DEFAULT_GENERATION_PROMPT =
  'You are a medical record analyst. Answer the question based ONLY on the provided medical record context. Do not use outside knowledge or make assumptions beyond what is stated.'

interface Props {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}

export function GenerationPromptEditor({ value, onChange, disabled }: Props) {
  const isDefault = value === DEFAULT_GENERATION_PROMPT

  return (
    <div
      data-testid="generation-prompt-editor"
      style={{
        border: '1.5px solid #b8860b',
        borderRadius: 6,
        background: '#fffbf0',
        padding: '0.75rem',
        marginTop: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label
          htmlFor="generation-prompt-input"
          style={{ fontSize: '0.9rem', fontWeight: 600, color: '#7a5c00' }}
        >
          Generation Prompt (System)
        </label>
        <button
          data-testid="reset-generation-prompt-btn"
          onClick={() => onChange(DEFAULT_GENERATION_PROMPT)}
          disabled={disabled || isDefault}
          style={{
            fontSize: '0.75rem',
            padding: '2px 8px',
            background: 'none',
            border: '1px solid #b8860b',
            color: '#7a5c00',
            borderRadius: 3,
            cursor: isDefault ? 'default' : 'pointer',
            opacity: isDefault ? 0.4 : 1,
          }}
        >
          Reset to example
        </button>
      </div>

      <div
        data-testid="generation-prompt-warning"
        style={{
          fontSize: '0.75rem',
          color: '#7a5c00',
          background: '#fff3cd',
          border: '1px solid #ffc107',
          borderRadius: 3,
          padding: '3px 8px',
          marginBottom: 6,
        }}
      >
        Synthetic data only — do not paste real patient data.
      </div>

      <textarea
        id="generation-prompt-input"
        data-testid="generation-prompt-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={4}
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: '0.8rem',
          padding: '0.4rem 0.6rem',
          resize: 'vertical',
          boxSizing: 'border-box',
          background: disabled ? '#f5f5f5' : '#fffef7',
          border: '1px solid #d4a017',
          borderRadius: 4,
        }}
      />
    </div>
  )
}
