'use client'

import { useCallback, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Container, Heading, Stack, Text } from './ui'
import { LessonBeat1 } from './LessonBeat1'
import { LessonBeat3 } from './LessonBeat3'
import styles from './LessonJourney.module.css'

interface Props {
  /** Faithfulness pass threshold, read from config by the page (rule 15). */
  initialThreshold: number
  /**
   * Beat 2 is a SERVER component (its data load reaches `node:crypto` to redact
   * the judge prompt), so it is rendered by the server page and handed in as a
   * slot — keeping that server-only dependency out of this client bundle.
   */
  beat2: ReactNode
}

type BeatNumber = 1 | 2 | 3

/** The three stops of the journey rail — Match → Meaning → Grounding. */
const STOPS: { n: BeatNumber; label: string; sub: string }[] = [
  { n: 1, label: 'Match', sub: 'diff' },
  { n: 2, label: 'Meaning', sub: 'judge' },
  { n: 3, label: 'Grounding', sub: 'faithfulness' },
]

/** Compact recap shown when a finished beat collapses (the learner can reopen). */
const SUMMARY: Record<BeatNumber, { eyebrow: string; title: string; gist: string }> = {
  1: {
    eyebrow: 'Beat 1 · Match',
    title: 'Correctness with a diff',
    gist: 'You authored an answer key and ran the deterministic structured diff against the seeded output.',
  },
  2: {
    eyebrow: 'Beat 2 · Meaning',
    title: 'A question with no field answer',
    gist: 'The structured diff could not grade prose; the reference judge resolved it on meaning.',
  },
  3: {
    eyebrow: 'Beat 3 · Grounding',
    title: 'Faithfulness capstone',
    gist: 'No answer key — you moved the rubric, labeled cases, and graded grounding.',
  },
}

/**
 * The lesson app shell (SHA-71 R15) — a stepper journey, not a stacked scroll.
 *
 * A persistent rail (Match → Meaning → Grounding) sits sticky at the top, and
 * EXACTLY ONE beat is interactive on screen at a time. Advancing is gated on
 * completing the current beat (Beat 1's run; Beat 2's contrast; Beat 3 ends in
 * the gated graduation). Finished beats collapse to a compact summary the
 * learner can reopen to review. The beats themselves are unchanged in
 * pedagogy/copy — this component only orchestrates which one is on screen.
 */
