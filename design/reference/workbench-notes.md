# The open workbench — design notes

## The hardest tension: open without empty

An open bench is the right answer and the dangerous one. The same property that makes it a *playground* — three independent knobs, no rails, start anywhere — is what makes a blank one **terrifying to a beginner and useless on first load**. A guided lesson can't feel empty because it always tells you the next move; a bench, by definition, doesn't. That's the core conflict: **agency vs. a cold start.**

Where it bites, concretely:
- **The empty evaluator.** "Author your scorer" is the most powerful knob and the one a newcomer has no instinct for. A blank judge-prompt box is the black box all over again, just relocated.
- **The empty cases.** "Pick patients and author expected outputs" assumes you already know what a good test case is — the exact thing the guided lesson exists to teach.
- **No win condition.** With no fork and no rails, nothing says "you did it." Open-endedness removes the dopamine of completion.

## How the layouts resolve it

The bench shouldn't *teach* (the guided lessons do that) — it should **arrive pre-loaded with a living example you mutate**, not a blank form you fill. The strategy across all three concepts:

1. **Never start empty — start from the lesson's last state.** The user lands on the bench with the prompt, the 3 cases, and the evaluator they just built in the guided flow already in place, results showing. The first act is *changing* something, not *creating* something. Editing has a floor that authoring doesn't.
2. **Defaults that are opinions.** Every knob ships with a sensible, labeled default (diff for structured fields, a starter judge prompt for fuzzy ones). The newcomer sees a *working* configuration and a legible set of choices, not a void.
3. **The atoms are always named on the surface.** Concept A and B keep "Prompt / Cases / Evaluator · atom 1·2·3" visible so the structure itself is the scaffolding — you're never lost about *what kind of thing* each knob is.
4. **A reproducible aha, not a scripted one.** The red `dose` cell (Concept C) lets the reference-was-wrong moment happen again on the user's own terms — discovery, not a rail.

## Lean

- **Concept B (pipeline)** is the best *on-ramp* to the bench — it teaches the 3-atom structure by its literal shape and makes "diff vs judge" a visible knob rather than a hidden fork.
- **Concept A (panels)** is the best *daily driver* — the whole machine at a glance, closest to a real tool.
- **Likely answer: B collapses into A.** Land on the pipeline (legible), let it expand into the three-panel bench (powerful) as the user gains confidence — the same hybrid instinct that worked for the guided flow.
- **Concept C (grid)** is the right *results view inside* A — not a separate bench.

The fork is demoted to a one-line teaching beat at the end of the guided lessons ("you've now done both kinds"); the bench then opens with both evaluator types available as knobs.
