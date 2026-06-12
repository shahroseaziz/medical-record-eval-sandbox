export const dynamic = 'force-static'

import Link from 'next/link'
import { REPO_URL } from '@/lib/site'
import styles from './page.module.css'

/**
 * The front door (SHA-73 R17). `/` used to render the v1 single-page workspace;
 * it now routes by persona. Two clear paths — "Learn evals" (novice, primary →
 * `/lesson`) and "Open the workbench" (practitioner → `/workbench`) — plus a quiet
 * link to the re-homed classic workspace (`/workspace`). Static: no DB, no model
 * call. Visual language per design/reference/tokens.css + shots/onramp.png.
 */
export default function Home() {
  return (
    <main className={styles.page} data-testid="landing-page">
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link href="/" className={styles.brand} data-testid="landing-brand">
            <span className={styles.brandMark} aria-hidden="true">
              ⚖
            </span>
            Eval Sandbox
          </Link>
        </div>
      </header>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>A hands-on teaching sandbox for AI evals</p>
        <h1 className={styles.title}>Measure whether an AI actually did its job.</h1>
        <p className={styles.lede}>
          An <span className={styles.accent}>eval</span> is how you check an AI&apos;s work on
          purpose, instead of eyeballing it. Build small ones here over synthetic patient records,
          run them, and watch yourself catch a model making something up.
        </p>
        <ul className={styles.chips}>
          <li className={styles.chip}>
            <span className={styles.chipDot} aria-hidden="true" />
            Synthetic records only — never a real patient
          </li>
          <li className={styles.chip}>
            <span className={styles.chipDot} aria-hidden="true" />
            No sign-up, nothing to install
          </li>
        </ul>
      </section>

      <section className={styles.routes} aria-label="Choose a path">
        <Link
          href="/lesson"
          className={`${styles.route} ${styles.routePrimary}`}
          data-testid="route-lesson"
        >
          <span className={styles.routeEyebrow}>Start here · ten minutes</span>
          <span className={styles.routeTitle}>
            Learn evals
            <span className={styles.routeArrow} aria-hidden="true">
              →
            </span>
          </span>
          <p className={styles.routeBlurb}>
            A guided walk-through that builds one eval from scratch and ends with you catching a real
            dose error. No prior background assumed.
          </p>
          <span className={styles.routeMeta}>Best if evals are new to you.</span>
        </Link>

        <Link href="/workbench" className={styles.route} data-testid="route-workbench">
          <span className={styles.routeEyebrow}>For practitioners</span>
          <span className={styles.routeTitle}>
            Open the workbench
            <span className={styles.routeArrow} aria-hidden="true">
              →
            </span>
          </span>
          <p className={styles.routeBlurb}>
            Prompt, cases, and evaluator as free knobs. Swap the evaluator, slide the rubric, edit
            the generation prompt, and re-run live.
          </p>
          <span className={styles.routeMeta}>Best if you already know what an eval is.</span>
        </Link>
      </section>

      <footer className={styles.footer}>
        <hr className={styles.footerRule} />
        <p className={styles.footerText}>
          {/* O12b: the classic workspace is retired — the bench reached parity and
              /workspace now 301s there. The worked example stays. */}
          Read a{' '}
          <Link href="/example" className={styles.footerLink} data-testid="example-link">
            worked example run
          </Link>
          .
        </p>
        <p className={styles.footerText}>
          Every prompt, scorer, and seeded case in here is open source —{' '}
          <a
            href={REPO_URL}
            className={styles.footerLink}
            data-testid="repo-link"
            target="_blank"
            rel="noreferrer"
          >
            read the whole thing on GitHub
          </a>
          .
        </p>
      </footer>
    </main>
  )
}
