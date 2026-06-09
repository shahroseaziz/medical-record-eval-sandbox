import type { ElementType, HTMLAttributes } from 'react'
import styles from './Card.module.css'

export type CardTone = 'default' | 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export type CardPadding = 'none' | 'sm' | 'md' | 'lg'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
  tone?: CardTone
  padding?: CardPadding
}

const toneClass: Record<CardTone, string> = {
  default: '',
  neutral: styles.neutral,
  info: styles.info,
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
}

const padClass: Record<CardPadding, string> = {
  none: styles.padNone,
  sm: styles.padSm,
  md: styles.padMd,
  lg: styles.padLg,
}

/**
 * Surface container with optional intent tone. Use `tone` for callouts
 * (info / warning / success / danger) instead of hardcoding background +
 * border colors inline.
 */
export function Card({
  as: Tag = 'div',
  tone = 'default',
  padding = 'md',
  className,
  ...rest
}: CardProps) {
  const classes = [styles.card, toneClass[tone], padClass[padding], className ?? '']
    .filter(Boolean)
    .join(' ')
  return <Tag className={classes} {...rest} />
}
