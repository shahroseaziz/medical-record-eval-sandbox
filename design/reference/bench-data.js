/* ============================================================
   Open Workbench data layer.
   Extends ACT2 with: allergy records (for faithfulness mode),
   the model's allergy answers + grounded/ungrounded claims,
   prompt presets, and an initial pre-loaded bench state
   (carried over from the guided lesson's last state).
   Exposes window.BENCH.
   ============================================================ */
window.BENCH = (function () {
  const A2 = window.ACT2;
  const cohort = A2.patients.filter((p) => p.qualifies);

  /* ---- Allergy layer for FAITHFULNESS mode (no expected answer) ---- */
  // Each patient: record allergies (source of truth) + the model's free-text
  // answer decomposed into claims the judge checks against the record.
  const allergy = {
    'p-benally': {
      record: ['Penicillin — reaction: hives (moderate) · onset 2009'],
      answer: 'The patient is allergic to penicillin (hives) and also has an aspirin sensitivity.',
      claims: [
        { t: 'Allergic to penicillin (hives)', grounded: true,  why: 'Stated in the record.' },
        { t: 'Has an aspirin sensitivity',     grounded: false, why: 'Nothing about aspirin appears in the record — invented.' },
      ],
    },
    'p-crisostomo': {
      record: ['No known drug allergies'],
      answer: 'No known drug allergies are documented for this patient.',
      claims: [
        { t: 'No known drug allergies', grounded: true, why: 'Matches the record exactly.' },
      ],
    },
    'p-okafor': {
      record: ['Sulfa drugs — reaction: rash (mild) · onset 2017'],
      answer: 'The patient is allergic to sulfa drugs, which cause a rash.',
      claims: [
        { t: 'Allergic to sulfa drugs (rash)', grounded: true, why: 'Stated in the record.' },
      ],
    },
  };
  function faithScore(pid) {
    const c = allergy[pid].claims;
    return c.filter((x) => x.grounded).length / c.length;
  }

  /* ---- Prompt presets (atom 1 knob default + alternatives) ---- */
  const promptPresets = [
    { id: 'meds-json', label: 'Meds → JSON (from your lesson)', forMode: 'correctness',
      text: A2.DEFAULT_GEN_PROMPT },
    { id: 'meds-grounded', label: 'Meds → JSON · strict grounding', forMode: 'correctness',
      text: 'For each patient with HbA1c > 8.0, return active medications as a JSON array of { "name", "dose", "freq" }. Copy dose and frequency VERBATIM from the record. Output JSON only.' },
    { id: 'allergies', label: 'List allergies (free text)', forMode: 'faithfulness',
      text: 'List this patient\'s documented drug allergies in one sentence. Use only the record.' },
  ];

  /* ---- Evaluator palette: the three real-world eval types ---- */
  const evalTypes = [
    { id: 'diff',  name: 'Deterministic match', icon: 'scale', when: 'structured output, you know exactly what\'s right', cost: 'free · instant' },
    { id: 'judge', name: 'Reference judge',      icon: 'flask', when: 'you have an expected answer but it\'s fuzzy/prose', cost: 'tokens · compares meaning' },
    { id: 'faith', name: 'Faithfulness judge',   icon: 'target', when: 'no expected answer — check output against the source', cost: 'tokens · must be calibrated' },
  ];

  /* ---- Initial bench state: PRE-LOADED from the lesson's last state ----
     prompt = meds→JSON · cases = the 3 A1c>8 patients · evaluator =
     per-field diff, with the answer key the user fixed in Beat 1 (dose
     corrected to the record). freq is included and defaults to diff, so a
     live BID-vs-"twice daily" red cell is reproducible in the grid. ---- */
  function initialState() {
    const expected = {};
    cohort.forEach((p) => {
      expected[p.id] = p.truth.map((m) => ({
        name: m.name,
        dose: m.dose,                 // corrected to the record (lesson end state)
        freq: seedFreq(p.id, m.name), // worded freq — semantically equal, textually different from truth's abbrev
      }));
    });
    return {
      mode: 'correctness',
      promptId: 'meds-json',
      prompt: A2.DEFAULT_GEN_PROMPT,
      caseIds: cohort.map((p) => p.id),
      schema: ['name', 'dose', 'freq'],
      fieldEval: { name: 'diff', dose: 'diff', freq: 'diff' }, // freq diff = the reproducible red cell
      expected,
    };
  }
  // worded frequencies the user "wrote" (vs the record's clinical abbreviations)
  function seedFreq(pid, name) {
    const p = cohort.find((x) => x.id === pid);
    const m = (p.seedExpected || []).find((x) => x.name === name);
    return m ? m.freq : 'once daily';
  }

  return { A2, cohort, allergy, faithScore, promptPresets, evalTypes, initialState, diff: A2.diff };
})();
