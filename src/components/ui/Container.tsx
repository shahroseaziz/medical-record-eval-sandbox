import type { ElementType, HTMLAttributes } from 'react'
import styles from './Container.module.css'

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  /** Render as a different element (e.g. "main", "section"). Defaults to "div". */
  as?: ElementType
}

/**
 * Page-width wrapper: centers content and applies the responsive layout gutter.
 * Replaces the repeated `maxWidth: 1100, margin: '0 auto', padding: '… 1.5rem'`
 * inline pattern found across surfaces.
 */
export function Container({ as: Tag = 'div', className, ...rest }: ContainerProps) {
  return <Tag className={[styles.container, className ?? ''].filter(Boolean).join(' ')} {...rest} />
}
