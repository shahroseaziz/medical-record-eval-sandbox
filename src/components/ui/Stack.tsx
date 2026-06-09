import type { ElementType, HTMLAttributes } from 'react'
import styles from './Stack.module.css'

type Gap = 1 | 2 | 3 | 4 | 5 | 6
type Align = 'start' | 'center' | 'end' | 'stretch'
type Justify = 'start' | 'center' | 'end' | 'between'

export interface StackProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
  direction?: 'row' | 'column'
  gap?: Gap
  align?: Align
  justify?: Justify
  wrap?: boolean
}

const alignClass: Record<Align, string> = {
  start: styles.alignStart,
  center: styles.alignCenter,
  end: styles.alignEnd,
  stretch: styles.alignStretch,
}

const justifyClass: Record<Justify, string> = {
  start: styles.justifyStart,
  center: styles.justifyCenter,
  end: styles.justifyEnd,
  between: styles.justifyBetween,
}

/**
 * Flexbox layout primitive with token-driven gaps. Replaces ad-hoc
 * `display: flex; gap: …; align-items: …` inline blocks.
 */
export function Stack({
  as: Tag = 'div',
  direction = 'column',
  gap = 4,
  align,
  justify,
  wrap = false,
  className,
  ...rest
}: StackProps) {
  const classes = [
    styles.stack,
    direction === 'row' ? styles.row : styles.column,
    styles[`gap${gap}` as const],
    align ? alignClass[align] : '',
    justify ? justifyClass[justify] : '',
    wrap ? styles.wrap : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return <Tag className={classes} {...rest} />
}
