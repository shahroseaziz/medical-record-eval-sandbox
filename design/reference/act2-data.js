/* ============================================================
   Act 2 — "Bring your own prompt" correctness playground data.
   Canonical case: return a JSON medication list for every
   patient with HbA1c > 8.0. All synthetic.
   Exposes window.ACT2.
   ============================================================ */
window.ACT2 = (function () {
  // ---- The cohort: diabetic patients, with A1c. Three qualify (>8). ----
  const patients = [
    {
      id: 'p-benally', name: 'Marcus Benally', initials: 'MB', age: 58, sex: 'M',
      a1c: 8.4, qualifies: true,
      record: {
        Labs: ['HbA1c 8.4% · 2026-02-11 · above target', 'eGFR 71 mL/min', 'LDL 96 mg/dL'],
        Medications: [
          'Metformin 1000 mg oral — 1 tablet twice daily · active',
          'Empagliflozin 10 mg oral — 1 daily · active since 2024',
          'Lisinopril 10 mg oral — 1 daily for hypertension · active',
        ],
        Conditions: ['Type 2 diabetes mellitus (E11.9)', 'Essential hypertension (I10)'],
      },
      // ground-truth structured meds (what the record actually says).
      // freq uses clinical abbreviations — semantically equal to the references, textually different.
      truth: [
        { name: 'Metformin', dose: '1000 mg', freq: 'BID' },
        { name: 'Empagliflozin', dose: '10 mg', freq: 'QD' },
        { name: 'Lisinopril', dose: '10 mg', freq: 'QD' },
      ],
      // user's hand-authored reference — Metformin dose is mis-remembered (500 vs 1000)
      seedExpected: [
        { name: 'Metformin', dose: '500 mg', freq: 'twice daily' },
        { name: 'Empagliflozin', dose: '10 mg', freq: 'once daily' },
        { name: 'Lisinopril', dose: '10 mg', freq: 'once daily' },
      ],
      planted: 'dose', // the deliberately-wrong reference field
    },
    {
      id: 'p-crisostomo', name: 'Yolanda Crisostomo', initials: 'YC', age: 64, sex: 'F',
      a1c: 9.1, qualifies: true,
      record: {
        Labs: ['HbA1c 9.1% · 2026-01-28 · markedly elevated', 'Fasting glucose 184 mg/dL'],
        Medications: [
          'Insulin glargine 22 units subcutaneous — nightly · active',
          'Metformin 1000 mg oral — 1 tablet twice daily · active',
        ],
        Conditions: ['Type 2 diabetes mellitus, uncontrolled (E11.65)'],
      },
      truth: [
        { name: 'Insulin glargine', dose: '22 units', freq: 'QHS' },
        { name: 'Metformin', dose: '1000 mg', freq: 'BID' },
      ],
      seedExpected: [
        { name: 'Insulin glargine', dose: '22 units', freq: 'nightly' },
        { name: 'Metformin', dose: '1000 mg', freq: 'twice daily' },
      ],
      planted: null,
    },
    {
      id: 'p-okafor', name: 'Dwight Okafor', initials: 'DO', age: 51, sex: 'M',
      a1c: 8.2, qualifies: true,
      record: {
        Labs: ['HbA1c 8.2% · 2026-02-03 · above target', 'Triglycerides 210 mg/dL'],
        Medications: [
          'Metformin 500 mg oral — 1 tablet twice daily · active',
          'Sitagliptin 100 mg oral — 1 daily · active',
          'Atorvastatin 40 mg oral — 1 nightly · active',
        ],
        Conditions: ['Type 2 diabetes mellitus (E11.9)', 'Mixed hyperlipidemia (E78.2)'],
      },
      truth: [
        { name: 'Metformin', dose: '500 mg', freq: 'BID' },
        { name: 'Sitagliptin', dose: '100 mg', freq: 'QD' },
        { name: 'Atorvastatin', dose: '40 mg', freq: 'QHS' },
      ],
      seedExpected: [
        { name: 'Metformin', dose: '500 mg', freq: 'twice daily' },
        { name: 'Sitagliptin', dose: '100 mg', freq: 'once daily' },
        { name: 'Atorvastatin', dose: '40 mg', freq: 'nightly' },
      ],
      planted: null,
    },
    // a non-qualifying patient, shown filtered OUT to make the cohort logic legible
    {
      id: 'p-reyes', name: 'Pilar Reyes', initials: 'PR', age: 47, sex: 'F',
      a1c: 6.4, qualifies: false,
      record: { Labs: ['HbA1c 6.4% · 2026-02-09 · at target'], Medications: ['Metformin 500 mg — 1 twice daily'] },
      truth: [], seedExpected: [], planted: null,
    },
  ];

  const DEFAULT_GEN_PROMPT =
    'For each patient with HbA1c greater than 8.0, return their ACTIVE medications as a JSON array. ' +
    'Each item: { "name", "dose", "freq" }. Use only the record. Output JSON only.';

  // schema fields the user can include
  const schemaFields = [
    { key: 'name', label: 'name', type: 'string', required: true, example: '"Metformin"' },
    { key: 'dose', label: 'dose', type: 'string', required: false, example: '"1000 mg"' },
    { key: 'freq', label: 'freq', type: 'string', required: false, example: '"twice daily"' },
  ];

  // ---- Deterministic diff between expected[] and actual[] ----
  // matches by normalized name; compares included fields.
  function norm(s) { return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' '); }

  // Semantic frequency equivalence — what a correctness JUDGE "understands"
  // but an exact string diff cannot. "BID" === "twice daily" === "2x daily".
  function freqNorm(s) {
    const t = norm(s);
    const map = {
      'qd': 'once daily', 'daily': 'once daily', 'once daily': 'once daily', '1 daily': 'once daily',
      'every day': 'once daily', 'q day': 'once daily', 'od': 'once daily',
      'bid': 'twice daily', 'twice daily': 'twice daily', '2x daily': 'twice daily', 'two times daily': 'twice daily', 'q12h': 'twice daily',
      'tid': 'three times daily', 'three times daily': 'three times daily',
      'qhs': 'nightly', 'nightly': 'nightly', 'at night': 'nightly', 'at bedtime': 'nightly', 'qpm': 'nightly',
    };
    return map[t] || t;
  }

  // judgeFields: array of field keys scored SEMANTICALLY (by a judge) instead of by exact match.
  function diff(expected, actual, fields, judgeFields) {
    const jf = judgeFields || [];
    const byName = (arr) => Object.fromEntries(arr.map((m) => [norm(m.name), m]));
    const E = byName(expected), A = byName(actual);
    const names = Array.from(new Set([...Object.keys(E), ...Object.keys(A)]));
    const rows = names.map((n) => {
      const e = E[n], a = A[n];
      // e present, a absent  => the model DROPPED a med that's in your reference => MISSING (false negative)
      if (!a) return { name: e.name, status: 'missing', fields: {} };
      // a present, e absent  => the model ADDED a med not in your reference   => EXTRA   (false positive)
      if (!e) return { name: a.name, status: 'extra', fields: {} };
      const fr = {};
      let ok = true;
      fields.forEach((f) => {
        if (f === 'name') { fr.name = { e: e.name, a: a.name, match: norm(e.name) === norm(a.name) }; return; }
        const judged = jf.includes(f);
        const match = judged ? freqNorm(e[f]) === freqNorm(a[f]) : norm(e[f]) === norm(a[f]);
        fr[f] = { e: e[f], a: a[f], match, judged };
        if (!match) ok = false;
      });
      return { name: a.name, status: ok ? 'match' : 'mismatch', fields: fr };
    });
    const perfect = rows.every((r) => r.status === 'match');
    return { rows, perfect };
  }

  return { patients, DEFAULT_GEN_PROMPT, schemaFields, diff, norm, freqNorm };
})();
