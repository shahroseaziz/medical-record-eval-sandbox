/**
 * UI primitive foundation — token-driven building blocks shared app-wide.
 *
 * Design tokens live in `src/app/tokens.css` (loaded in the root layout); these
 * components consume them via CSS modules. New surfaces should compose these
 * primitives rather than hardcoding colors, spacing, or focus/ARIA behavior.
 */
export { Button } from './Button'
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button'

export { Container } from './Container'
export type { ContainerProps } from './Container'

export { Stack } from './Stack'
export type { StackProps } from './Stack'

export { Card } from './Card'
export type { CardProps, CardTone, CardPadding } from './Card'

export { Text, Heading } from './Text'
export type { TextProps, TextSize, TextWeight, TextTone, HeadingProps, HeadingLevel } from './Text'

export { Badge } from './Badge'
export type { BadgeProps, BadgeTone } from './Badge'

export { Input, Textarea } from './Field'
export type { InputProps, TextareaProps } from './Field'

export { ScoreRing } from './ScoreRing'
export type { ScoreRingProps } from './ScoreRing'
