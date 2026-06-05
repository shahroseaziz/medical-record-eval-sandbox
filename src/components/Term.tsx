'use client'

import { useState } from 'react'

interface Props {
  term: string
  definition: string
  children?: React.ReactNode
}

export function Term({ term, definition, children }: Props) {
  const [visible, setVisible] = useState(false)
  const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  return (
    <span style={{ position: 'relative', display: 'inline' }}>
      <span
        data-testid={`term-${slug}`}
        tabIndex={0}
        role="button"
        aria-label={`${term}: ${definition}`}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        style={{
          borderBottom: '1px dashed #888',
          cursor: 'help',
          display: 'inline',
        }}
      >
        {children ?? term}
      </span>
      {visible && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: 0,
            zIndex: 1000,
            background: '#1a1a2e',
            color: '#f0f0f8',
            padding: '5px 9px',
            borderRadius: 4,
            fontSize: '0.72rem',
            maxWidth: 260,
            minWidth: 140,
            whiteSpace: 'normal',
            lineHeight: 1.5,
            boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
            pointerEvents: 'none',
          }}
        >
          {definition}
        </span>
      )}
    </span>
  )
}
