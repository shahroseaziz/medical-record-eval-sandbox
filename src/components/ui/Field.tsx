import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import styles from './Field.module.css'

interface FieldChromeProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
}

/**
 * Wires a label + optional hint/error to a control with the right ARIA
 * relationships: htmlFor → id, aria-describedby → hint/error, aria-invalid on
 * error. Used by Input and Textarea below; not normally rendered directly.
 */
function useFieldAria(id: string, { hint, error }: Pick<FieldChromeProps, 'hint' | 'error'>) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return { hintId, errorId, describedBy, invalid: Boolean(error) }
}

function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  children,
}: FieldChromeProps & { id: string; children: ReactNode }) {
  const { hintId, errorId } = useFieldAria(id, { hint, error })
  return (
    <div className={styles.field}>
      {label != null && (
        <label htmlFor={id} className={styles.label}>
          {label}
          {required && (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      {children}
      {hint != null && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      {error != null && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>, FieldChromeProps {
  id?: string
}

/** Labeled text input with built-in hint/error and ARIA wiring. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, label, hint, error, required, className, ...rest },
  ref,
) {
  const reactId = useId()
  const fieldId = id ?? reactId
  const { describedBy, invalid } = useFieldAria(fieldId, { hint, error })
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} required={required}>
      <input
        ref={ref}
        id={fieldId}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={[styles.control, className ?? ''].filter(Boolean).join(' ')}
        {...rest}
      />
    </FieldShell>
  )
})

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>, FieldChromeProps {
  id?: string
}

/** Labeled multi-line textarea with built-in hint/error and ARIA wiring. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id, label, hint, error, required, className, ...rest },
  ref,
) {
  const reactId = useId()
  const fieldId = id ?? reactId
  const { describedBy, invalid } = useFieldAria(fieldId, { hint, error })
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} required={required}>
      <textarea
        ref={ref}
        id={fieldId}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={[styles.control, styles.textarea, className ?? ''].filter(Boolean).join(' ')}
        {...rest}
      />
    </FieldShell>
  )
})
