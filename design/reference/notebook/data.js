/* MRES synthetic corpus — 111 Synthea-style C-CDA patients + a chart generator.
   Everything is deterministic so the table, charts and raw XML are stable across reloads.
   This is FAKE data. Names carry Synthea's numeric suffixes on purpose. */
(function () {
  // --- deterministic PRNG -------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const pint = (r, a, b) => a + Math.floor(r() * (b - a + 1));
  const round = (n, d = 0) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };

  // --- name pools (Synthea-style with numeric suffixes) -------------------
  const FIRST_M = ["Aaron", "Carlos", "Dwight", "Edmund", "Forest", "German", "Harlan", "Isaias", "Jamel", "Kareem", "Lonnie", "Mervin", "Normand", "Orval", "Porfirio", "Quinton", "Rolland", "Santos", "Tomas", "Ulysses", "Vince", "Wilbur"];
  const FIRST_F = ["Adriana", "Bernardine", "Cleta", "Delpha", "Earlean", "Frieda", "Gracie", "Hortencia", "Iva", "Jovita", "Karyn", "Lashawn", "Maryann", "Nakisha", "Ozella", "Particia", "Raylene", "Shanell", "Tonita", "Vada", "Willodean", "Yolanda"];
  const LAST = ["Brekke", "Mraz", "Hilll", "Konopelski", "Larson", "Wisozk", "Hahn", "Schimmel", "Renner", "Stehr", "Wuckert", "Howe", "Beahan", "Lakin", "Bartell", "Dare", "Pfannerstill", "Towne", "Olson", "Bahringer", "Reilly", "Cremin", "Veum", "Lehner", "Rohan"];

  // --- condition catalog --------------------------------------------------
  // each: label (SNOMED-ish), icd, meds[], labs[]
  const COND = {
    diabetes: { label: "Type 2 diabetes mellitus", icd: "E11.9", meds: ["Metformin 500 MG", "Metformin 1000 MG", "Insulin glargine 100 UNT/ML", "Empagliflozin 10 MG"], labs: ["a1c", "glucose", "egfr"] },
    htn: { label: "Essential hypertension", icd: "I10", meds: ["Lisinopril 10 MG", "Amlodipine 5 MG", "Hydrochlorothiazide 25 MG"], labs: ["sbp", "potassium"] },
    hld: { label: "Hyperlipidemia", icd: "E78.5", meds: ["Atorvastatin 40 MG", "Rosuvastatin 20 MG"], labs: ["ldl", "hdl", "chol", "trig"] },
    chf: { label: "Chronic systolic heart failure", icd: "I50.22", meds: ["Furosemide 40 MG", "Carvedilol 12.5 MG", "Sacubitril/Valsartan 49-51 MG"], labs: ["bnp", "creatinine"] },
    ckd: { label: "Chronic kidney disease, stage 3", icd: "N18.3", meds: ["Sodium bicarbonate 650 MG"], labs: ["creatinine", "egfr", "potassium"] },
    copd: { label: "Chronic obstructive pulmonary disease", icd: "J44.9", meds: ["Tiotropium 18 MCG", "Albuterol 90 MCG inhaler"], labs: [] },
    asthma: { label: "Asthma", icd: "J45.909", meds: ["Fluticasone 110 MCG", "Albuterol 90 MCG inhaler"], labs: [] },
    afib: { label: "Atrial fibrillation", icd: "I48.91", meds: ["Apixaban 5 MG", "Metoprolol 50 MG"], labs: [] },
    hypothy: { label: "Hypothyroidism", icd: "E03.9", meds: ["Levothyroxine 75 MCG"], labs: ["tsh"] },
    depr: { label: "Major depressive disorder", icd: "F33.1", meds: ["Sertraline 100 MG"], labs: [] },
    gerd: { label: "Gastro-esophageal reflux disease", icd: "K21.9", meds: ["Omeprazole 20 MG"], labs: [] },
    oa: { label: "Osteoarthritis of knee", icd: "M17.0", meds: ["Acetaminophen 500 MG", "Naproxen 500 MG"], labs: [] },
    cad: { label: "Coronary artery disease", icd: "I25.10", meds: ["Aspirin 81 MG", "Atorvastatin 80 MG", "Metoprolol 25 MG"], labs: ["ldl"] },
    anemia: { label: "Anemia, unspecified", icd: "D64.9", meds: ["Ferrous sulfate 325 MG"], labs: ["hgb"] },
  };
  const CONDKEYS = Object.keys(COND);

  // --- lab definitions: unit, ref, generator around a base -----------------
  const LABDEF = {
    a1c: { name: "Hemoglobin A1c", loinc: "4548-4", unit: "%", ref: "4.0–5.6", base: [6.4, 9.8] },
    glucose: { name: "Glucose, fasting", loinc: "1558-6", unit: "mg/dL", ref: "70–99", base: [110, 190] },
    egfr: { name: "eGFR", loinc: "33914-3", unit: "mL/min", ref: ">60", base: [38, 88] },
    ldl: { name: "LDL cholesterol", loinc: "2089-1", unit: "mg/dL", ref: "<100", base: [78, 168] },
    hdl: { name: "HDL cholesterol", loinc: "2085-9", unit: "mg/dL", ref: ">40", base: [33, 61] },
    chol: { name: "Total cholesterol", loinc: "2093-3", unit: "mg/dL", ref: "<200", base: [165, 255] },
    trig: { name: "Triglycerides", loinc: "2571-8", unit: "mg/dL", ref: "<150", base: [120, 280] },
    sbp: { name: "Systolic blood pressure", loinc: "8480-6", unit: "mmHg", ref: "<130", base: [122, 168] },
    potassium: { name: "Potassium", loinc: "6298-4", unit: "mmol/L", ref: "3.5–5.1", base: [3.8, 5.3] },
    creatinine: { name: "Creatinine", loinc: "2160-0", unit: "mg/dL", ref: "0.6–1.3", base: [1.0, 2.1] },
    bnp: { name: "BNP", loinc: "30934-4", unit: "pg/mL", ref: "<100", base: [180, 720] },
    tsh: { name: "TSH", loinc: "3016-3", unit: "mIU/L", ref: "0.4–4.0", base: [2.1, 6.4] },
    hgb: { name: "Hemoglobin", loinc: "718-7", unit: "g/dL", ref: "12.0–16.0", base: [9.2, 12.4] },
  };

  const ENC_TYPES = ["Office visit", "Telehealth follow-up", "Annual wellness visit", "Endocrinology consult", "Cardiology follow-up", "Emergency department visit", "Lab-only encounter", "Medication review"];
  const PROVIDERS = ["Dr. A. Reyes", "Dr. M. Okafor", "Dr. P. Lindgren", "Dr. S. Nakamura", "Dr. J. Whitfield", "NP K. Boateng"];

  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function monthsAgo(n) { const d = new Date(2026, 5, 12); d.setMonth(d.getMonth() - n); return d; }

  // --- build a patient ----------------------------------------------------
  function buildPatient(i) {
    const r = mulberry32(1000 + i * 97);
    const sex = r() < 0.5 ? "M" : "F";
    const first = pick(r, sex === "M" ? FIRST_M : FIRST_F) + pint(r, 100, 999);
    const last = pick(r, LAST) + pint(r, 100, 999);
    const age = pint(r, 34, 88);

    // condition set: 1 anchor + extras, weighted toward chronic clusters
    const nC = pint(r, 1, 5);
    const set = new Set();
    // anchors more likely to be common chronic conditions
    const common = ["diabetes", "htn", "hld", "copd", "afib", "ckd", "depr", "gerd", "oa", "hypothy"];
    set.add(pick(r, common));
    while (set.size < nC) set.add(pick(r, CONDKEYS));
    const conds = [...set];

    const mrn = "SYN-" + String(10000 + i * 7 % 90000 + i).slice(0, 5);
    const chartKB = round(38 + conds.length * 14 + r() * 40, 0);

    return { i, mrn, name: first + " " + last, first, last, age, sex, conds, chartKB, _r: 1000 + i * 97 };
  }

  // --- generate the full chart on demand (deterministic) ------------------
  function buildChart(p) {
    const r = mulberry32(p._r + 5);
    // problems
    const problems = p.conds.map((c, idx) => {
      const d = COND[c];
      const onset = monthsAgo(pint(r, 8, 140));
      return { code: d.icd, label: d.label, onset: isoDate(onset), status: "Active" };
    });

    // medications (dedup)
    const medSet = [];
    p.conds.forEach((c) => {
      const opts = COND[c].meds;
      const n = Math.min(opts.length, pint(r, 1, 2));
      const chosen = new Set();
      while (chosen.size < n) chosen.add(pick(r, opts));
      [...chosen].forEach((m) => {
        if (!medSet.find((x) => x.name === m)) {
          medSet.push({ name: m, sig: pick(r, ["1 tab PO daily", "1 tab PO BID", "1 tab PO QHS", "2 puffs INH BID", "1 tab PO QAM"]), start: isoDate(monthsAgo(pint(r, 1, 60))) });
        }
      });
    });

    // labs: gather lab keys from conditions, build a 4-point trend each
    const labKeys = [...new Set(p.conds.flatMap((c) => COND[c].labs))];
    const labs = labKeys.map((k) => {
      const def = LABDEF[k];
      const lo = def.base[0], hi = def.base[1];
      const start = lo + r() * (hi - lo);
      // trend direction
      const dir = pick(r, [-1, -1, 0, 1]); // bias toward improving/stable
      const series = [];
      for (let t = 3; t >= 0; t--) {
        const drift = dir * (3 - t) * (hi - lo) * 0.06;
        let v = start + drift + (r() - 0.5) * (hi - lo) * 0.05;
        const dec = (k === "a1c" || k === "creatinine" || k === "potassium") ? 1 : 0;
        v = round(v, dec);
        series.push({ date: isoDate(monthsAgo(t * 4 + pint(r, 0, 2))), value: v });
      }
      const latest = series[series.length - 1];
      const trend = dir < 0 ? "improving" : dir > 0 ? "worsening" : "stable";
      return { key: k, name: def.name, loinc: def.loinc, unit: def.unit, ref: def.ref, value: latest.value, date: latest.date, trend, series };
    });

    // encounters
    const nEnc = pint(r, 3, 7);
    const encounters = [];
    for (let e = 0; e < nEnc; e++) {
      encounters.push({
        date: isoDate(monthsAgo(e * 3 + pint(r, 0, 2))),
        type: pick(r, ENC_TYPES),
        provider: pick(r, PROVIDERS),
        reason: pick(r, [COND[p.conds[0]].label, "Routine chronic care", "Medication titration", "Symptom evaluation"]),
      });
    }
    encounters.sort((a, b) => b.date.localeCompare(a.date));

    return { problems, medications: medSet, labs, encounters };
  }

  // --- raw C-CDA-ish XML snippet ------------------------------------------
  function buildXML(p, chart) {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const probEntries = chart.problems.map((pr) => `      <entry>
        <observation classCode="OBS" moodCode="EVN">
          <code code="${pr.code}" codeSystem="2.16.840.1.113883.6.90" displayName="${esc(pr.label)}"/>
          <effectiveTime><low value="${pr.onset.replace(/-/g, "")}"/></effectiveTime>
          <value xsi:type="CD" code="${pr.code}" displayName="${esc(pr.label)}"/>
          <statusCode code="active"/>
        </observation>
      </entry>`).join("\n");
    const medEntries = chart.medications.slice(0, 3).map((m) => `      <substanceAdministration classCode="SBADM" moodCode="EVN">
        <consumable><manufacturedProduct><manufacturedMaterial>
          <name>${esc(m.name)}</name>
        </manufacturedMaterial></manufacturedProduct></consumable>
        <text>${esc(m.sig)}</text>
      </substanceAdministration>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <recordTarget><patientRole>
    <id extension="${p.mrn}" root="2.16.840.1.113883.19.5"/>
    <patient>
      <name><given>${esc(p.first)}</given><family>${esc(p.last)}</family></name>
      <administrativeGenderCode code="${p.sex}"/>
      <birthTime value="${2026 - p.age}0000"/>
    </patient>
  </patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <code code="11450-4" displayName="Problem List"/>
      <title>Problems</title>
${probEntries}
    </section></component>
    <component><section>
      <code code="10160-0" displayName="Medications"/>
      <title>Medications</title>
${medEntries}
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
  }

  // --- build the corpus ---------------------------------------------------
  const PATIENTS = [];
  for (let i = 0; i < 111; i++) PATIENTS.push(buildPatient(i));

  // corpus-level honest stats
  const totalConds = PATIENTS.reduce((a, p) => a + p.conds.length, 0);

  window.MRES_DATA = {
    patients: PATIENTS,
    count: PATIENTS.length,
    chart: buildChart,
    xml: buildXML,
    labdef: LABDEF,
    cond: COND,
    avgConds: round(totalConds / PATIENTS.length, 1),
    // four patients featured in the worked example (diabetes-forward)
    featured: PATIENTS.filter((p) => p.conds.includes("diabetes")).slice(0, 4).map((p) => p.i),
  };
})();
