import Link from 'next/link'
import { GENERATION_MODEL, modelDisplayName } from '@/lib/models'
import styles from './start.module.css'

// New minimal front page (SHA-156 N6) — staged at /notebook/start alongside the
// existing landing page; the N18 cutover moves it to `/`. Two CO-EQUAL actions
// (same visual weight): open the sandbox, or load the worked example. Honest,
// single-patient framing — no cohort/analytics phrasing. Static: no DB, no model
// call; the model label is derived from lib/models.ts, never a literal.
export const dynamic = 'force-static'

export default function NotebookStartPage() {
  return (
    <div className={styles.wrap} data-testid="notebook-front-page">
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.mark}>
            M<span className={styles.dot} aria-hidden="true" />RES
          </span>
          <span className={styles.sub}>Medical-Record Eval Sandbox</span>
        </div>
        <div className={styles.model} data-testid="front-model-label">
          <span className={styles.led} aria-hidden="true" />
          {modelDisplayName(GENERATION_MODEL)} · free tier
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.hero}>
          <div className={styles.eyebrow}>Synthetic clinical evals</div>
          <h1 className={styles.title}>
            Prove your prompt
            <br />
            <span className={styles.grey}>reads one chart right.</span>
          </h1>
          <p className={styles.lede}>
            Write a prompt against a synthetic patient chart. <b>Build an eval that proves it
            works</b> — then watch it catch the model getting one wrong.
          </p>

          <div className={styles.blurb} data-testid="front-honesty">
            <p className={styles.note}>
              <span className={styles.tag}>honest</span>
              Every chart here is fully synthetic — Synthea C-CDA, no real PHI. Synthetic records
              are cleaner than real ones, so a prompt that works here still has real-world edges to
              find.
            </p>
          </div>

          <div className={styles.actions}>
            <Link
              href="/notebook"
              className={styles.btn}
              data-testid="action-open-sandbox"
            >
              Open the sandbox
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>
            <Link
              href="/notebook?example=1"
              className={styles.btn}
              data-testid="action-worked-example"
            >
              Load the worked example
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <span>fully synthetic · no real PHI</span>
        <span>Synthea C-CDA</span>
      </footer>
    </div>
  )
}