export function LessonJourney({ initialThreshold, beat2 }: Props) {
  const [beat, setBeat] = useState<BeatNumber>(1)
  // The furthest beat unlocked — stops at/below it are clickable for review.
  const [furthest, setFurthest] = useState<BeatNumber>(1)
  // Beat 1's completion latch: set when the diff runs, never cleared (so a
  // re-author inside Beat 1 doesn't re-lock the journey).
  const [beat1Ran, setBeat1Ran] = useState(false)
  // Which finished beats the learner has expanded for review.
  const [reopened, setReopened] = useState<Record<number, boolean>>({})

  const goTo = useCallback((n: BeatNumber) => {
    setBeat(n)
    setFurthest((f) => (n > f ? n : f))
    setReopened({})
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [])

  const toggleReopen = (n: number) =>
    setReopened((prev) => ({ ...prev, [n]: !prev[n] }))

  function renderBeatBody(n: BeatNumber) {
    if (n === 1) return <LessonBeat1 onRun={() => setBeat1Ran(true)} />
    if (n === 2) return beat2
    return <LessonBeat3 initialThreshold={initialThreshold} />
  }

  return (
    <div className={styles.journey} data-testid="lesson-journey">
      {/* ── Persistent journey rail ──────────────────────────────────────── */}
      <header className={styles.stepper} data-testid="lesson-stepper">
        <div className={styles.stepperInner}>
          <Link href="/" className={styles.brand} data-testid="lesson-stepper-home">
            <span className={styles.brandMark} aria-hidden="true">
              ⚖
            </span>
            MRES · learn evals
          </Link>
          <ol className={styles.stops} aria-label="Lesson progress">
            {STOPS.map((stop, i) => {
              const isActive = stop.n === beat
              const isPast = stop.n < beat
              const clickable = stop.n <= furthest && stop.n !== beat
              const state = isActive ? 'active' : isPast ? 'past' : 'future'
              return (
                <li key={stop.n} className={styles.stopItem}>
                  <button
                    type="button"
                    data-testid={`lesson-stepper-stop-${stop.n}`}
                    data-state={state}
                    aria-current={isActive ? 'step' : undefined}
                    disabled={!clickable}
                    onClick={clickable ? () => goTo(stop.n) : undefined}
                    className={[
                      styles.stop,
                      isActive ? styles.stopActive : '',
                      isPast ? styles.stopPast : '',
                      clickable ? styles.stopClickable : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className={styles.stopNum}>{isPast ? '✓' : stop.n}</span>
                    <span className={styles.stopLabel}>{stop.label}</span>
                  </button>
                  {i < STOPS.length - 1 && (
                    <span className={styles.stopArrow} aria-hidden="true">
                      →
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      </header>

      <Container as="main" data-testid="lesson-page" className={styles.content}>
        <Stack gap={5}>
          <Stack gap={1}>
            <span className={styles.eyebrow}>Correctness lesson</span>
            <Heading level={1}>From a dose error to a judgment call</Heading>
            <Text as="p" size="sm" tone="muted">
              Every eval is the same three atoms — a <strong>prompt</strong> (the thing tested),{' '}
              <strong>cases</strong> (the golden set you grade), and an <strong>evaluator</strong>{' '}
              (the thing that decides pass/fail). Across three beats you meet the three evaluator
              types in turn: a structured diff catches a real extraction error (Beat 1); a prose
              question defeats that diff and a reference judge resolves it (Beat 2); and a
              faithfulness judge grades when there is no answer key at all (Beat 3). Read-only and
              deterministic — runs on committed generation, no database or model calls.
            </Text>
          </Stack>

          {/* Finished beats above the active one — collapsed, reopenable. */}
          {STOPS.filter((s) => s.n < beat).map((s) => {
            const open = !!reopened[s.n]
            const recap = SUMMARY[s.n]
            return (
              <section
                key={s.n}
                className={styles.summaryCard}
                data-testid={`beat-${s.n}-summary`}
              >
                <button
                  type="button"
                  className={styles.summaryHead}
                  aria-expanded={open}
                  data-testid={`beat-${s.n}-summary-toggle`}
                  onClick={() => toggleReopen(s.n)}
                >
                  <span className={styles.summaryCheck} aria-hidden="true">
                    ✓
                  </span>
                  <span className={styles.summaryText}>
                    <span className={styles.summaryLine}>
                      <span className={styles.summaryEyebrow}>{recap.eyebrow}</span>
                      <span className={styles.summaryTitle}>{recap.title}</span>
                    </span>
                    <span className={styles.summaryGist}>{recap.gist}</span>
                  </span>
                  <span className={styles.summaryReopen}>{open ? 'Hide ▲' : 'Reopen ▾'}</span>
                </button>
                {open && (
                  <div className={styles.summaryBody} data-testid={`beat-${s.n}-summary-body`}>
                    {renderBeatBody(s.n)}
                  </div>
                )}
              </section>
            )
          })}

          {/* The single active beat. */}
          <section className={styles.activeBeat} data-testid={`beat-${beat}-active`}>
            {renderBeatBody(beat)}
          </section>

          {/* Gated advance — Beat 3 is terminal (its graduation is the close). */}
          {beat === 1 && (
            <div className={styles.advance} data-testid="beat-advance">
              <button
                type="button"
                className={styles.advanceBtn}
                data-testid="beat-1-advance"
                disabled={!beat1Ran}
                onClick={() => goTo(2)}
              >
                Continue to Meaning →
              </button>
              {!beat1Ran && (
                <span className={styles.advanceHint}>
                  Author a key and run the diff to continue.
                </span>
              )}
            </div>
          )}
          {beat === 2 && (
            <div className={styles.advance} data-testid="beat-advance">
              <button
                type="button"
                className={styles.advanceBtn}
                data-testid="beat-2-advance"
                onClick={() => goTo(3)}
              >
                Continue to Grounding →
              </button>
            </div>
          )}
        </Stack>
      </Container>
    </div>
  )
}
