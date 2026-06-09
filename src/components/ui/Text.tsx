import type { ElementType, HTMLAttributes } from 'react'
import styles from './Text.module.css'

export type TextSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl'
export type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold'
export type TextTone = 'default' | 'muted' | 'subtle' | 'primary' | 'danger'

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
  size?: TextSize
  weight?: TextWeight
  tone?: TextTone
}

const sizeClass: Record<TextSize, string> = {
  xs: styles.xs,
  sm: styles.sm,
  base: styles.base,
  lg: styles.lg,
  xl: styles.xl,
  '2xl': styles['2xl'],
}

/**
 * Typographic primitive. Renders an inline <span> by default; pass `as` for
 * paragraphs, labels, etc. Font size / weight / color are all token-driven.
 */
export function Text({
  as: Tag = 'span',
  size = 'base',
  weight = 'normal',
  tone = 'default',
  className,
  ...rest
}: TextProps) {
  const classes = [styles.text, sizeClass[size], styles[weight], styles[tone], className ?? '']
    .filter(Boolean)
    .join(' ')
  return <Tag className={classes} {...rest} />
}

export type HeadingLevel = 1 | 2 | 3 | 4

const headingDefaults: Record<HeadingLevel, { size: TextSize; weight: TextWeight }> = {
  1: { size: '2xl', weight: 'bold' },
  2: { size: 'xl', weight: 'semibold' },
  3: { size: 'lg', weight: 'semibold' },
  4: { size: 'base', weight: 'semibold' },
}

export interface HeadingProps extends Omit<TextProps, 'as'> {
  level?: HeadingLevel
}

/** Semantic heading (<h1>–<h4>) with token-driven defaults per level. */
export function Heading({ level = 2, size, weight, className, ...rest }: HeadingProps) {
  const d = headingDefaults[level]
  const Tag = `h${level}` as const
  return (
    <Text
      as={Tag}
      size={size ?? d.size}
      weight={weight ?? d.weight}
      className={[styles.headingLeading, className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}
