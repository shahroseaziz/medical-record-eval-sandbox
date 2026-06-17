# Notebook design reference (MRES v3) — canonical UX/visual prototypes

The **final, canonical** design-prototype artifacts for the **v3 notebook rebuild** —
the single-scroll, Colab-style sandbox that razes the workbench surface and keeps the
engine. Pulled via DesignSync from the `MRES v2` claude.ai/design project (the iteration
that closed the 4-round design exploration of 2026-06-12). Copied here so builders (human
or factory) can read the design they are implementing **without reaching the design tool**.

## Authority boundary (READ FIRST)

This reference is authoritative for **visual language and interaction ONLY**. It is **NOT**
authoritative for **data shapes or eval semantics** — those come from `src/` and the
production engine.

**What this reference IS authoritative for:**

- **Interaction architecture** — the single-scroll notebook: header (wordmark, BYO-key
  slot, always-visible model identity, key-gated picker) → data strip + Explore drawer →
  prompt cell → streaming output cards with a "what the model saw" receipt → the
  progressively-added eval layer (golden, then judge) → the score line that expands into
  the runs×evals grid. The 1×1 path stays visually identical to the simple trail; depth
  appears only when you add a second run or a second eval. The drawer is a fixed-position
  slide-over (the flex-sibling collapse was tried and rejected in design round 1).
- **Visual language** — type stack, color/accent family, spacing, radii, pill badges,
  score chips/rings, the card and cell chrome, the front-page two-action layout. New
  surfaces should consume the prototype's visual system, not invent values.
- **Copy tone & teaching devices** — the plain-language glosses, the honesty banners, the
  receipt's "full chart · fit in context" vs "retrieved sections · chart too large"
  framing, the no-chooser eval invite, the "a mismatch is a lead, not a verdict" register,
  the forgiveness copy. The four-word lexicon (example input · golden answer · model
  output · score) is the vocabulary cap — the banned words (faithfulness, grounding,
  rubric, knob, calibration, atom) never appear on the user path.

**What this reference is NOT authoritative for:**

- **Data models, API shapes, eval scoring, storage schema** — the prototypes fake their
  data (`data.js` is a deterministic synthetic generator) and simplify scoring. The
  production truth lives in `src/`: the bench-state schema in `src/lib/notebook/state.ts`,
  golden normalization in `src/lib/eval/normalize.ts`, model identity in `src/lib/models.ts`,
  the `/api/run` context manifest, `/api/score` single-call criteria verdict, and
  `/api/patients?all=1`. **If a prototype disagrees with `src/`, `src/` wins.** In
  particular: the prototype's scoring math, judge-call counts, and context-mode flags are
  illustrative — implement them against the engine and the issue's inlined spec, never by
  reading numbers off the prototype.
- **Patient corpus** — `data.js` is fake (Synthea-style synthetic names + a chart
  generator) and exists only so the prototype renders standalone. The real corpus is the
  ingested pgvector seed; column shapes come from the ingest/patients API, not `data.js`.

## File map

| File | Shows (visual/interaction reference for) |
|---|---|
| `Front Page.html` | The minimal front page: two co-equal actions, honest copy, no cohort phrasing |
| `MRES Sandbox.html` | The notebook harness — full single-scroll layout; loads the `.jsx`/`data.js` below via CDN React + Babel |
| `app.jsx` | Root app: header, data strip, notebook shell, the runs×evals model, drawer wiring |
| `drawer.jsx` | Explore drawer: patient table → parsed chart → raw-XML toggle (slide-over chrome) |
| `cells.jsx` | Notebook cells: prompt, output cards, eval (golden + judge), score line |
| `eval.jsx` | Eval section: golden answers + LLM judges, versioning, the runs×evals grid + trust markers |
| `worked.jsx` | Worked-example judge leg: a prose-output query graded by a judge, shown finished |
| `util.jsx` | Shared prototype helpers (attached to `window`) — visual primitives, not production utils |
| `data.js` | FAKE deterministic synthetic corpus + chart/XML generators (prototype data only) |

## Build hygiene

This directory is **reference only** and is excluded from typechecking, linting, tests, and
Vercel deploys. The exclusion is **inherited from the parent `design/` rules** — no per-file
config is needed:

- `tsconfig.json` → `"exclude": ["node_modules", "design"]`
- `eslint.config.mjs` → `{ ignores: ['design/**'] }`
- `.vercelignore` → `design/`
- `vitest.config.ts` → tests are an allowlist (`src/**`, `evals/**`); `design/**` is never collected.

The `.jsx`/`.html` files reference CDN globals (`window.MRES_DATA`, CDN React, Babel-standalone)
and **will not compile in this app — by design**. Do **not** import from `design/`.

## Related

The sibling `design/reference/` (the parent directory) holds the **older cycle-3 workbench**
design prototypes. That surface is being razed by the notebook rebuild and its reference
folder is removed in the deletion-cut step (N19) along with the workbench code. Until then,
both reference sets coexist; **this `notebook/` folder is the authority for the v3 build.**
