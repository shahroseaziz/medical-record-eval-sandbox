import type { HTMLAttributes } from 'react'
import styles from './Badge.module.css'

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

/**
 * Compact status pill (pass / fail / warning, etc.). Color is conveyed by tone
 * *and* text — never rely on color alone to communicate state.
 */
export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      className={[styles.badge, styles[tone], className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}
