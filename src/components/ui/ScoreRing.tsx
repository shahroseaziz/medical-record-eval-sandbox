import styles from './ScoreRing.module.css'

export interface ScoreRingProps {
  /** Score in [0, 1]; `null` renders an empty/neutral ring (no value yet). */
  score: number | null
  /** Outer diameter in px (matches the reference's 76px capstone ring). */
  size?: number
  /** Pass cutoff — the ring reads green at/above it (config-driven, rule 15). */
  threshold?: number
  /** Accessible label; defaults to a percent read-out. */
  label?: string
}

/**
 * ScoreRing — the faithfulness score dial from the design system
 * (design/reference/components.jsx `ScoreRing`, tokens.css score-ring styling).
 *
 * A pure, deterministic SVG donut: the arc length and colour are a direct
 * function of `score` and `threshold`, so it renders identically every load and
 * is safe in jsdom (no animation / rAF — rule 20). Colour follows the reference:
 * green at/above threshold, amber from 0.5, red below, neutral when `null`.
 */
export function ScoreRing({ score, size = 76, threshold = 0.85, label }: ScoreRingProps) {
  const stroke = 8
  const r = (size - (stroke + 4)) / 2
  const circ = 2 * Math.PI * r
  const v = score ?? 0
  const offset = circ * (1 - v)

  const color =
    score === null
      ? 'var(--ink-4, var(--color-text-subtle))'
      : score >= threshold
        ? 'var(--pass, var(--color-success))'
        : score >= 0.5
          ? 'var(--partial, var(--color-warning))'
          : 'var(--fail, var(--color-danger))'

  const pct = score === null ? '—' : `${Math.round(score * 100)}%`
  const ariaLabel = label ?? (score === null ? 'No score yet' : `Score ${pct}`)

  return (
    <div
      className={styles.ring}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel}
      data-testid="score-ring"
    >
      <svg width={size} height={size} className={styles.svg} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-3, var(--color-surface-sunken))"
          strokeWidth={stroke}
        />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        )}
      </svg>
      <span className={styles.value} style={{ fontSize: size * 0.26 }} aria-hidden="true">
        {score === null ? '—' : Math.round(score * 100)}
        {score !== null && <span className={styles.pct} style={{ fontSize: size * 0.13 }}>%</span>}
      </span>
    </div>
  )
}
