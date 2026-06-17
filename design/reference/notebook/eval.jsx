/* Eval section: golden answers + LLM judges, versioned, scored into a runs×evals grid. */
(function () {
  const R = React;
  const h = R.createElement;
  const D = window.MRES_DATA;
  const I = window.MRES_ICON;
  const setEq = window.MRES_setEq;
  const norm = window.MRES_norm;
  const fmt = (v) => (Array.isArray(v) ? (v.length ? v.join(", ") : "[]") : String(v));
  const clean = (n) => n.replace(/\d+/g, "");

  function parseGolden(text) {
    if (!text || !text.trim()) return null;
    try { return JSON.parse(text); } catch (e) { /* tolerant */ }
    const g = {};
    const a = text.match(/a1c[_\s]*current["\s:]*([0-9.]+)/i); if (a) g.a1c_current = parseFloat(a[1]);
    const t = text.match(/trend["\s:]*["']?(improving|stable|worsening)/i); if (t) g.a1c_trend = t[1].toLowerCase();
    const m = text.match(/meds?["\s:]*\[([^\]]*)\]/i);
    if (m) g.diabetes_meds = m[1].split(",").map((s) => s.replace(/["']/g, "").trim()).filter(Boolean);
    return Object.keys(g).length ? g : null;
  }

  function gradeGolden(out, goldenText) {
    const g = parseGolden(goldenText);
    if (!g) return { state: "empty", fails: [] };
    const fails = [];
    if (g.a1c_current != null && Number(g.a1c_current) !== Number(out.a1c_current)) fails.push({ field: "a1c_current", expected: g.a1c_current, got: out.a1c_current });
    if (g.a1c_trend != null && norm(g.a1c_trend) !== norm(out.a1c_trend)) fails.push({ field: "a1c_trend", expected: g.a1c_trend, got: out.a1c_trend });
    if (g.diabetes_meds != null && !setEq(g.diabetes_meds, out.diabetes_meds)) fails.push({ field: "diabetes_meds", expected: g.diabetes_meds, got: out.diabetes_meds });
    return { state: fails.length ? "fail" : "pass", fails };
  }

  function judgeVerdict(result) {
    const o = result.json, t = result.truth;
    const ok = Number(o.a1c_current) === Number(t.a1c_current)
      && String(o.a1c_trend) === String(t.a1c_trend)
      && setEq(o.diabetes_meds, t.diabetes_meds);
    const first = t.a1c_current;
    const oldest = result.chart.labs.find((l) => l.key === "a1c");
    const yearAgo = oldest ? oldest.series[0].value : null;
    const medList = t.diabetes_meds.length ? t.diabetes_meds.join(" and ") : "no diabetes medications";
    const trendClause = yearAgo != null
      ? `The most recent A1c in the chart is ${first}%, ${t.a1c_trend === "improving" ? "down" : t.a1c_trend === "worsening" ? "up" : "level"} from ${yearAgo}% a year earlier — ${t.a1c_trend}.`
      : `The most recent A1c is ${first}%, trend ${t.a1c_trend}.`;
    let reason;
    if (ok) reason = `${trendClause} Current diabetes medications are ${medList}. The output reports ${o.a1c_current}% with the same medication list, so it matches the chart on every field. Pass.`;
    else if (result.flaw === "stale-a1c") reason = `${trendClause} The output reports ${o.a1c_current}% dated ${o.a1c_date}, which is the prior draw rather than the most recent result. Current value is wrong, so this fails on a1c_current.`;
    else if (result.flaw === "dropped-med") reason = `${trendClause} Current diabetes medications are ${medList}, but the output lists only ${o.diabetes_meds.join(", ") || "none"} — a current medication is missing. Fails on diabetes_meds.`;
    else reason = `${trendClause} The output disagrees with the chart on at least one field. Fail.`;
    return { pass: ok, reason };
  }

  window.MRES_gradeGolden = gradeGolden;
  window.MRES_judgeVerdict = judgeVerdict;

  function ResultBadge({ pass }) {
    return h("span", { className: "verdict " + (pass ? "v-pass" : "v-fail") },
      h(pass ? I.check : I.dash, null), pass ? "pass" : "fail");
  }

  // ---- golden row with collapsed "≠ field" chip that expands to a diff ----
  function GoldenRow({ r, value, setValue, grade, onOpenChart }) {
    const [exp, setExp] = R.useState(false);
    return h("div", { className: "golden-row" },
      h("div", { className: "gr-side" },
        h("div", { className: "gr-name" }, clean(r.p.name)),
        h("button", { className: "chartlink", onClick: () => onOpenChart(r.p.i) }, h(I.doc, null), "open chart"),
        grade && grade.state === "pass" && h(ResultBadge, { pass: true }),
        grade && grade.state === "fail" && h("button", { className: "fail-chip", onClick: () => setExp((e) => !e) },
          h(I.dash, null), "≠ " + grade.fails.map((f) => f.field).join(", "),
          h(I.chevD, { width: 11, height: 11, style: { transform: exp ? "rotate(180deg)" : "none", transition: "transform .15s" } })),
        grade && grade.state === "empty" && h("span", { className: "fail-on dim" }, "no answer")),
      h("textarea", {
        className: "golden-in" + (grade ? (grade.state === "pass" ? " ok" : grade.state === "fail" ? " bad" : "") : ""),
        value: value, spellCheck: false,
        placeholder: '{\n  "a1c_current": …,\n  "a1c_trend": "…",\n  "diabetes_meds": […]\n}',
        onChange: (e) => setValue(e.target.value),
      }),
      grade && grade.state === "fail" && exp && h("div", { className: "golden-diff" },
        h("div", { className: "gd-head" }, h("span", null, "field"), h("span", null, "expected (your golden)"), h("span", null, "got (model)")),
        grade.fails.map((f) =>
          h("div", { className: "gd-row", key: f.field },
            h("span", { className: "gd-field" }, f.field),
            h("span", { className: "gd-exp" }, fmt(f.expected)),
            h("span", { className: "gd-got" }, fmt(f.got))))));
  }

  // ---- a judge's per-patient results (shared by primary + added judges) ----
  function JudgeResults({ cell, jkey, runId, model, version, goldenCell, onAgree }) {
    if (!cell) return null;
    const scored = cell.per.filter((x) => !x.errored);
    const passN = scored.filter((x) => x.pass).length;
    const erroredN = cell.per.length - scored.length;
    const goldenOf = (i) => goldenCell && goldenCell.per.find((x) => x.i === i);
    const comparable = goldenCell ? scored.filter((x) => goldenOf(x.i) && goldenOf(x.i).state !== "empty") : [];
    const matchN = comparable.filter((x) => x.pass === goldenOf(x.i).pass).length;
    const marked = scored.filter((x) => x.agree);
    const disagreeN = marked.filter((x) => x.agree === "disagree").length;
    const verTag = version > 1 ? " · judge v" + version : "";

    return h("div", null,
      h("div", { className: "judge-rows" },
        cell.per.map((j) => {
          if (j.errored) return h("div", { className: "judge-row errored", key: j.i },
            h("div", { className: "jr-head" },
              h("span", { className: "jr-name" }, clean(j.name)),
              h("span", { className: "verdict v-err" }, h(I.bolt, null), "judge errored — not scored")),
            h("div", { className: "jr-reason dim" }, "The judge call failed for this patient. It is left out of the number below — re-run the judge to score it."));
          const g = goldenOf(j.i);
          const mism = g && g.state !== "empty" && g.pass !== j.pass;
          return h("div", { className: "judge-row" + (mism ? " mismatch" : ""), key: j.i },
            h("div", { className: "jr-head" },
              h("span", { className: "jr-name" }, clean(j.name)),
              h(ResultBadge, { pass: j.pass }),
              mism && h("span", { className: "mism-tag" }, "≠ your golden"),
              h("span", { className: "agree-wrap" },
                h("span", { className: "agree-label" }, "do you agree?"),
                h("button", { className: "agree-btn" + (j.agree === "agree" ? " on yes" : ""), onClick: () => onAgree(jkey, runId, j.i, "agree") }, "agree"),
                h("button", { className: "agree-btn" + (j.agree === "disagree" ? " on no" : ""), onClick: () => onAgree(jkey, runId, j.i, "disagree") }, "disagree"))),
            h("div", { className: "jr-reason" }, j.reason));
        })),
      h("div", { className: "overall" },
        h("span", { className: "ov-num" }, passN + "/" + scored.length), " pass",
        h("span", { className: "ov-note" }, " · judged by " + model + (erroredN ? " · " + erroredN + " not scored" : "") + verTag)),
      goldenCell && comparable.length > 0 && h("div", { className: "cross-line" },
        h("div", { className: "cl-main" }, "The judge matched your golden answers on " + matchN + " of " + comparable.length + " patients."),
        h("div", { className: "cl-sub" }, "A mismatch is a lead, not a verdict — sometimes the judge is right and your golden answer is stale.")),
      marked.length > 0 && h("div", { className: "yvj-line" },
        "You disagreed with the judge on " + disagreeN + " of " + scored.length + "."));
  }

  // ===================== PRIMARY EVAL CELL ==============================
  function EvalCell({ ctx }) {
    const { results, mode, setMode, golden, setGolden, judges, updateJudge, scores, versions,
      onScoreGolden, onScoreJudge, onOpenChart, model, stale, curRunId, onAgree } = ctx;
    if (!results.length) return null;

    if (!mode) {
      return h("div", { className: "cell" },
        h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag dim" }, "eval")),
        h("div", { className: "cell-main" },
          h("div", { className: "eval-invite" },
            h("div", { className: "ei-text" },
              h("div", { className: "ei-title" }, "Does the output hold up?"),
              h("div", { className: "ei-sub" }, "Add the answers you expect, or let a model judge against criteria you write.")),
            h("div", { className: "ei-actions" },
              h("button", { className: "btn-primary", onClick: () => setMode("golden") }, "Add golden answers"),
              h("button", { className: "btn-ghost", onClick: () => setMode("judge") }, "or use an LLM judge")))));
    }

    const j0 = judges[0];
    const jkey = "judge:" + j0.id;
    const goldenCell = scores.golden && scores.golden[curRunId];
    const judgeCell = scores[jkey] && scores[jkey][curRunId];
    const goldenVer = versions.golden ? versions.golden.v : 0;
    const judgeVer = versions[jkey] ? versions[jkey].v : 0;

    const actionBtn = stale
      ? h("button", { className: "btn-primary sm", disabled: true, title: "Re-run — the output above is stale" }, "Re-run to score")
      : mode === "golden"
        ? h("button", { className: "btn-primary sm", onClick: onScoreGolden }, "Score")
        : h("button", { className: "btn-primary sm", onClick: () => onScoreJudge(j0.id) }, "Run judge");

    return h("div", { id: "eval-primary", className: "cell" + (stale ? " quiet" : "") },
      h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "eval")),
      h("div", { className: "cell-main" },
        h("div", { className: "eval-head" },
          h("div", { className: "seg" },
            h("button", { className: "seg-btn" + (mode === "golden" ? " on" : ""), onClick: () => setMode("golden") }, "Golden answers"),
            h("button", { className: "seg-btn" + (mode === "judge" ? " on" : ""), onClick: () => setMode("judge") }, "LLM judge")),
          actionBtn),

        mode === "golden"
          ? h("div", null,
              h("div", { className: "eval-copy" }, "Write each expected answer from the chart, not from the output above."),
              h("div", { className: "golden-rows" },
                results.map((r) =>
                  h(GoldenRow, { key: r.p.i, r,
                    value: golden[r.p.i] || "",
                    setValue: (v) => setGolden(Object.assign({}, golden, { [r.p.i]: v })),
                    grade: goldenCell && goldenCell.per.find((x) => x.i === r.p.i),
                    onOpenChart }))),
              h("div", { className: "forgive" }, "The diff forgives casing, whitespace, list order, and common clinical aliases — “QD” matches “once daily”."),
              goldenCell && h("div", { className: "overall" },
                h("span", { className: "ov-num" }, goldenCell.frac), " pass",
                h("span", { className: "ov-note" }, " · scored against your golden answers" + (goldenVer > 1 ? " · golden v" + goldenVer : ""))))
          : h("div", null,
              h("div", { className: "eval-copy" }, "Describe what a correct answer must contain. The judge reads each chart and rules per patient."),
              h("textarea", {
                className: "criteria-in", value: j0.criteria, spellCheck: false,
                placeholder: window.MRES_WORKED_CRITERIA,
                onChange: (e) => updateJudge(j0.id, e.target.value),
              }),
              judgeVer > 1 && h("div", { className: "judge-teach" }, "A judge is a prompt — tune it like one."),
              h(JudgeResults, { cell: judgeCell, jkey, runId: curRunId, model, version: judgeVer, goldenCell, onAgree }))));
  }

  // ===================== ADDED JUDGE CELL ==============================
  function JudgeCell({ ctx, judge }) {
    const { scores, versions, onScoreJudge, updateJudge, model, stale, curRunId, onAgree, removeJudge } = ctx;
    const jkey = "judge:" + judge.id;
    const cell = scores[jkey] && scores[jkey][curRunId];
    const ver = versions[jkey] ? versions[jkey].v : 0;
    const goldenCell = scores.golden && scores.golden[curRunId];
    return h("div", { id: "eval-" + judge.id, className: "cell" + (stale ? " quiet" : "") },
      h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "eval")),
      h("div", { className: "cell-main" },
        h("div", { className: "eval-head" },
          h("div", { className: "jc-title" }, judge.label, ver > 1 && h("span", { className: "jc-ver" }, "v" + ver)),
          h("div", { className: "jc-actions" },
            h("button", { className: "jc-remove", onClick: () => removeJudge(judge.id), title: "Remove this judge" }, h(I.x, null)),
            stale
              ? h("button", { className: "btn-primary sm", disabled: true, title: "Re-run — the output above is stale" }, "Re-run to score")
              : h("button", { className: "btn-primary sm", onClick: () => onScoreJudge(judge.id) }, "Run judge"))),
        h("div", { className: "eval-copy" }, "Describe what a correct answer must contain. The judge reads each chart and rules per patient."),
        h("textarea", {
          className: "criteria-in", value: judge.criteria, spellCheck: false,
          placeholder: window.MRES_WORKED_CRITERIA,
          onChange: (e) => updateJudge(judge.id, e.target.value),
        }),
        ver > 1 && h("div", { className: "judge-teach" }, "A judge is a prompt — tune it like one."),
        h(JudgeResults, { cell, jkey, runId: curRunId, model, version: ver, goldenCell, onAgree })));
  }

  // ===================== "+ ADD ANOTHER EVAL" =========================
  function AddEval({ ctx }) {
    const { scores, judges, addJudge } = ctx;
    const anyScore = (scores.golden && Object.keys(scores.golden).length) ||
      judges.some((j) => scores["judge:" + j.id] && Object.keys(scores["judge:" + j.id]).length);
    if (!anyScore) return null; // appears only after the first eval exists
    return h("div", { className: "add-eval" },
      h("div", { className: "cell-gutter" }),
      h("button", { className: "add-eval-btn", onClick: addJudge },
        h("span", { className: "ae-plus" }, "+"), "Add another eval",
        h("span", { className: "ae-hint" }, "another judge — a judge is just another criteria box")));
  }

  // scroll to an editor without scrollIntoView (which can disrupt the layout)
  function scrollToEditor(id) {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const target = Math.max(0, el.getBoundingClientRect().top + window.scrollY - 76);
      const start = window.scrollY;
      const dist = target - start;
      if (Math.abs(dist) < 2) return;
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const steps = 26;
      for (let i = 1; i <= steps; i++) {
        setTimeout(() => window.scrollTo(0, start + dist * ease(i / steps)), i * 14);
      }
    }, 110);
  }

  // ===================== SCORE AREA (line or grid) ====================
  function ScoreArea({ ctx }) {
    const { scores, runs, judges, curRunId, onExport, stale, versions, expandRuns, setExpandRuns, setMode } = ctx;
    const [peek, setPeek] = R.useState(null);
    const labelFor = (k) => k === "golden" ? "golden" : (judges.find((j) => "judge:" + j.id === k) || {}).label || "judge";
    const evalKeys = [];
    if (scores.golden && Object.keys(scores.golden).length) evalKeys.push("golden");
    judges.forEach((j) => { const k = "judge:" + j.id; if (scores[k] && Object.keys(scores[k]).length) evalKeys.push(k); });
    if (!evalKeys.length) return null;
    const scoredRuns = runs.filter((r) => evalKeys.some((k) => scores[k] && scores[k][r.id]));

    // ---- simple line: exactly one eval and one scored run (1×1, unchanged) ----
    if (evalKeys.length === 1 && scoredRuns.length === 1) {
      const cell = scores[evalKeys[0]][scoredRuns[0].id];
      return h("div", { className: "scoreline" + (stale ? " quiet" : "") },
        h("div", { className: "sl-left" },
          h("span", { className: "sl-label" }, "Runs"),
          h("div", { className: "sl-trail" }, h("span", { className: "sl-num cur" }, cell.frac)),
          stale && h("span", { className: "sl-stale" }, "stale — re-run")),
        h("button", { className: "btn-ghost sm", onClick: onExport }, h(I.dl, null), "Export"));
    }

    // ---- grid: runs (cols) × evals (rows) ----
    const primaryKey = "judge:" + judges[0].id;
    const allCols = scoredRuns;
    const cols = expandRuns ? allCols : allCols.slice(-3);
    const peekRun = peek != null ? runs.find((r) => r.id === peek) : null;

    function onRowClick(k) {
      if (k === "golden") { setMode("golden"); scrollToEditor("eval-primary"); }
      else if (k === primaryKey) { setMode("judge"); scrollToEditor("eval-primary"); }
      else scrollToEditor("eval-" + k.slice(6));
    }

    // trust markers for a judge row, reflecting the CURRENT column only
    function markersFor(k) {
      if (k === "golden") return [];
      const cell = scores[k] && scores[k][curRunId];
      if (!cell) return [];
      const out = [];
      const gc = scores.golden && scores.golden[curRunId];
      if (gc) {
        const comp = cell.per.filter((x) => !x.errored && gc.per.find((y) => y.i === x.i && y.state !== "empty"));
        if (comp.length) {
          const m = comp.filter((x) => x.pass === gc.per.find((y) => y.i === x.i).pass).length;
          out.push({ cls: "vg", text: "vs your golden " + m + "/" + comp.length });
        }
      }
      const marked = cell.per.filter((x) => !x.errored && x.agree);
      if (marked.length) {
        const ag = marked.filter((x) => x.agree === "agree").length;
        out.push({ cls: "you", text: "you: " + ag + "/" + marked.length });
      }
      return out;
    }

    return h("div", { className: "scoregrid-wrap" },
      h("div", { className: "sg-top" },
        h("span", { className: "sl-label" }, "Runs × evals"),
        allCols.length > 3 && h("button", { className: "sg-expander", onClick: () => setExpandRuns(!expandRuns) },
          expandRuns ? "last 3 runs" : "all runs (" + allCols.length + ")"),
        h("button", { className: "btn-ghost sm", onClick: onExport }, h(I.dl, null), "Export")),
      peekRun && h("div", { className: "run-peek" },
        h("div", { className: "rp-head" },
          h("span", null, "run " + peekRun.version + " · prompt"),
          h("button", { className: "rp-close", onClick: () => setPeek(null) }, h(I.x, null))),
        h("pre", { className: "rp-body" }, peekRun.prompt && peekRun.prompt.trim() ? peekRun.prompt : window.MRES_WORKED_PROMPT)),
      h("div", { className: "scoregrid", style: { gridTemplateColumns: "minmax(168px, 1.4fr) repeat(" + cols.length + ", 1fr)" } },
        h("div", { className: "sg-corner" }),
        cols.map((r) => h("button", { className: "sg-col" + (r.id === curRunId ? " cur" : "") + (peek === r.id ? " open" : ""), key: r.id, title: "show this run's prompt", onClick: () => setPeek(peek === r.id ? null : r.id) },
          "run " + r.version, r.id === curRunId && h("span", { className: "sg-cur" }, "current"))),
        evalKeys.map((k) => {
          const ver = versions[k] ? versions[k].v : 1;
          const mk = markersFor(k);
          return [
            h("button", { className: "sg-rowlabel", key: k + "-l", title: "go to this eval's editor", onClick: () => onRowClick(k) },
              h("span", { className: "sg-rl-main" }, labelFor(k), ver > 1 && h("span", { className: "sg-ver" }, "v" + ver)),
              mk.length > 0 && h("span", { className: "sg-rl-markers" },
                mk.map((m, idx) => h("span", { className: "sg-marker " + m.cls, key: idx }, m.text)))),
            cols.map((r) => {
              const c = scores[k] && scores[k][r.id];
              return h("div", { className: "sg-cell" + (r.id === curRunId ? " cur" : "") + (c ? "" : " empty"), key: k + r.id },
                c ? c.frac : "—");
            }),
          ];
        })));
  }

  window.MRES_EvalCell = EvalCell;
  window.MRES_JudgeCell = JudgeCell;
  window.MRES_AddEval = AddEval;
  window.MRES_ScoreArea = ScoreArea;
})();
