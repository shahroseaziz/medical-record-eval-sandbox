# The open bench — the one place it still felt cold

Built and clicking through, the "open without empty" resolution mostly holds: landing pre-loaded on the pipeline with results already showing means the first act is *mutating a living example*, and that defuses the blank-form dread we feared. But there's one seam where it still goes cold, and it's the thing the build spec needs to solve.

## The cold spot: changing the *prompt* has no honest consequence

Every other knob gives immediate, truthful feedback:
- Toggle **freq → judge** and three red cells turn green in front of you.
- Switch to **faithfulness** and the whole surface visibly reshapes.
- Add/remove a **case** and the grid grows or shrinks.

But the **prompt textarea** — atom 1, the thing the whole eval supposedly exists to measure — is the one knob whose edits *can't* actually re-run a model in a canned prototype. You can rewrite the prompt, but the model's outputs are fixtures; the grid won't move. In the lesson that was fine because the prompt was fixed. On an *open bench* it's the central lie: we tell the user "change any atom and re-grade," then the most important atom is the one that doesn't really respond. A sharp user will edit the prompt, hit nothing, and feel the floor was painted on.

We papered over it with **prompt presets** (the two "Meds → JSON" chips do swap real fixture sets), so there's *a* response — but it's a multiple-choice prompt, not an open one. The moment you free-type, the bench is inert.

## Why this is the spec's problem, not a prototype patch

This is exactly the boundary where prototyping should stop. Faking it further (pre-canning a tree of prompt variants) would be more scaffolding lying about openness — the opposite of the lesson. The honest fix requires the real thing: **a live generation call.** In the Next.js build, editing the prompt must actually re-run Haiku over the selected records and re-diff the result. That's the single feature that converts the bench from "a configurator with a prompt-shaped decoration" into a genuine playground.

So the build spec's first-priority item: **the prompt atom is the only knob that needs a real backend round-trip; everything else (diff, per-field assignment, faithfulness reshape, record inspection, the red-cell explainer) is honestly client-side and already proven here.** Scope the server work to exactly that, and the "open without empty" promise becomes true instead of mostly-true.

## Secondary chill (minor): the cohort feels small

Three cases makes the grid legible for teaching, but an "open bench" invites scale, and three rows can read as still-a-lesson. Not worth solving in the prototype — but the spec should let the corpus and cohort grow (paginate the grid, sample N), so the bench *feels* like a workbench and not a worksheet once the prompt is live.
