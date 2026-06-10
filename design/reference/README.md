# Design reference — canonical UX/visual prototypes

The **final, canonical** design-prototype artifacts for the correctness-first redesign,
curated from the design exploration of 2026-06-08/09 (the `MRES Design 20260608 1318PM PT`
iteration — the last one before build). Copied here so builders (human or factory) can
actually read the design they are implementing.

## What this reference IS authoritative for

- **Interaction architecture** — the app-like shell: the lesson is a *stepper journey*
  (`Match → Meaning → Grounding`), **one beat on screen at a time** with a persistent
  journey rail, not a stacked scroll page. The workbench *lands as a pipeline and expands
  into three atom panels*. Graduation is a gated win-moment.
- **Visual language** — `tokens.css` is the design system: the violet clinical-calm
  accent family, type stack (Schibsted Grotesk / Geist / Geist Mono), spacing, radii,
  pill badges, score rings. New surfaces should consume these tokens, not invent values.
- **Copy tone & teaching devices** — glosses (plain line first, real definition second),
  the honesty banners, the eyebrow/heading rhythm.

## What this reference is NOT authoritative for

- **Eval semantics, scorer logic, data models** — these prototypes fake their data and
  contain simplified scoring. The production truth lives in `src/lib/eval/` and the
  REDESIGN-SPEC. If a prototype file disagrees with `src/`, **`src/` wins**.
- **The faithfulness-first teaching order** — superseded. The shipped pedagogy is
  correctness-first (Beat 1 diff → Beat 2 reference judge → Beat 3 faithfulness).
  Earlier iterations with other orderings were deliberately NOT copied here.

## File map

| File | Shows |
|---|---|
| `tokens.css` | The design system (use these custom properties) |
| `components.jsx` | Shared primitives: Gloss, ScoreRing, stepper, badges, buttons |
| `correctness-first.jsx` | Lesson shell: the 3-stop stepper + Beat 1 (authoring, diff, both endings) |
| `correctness-first2.jsx` | Beat 2 (prose contrast), Beat 3 (faithfulness capstone), graduation |
| `act2-data.js` | The cohort/fixture shapes the lesson prototypes render (fake data) |
| `bench.jsx` | Workbench: pipeline landing → expand to panels orchestration |
| `bench-panels.jsx` | Workbench panels: atom chrome, evaluator palette, per-field chips, results grid |
| `bench-data.js` | Bench prototype data incl. the faithfulness-reshape fixture (fake) |
| `*-notes.md` | Design rationale: open-without-empty, correctness-first foil, tensions |
| `shots/*.png` | Rendered look: bench panels, correctness surface, on-ramp aesthetic |

## Build hygiene

This directory is **reference only**: excluded from typechecking, linting, tests, and
Vercel deploys (see `tsconfig.json` excludes, `eslint.config.mjs` ignores, `.vercelignore`).
The `.jsx` files reference globals (`window.ACT2`, CDN React) and will not compile in this
app — by design. Do not import from `design/`.
