/* Shared helpers for the MRES sandbox. Attaches everything to window. */
(function () {
  const D = window.MRES_DATA;
  window.MRES_MODEL_FREE = "claude-haiku-4-5";
  window.MRES_MODEL_PAID = "claude-sonnet-4-5";
  window.MRES_MODEL = window.MRES_MODEL_FREE; // default = free tier
  window.MRES_ACTIVE_MODEL = window.MRES_MODEL_FREE;

  // context-mode per patient: big charts get retrieved instead of fitting whole
  window.MRES_contextMode = function (p) { return p.chartKB > 108 ? "retrieved" : "full"; };

  // forgiving normalization: casing, whitespace, punctuation, clinical aliases
  const ALIAS = { qd: "once daily", qday: "once daily", daily: "once daily", bid: "twice daily",
    tid: "three times daily", qid: "four times daily", qhs: "at bedtime", hs: "at bedtime",
    qam: "every morning", prn: "as needed", po: "by mouth", inh: "inhaled", q12h: "twice daily", q24h: "once daily" };
  window.MRES_norm = function (s) {
    s = String(s == null ? "" : s).toLowerCase().trim().replace(/[.,;]/g, "").replace(/\s+/g, " ");
    return s.split(" ").map((w) => ALIAS[w] || w).join(" ");
  };

  // --- the worked extraction prompt (placeholder + example fill) ----------
  window.MRES_WORKED_PROMPT =
`From this patient's chart, extract their diabetes management as JSON.

- a1c_current: most recent Hemoglobin A1c value
- a1c_date: the date of that result (YYYY-MM-DD)
- a1c_trend: "improving" | "stable" | "worsening" over the last year
- diabetes_meds: every current diabetes medication, with dose

Use only what is in the chart. If a field is absent, return null.`;

  window.MRES_WORKED_CRITERIA =
`Pass if a1c_current matches the most recent A1c in the chart, a1c_trend reflects the last year of values, and diabetes_meds lists every current diabetes medication — no extras, none missing.`;

  // --- generate the model's structured output for a patient ---------------
  // Deterministic extraction from the chart. A small share of patients get a
  // realistic miss (stale value or a dropped med) so the eval has something to catch.
  window.MRES_genOutput = function (p, version) {
    const chart = D.chart(p);
    const a1c = chart.labs.find((l) => l.key === "a1c");
    const dmMeds = chart.medications
      .filter((m) => D.cond.diabetes.meds.some((dm) => dm.split(" ")[0] === m.name.split(" ")[0]))
      .map((m) => m.name);
    // seeded "model behaviour"
    const seed = (p.i * 31 + 7) % 10;
    const out = {
      a1c_current: a1c ? a1c.value : null,
      a1c_date: a1c ? a1c.date : null,
      a1c_trend: a1c ? a1c.trend : null,
      diabetes_meds: dmMeds.slice(),
    };
    let flaw = null;
    // v1 of a prompt carries the modeled mistakes; a revised prompt (v2+) fixes them
    if ((version || 1) < 2) {
      if (a1c && (seed === 3 || seed === 8)) { // grabbed an older value
        const older = a1c.series[a1c.series.length - 2];
        out.a1c_current = older.value; out.a1c_date = older.date; flaw = "stale-a1c";
      } else if (dmMeds.length > 1 && (seed === 6 || seed === 1)) { // dropped a med
        out.diabetes_meds = dmMeds.slice(0, dmMeds.length - 1); flaw = "dropped-med";
      }
    }
    return { json: out, chart, flaw, truth: { a1c_current: a1c ? a1c.value : null, a1c_date: a1c ? a1c.date : null, a1c_trend: a1c ? a1c.trend : null, diabetes_meds: dmMeds } };
  };

  // --- serialize the chart to the exact text the model "saw" --------------
  window.MRES_serializeChart = function (p, prompt) {
    const chart = D.chart(p);
    const retrieved = window.MRES_contextMode(p) === "retrieved";
    const L = [];
    L.push("=== PATIENT CHART (synthetic) ===");
    L.push(`Patient: ${p.name}   MRN: ${p.mrn}`);
    L.push(`Age/Sex: ${p.age} ${p.sex === "M" ? "Male" : "Female"}`);
    if (retrieved) L.push(`[chart is ${p.chartKB} KB — over the context budget; the sections below were retrieved by relevance, encounters dropped]`);
    L.push("");
    L.push("# Problems");
    chart.problems.forEach((pr) => L.push(`- [${pr.code}] ${pr.label} — onset ${pr.onset}, ${pr.status}`));
    L.push("");
    L.push("# Medications");
    chart.medications.forEach((m) => L.push(`- ${m.name} — ${m.sig} (started ${m.start})`));
    L.push("");
    L.push("# Labs");
    chart.labs.forEach((l) => {
      const hist = l.series.map((s) => `${s.value} (${s.date})`).join(", ");
      L.push(`- ${l.name} [${l.loinc}]: ${l.value} ${l.unit}  ref ${l.ref}`);
      L.push(`    history: ${hist}`);
    });
    if (!retrieved) {
      L.push("");
      L.push("# Encounters");
      chart.encounters.forEach((e) => L.push(`- ${e.date}  ${e.type} — ${e.provider} (${e.reason})`));
    } else {
      L.push("");
      L.push("# Encounters");
      L.push(`- [${chart.encounters.length} encounters not retrieved — trimmed to fit context]`);
    }
    return { prompt: prompt && prompt.trim() ? prompt.trim() : window.MRES_WORKED_PROMPT, chartText: L.join("\n"), retrieved };
  };

  // --- prose worked query (judge leg) -------------------------------------
  window.MRES_PROSE_PROMPT = "Summarize whether this patient's diabetes is controlled, in one sentence.";
  window.MRES_PROSE_CRITERIA =
`Pass if the sentence states whether the diabetes is controlled and that call matches the chart — controlled when the most recent A1c is under ~7.5% and not worsening.`;

  function controlled(t) {
    return t.a1c_current != null && Number(t.a1c_current) < 7.5 && t.a1c_trend !== "worsening";
  }
  window.MRES_controlled = controlled;

  // model's prose answer; miscall flips the conclusion while keeping real numbers
  window.MRES_genProse = function (p, miscall) {
    const t = window.MRES_genOutput(p).truth;
    const ctrl = controlled(t);
    const claim = miscall ? !ctrl : ctrl;
    const meds = t.diabetes_meds.length ? t.diabetes_meds.join(" and ") : "no diabetes medications";
    return {
      claim,
      text: `This patient's diabetes appears ${claim ? "well controlled" : "not well controlled"} — the most recent A1c is ${t.a1c_current}% and ${t.a1c_trend}, on ${meds}.`,
    };
  };

  // judge reads the chart and rules on the prose claim
  window.MRES_judgeProse = function (p, claim) {
    const t = window.MRES_genOutput(p).truth;
    const ctrl = controlled(t);
    const pass = claim === ctrl;
    const reason = `Most recent A1c is ${t.a1c_current}% and ${t.a1c_trend}, which is ${ctrl ? "under the ~7.5% control threshold with a non-worsening trend" : "at or above the ~7.5% control threshold or worsening"} — so the chart reads as ${ctrl ? "controlled" : "not controlled"}. The summary calls it ${claim ? "controlled" : "not controlled"}, which ${pass ? "agrees with the chart. Pass." : "contradicts the chart. Fail."}`;
    return { pass, reason };
  };

  // deterministic, rare judge transport error
  window.MRES_judgeErr = function (p) { return (p.i % 11) === 4; };

  // --- JSON syntax highlight to HTML --------------------------------------
  window.MRES_hl = function (obj) {
    const json = JSON.stringify(obj, null, 2);
    const esc = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m) => {
        let cls = "j-num";
        if (/^"/.test(m)) cls = /:$/.test(m) ? "j-key" : "j-str";
        else if (/true|false/.test(m)) cls = "j-bool";
        else if (/null/.test(m)) cls = "j-null";
        return `<span class="${cls}">${m}</span>`;
      }
    );
  };

  // --- tiny inline icons --------------------------------------------------
  const R = React;
  const svg = (path, extra) => (props) =>
    R.createElement("svg", Object.assign({ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }, extra || {}, props), path);
  window.MRES_ICON = {
    chevR: svg(R.createElement("path", { d: "M6 4l4 4-4 4" })),
    chevL: svg(R.createElement("path", { d: "M10 4l-4 4 4 4" })),
    chevD: svg(R.createElement("path", { d: "M4 6l4 4 4-4" })),
    x: svg([R.createElement("path", { key: 1, d: "M4 4l8 8" }), R.createElement("path", { key: 2, d: "M12 4l-8 8" })]),
    ext: svg([R.createElement("path", { key: 1, d: "M6.5 3.5H3.5v9h9v-3" }), R.createElement("path", { key: 2, d: "M9.5 3.5h3v3" }), R.createElement("path", { key: 3, d: "M12.5 3.5l-5 5" })]),
    doc: svg([R.createElement("path", { key: 1, d: "M4 2.5h5l3 3v8H4z" }), R.createElement("path", { key: 2, d: "M9 2.5v3h3" })]),
    run: svg(R.createElement("path", { d: "M5 3.5l7 4.5-7 4.5z", fill: "currentColor", stroke: "none" })),
    eye: svg([R.createElement("path", { key: 1, d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" }), R.createElement("circle", { key: 2, cx: 8, cy: 8, r: 1.6 })]),
    check: svg(R.createElement("path", { d: "M3.5 8.5l3 3 6-7" })),
    dash: svg(R.createElement("path", { d: "M4 8h8" })),
    dl: svg([R.createElement("path", { key: 1, d: "M8 3v7" }), R.createElement("path", { key: 2, d: "M5 7.5l3 3 3-3" }), R.createElement("path", { key: 3, d: "M3.5 13h9" })]),
    table: svg([R.createElement("rect", { key: 1, x: 2.5, y: 3, width: 11, height: 10, rx: 1 }), R.createElement("path", { key: 2, d: "M2.5 6.5h11M6.5 6.5v6.5" })]),
    bolt: svg(R.createElement("path", { d: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z", fill: "currentColor", stroke: "none" })),
    refresh: svg([R.createElement("path", { key: 1, d: "M13 8a5 5 0 1 1-1.5-3.5" }), R.createElement("path", { key: 2, d: "M13 2.5V5h-2.5" })]),
    lock: svg([R.createElement("rect", { key: 1, x: 3.5, y: 7, width: 9, height: 6.5, rx: 1 }), R.createElement("path", { key: 2, d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" })]),
  };
})();
