# Structured-diff scorer — normalization contract (appendix)

The `structured-diff` scorer is a **deterministic, client-side (free),
field-by-field** reference comparison of a structured medication list against a
hand-authored expected list. It is the prototype's per-field `{ name, dose }`
compare — **not** `contains`.

| | `contains` | `structured-diff` |
|---|---|---|
| Unit of comparison | one flat string | per item, per field |
| Semantics | set membership ("is each token present?") | field diff (match / mismatch / missing / extra) |
| False-neg / false-pos | not distinguished | explicit `missing` / `extra` |
| Cost | free | free |

A field diff is only meaningful if two values that mean the same clinical thing
normalize to the same canonical form **before** they are compared. Those rules
live in `structured-diff-normalization.ts` and are specified here. They are the
contract: change the table, change the scores.

---

## 1. Canonical-unit table

Doses are parsed into `value + unit`, then the unit is resolved to a **canonical
unit** and the value scaled by the table factor. Two doses are equal iff they
share a canonical unit and their scaled magnitudes are equal (within float
epsilon). Cross-dimension comparisons (mass vs volume) are always a mismatch.

| Dimension | Canonical unit | Aliases → factor (to canonical) |
|---|---|---|
| Mass | `mg` | `mg`/`milligram(s)` ×1 · `g`/`gm`/`gram(s)` ×1000 · `mcg`/`ug`/`µg`/`microgram(s)` ×0.001 · `kg` ×1e6 · `ng`/`nanogram(s)` ×1e-6 |
| Volume | `mL` | `ml`/`milliliter(s)`/`millilitre(s)`/`cc` ×1 · `l`/`liter(s)`/`litre(s)` ×1000 |
| Activity | `unit` | `unit(s)`/`iu` ×1 |
| Electrolyte | `meq` | `meq`/`milliequivalent(s)` ×1 |
| Amount of substance | `mmol` | `mmol` ×1 |
| Fraction | `%` | `%`/`percent` ×1 |
| Dose forms | `tablet`,`capsule`,`puff`,`spray`,`drop` | `tab(s)`→`tablet` · `cap(s)`→`capsule` · etc. |

So `500 mg` == `0.5 g` == `500000 mcg`; `5 mg` != `5 mL`.

**Compound / concentration units** (`mg/mL`): each side of the slash is
alias-normalized, but **no magnitude conversion is performed across the slash**.
`10 mg/mL` and `10 mg/ml` match; `10 mg/mL` and `1 g/100mL` do **not**. This is a
documented blind spot, surfaced (see §4).

## 2. Drug-name alias resolution

Strategy is **purely lexical salt-suffix stripping**:

1. lowercase, replace any non-alphanumeric run with a single space, collapse;
2. iteratively drop a **trailing** salt / ester / hydrate token
   (`hcl`, `hydrochloride`, `sodium`, `potassium`, `sulfate`, `succinate`,
   `besylate`, `mesylate`, `maleate`, `monohydrate`, … — full set in code);
3. **never strip the last remaining token** (a drug literally named `sodium`
   survives);
4. **never strip the anion off an electrolyte / mineral salt.** If a strip would
   expose a bare mineral cation (`sodium`, `potassium`, `calcium`, `magnesium`,
   `lithium`, `iron`/`ferrous`/`ferric`, `zinc`, … — `MINERAL_TOKENS`), it is
   refused. For these meds the anion is part of the drug identity:
   `potassium chloride` ≠ `potassium citrate`, `magnesium sulfate` ≠ `magnesium`.
   This is **systematic, not rare** — electrolyte salts are common — so it is
   mitigated in code, not just documented.
5. **every strip that alters a name is recorded.** The dropped tokens are
   returned (`NameResolution.strippedSalts`) and the scorer emits a per-case
   blind spot, so a lexical merge that could mask a clinically distinct salt is
   visible at scoring time — never silent.

| Input | Canonical | Note |
|---|---|---|
| `Metformin` | `metformin` | — |
| `Metformin HCl` | `metformin` | blind spot: dropped `hcl` |
| `Metformin hydrochloride` | `metformin` | blind spot: dropped `hydrochloride` |
| `Amlodipine besylate` | `amlodipine` | blind spot: dropped `besylate` |
| `Metoprolol succinate` | `metoprolol` | blind spot: dropped `succinate` |
| `Sodium` | `sodium` | last token never stripped |
| `Potassium chloride` | `potassium chloride` | mineral salt preserved |
| `Magnesium sulfate` | `magnesium sulfate` | mineral salt preserved |

## 3. Duplicate-name collapse rule

Applied **within one list** (expected or actual), after normalization:

- Entries with the **same canonical name AND same canonical dose** collapse to a
  single entry — a true duplicate.
- Entries with the **same canonical name but a different canonical dose** are
  **kept as distinct entries** (multiple strengths of one drug are clinically
  valid) and the name is reported in `duplicateNameGroups` / `blindSpots` so the
  reviewer sees the multi-strength situation rather than having it silently
  merged or dropped.

Matching across lists then pairs same-name entries greedily: exact dose matches
first, leftovers paired by order as dose mismatches, remaining expected →
`missing`, remaining actual → `extra`.

## 4. Scoring & blind spots

- **`match`** → true positive · **`mismatch`** → false pos + false neg ·
  **`missing`** → false negative · **`extra`** → false positive.
- **score = F1** over field-level matches, so both missed expected fields
  (recall) and spurious extra fields (precision) are penalized.
- **Empty vs empty is a true negative.** When the expected list is empty and the
  model also produces an empty list ("patient has no meds"), F1 is vacuously
  perfect — the scorer returns **score 1**, not an error. A patient-with-no-meds
  golden case is a first-class, scorable case.
- Every normalization limitation hit on a case is pushed to `blindSpots[]`
  (deduped):
  - unparseable dose strings (fell back to text equality),
  - multi-strength duplicate names (kept distinct, not merged),
  - **compound / concentration doses** (`mg/mL`) — emitted whenever such a dose
    participates in a comparison, since magnitudes are not converted across the
    slash,
  - **salt strips that altered a name** — emitted with the dropped tokens, since
    a lexical merge could mask a clinically distinct salt.

### Known blind spots (by design, surfaced not hidden)

- **No brand↔generic mapping.** `Tylenol` ≠ `acetaminophen`; lexical only. A
  false-negative source.
- **Salt stripping is heuristic.** It can merge two distinct salts that differ
  clinically. Electrolyte / mineral salts (the systematic case) are protected by
  the mineral-cation rule (§2.4); every other strip that alters a name is
  surfaced as a per-case blind spot (§2.5) rather than hidden.
- **Compound units are not magnitude-converted** across the slash, and this is
  surfaced per comparison.
- **Frequency / route / form beyond the dose field are out of scope** — the
  contract compares `{ name, dose }`.

## 5. Thresholds

The F1 acceptance floor is read from config (`evals/thresholds.yaml` →
`structured_diff`), never hardcoded. It is a placeholder (`0.0`) until structured
golden cases are authored, per the evals discipline (thresholds gate and live in
config).
